'use strict';
// Storage layer. Two tabs in one Google Sheet:
//   Sessions: one row per finished workout
//   Sets:     one row per logged set
// A memory store with the same interface is used for local dev and tests.

const SESSIONS_TAB = 'Sessions';
const SETS_TAB = 'Sets';
const SESSION_HEADERS = ['sessionId', 'date', 'workout', 'startedAt', 'finishedAt', 'week'];
const SET_HEADERS = [
  'sessionId', 'date', 'workout', 'exerciseId', 'exercise',
  'setNo', 'weightKg', 'reps', 'seconds', 'variant', 'pain',
];
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const str = (v) => (v == null ? '' : String(v));

const sessionRow = (s) => [s.sessionId, s.date, s.workout, s.startedAt, s.finishedAt, s.week];
const setRows = (s) =>
  s.sets.map((x) => [
    s.sessionId, s.date, s.workout, x.exerciseId, x.exercise || '', x.setNo,
    x.weightKg == null ? '' : x.weightKg,
    x.reps == null ? '' : x.reps,
    x.seconds == null ? '' : x.seconds,
    x.variant || '',
    x.pain ? 'TRUE' : '',
  ]);

const parseSession = (r) => ({
  sessionId: str(r[0]), date: str(r[1]), workout: str(r[2]),
  startedAt: str(r[3]), finishedAt: str(r[4]), week: num(r[5]),
});
const parseSet = (r) => ({
  sessionId: str(r[0]), exerciseId: str(r[3]), setNo: num(r[5]),
  weightKg: num(r[6]), reps: num(r[7]), seconds: num(r[8]),
  variant: str(r[9]), pain: str(r[10]).toUpperCase() === 'TRUE',
});

// Sets are written before the session row, so a half-failed save can be retried safely.
// A retry may duplicate set rows; they are collapsed here when reading.
function dedupe(sessions, sets) {
  const seenSessions = new Set();
  const outSessions = sessions.filter((s) => {
    if (!s.sessionId || seenSessions.has(s.sessionId)) return false;
    seenSessions.add(s.sessionId);
    return true;
  });
  const seenSets = new Set();
  const outSets = sets.filter((s) => {
    const k = `${s.sessionId}|${s.exerciseId}|${s.setNo}`;
    if (!seenSessions.has(s.sessionId) || seenSets.has(k)) return false;
    seenSets.add(k);
    return true;
  });
  return { sessions: outSessions, sets: outSets };
}

function createMemoryStore() {
  const sessionRows = [];
  const setRowsAll = [];
  return {
    async readAll() {
      return dedupe(sessionRows.map(parseSession), setRowsAll.map(parseSet));
    },
    async appendSession(s) {
      if (sessionRows.some((r) => r[0] === s.sessionId)) return { duplicate: true };
      setRows(s).forEach((r) => setRowsAll.push(r));
      sessionRows.push(sessionRow(s));
      return { duplicate: false };
    },
  };
}

// `request` is google-auth-library's client.request (or a fake in tests):
// request({ method, url, data }) -> Promise<{ data }>
function createSheetsStore({ sheetId, request }) {
  const base = `${API}/${encodeURIComponent(sheetId)}`;
  const rng = (r) => encodeURIComponent(r);
  let ready = null;

  async function ensure() {
    const meta = await request({ method: 'GET', url: `${base}?fields=sheets.properties.title` });
    const have = new Set(((meta.data && meta.data.sheets) || []).map((s) => s.properties.title));
    const missing = [SESSIONS_TAB, SETS_TAB].filter((t) => !have.has(t));
    if (missing.length) {
      await request({
        method: 'POST',
        url: `${base}:batchUpdate`,
        data: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) },
      });
    }
    for (const [tab, headers] of [[SESSIONS_TAB, SESSION_HEADERS], [SETS_TAB, SET_HEADERS]]) {
      const r = await request({ method: 'GET', url: `${base}/values/${rng(`${tab}!A1:A1`)}` });
      if (!r.data || !r.data.values || !r.data.values.length) {
        await request({
          method: 'PUT',
          url: `${base}/values/${rng(`${tab}!A1`)}?valueInputOption=RAW`,
          data: { values: [headers] },
        });
      }
    }
  }
  const init = () => {
    if (!ready) ready = ensure().catch((e) => { ready = null; throw e; });
    return ready;
  };

  const read = async (range) => {
    const r = await request({ method: 'GET', url: `${base}/values/${rng(range)}` });
    return (r.data && r.data.values) || [];
  };
  const append = (tab, values) =>
    request({
      method: 'POST',
      url: `${base}/values/${rng(`${tab}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      data: { values },
    });

  return {
    async readAll() {
      await init();
      const [sessionVals, setVals] = await Promise.all([
        read(`${SESSIONS_TAB}!A2:F`),
        read(`${SETS_TAB}!A2:K`),
      ]);
      return dedupe(sessionVals.map(parseSession), setVals.map(parseSet));
    },
    async appendSession(s) {
      await init();
      const ids = await read(`${SESSIONS_TAB}!A2:A`);
      if (ids.some((r) => r[0] === s.sessionId)) return { duplicate: true };
      await append(SETS_TAB, setRows(s));
      await append(SESSIONS_TAB, [sessionRow(s)]);
      return { duplicate: false };
    },
  };
}

function parseCredentials(raw) {
  const text = String(raw).trim();
  const json = text.startsWith('{') ? text : Buffer.from(text, 'base64').toString('utf8');
  const creds = JSON.parse(json);
  if (!creds.client_email || !creds.private_key) {
    throw new Error('Service account JSON needs client_email and private_key');
  }
  return creds;
}

function defaultRequest(creds) {
  const { JWT } = require('google-auth-library');
  const client = new JWT({
    email: creds.client_email,
    key: creds.private_key.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return (opts) => client.request(opts);
}

let cached = null;
function getStore() {
  if (cached) return cached;
  const sheetId = process.env.SHEET_ID;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (sheetId && raw) {
    cached = createSheetsStore({ sheetId, request: defaultRequest(parseCredentials(raw)) });
  } else if (process.env.ALLOW_MEMORY_STORE === '1') {
    cached = createMemoryStore();
  } else {
    throw new Error('Storage is not configured: set SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON');
  }
  return cached;
}

module.exports = {
  getStore, createMemoryStore, createSheetsStore, parseCredentials,
  SESSION_HEADERS, SET_HEADERS,
};
