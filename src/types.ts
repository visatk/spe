export interface Env {
  Bindings: {
    UPSTREAM_API1_URL: string;
    UPSTREAM_API2_URL: string;
    UPSTREAM_TIMEOUT_MS: string;
    TELEGRAM_BOT_TOKEN: string;
    TELEGRAM_WEBHOOK_SECRET: string;
    ADMIN_TELEGRAM_ID: string;
    DAILY_CARD_LIMIT: string;
    KV: KVNamespace;
    MY_DURABLE_OBJECT: DurableObjectNamespace;
  };
}

export interface CheckPayload {
  cclist: string;
  api?: '1' | '2';
}

export interface UpstreamResponse {
  card: string;
  status: 'live' | 'dead' | 'unknown';
  message: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from?: { id: number; is_bot: boolean; first_name: string; username?: string; };
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; };
  date: number;
  text?: string;
}

// DO RPC Interface for strict TypeScript support
export interface IMyDurableObject {
  getRemainingQuota(limit: number): Promise<number>;
  consumeQuota(cardsToProcess: number, limit: number): Promise<{ allowed: boolean; remaining: number }>;
  processCardsBatch(validCards: string[], gateName: string, isApi1: boolean, chatId: number, messageId: number, token: string, remainingQuota: number): Promise<void>;
}
