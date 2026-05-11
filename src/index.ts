import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env, CheckPayload, UpstreamResponse } from './types';

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

// Main Route
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

    // Asynchronous logging example: Does not block the HTTP response
    c.executionCtx.waitUntil(
      (async () => {
        // e.g., await logToAnalytics(apiChoice, result.status);
        console.log(`Processed request via API ${apiChoice} - Result: ${result.status}`);
      })()
    );

    return c.json({
      status: result.status,
      cardData: sanitizedCcList, // Return sanitized version
      message: result.message,
      apiUsed: apiChoice,
      raw: result.raw
    });

  } catch (error: any) {
    // Prevent leaking internal stack traces to the client
    const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
    return c.json({ status: 'error', message: errorMessage }, 500);
  }
});

export default app;
