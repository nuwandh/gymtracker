'use strict';
const { checkAuth } = require('../lib/auth');
const { getStore } = require('../lib/store');
const { validateSession } = require('../lib/validate');

// POST /api/session  body: one finished workout with its sets.
// Safe to retry: a sessionId that is already stored is reported as duplicate, not written twice.
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = checkAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  const v = validateSession(body);
  if (!v.ok) return res.status(400).json({ error: v.error });

  try {
    const r = await getStore().appendSession(v.value);
    return res.status(200).json({ ok: true, duplicate: r.duplicate });
  } catch (e) {
    console.error('session error:', e);
    return res.status(502).json({ error: 'Storage error: ' + String(e.message || e).slice(0, 200) });
  }
};
