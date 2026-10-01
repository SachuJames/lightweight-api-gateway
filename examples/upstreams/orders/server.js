/**
 * Example "orders" upstream service for the gateway demos.
 *
 * A tiny in-memory REST-ish API with no dependencies. Run with:
 *   node server.js            # listens on PORT env var, default 3002
 */
const http = require('http');

const PORT = Number(process.env.PORT ?? 3002);

const orders = new Map([
  ['1001', { id: '1001', userId: '1', items: [{ sku: 'BOOK-1', qty: 2 }], total: 499.0, status: 'shipped' }],
  ['1002', { id: '1002', userId: '2', items: [{ sku: 'PEN-3', qty: 5 }], total: 249.5, status: 'processing' }],
]);

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname === '/health' && req.method === 'GET') {
    return json(res, 200, { status: 'ok', service: 'orders' });
  }

  if (url.pathname === '/orders' && req.method === 'GET') {
    const userId = url.searchParams.get('userId');
    const all = [...orders.values()].filter((o) => !userId || o.userId === userId);
    return json(res, 200, { orders: all });
  }

  if (url.pathname === '/orders' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const id = String(1000 + orders.size + 1);
      const order = {
        id,
        userId: body.userId ?? '1',
        items: body.items ?? [],
        total: body.total ?? 0,
        status: 'processing',
      };
      orders.set(id, order);
      return json(res, 201, { order });
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
  }

  const match = /^\/orders\/([\w-]+)$/.exec(url.pathname);
  if (match && req.method === 'GET') {
    const order = orders.get(match[1]);
    return order ? json(res, 200, { order }) : json(res, 404, { error: 'order not found' });
  }

  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`orders service listening on :${PORT}`);
});
