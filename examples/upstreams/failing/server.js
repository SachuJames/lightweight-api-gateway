/**
 * Example "failing" upstream service for the gateway demos.
 *
 * Returns HTTP 500 for everything except /health so you can watch the
 * gateway's circuit breaker open, reject fast while open, and recover.
 * The seeded /api/failing/* route has a circuit breaker policy attached.
 *
 * No dependencies. Run with:
 *   node server.js            # listens on PORT env var, default 3004
 */
const http = require('http');

const PORT = Number(process.env.PORT ?? 3004);

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname === '/health' && req.method === 'GET') {
    return json(res, 200, { status: 'ok', service: 'failing' });
  }

  // Simulate a broken upstream: every real request fails.
  json(res, 500, { error: 'upstream exploded (this is intentional)' });
});

server.listen(PORT, () => {
  console.log(`failing service listening on :${PORT}`);
});
