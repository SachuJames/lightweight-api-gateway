/**
 * Example "users" upstream service for the gateway demos.
 *
 * A tiny in-memory REST-ish API with no dependencies. Run with:
 *   node server.js            # listens on PORT env var, default 3001
 */
const http = require('http');

const PORT = Number(process.env.PORT ?? 3001);

const users = new Map([
  ['1', { id: '1', name: 'Asha Nair', email: 'asha@example.com' }],
  ['2', { id: '2', name: 'Rahul Menon', email: 'rahul@example.com' }],
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
    return json(res, 200, { status: 'ok', service: 'users' });
  }

  if (url.pathname === '/users' && req.method === 'GET') {
    return json(res, 200, { users: [...users.values()] });
  }

  if (url.pathname === '/users' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const id = String(users.size + 1);
      const user = { id, name: body.name ?? 'Unnamed', email: body.email ?? '' };
      users.set(id, user);
      return json(res, 201, { user });
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
  }

  const match = /^\/users\/([\w-]+)$/.exec(url.pathname);
  if (match && req.method === 'GET') {
    const user = users.get(match[1]);
    return user ? json(res, 200, { user }) : json(res, 404, { error: 'user not found' });
  }

  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`users service listening on :${PORT}`);
});
