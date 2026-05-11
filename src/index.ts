import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { DurableObject } from 'cloudflare:workers';
import { Env, UpstreamResponse, TelegramUpdate, IMyDurableObject } from './types';

// --- Core Utilities ---
const sanitizeInput = (input: string): string => input.replace(/[^\d\|]/g, '').trim();
const escapeHTML = (str: string): string => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function sendTelegramMessage(token: string, chatId: number, text: string, replyToMessageId?: number) {
  const payload: any = { chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function sendChunkedTelegramMessage(token: string, chatId: number, text: string, messageId?: number) {
  const MAX_LENGTH = 4000;
  if (text.length <= MAX_LENGTH) return await sendTelegramMessage(token, chatId, text, messageId);

  const lines = text.split('\n');
  let currentChunk = '';
  for (const line of lines) {
    if (currentChunk.length + line.length + 1 > MAX_LENGTH) {
      await sendTelegramMessage(token, chatId, currentChunk.trim(), messageId);
      currentChunk = '';
      await sleep(300); 
    }
    currentChunk += line + '\n';
  }
  if (currentChunk.trim().length > 0) await sendTelegramMessage(token, chatId, currentChunk.trim(), messageId);
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

// ==========================================
// DURABLE OBJECT: Stateful Processing Engine
// ==========================================
export class MyDurableObject extends DurableObject implements IMyDurableObject {
  constructor(ctx: DurableObjectState, env: Env['Bindings']) {
    super(ctx, env);
  }

  // Transactionally reads current quota
  async getRemainingQuota(limit: number): Promise<number> {
    const dateStr = new Date().toISOString().split('T')[0];
    const usage = await this.ctx.storage.get<number>(`usage:${dateStr}`) || 0;
    return Math.max(0, limit - usage);
  }

  // Strongly consistent transactional quota consumption + Auto Cleanup
  async consumeQuota(cardsToProcess: number, limit: number): Promise<{ allowed: boolean; remaining: number }> {
    const dateStr = new Date().toISOString().split('T')[0];
    const key = `usage:${dateStr}`;
    
    let currentUsage = await this.ctx.storage.get<number>(key) || 0;

    if (currentUsage + cardsToProcess > limit) {
      return { allowed: false, remaining: Math.max(0, limit - currentUsage) };
    }

    currentUsage += cardsToProcess;
    await this.ctx.storage.put(key, currentUsage);

    // Maintenance: Delete yesterday's keys to keep the SQLite instance optimized
    const yesterdayStr = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    await this.ctx.storage.delete(`usage:${yesterdayStr}`);

    return { allowed: true, remaining: limit - currentUsage };
  }

  // Background Processing Queue
  async processCardsBatch(validCards: string[], gateName: string, isApi1: boolean, chatId: number, messageId: number, token: string, remainingQuota: number): Promise<void> {
    // waitUntil ensures the DO completes this task even if the external worker request drops
    this.ctx.waitUntil((async () => {
      try {
        const results: string[] = [];
        const BATCH_SIZE = 5; 
        
        for (let i = 0; i < validCards.length; i += BATCH_SIZE) {
          const batch = validCards.slice(i, i + BATCH_SIZE);
          
          const batchPromises = batch.map(card => 
            isApi1 
              ? checkSingleCard(this.env.UPSTREAM_API1_URL, 'ajax', card, this.env.UPSTREAM_TIMEOUT_MS, 0)
              : checkSingleCard(this.env.UPSTREAM_API2_URL, 'data', card, this.env.UPSTREAM_TIMEOUT_MS, 1)
          );
          
          const batchResults = await Promise.all(batchPromises);
          
          for (const result of batchResults) {
             const emoji = result.status === 'live' ? '✅' : result.status === 'dead' ? '❌' : '⚠️';
             results.push(`${emoji} <code>${result.card}</code> - ${result.message}`);
          }
          
          if (i + BATCH_SIZE < validCards.length) await sleep(800);
        }

        const aggregatedMessage = `<b>[${gateName}] Final Report:</b>\n\n${results.join('\n')}\n\n<i>Quota Remaining: ${remainingQuota}</i>`;
        await sendChunkedTelegramMessage(token, chatId, aggregatedMessage, messageId);

      } catch (error: any) {
        await sendTelegramMessage(token, chatId, `⚠️ <b>DO System Error:</b> ${escapeHTML(error.message)}`, messageId);
      }
    })());
  }
}

// ==========================================
// EDGE WORKER: Webhook Router 
// ==========================================
const app = new Hono<Env>();
app.use('/*', cors({ origin: '*', allowMethods: ['POST', 'GET'], maxAge: 86400 }));

const KV_USER_PREFIX = 'user:';
async function isAuthorized(kv: KVNamespace, userId: number, adminId: string): Promise<boolean> {
  if (userId.toString() === adminId) return true;
  return (await kv.get(`${KV_USER_PREFIX}${userId}`)) !== null;
}

app.get('/webhook/setup', async (c) => {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET } = c.env;
  if (!TELEGRAM_BOT_TOKEN) return c.text("Error: Missing token", 500);
  const webhookUrl = new URL(c.req.url).origin + '/webhook/telegram';
  const req = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${webhookUrl}&secret_token=${TELEGRAM_WEBHOOK_SECRET || 'fallback'}`);
  return c.json(await req.json());
});

app.post('/webhook/telegram', async (c) => {
  const secretToken = c.req.header('X-Telegram-Bot-Api-Secret-Token');
  if (c.env.TELEGRAM_WEBHOOK_SECRET && secretToken !== c.env.TELEGRAM_WEBHOOK_SECRET) return c.text('Unauthorized', 403);

  try {
    const update = await c.req.json<TelegramUpdate>();
    if (!update.message?.text || !update.message.from) return c.text('OK');

    const { id: chatId } = update.message.chat;
    const { id: userId } = update.message.from;
    const messageId = update.message.message_id;
    const text = update.message.text.trim();
    const token = c.env.TELEGRAM_BOT_TOKEN;
    const isAdmin = userId.toString() === c.env.ADMIN_TELEGRAM_ID;
    const dailyLimit = parseInt(c.env.DAILY_CARD_LIMIT) || 100;

    if (isAdmin && text.startsWith('/add ')) {
      const targetId = text.split(' ')[1];
      if (targetId) await c.env.KV.put(`${KV_USER_PREFIX}${targetId}`, "1");
      await sendTelegramMessage(token, chatId, `✅ Authorized user <code>${targetId}</code>.`, messageId);
      return c.text('OK');
    }

    if (isAdmin && text.startsWith('/remove ')) {
      const targetId = text.split(' ')[1];
      if (targetId) await c.env.KV.delete(`${KV_USER_PREFIX}${targetId}`);
      await sendTelegramMessage(token, chatId, `🗑 Revoked user <code>${targetId}</code>.`, messageId);
      return c.text('OK');
    }

    if (!(await isAuthorized(c.env.KV, userId, c.env.ADMIN_TELEGRAM_ID))) {
      await sendTelegramMessage(token, chatId, "⛔️ <b>Access Denied</b>", messageId);
      return c.text('OK');
    }

    // Connect to the specific User's Durable Object (Native RPC Setup)
    const doId = c.env.MY_DURABLE_OBJECT.idFromName(userId.toString());
    const userDO = c.env.MY_DURABLE_OBJECT.get(doId) as unknown as IMyDurableObject;

    if (text.startsWith('/start') || text === '/me' || text === '/stats') {
      const remaining = await userDO.getRemainingQuota(dailyLimit);
      const resText = `📊 <b>System Dashboard</b>\n\n🆔 User ID: <code>${userId}</code>\n💳 Quota Remaining: <b>${remaining}</b> / ${dailyLimit}\n\n<i>Resets daily at 00:00 UTC.</i>`;
      await sendTelegramMessage(token, chatId, resText, messageId);
      return c.text('OK');
    }

    const isApi1 = text.startsWith('/chk1 ');
    const isApi2 = text.startsWith('/chk2 ');

    if (isApi1 || isApi2) {
      const validCards = text.replace(/^\/chk[12] /, '').split('\n').map(sanitizeInput).filter(l => l.length >= 12); 
      if (validCards.length === 0) return c.text('OK');

      const quota = await userDO.consumeQuota(validCards.length, dailyLimit);
      
      if (!quota.allowed) {
        await sendTelegramMessage(token, chatId, `🛑 <b>Rate Limit Exceeded</b>\nRequested: ${validCards.length}\nRemaining: ${quota.remaining}`, messageId);
        return c.text('OK');
      }

      const gateName = isApi1 ? "Gate 1" : "Gate 2";
      await sendTelegramMessage(token, chatId, `⏳ <i>Dispatched ${validCards.length} cards to the Edge Queue (${gateName})...</i>`, messageId);

      // Trigger the background RPC process on the DO. We do NOT await this.
      userDO.processCardsBatch(validCards, gateName, isApi1, chatId, messageId, token, quota.remaining);
    }

    return c.text('OK');
  } catch (error) {
    console.error("Webhook Error:", error);
    return c.text('OK'); 
  }
});

export default app;
