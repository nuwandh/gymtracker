'use strict';
const crypto = require('crypto');

// Single-user app: one shared secret (APP_PASSWORD) sent in the x-app-key header.
// Both values are hashed first so timingSafeEqual always compares equal-length buffers.
function checkAuth(req) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) {
    return { ok: false, status: 500, error: 'APP_PASSWORD is not set on the server' };
  }
  const given = String(req.headers['x-app-key'] || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: 'Wrong key' };
  }
  return { ok: true };
}

module.exports = { checkAuth };
