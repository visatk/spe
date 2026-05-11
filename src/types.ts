export interface Env {
  Bindings: {
    UPSTREAM_API1_URL: string;
    UPSTREAM_API2_URL: string;
    UPSTREAM_TIMEOUT_MS: string;
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
