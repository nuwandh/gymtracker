'use strict';
const { checkAuth } = require('../lib/auth');
const { getStore } = require('../lib/store');

// GET /api/data -> { sessions: [...], sets: [...] }  (the whole history; it stays small)
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = checkAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  try {
    const data = await getStore().readAll();
    return res.status(200).json(data);
  } catch (e) {
    console.error('data error:', e);
    return res.status(502).json({ error: 'Storage error: ' + String(e.message || e).slice(0, 200) });
  }
};
