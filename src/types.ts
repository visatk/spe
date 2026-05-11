export interface Env {
  Bindings: {
    UPSTREAM_API1_URL: string;
    UPSTREAM_API2_URL: string;
    UPSTREAM_TIMEOUT_MS: string;
    TELEGRAM_BOT_TOKEN: string; // Added for the bot
    TELEGRAM_WEBHOOK_SECRET: string; // Added for security
  };
}

export interface CheckPayload {
  cclist: string;
  api?: '1' | '2';
}

export interface UpstreamResponse {
  status: 'live' | 'dead' | 'unknown';
  message: string;
  raw?: any;
}

// Telegram Webhook Typings
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from?: {
    id: number;
    is_bot: boolean;
    first_name: string;
    username?: string;
  };
  chat: {
    id: number;
    type: 'private' | 'group' | 'supergroup' | 'channel';
  };
  date: number;
  text?: string;
}
