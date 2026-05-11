import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

app.use('/*', cors({
  origin: '*', 
  allowMethods: ['POST', 'GET', 'OPTIONS'],
}));

// API 1: Wallet Payate (alien07)
async function checkApi1(cclist: string) {
  const upstreamBody = new URLSearchParams();
  upstreamBody.append('ajax', '1');
  upstreamBody.append('do', 'check');
  upstreamBody.append('cclist', cclist);

  try {
    const response = await fetch("https://wallet.payate.com/card/ccn1/alien07.php", {
      method: "POST",
      headers: {
        "accept": "application/json, text/javascript, */*; q=0.01",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "sec-fetch-mode": "cors",
        "x-requested-with": "XMLHttpRequest",
        "Referer": "https://wallet.payate.com/card/ccn1/"
      },
      body: upstreamBody.toString()
    });
    
    const text = await response.text();
    const data = JSON.parse(text);
    
    let status = 'unknown';
    if (data.error === 0) status = 'live';
    else if (data.error === 2) status = 'dead';
    else if (data.error === -1) status = 'unknown';
    
    return {
      status,
      message: data.msg ? data.msg.replace(/<[^>]*>?/gm, '').trim() : 'No message',
      raw: data
    };
  } catch (e) {
    throw new Error('API 1 Failed');
  }
}

// API 2: Mock Payate
async function checkApi2(cclist: string) {
  const upstreamBody = new URLSearchParams();
  upstreamBody.append('data', cclist);

  try {
    const response = await fetch("https://mock.payate.com/api.php", {
      method: "POST",
      headers: {
        "accept": "*/*",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "sec-fetch-mode": "cors",
        "x-requested-with": "XMLHttpRequest",
        "Referer": "https://mock.payate.com/"
      },
      body: upstreamBody.toString()
    });
    
    const text = await response.text();
    const data = JSON.parse(text);
    
    let status = 'unknown';
    // Error mapping based on the mock.payate documentation
    if (data.error === 1) status = 'live';
    else if (data.error === 2) status = 'dead';
    else if (data.error === 3) status = 'unknown';
    
    return {
      status,
      message: data.msg ? data.msg.replace(/<[^>]*>?/gm, '').trim() : 'No message',
      raw: data
    };
  } catch (e) {
    throw new Error('API 2 Failed');
  }
}

app.post('/api/check', async (c) => {
  try {
    const body = await c.req.json();
    const cclist = body.cclist;
    const apiChoice = body.api || '1'; // Default to API 1

    if (!cclist) {
      return c.json({ status: 'unknown', message: 'Missing cclist parameter' }, 400);
    }

    let result;
    if (apiChoice === '1') {
      result = await checkApi1(cclist);
    } else if (apiChoice === '2') {
      result = await checkApi2(cclist);
    } else {
       return c.json({ status: 'unknown', message: 'Invalid API choice' }, 400);
    }

    return c.json({
      status: result.status,
      cardData: cclist,
      message: result.message,
      apiUsed: apiChoice,
      raw: result.raw
    });

  } catch (error: any) {
    return c.json({ status: 'unknown', message: error.message }, 500);
  }
});

export default app;
