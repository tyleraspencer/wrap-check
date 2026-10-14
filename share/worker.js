// Wrap Check share service: a blind store for ENCRYPTED wrap files.
//
//   POST /        body = ciphertext (application/octet-stream, <= MAX_BYTES)  ->  { "id": "..." }
//   GET  /<id>    -> the same ciphertext bytes
//
// The browser encrypts before uploading and keeps the key in the link's #fragment, which is never sent anywhere,
// so this service only ever holds unreadable bytes. Entries expire on their own.

const MAX_BYTES = 1_300_000;          // a 1 MB wrap plus encryption overhead
const TTL_SECONDS = 90 * 24 * 3600;   // 90 days

const cors = (req, env) => {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin);
  return { ok, headers: ok ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } : { 'Vary': 'Origin' } };
};
const json = (obj, status, headers) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const newId = () => { const b = crypto.getRandomValues(new Uint8Array(9)); return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_'); };   // 12 url-safe chars

export default {
  async fetch(req, env) {
    const { ok, headers } = cors(req, env);
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: ok ? 204 : 403, headers });

    if (req.method === 'POST' && url.pathname === '/') {
      if (!ok) return json({ error: 'origin not allowed' }, 403, headers);
      const declared = +req.headers.get('Content-Length') || 0;
      if (!declared) return json({ error: 'length required' }, 411, headers);
      if (declared > MAX_BYTES) return json({ error: 'too large' }, 413, headers);
      const body = await req.arrayBuffer();
      if (body.byteLength < 29 || body.byteLength > MAX_BYTES) return json({ error: 'bad size' }, 400, headers);
      const id = newId();
      await env.SHARES.put(id, body, { expirationTtl: TTL_SECONDS });
      return json({ id, expiresInDays: TTL_SECONDS / 86400 }, 201, headers);
    }

    if (req.method === 'GET' && /^\/[A-Za-z0-9_-]{12}$/.test(url.pathname)) {
      const value = await env.SHARES.get(url.pathname.slice(1), 'arrayBuffer');
      if (!value) return json({ error: 'not found or expired' }, 404, headers);
      return new Response(value, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=3600', ...headers } });
    }

    if (req.method === 'GET' && url.pathname === '/') return json({ service: 'wrap-check-share', ok: true }, 200, headers);
    return json({ error: 'not found' }, 404, headers);
  },
};
