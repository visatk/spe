import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env, CheckPayload, UpstreamResponse, TelegramUpdate, UserRecord } from './types';

const app = new Hono<Env>();

app.use('/*', cors({
  origin: '*',
  allowMethods: ['POST', 'GET', 'OPTIONS'],
  maxAge: 86400,
}));

// --- Utilities ---
const sanitizeInput = (input: string): string => input.replace(/[^\d\|]/g, '').trim();

async function sendTelegramMessage(token: string, chatId: number, text: string, replyToMessageId?: number) {
  const payload: any = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

// --- KV Access Control Service ---
const KV_PREFIX = 'user:';

async function isAuthorized(kv: KVNamespace, userId: number, adminId: string): Promise<boolean> {
  if (userId.toString() === adminId) return true; // Master admin bypass
  const record = await kv.get(`${KV_PREFIX}${userId}`);
  return record !== null;
}

// --- Upstream API Handlers (Unchanged internally, optimized for Edge) ---
async function checkApi1(cclist: string, env: Env['Bindings']): Promise<UpstreamResponse> {
  const upstreamBody = new URLSearchParams({ ajax: '1', do: 'check', cclist });
  const timeoutMs = parseInt(env.UPSTREAM_TIMEOUT_MS) || 5000;

  try {
    const response = await fetch(env.UPSTREAM_API1_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Referer": new URL(env.UPSTREAM_API1_URL).origin + "/"
      },
      body: upstreamBody.toString(),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json<any>();
    let status: UpstreamResponse['status'] = 'unknown';
    if (data.error === 0) status = 'live';
    else if (data.error === 2) status = 'dead';
    return { status, message: data.msg?.replace(/<[^>]*>?/gm, '').trim() || 'No message', raw: data };
  } catch (e: any) {
    throw new Error(`API 1 Failed: ${e.message}`);
  }
}

async function checkApi2(cclist: string, env: Env['Bindings']): Promise<UpstreamResponse> {
  const upstreamBody = new URLSearchParams({ data: cclist });
  const timeoutMs = parseInt(env.UPSTREAM_TIMEOUT_MS) || 5000;

  try {
    const response = await fetch(env.UPSTREAM_API2_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Referer": new URL(env.UPSTREAM_API2_URL).origin + "/"
      },
      body: upstreamBody.toString(),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json<any>();
    let status: UpstreamResponse['status'] = 'unknown';
    if (data.error === 1) status = 'live';
    else if (data.error === 2) status = 'dead';
    return { status, message: data.msg?.replace(/<[^>]*>?/gm, '').trim() || 'No message', raw: data };
  } catch (e: any) {
    throw new Error(`API 2 Failed: ${e.message}`);
  }
}

// --- REST API Route ---
app.post('/api/check', async (c) => {
  // Note: REST API auth omitted for brevity, recommend adding API keys here
  try {
    const body = await c.req.json<CheckPayload>();
    const sanitizedCcList = sanitizeInput(body.cclist || '');
    if (!sanitizedCcList) return c.json({ status: 'error', message: 'Malformed payload' }, 400);

    const result = body.api === '2' ? await checkApi2(sanitizedCcList, c.env) : await checkApi1(sanitizedCcList, c.env);
    return c.json({ status: result.status, cardData: sanitizedCcList, message: result.message });
  } catch (error: any) {
    return c.json({ status: 'error', message: error.message }, 500);
  }
});

// --- Telegram Webhook Setup ---
app.get('/webhook/setup', async (c) => {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET } = c.env;
  if (!TELEGRAM_BOT_TOKEN) return c.text("Error: Missing token", 500);
  
  const webhookUrl = new URL(c.req.url).origin + '/webhook/telegram';
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${webhookUrl}&secret_token=${TELEGRAM_WEBHOOK_SECRET || 'secret'}`);
  return c.json(await response.json());
});

// --- Telegram Webhook Receiver ---
app.post('/webhook/telegram', async (c) => {
  const secretToken = c.req.header('X-Telegram-Bot-Api-Secret-Token');
  if (c.env.TELEGRAM_WEBHOOK_SECRET && secretToken !== c.env.TELEGRAM_WEBHOOK_SECRET) {
    return c.text('Unauthorized', 403);
  }

  try {
    const update = await c.req.json<TelegramUpdate>();
    if (!update.message?.text || !update.message.from) return c.text('OK');

    const chatId = update.message.chat.id;
    const userId = update.message.from.id;
    const messageId = update.message.message_id;
    const text = update.message.text.trim();
    const token = c.env.TELEGRAM_BOT_TOKEN;
    const isAdmin = userId.toString() === c.env.ADMIN_TELEGRAM_ID;

    // 1. Initial Start Command (Public)
    if (text.startsWith('/start')) {
      const authStatus = (await isAuthorized(c.env.KV, userId, c.env.ADMIN_TELEGRAM_ID)) ? "✅ Authorized" : "❌ Unauthorized";
      await sendTelegramMessage(token, chatId, `🤖 <b>CC Bot System</b>\n\nYour ID: <code>${userId}</code>\nStatus: ${authStatus}`, messageId);
      return c.text('OK');
    }

    // 2. Admin Commands (KV Management)
    if (isAdmin) {
      if (text.startsWith('/add ')) {
        const targetId = text.split(' ')[1];
        if (!targetId || isNaN(Number(targetId))) {
          await sendTelegramMessage(token, chatId, "⚠️ Usage: `/add <userid>`", messageId);
          return c.text('OK');
        }
        const record: UserRecord = { role: 'user', addedAt: Date.now(), addedBy: userId };
        await c.env.KV.put(`${KV_PREFIX}${targetId}`, JSON.stringify(record));
        await sendTelegramMessage(token, chatId, `✅ User <code>${targetId}</code> authorized.`, messageId);
        return c.text('OK');
      }

      if (text.startsWith('/remove ')) {
        const targetId = text.split(' ')[1];
        await c.env.KV.delete(`${KV_PREFIX}${targetId}`);
        await sendTelegramMessage(token, chatId, `🗑 User <code>${targetId}</code> removed.`, messageId);
        return c.text('OK');
      }

      if (text === '/users') {
        const list = await c.env.KV.list({ prefix: KV_PREFIX });
        const ids = list.keys.map(k => k.name.replace(KV_PREFIX, ''));
        const responseText = ids.length > 0 ? `👥 <b>Authorized Users:</b>\n<code>${ids.join('\n')}</code>` : "No authorized users.";
        await sendTelegramMessage(token, chatId, responseText, messageId);
        return c.text('OK');
      }
    }

    // 3. Authorization Gatekeeper
    const authorized = await isAuthorized(c.env.KV, userId, c.env.ADMIN_TELEGRAM_ID);
    if (!authorized) {
      await sendTelegramMessage(token, chatId, "⛔️ <b>Access Denied</b>\nYou are not authorized to use this bot. Send your ID to the admin.", messageId);
      return c.text('OK');
    }

    // 4. Checker Commands
    const isApi1 = text.startsWith('/check ');
    const isApi2 = text.startsWith('/check2 ');

    if (isApi1 || isApi2) {
      const sanitizedCcList = sanitizeInput(text.replace(/^\/check2? /, ''));
      if (!sanitizedCcList) {
        await sendTelegramMessage(token, chatId, "❌ Invalid CC Format.", messageId);
        return c.text('OK');
      }

      await sendTelegramMessage(token, chatId, "⏳ <i>Processing via Edge...</i>", messageId);

      c.executionCtx.waitUntil((async () => {
        try {
          const result = isApi1 ? await checkApi1(sanitizedCcList, c.env) : await checkApi2(sanitizedCcList, c.env);
          const emoji = result.status === 'live' ? '✅' : result.status === 'dead' ? '❌' : '⚠️';
          await sendTelegramMessage(token, chatId, `<b>Result:</b> ${emoji} ${result.status.toUpperCase()}\n<b>CC:</b> <code>${sanitizedCcList}</code>\n<b>Message:</b> ${result.message}`, messageId);
        } catch (error: any) {
          await sendTelegramMessage(token, chatId, `⚠️ <b>Gateway Error:</b> ${error.message}`, messageId);
        }
      })());
    }

    return c.text('OK');
  } catch (error) {
    console.error("Fatal Webhook Error:", error);
    return c.text('OK'); // Always return 200 to prevent Telegram retry death-loops
  }
});

export default app;
