import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env, CheckPayload, UpstreamResponse, TelegramUpdate, UserRecord } from './types';

const app = new Hono<Env>();

app.use('/*', cors({ origin: '*', allowMethods: ['POST', 'GET', 'OPTIONS'], maxAge: 86400 }));

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

// --- KV Access & Quota Control Service ---
const KV_USER_PREFIX = 'user:';
const KV_USAGE_PREFIX = 'usage:';

async function isAuthorized(kv: KVNamespace, userId: number, adminId: string): Promise<boolean> {
  if (userId.toString() === adminId) return true;
  return (await kv.get(`${KV_USER_PREFIX}${userId}`)) !== null;
}

// Calculates exact seconds until Midnight UTC for precise daily resets
const getSecondsUntilMidnightUTC = (): number => {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCHours(24, 0, 0, 0);
  return Math.max(60, Math.floor((tomorrow.getTime() - now.getTime()) / 1000));
};

// Rate Limiter: Checks and increments user usage
async function consumeQuota(kv: KVNamespace, userId: number, cardsToProcess: number, limit: number): Promise<{ allowed: boolean; remaining: number }> {
  const dateStr = new Date().toISOString().split('T')[0];
  const usageKey = `${KV_USAGE_PREFIX}${userId}:${dateStr}`;
  
  const currentUsageStr = await kv.get(usageKey);
  const currentUsage = currentUsageStr ? parseInt(currentUsageStr, 10) : 0;
  
  if (currentUsage + cardsToProcess > limit) {
    return { allowed: false, remaining: Math.max(0, limit - currentUsage) };
  }
  
  const newUsage = currentUsage + cardsToProcess;
  // Set KV TTL to automatically delete the key at Midnight UTC
  await kv.put(usageKey, newUsage.toString(), { expirationTtl: getSecondsUntilMidnightUTC() });
  
  return { allowed: true, remaining: limit - newUsage };
}

// Get current stats without consuming
async function getRemainingQuota(kv: KVNamespace, userId: number, limit: number): Promise<number> {
  const dateStr = new Date().toISOString().split('T')[0];
  const currentUsageStr = await kv.get(`${KV_USAGE_PREFIX}${userId}:${dateStr}`);
  const currentUsage = currentUsageStr ? parseInt(currentUsageStr, 10) : 0;
  return Math.max(0, limit - currentUsage);
}

// --- Upstream API Handlers ---
async function checkApi(url: string, payloadKey: string, payloadValue: string, timeoutStr: string, successCode: number): Promise<UpstreamResponse> {
  const upstreamBody = new URLSearchParams();
  if (payloadKey === 'ajax') {
    upstreamBody.append('ajax', '1');
    upstreamBody.append('do', 'check');
    upstreamBody.append('cclist', payloadValue);
  } else {
    upstreamBody.append(payloadKey, payloadValue);
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
    
    return { status, message: data.msg?.replace(/<[^>]*>?/gm, '').trim() || 'No message', raw: data };
  } catch (e: any) {
    throw new Error(`Upstream API Failed: ${e.message}`);
  }
}

// --- Telegram Webhook Receiver ---
app.post('/webhook/telegram', async (c) => {
  const secretToken = c.req.header('X-Telegram-Bot-Api-Secret-Token');
  if (c.env.TELEGRAM_WEBHOOK_SECRET && secretToken !== c.env.TELEGRAM_WEBHOOK_SECRET) return c.text('Unauthorized', 403);

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

    // 1. Initial Start Command (Public)
    if (text.startsWith('/start')) {
      const authorized = await isAuthorized(c.env.KV, userId, c.env.ADMIN_TELEGRAM_ID);
      const authStatus = authorized ? "✅ Authorized" : "❌ Unauthorized";
      const remaining = authorized ? await getRemainingQuota(c.env.KV, userId, dailyLimit) : 0;
      
      const welcomeText = `🤖 <b>Advanced CC Checker</b>\n\n` +
        `🆔 Your ID: <code>${userId}</code>\n` +
        `🛡 Status: ${authStatus}\n` +
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
      await sendTelegramMessage(token, chatId, "⛔️ <b>Access Denied</b>\nYou are not authorized to use this bot.", messageId);
      return c.text('OK');
    }

    // 4. Stats Command
    if (text === '/me' || text === '/stats') {
      const remaining = await getRemainingQuota(c.env.KV, userId, dailyLimit);
      await sendTelegramMessage(token, chatId, `📊 <b>Your Stats</b>\n\nRemaining Quota: <b>${remaining}</b> / ${dailyLimit}\n<i>Resets daily at Midnight UTC.</i>`, messageId);
      return c.text('OK');
    }

    // 5. Checker Commands & Gate Selection
    const isApi1 = text.startsWith('/chk1 ');
    const isApi2 = text.startsWith('/chk2 ');

    if (isApi1 || isApi2) {
      // Parse multi-line payloads and count actual cards
      const rawPayload = text.replace(/^\/chk[12] /, '');
      const validCards = rawPayload.split('\n')
        .map(line => sanitizeInput(line))
        .filter(line => line.length >= 12); // Minimum length for a credit card string
      
      const cardCount = validCards.length;

      if (cardCount === 0) {
        await sendTelegramMessage(token, chatId, "❌ No valid cards found in your message. Format: `CC|MM|YY|CVV`", messageId);
        return c.text('OK');
      }

      // Check and Consume Quota
      const quota = await consumeQuota(c.env.KV, userId, cardCount, dailyLimit);
      
      if (!quota.allowed) {
        await sendTelegramMessage(token, chatId, `🛑 <b>Rate Limit Exceeded</b>\n\nYou tried to check ${cardCount} cards, but you only have ${quota.remaining} remaining for today.`, messageId);
        return c.text('OK');
      }

      const gateName = isApi1 ? "Gate 1" : "Gate 2";
      const joinedCards = validCards.join('\n'); // Rejoin for upstream payload
      
      await sendTelegramMessage(token, chatId, `⏳ <i>Checking ${cardCount} card(s) via ${gateName}...</i>`, messageId);

      // Async Edge Processing
      c.executionCtx.waitUntil((async () => {
        try {
          const result = isApi1 
            ? await checkApi(c.env.UPSTREAM_API1_URL, 'ajax', joinedCards, c.env.UPSTREAM_TIMEOUT_MS, 0)
            : await checkApi(c.env.UPSTREAM_API2_URL, 'data', joinedCards, c.env.UPSTREAM_TIMEOUT_MS, 1);
          
          const emoji = result.status === 'live' ? '✅' : result.status === 'dead' ? '❌' : '⚠️';
          const replyText = `<b>[${gateName}] Result:</b> ${emoji} ${result.status.toUpperCase()}\n\n` +
                            `<b>Cards:</b>\n<code>${joinedCards}</code>\n\n` +
                            `<b>Message:</b> ${result.message}\n` +
                            `<i>Remaining Quota: ${quota.remaining}</i>`;
          
          await sendTelegramMessage(token, chatId, replyText, messageId);
        } catch (error: any) {
          // If the upstream fails, we technically consumed their quota. In a robust system, we could refund it here via KV.put, but for abuse prevention, keeping it consumed is standard.
          await sendTelegramMessage(token, chatId, `⚠️ <b>Gateway Error:</b> ${error.message}`, messageId);
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
