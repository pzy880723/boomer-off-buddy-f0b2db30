import http from 'node:http';

function loopbackOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Upstream must be a loopback HTTP origin');
  }
  return url;
}

export function createReviewGateway({ productionOrigin, reviewOrigin, reviewEmail, bootstrapLimit = 65536 }) {
  const production = loopbackOrigin(productionOrigin);
  const demo = loopbackOrigin(reviewOrigin);
  if (production.href === demo.href || !reviewEmail?.includes('@')) {
    throw new Error('Separate demo upstream and login are required');
  }
  const email = reviewEmail.trim().toLowerCase();
  return http.createServer(async (req, res) => {
    const reply = (status, error) => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error }));
    };
    let target = production;
    let bootstrap;
    const path = new URL(req.url, production).pathname;
    if (path.startsWith('/api/public/') && String(req.headers['x-device-token'] ?? '').startsWith('rvw_')) {
      target = demo;
    }
    if (req.method === 'POST' && path === '/api/public/handheld/auth/bootstrap') {
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > bootstrapLimit) { reply(413, 'Login request too large'); return; }
          chunks.push(chunk);
        }
        bootstrap = Buffer.concat(chunks);
        const payload = JSON.parse(bootstrap.toString('utf8'));
        target = typeof payload.email === 'string' && payload.email.trim().toLowerCase() === email ? demo : production;
      } catch { reply(400, 'Invalid login request'); return; }
    }
    // A prefix is a routing hint, never authorization. Each backend validates
    // both its own device credential and its own independently signed session.
    const headers = { ...req.headers, host: target.host };
    delete headers.connection;
    delete headers['proxy-authorization'];
    const upstream = http.request({ hostname: target.hostname, port: target.port,
      path: req.url, method: req.method, headers }, response => {
      const responseHeaders = { ...response.headers, 'cache-control': 'no-store' };
      delete responseHeaders.connection;
      res.writeHead(response.statusCode ?? 502, responseHeaders);
      response.pipe(res);
      response.on('error', () => res.destroy());
    });
    upstream.setTimeout(300000, () => upstream.destroy(new Error('Upstream timeout')));
    upstream.on('error', () => reply(502, 'ERP temporarily unavailable'));
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    if (bootstrap) upstream.end(bootstrap);
    else req.pipe(upstream);
  });
}
