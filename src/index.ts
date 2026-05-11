import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env, CheckPayload, UpstreamResponse, TelegramUpdate } from './types';

const app = new Hono<Env>();

app.use('/*', cors({
  origin: '*', 
  allowMethods: ['POST', 'GET', 'OPTIONS'],
  maxAge: 86400, // Cache preflight requests for 24 hours
}));

// Utility: Sanitize input to prevent injection or malformed requests
const sanitizeInput = (input: string): string => {
  return input.replace(/[^\d\|]/g, '').trim(); 
};

// Utility: Send Telegram Message
async function sendTelegramMessage(token: string, chatId: number, text: string, replyToMessageId?: number) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload: any = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };

  if (replyToMessageId) {
    payload.reply_to_message_id = replyToMessageId;
  }

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

// API 1 Handler
async function checkApi1(cclist: string, env: Env['Bindings']): Promise<UpstreamResponse> {
  const upstreamBody = new URLSearchParams();
  upstreamBody.append('ajax', '1');
  upstreamBody.append('do', 'check');
  upstreamBody.append('cclist', cclist);

  const timeoutMs = parseInt(env.UPSTREAM_TIMEOUT_MS) || 5000;

  try {
    const response = await fetch(env.UPSTREAM_API1_URL, {
      method: "POST",
      headers: {
        "accept": "application/json, text/javascript, */*; q=0.01",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "sec-fetch-mode": "cors",
        "x-requested-with": "XMLHttpRequest",
        "Referer": new URL(env.UPSTREAM_API1_URL).origin + "/"
      },
      body: upstreamBody.toString(),
      signal: AbortSignal.timeout(timeoutMs)
    });
    
    if (!response.ok) {
      throw new Error(`Upstream responded with ${response.status}`);
    }

    const data = await response.json<any>();
    
    let status: UpstreamResponse['status'] = 'unknown';
    if (data.error === 0) status = 'live';
    else if (data.error === 2) status = 'dead';
    
    return {
      status,
      message: data.msg ? data.msg.replace(/<[^>]*>?/gm, '').trim() : 'No message provided',
      raw: data
    };
  } catch (e: any) {
    if (e.name === 'TimeoutError') {
      throw new Error('Upstream API 1 connection timed out');
    }
    throw new Error(`API 1 Failed: ${e.message}`);
  }
}

// API 2 Handler
async function checkApi2(cclist: string, env: Env['Bindings']): Promise<UpstreamResponse> {
  const upstreamBody = new URLSearchParams();
  upstreamBody.append('data', cclist);

  const timeoutMs = parseInt(env.UPSTREAM_TIMEOUT_MS) || 5000;

  try {
    const response = await fetch(env.UPSTREAM_API2_URL, {
      method: "POST",
      headers: {
        "accept": "*/*",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "sec-fetch-mode": "cors",
        "x-requested-with": "XMLHttpRequest",
        "Referer": new URL(env.UPSTREAM_API2_URL).origin + "/"
      },
      body: upstreamBody.toString(),
      signal: AbortSignal.timeout(timeoutMs)
    });
    
    if (!response.ok) {
      throw new Error(`Upstream responded with ${response.status}`);
    }

    const data = await response.json<any>();
    
    let status: UpstreamResponse['status'] = 'unknown';
    if (data.error === 1) status = 'live';
    else if (data.error === 2) status = 'dead';
    
    return {
      status,
      message: data.msg ? data.msg.replace(/<[^>]*>?/gm, '').trim() : 'No message provided',
      raw: data
    };
  } catch (e: any) {
    if (e.name === 'TimeoutError') {
      throw new Error('Upstream API 2 connection timed out');
    }
    throw new Error(`API 2 Failed: ${e.message}`);
  }
}

// Existing REST API Route
app.post('/api/check', async (c) => {
  try {
    const body = await c.req.json<CheckPayload>();
    
    if (!body.cclist || typeof body.cclist !== 'string') {
      return c.json({ status: 'error', message: 'Missing or invalid cclist parameter' }, 400);
    }

    const sanitizedCcList = sanitizeInput(body.cclist);
    if (sanitizedCcList.length === 0) {
      return c.json({ status: 'error', message: 'Malformed cclist payload' }, 400);
    }

    const apiChoice = body.api || '1'; 
    let result: UpstreamResponse;

    if (apiChoice === '1') {
      result = await checkApi1(sanitizedCcList, c.env);
    } else if (apiChoice === '2') {
      result = await checkApi2(sanitizedCcList, c.env);
    } else {
       return c.json({ status: 'error', message: 'Invalid API choice specified' }, 400);
    }

    c.executionCtx.waitUntil(
      (async () => console.log(`Processed request via API ${apiChoice} - Result: ${result.status}`))()
    );

    return c.json({
      status: result.status,
      cardData: sanitizedCcList,
      message: result.message,
      apiUsed: apiChoice,
      raw: result.raw
    });

  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
    return c.json({ status: 'error', message: errorMessage }, 500);
  }
});

// Telegram Webhook Setup Route (Run this once in browser to register your worker with Telegram)
app.get('/webhook/setup', async (c) => {
  const botToken = c.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return c.text("Error: TELEGRAM_BOT_TOKEN is not set.", 500);

  const webhookUrl = new URL(c.req.url).origin + '/webhook/telegram';
  const secretToken = c.env.TELEGRAM_WEBHOOK_SECRET || 'fallback-secret-if-unset';

  const telegramApiUrl = `https://api.telegram.org/bot${botToken}/setWebhook?url=${webhookUrl}&secret_token=${secretToken}`;
  
  const response = await fetch(telegramApiUrl);
  const data = await response.json();
  
  return c.json({ setup: 'complete', telegram_response: data });
});

// Telegram Webhook Receiver Route
app.post('/webhook/telegram', async (c) => {
  const secretToken = c.req.header('X-Telegram-Bot-Api-Secret-Token');
  const expectedSecret = c.env.TELEGRAM_WEBHOOK_SECRET;

  // Security Verification (prevents random POSTs to your webhook)
  if (expectedSecret && secretToken !== expectedSecret) {
    return c.text('Unauthorized', 403);
  }

  try {
    const update = await c.req.json<TelegramUpdate>();
    
    // Ignore updates that aren't text messages
    if (!update.message || !update.message.text) {
      return c.text('OK'); 
    }

    const chatId = update.message.chat.id;
    const messageId = update.message.message_id;
    const text = update.message.text.trim();
    const token = c.env.TELEGRAM_BOT_TOKEN;

    if (!token) throw new Error("Bot token missing");

    // Process Commands
    if (text.startsWith('/start')) {
      await sendTelegramMessage(
        token, 
        chatId, 
        "🤖 <b>Welcome to the CC Checker Bot!</b>\n\nCommands:\n<code>/check &lt;cclist&gt;</code> - Check via API 1\n<code>/check2 &lt;cclist&gt;</code> - Check via API 2",
        messageId
      );
      return c.text('OK');
    }

    let isApi1 = text.startsWith('/check ');
    let isApi2 = text.startsWith('/check2 ');

    if (isApi1 || isApi2) {
      const rawCc = text.replace(/^\/check2? /, '');
      const sanitizedCcList = sanitizeInput(rawCc);

      if (!sanitizedCcList) {
        await sendTelegramMessage(token, chatId, "❌ Invalid or missing CC List.", messageId);
        return c.text('OK');
      }

      // Notify user processing has started
      await sendTelegramMessage(token, chatId, "⏳ Checking...", messageId);

      // Perform upstream check asynchronously
      c.executionCtx.waitUntil((async () => {
        try {
          const result = isApi1 
            ? await checkApi1(sanitizedCcList, c.env)
            : await checkApi2(sanitizedCcList, c.env);
          
          const statusEmoji = result.status === 'live' ? '✅' : result.status === 'dead' ? '❌' : '⚠️';
          const replyText = `<b>Result:</b> ${statusEmoji} ${result.status.toUpperCase()}\n<b>CC:</b> <code>${sanitizedCcList}</code>\n<b>Message:</b> ${result.message}`;
          
          await sendTelegramMessage(token, chatId, replyText, messageId);
        } catch (error: any) {
           await sendTelegramMessage(token, chatId, `⚠️ <b>Error:</b> ${error.message}`, messageId);
        }
      })());
    }

    // Always acknowledge Telegram quickly so it doesn't retry
    return c.text('OK');
  } catch (error) {
    console.error("Webhook Error:", error);
    return c.text('OK'); // Return OK to telegram to avoid webhook retry loops
  }
});

export default app;
