
import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

app.use('/*', cors({
  origin: '*', 
  allowMethods: ['POST', 'GET', 'OPTIONS'],
}));

// In-memory cache for the session ID. 
let cachedSessionId: string | null = null;

// Function to authenticate and get a new PHPSESSID
async function getFreshSessionId(): Promise<string> {
  const loginBody = new URLSearchParams();
  loginBody.append('mail', 'PAYATE');
  loginBody.append('pass', 'PAYATE');
  loginBody.append('do', 'login');
  loginBody.append('key', '14A9T3MMTTNAR0MA');

  const response = await fetch("https://sandbox.payate.com/account/login.php", {
    method: "POST",
    headers: {
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "content-type": "application/x-www-form-urlencoded",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "same-origin",
      "Referer": "https://sandbox.payate.com/account/"
    },
    body: loginBody.toString(),
    redirect: "manual" // Prevent auto-following redirects so we can grab the cookie
  });

  // Extract the Set-Cookie header
  const setCookieHeader = response.headers.get('set-cookie');
  if (setCookieHeader) {
    const match = setCookieHeader.match(/PHPSESSID=([^;]+)/);
    if (match && match[1]) {
      return match[1];
    }
  }
  
  throw new Error("Failed to extract PHPSESSID from login response");
}

app.post('/api/auth/reset', async (c) => {
    try {
        cachedSessionId = await getFreshSessionId();
        return c.json({ status: 'success', message: 'Session reset successfully' });
    } catch (e: any) {
        return c.json({ status: 'error', message: e.message }, 500);
    }
});

app.post('/api/check', async (c) => {
  try {
    const body = await c.req.json();
    const cclist = body.cclist;

    if (!cclist) {
      return c.json({ status: 'unknown', message: 'Missing cclist parameter' }, 400);
    }

    if (!cachedSessionId) {
      cachedSessionId = await getFreshSessionId();
    }

    const checkCard = async (sessionId: string) => {
      const upstreamBody = new URLSearchParams();
      upstreamBody.append('ajax', '1');
      upstreamBody.append('do', 'check');
      upstreamBody.append('cclist', cclist);

      return await fetch("https://sandbox.payate.com/ccn1/alien07.php", {
        method: "POST",
        headers: {
          "accept": "application/json, text/javascript, */*; q=0.01",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "sec-fetch-mode": "cors",
          "x-requested-with": "XMLHttpRequest",
          "cookie": `PHPSESSID=${sessionId}`,
          "Referer": "https://sandbox.payate.com/ccn1/"
        },
        body: upstreamBody.toString()
      });
    };

    let response = await checkCard(cachedSessionId);
    let rawText = await response.text();

    // Self-Healing Logic: If the session died, grab a new one and retry.
    if (rawText.includes('<html') || response.status === 401 || response.status === 403 || rawText.trim() === '') {
      cachedSessionId = await getFreshSessionId();
      response = await checkCard(cachedSessionId);
      rawText = await response.text();
    }

    let data;
    try {
        data = JSON.parse(rawText);
    } catch (e) {
         return c.json({ 
            status: 'unknown', 
            message: 'Upstream returned invalid JSON (Session may be heavily rate limited)',
            raw: rawText.substring(0, 200)
         });
    }
    
    let status = 'unknown';
    if (data.error === 0) status = 'live';
    else if (data.error === 2) status = 'dead';
    else if (data.error === -1) status = 'unknown';
    
    const cleanMsg = data.msg ? data.msg.replace(/<[^>]*>?/gm, '').trim() : '';

    return c.json({
      status: status,
      cardData: cclist,
      message: cleanMsg,
      raw: data
    });

  } catch (error: any) {
    return c.json({ status: 'unknown', message: error.message }, 500);
  }
});

export default app;
