'use strict';
// Tiny local server: serves public/ and routes /api/* to the same handlers Vercel runs.
// Uses an in-memory store, so data resets on restart. Run: npm run dev
process.env.ALLOW_MEMORY_STORE = process.env.ALLOW_MEMORY_STORE || '1';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'dev-password';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, 'public');
const ROUTES = { data: require('./api/data'), session: require('./api/session') };
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
};

function createServer() {
  return http.createServer((req, res) => {
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); return res; };

    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const handler = ROUTES[url.pathname.slice(5)];
      if (!handler) return res.status(404).json({ error: 'Not found' });
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw && /json/.test(req.headers['content-type'] || '')) {
          try { req.body = JSON.parse(raw); } catch (e) { req.body = raw; }
        } else req.body = raw || undefined;
        Promise.resolve(handler(req, res)).catch((e) => res.status(500).json({ error: String(e.message) }));
      });
      return undefined;
    }

    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.join(PUBLIC, rel);
    if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) { res.statusCode = 403; return res.end('Forbidden'); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.statusCode = 404; return res.end('Not found'); }
      res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
      return res.end(buf);
    });
    return undefined;
  });
}

module.exports = { createServer };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => {
    console.log(`Gym tracker dev server: http://localhost:${port}  (key: ${process.env.APP_PASSWORD})`);
  });
}
