/**
 * Example "slow" upstream service for the gateway demos.
 *
 * Delays every response by `?delay=` milliseconds so you can exercise the
 * gateway's per-route timeout (the seeded /api/slow/* route uses 5000ms).
 * Try:  GET /api/slow/anything?delay=2000   -> responds after ~2s
 *       GET /api/slow/anything?delay=8000   -> gateway times out first (504)
 *
 * No dependencies. Run with:
 *   node server.js            # listens on PORT env var, default 3003
 */
const http = require('http');

const PORT = Number(process.env.PORT ?? 3003);
const MAX_DELAY_MS = 30_000;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname === '/health' && req.method === 'GET') {
    return json(res, 200, { status: 'ok', service: 'slow' });
  }

  const delay = Math.min(Number(url.searchParams.get('delay') ?? 0) || 0, MAX_DELAY_MS);
  setTimeout(() => {
    json(res, 200, { service: 'slow', path: url.pathname, delayedMs: delay });
  }, delay);
});

server.listen(PORT, () => {
  console.log(`slow service listening on :${PORT}`);
});
