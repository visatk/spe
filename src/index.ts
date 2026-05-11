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

// --- Upstream API Connector (Processes a SINGLE card) ---
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
    return { card, status: 'unknown', message: `Gateway Timeout or Error` };
  }
}

// --- Telegram Webhook Lifecycle Management ---
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

    // 1. Initial Start Command
    if (text.startsWith('/start')) {
      const authorized = await isAuthorized(c.env.KV, userId, c.env.ADMIN_TELEGRAM_ID);
      const remaining = authorized ? await getRemainingQuota(c.env.KV, userId, dailyLimit) : 0;
      
      const welcomeText = `🤖 <b>Advanced CC Checker Architecture</b>\n\n` +
        `🆔 Your ID: <code>${userId}</code>\n` +
        `🛡 Status: ${authorized ? "✅ Authorized" : "❌ Unauthorized"}\n` +
        `💳 Quota: ${remaining} / ${dailyLimit} cards today\n\n` +
        `<b>Gates:</b>\n` +
        `<code>/chk1 &lt;cards&gt;</code> - Gate 1 (Payate CCN)\n` +
        `<code>/chk2 &lt;cards&gt;</code> - Gate 2 (Payate Mock)\n` +
        `<code>/me</code> - Check daily stats`;
      
      await sendTelegramMessage(token, chatId, welcomeText, messageId);
      return c.text('OK');
    }

    // 2. Admin Commands
    if (isAdmin) {
      if (text.startsWith('/add ')) {
        const targetId = text.split(' ')[1];
        if (!targetId || isNaN(Number(targetId))) {
          await sendTelegramMessage(token, chatId, "⚠️ Usage: `/add <userid>`", messageId);
          return c.text('OK');
        }
        await c.env.KV.put(`${KV_USER_PREFIX}${targetId}`, JSON.stringify({ role: 'user', addedAt: Date.now(), addedBy: userId }));
        await sendTelegramMessage(token, chatId, `✅ User <code>${targetId}</code> authorized.`, messageId);
        return c.text('OK');
      }
      if (text.startsWith('/remove ')) {
        const targetId = text.split(' ')[1];
        await c.env.KV.delete(`${KV_USER_PREFIX}${targetId}`);
        await sendTelegramMessage(token, chatId, `🗑 User <code>${targetId}</code> removed.`, messageId);
        return c.text('OK');
      }
    }

    // 3. Authorization Gatekeeper
    if (!(await isAuthorized(c.env.KV, userId, c.env.ADMIN_TELEGRAM_ID))) {
      await sendTelegramMessage(token, chatId, "⛔️ <b>Access Denied</b>\nYou are not authorized to use this system.", messageId);
      return c.text('OK');
    }

    // 4. Stats Command
    if (text === '/me' || text === '/stats') {
      const remaining = await getRemainingQuota(c.env.KV, userId, dailyLimit);
      await sendTelegramMessage(token, chatId, `📊 <b>Your Stats</b>\n\nRemaining Quota: <b>${remaining}</b> / ${dailyLimit}\n<i>Resets daily at Midnight UTC.</i>`, messageId);
      return c.text('OK');
    }

    // 5. Checker Commands & Orchestration
    const isApi1 = text.startsWith('/chk1 ');
    const isApi2 = text.startsWith('/chk2 ');

    if (isApi1 || isApi2) {
      const rawPayload = text.replace(/^\/chk[12] /, '');
      const validCards = rawPayload.split('\n')
        .map(line => sanitizeInput(line))
        .filter(line => line.length >= 12); 
      
      const cardCount = validCards.length;

      if (cardCount === 0) {
        await sendTelegramMessage(token, chatId, "❌ No valid cards found. Format: `CC|MM|YY|CVV`", messageId);
        return c.text('OK');
      }

      const quota = await consumeQuota(c.env.KV, userId, cardCount, dailyLimit);
      
      if (!quota.allowed) {
        await sendTelegramMessage(token, chatId, `🛑 <b>Rate Limit Exceeded</b>\n\nYou attempted to process ${cardCount} cards, but you only have ${quota.remaining} remaining today.`, messageId);
        return c.text('OK');
      }

      const gateName = isApi1 ? "Gate 1" : "Gate 2";
      await sendTelegramMessage(token, chatId, `⏳ <i>Processing ${cardCount} card(s) sequentially via ${gateName}...</i>`, messageId);

      // Async Edge Processing Engine
      c.executionCtx.waitUntil((async () => {
        try {
          const results: string[] = [];
          
          for (let i = 0; i < validCards.length; i++) {
            const card = validCards[i];
            const result = isApi1 
              ? await checkSingleCard(c.env.UPSTREAM_API1_URL, 'ajax', card, c.env.UPSTREAM_TIMEOUT_MS, 0)
              : await checkSingleCard(c.env.UPSTREAM_API2_URL, 'data', card, c.env.UPSTREAM_TIMEOUT_MS, 1);
            
            const emoji = result.status === 'live' ? '✅' : result.status === 'dead' ? '❌' : '⚠️';
            results.push(`${emoji} <code>${result.card}</code> - ${result.message}`);
            
            // Introduce a 500ms delay between upstream calls to prevent rate-limiting IP bans
            if (i < validCards.length - 1) await sleep(500); 
          }

          // Aggregate the response safely
          const aggregatedMessage = `<b>[${gateName}] Final Report:</b>\n\n${results.join('\n')}\n\n<i>Remaining Quota: ${quota.remaining}</i>`;
          await sendTelegramMessage(token, chatId, aggregatedMessage, messageId);

        } catch (error: any) {
          await sendTelegramMessage(token, chatId, `⚠️ <b>System Error:</b> ${escapeHTML(error.message)}`, messageId);
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
