'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');

process.env.APP_PASSWORD = 'correct horse battery';
process.env.ALLOW_MEMORY_STORE = '1';
delete process.env.SHEET_ID;
delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

const { createSheetsStore, createMemoryStore, parseCredentials, SESSION_HEADERS, SET_HEADERS } = require('../lib/store');
const { validateSession } = require('../lib/validate');
const { checkAuth } = require('../lib/auth');

const goodSession = (over = {}) => ({
  sessionId: 'sess-0001-abcd', date: '2026-10-12', workout: 'A',
  startedAt: '2026-10-12T04:30:00.000Z', finishedAt: '2026-10-12T05:45:00.000Z', week: 1,
  sets: [
    { exerciseId: 'leg-press', exercise: 'Leg press', setNo: 1, weightKg: 40, reps: 10, seconds: null, variant: '', pain: false },
    { exerciseId: 'leg-press', exercise: 'Leg press', setNo: 2, weightKg: 40, reps: 9, seconds: null, variant: '', pain: false },
    { exerciseId: 'plank', exercise: 'Plank', setNo: 1, weightKg: null, reps: null, seconds: 35, variant: '', pain: true },
  ],
  ...over,
});

// ---- A fake of the Google Sheets v4 REST API (just the endpoints the store uses) ----
function fakeSheets({ titles = ['Sheet1'], failOnce } = {}) {
  const tabs = {}; titles.forEach((t) => { tabs[t] = []; });
  const calls = [];
  const request = async ({ method, url, data }) => {
    calls.push(`${method} ${url.replace('https://sheets.googleapis.com/v4/spreadsheets/', '')}`);
    const u = new URL(url);
    const path = u.pathname.replace('/v4/spreadsheets/', '');
    if (method === 'GET' && !path.includes('/values/')) {
      return { data: { sheets: Object.keys(tabs).map((title) => ({ properties: { title } })) } };
    }
    if (method === 'POST' && path.endsWith(':batchUpdate')) {
      data.requests.forEach((r) => { tabs[r.addSheet.properties.title] = []; });
      return { data: {} };
    }
    const rest = decodeURIComponent(path.split('/values/')[1]);
    if (method === 'POST' && rest.endsWith(':append')) {
      assert.equal(u.searchParams.get('valueInputOption'), 'RAW');
      const tab = rest.split('!')[0];
      if (failOnce && failOnce(tab)) throw new Error('boom');
      assert.ok(tabs[tab], 'append to unknown tab ' + tab);
      data.values.forEach((r) => tabs[tab].push(r.map(String)));
      return { data: {} };
    }
    const [tab, a1] = rest.split('!');
    assert.ok(tabs[tab], 'unknown tab ' + tab);
    if (method === 'PUT') {
      assert.equal(u.searchParams.get('valueInputOption'), 'RAW');
      tabs[tab][0] = data.values[0].map(String);
      return { data: {} };
    }
    if (method === 'GET') {
      const start = Number(/^[A-Z]+(\d+)/.exec(a1)[1]);
      const end = /:[A-Z]+(\d+)$/.exec(a1);
      const rows = tabs[tab].slice(start - 1, end ? Number(end[1]) : undefined)
        .map((r) => { const c = r.slice(); while (c.length && c[c.length - 1] === '') c.pop(); return c; });
      return { data: rows.length ? { values: rows } : {} };
    }
    throw new Error('unhandled ' + method + ' ' + url);
  };
  return { request, tabs, calls };
}

test('sheets store: creates tabs + headers, saves, reads back typed values', async () => {
  const fake = fakeSheets();
  const store = createSheetsStore({ sheetId: 'SHEET123', request: fake.request });
  assert.deepEqual(await store.readAll(), { sessions: [], sets: [] });
  assert.deepEqual(fake.tabs.Sessions[0], SESSION_HEADERS);
  assert.deepEqual(fake.tabs.Sets[0], SET_HEADERS);

  assert.deepEqual(await store.appendSession(goodSession()), { duplicate: false });
  assert.equal(fake.tabs.Sets.length, 4);
  const all = await store.readAll();
  assert.equal(all.sessions.length, 1);
  assert.equal(all.sessions[0].week, 1);
  assert.equal(all.sets.length, 3);
  assert.equal(all.sets[0].weightKg, 40);
  assert.equal(all.sets[2].seconds, 35);
  assert.equal(all.sets[2].weightKg, null);
  assert.equal(all.sets[2].pain, true);
  assert.equal(all.sets[0].pain, false);
});

test('sheets store: duplicate session is skipped; setup only runs once', async () => {
  const fake = fakeSheets();
  const store = createSheetsStore({ sheetId: 'S', request: fake.request });
  await store.appendSession(goodSession());
  const rowsBefore = fake.tabs.Sets.length;
  assert.deepEqual(await store.appendSession(goodSession()), { duplicate: true });
  assert.equal(fake.tabs.Sets.length, rowsBefore);
  assert.equal(fake.calls.filter((c) => c.includes('batchUpdate')).length, 1);
});

test('sheets store: retry after a failed session-row write does not lose or double data', async () => {
  let failures = 1;
  const fake = fakeSheets({ failOnce: (tab) => tab === 'Sessions' && failures-- > 0 });
  const store = createSheetsStore({ sheetId: 'S', request: fake.request });
  await assert.rejects(() => store.appendSession(goodSession()), /boom/);
  assert.equal((await store.readAll()).sessions.length, 0); // not visible until the session row exists
  assert.deepEqual(await store.appendSession(goodSession()), { duplicate: false });
  const all = await store.readAll();
  assert.equal(all.sessions.length, 1);
  assert.equal(all.sets.length, 3); // duplicate set rows from the first attempt are collapsed
});

test('sheets store: works when tabs already exist', async () => {
  const fake = fakeSheets({ titles: ['Sessions', 'Sets'] });
  const store = createSheetsStore({ sheetId: 'S', request: fake.request });
  await store.readAll();
  assert.equal(fake.calls.filter((c) => c.includes('batchUpdate')).length, 0);
});

test('sheets store: setup failure is not cached', async () => {
  let n = 0;
  const fake = fakeSheets();
  const flaky = (o) => (n++ === 0 ? Promise.reject(new Error('The caller does not have permission')) : fake.request(o));
  const store = createSheetsStore({ sheetId: 'S', request: flaky });
  await assert.rejects(() => store.readAll(), /permission/);
  assert.deepEqual(await store.readAll(), { sessions: [], sets: [] });
});

test('validateSession accepts a good session and rejects bad ones', () => {
  assert.equal(validateSession(goodSession()).ok, true);
  const bad = [
    null, [], {},
    goodSession({ sessionId: 'short' }),
    goodSession({ sessionId: 'has spaces in it!!' }),
    goodSession({ date: '12/10/2026' }),
    goodSession({ date: '2026-13-45' }),
    goodSession({ workout: 'C' }),
    goodSession({ week: 0 }),
    goodSession({ startedAt: 'yesterday' }),
    goodSession({ sets: [] }),
    goodSession({ sets: Array(61).fill(goodSession().sets[0]) }),
    goodSession({ sets: [{ exerciseId: 'Leg Press', setNo: 1, reps: 5 }] }),
    goodSession({ sets: [{ exerciseId: 'leg-press', setNo: 1, weightKg: -5, reps: 5 }] }),
    goodSession({ sets: [{ exerciseId: 'leg-press', setNo: 1, weightKg: 20, reps: 5.5 }] }),
    goodSession({ sets: [{ exerciseId: 'leg-press', setNo: 1, weightKg: 20 }] }),
    goodSession({ sets: [{ exerciseId: 'leg-press', setNo: 0, reps: 5 }] }),
    goodSession({ sets: [{ exerciseId: 'leg-press', setNo: 1, weightKg: '20', reps: 5 }] }),
  ];
  bad.forEach((b, i) => assert.equal(validateSession(b).ok, false, 'case ' + i));
});

test('validateSession strips unknown fields and trims long strings', () => {
  const v = validateSession(goodSession({ evil: 'x', sets: [{ exerciseId: 'plank', exercise: ' '.repeat(3) + 'A'.repeat(200), setNo: 1, seconds: 30, extra: 1 }] }));
  assert.equal(v.ok, true);
  assert.equal(v.value.evil, undefined);
  assert.equal(v.value.sets[0].extra, undefined);
  assert.equal(v.value.sets[0].exercise.length, 80);
  assert.equal(v.value.sets[0].pain, false);
});

test('auth: correct, wrong, missing, unset', () => {
  assert.equal(checkAuth({ headers: { 'x-app-key': 'correct horse battery' } }).ok, true);
  assert.equal(checkAuth({ headers: { 'x-app-key': 'nope' } }).status, 401);
  assert.equal(checkAuth({ headers: {} }).status, 401);
  const saved = process.env.APP_PASSWORD; delete process.env.APP_PASSWORD;
  assert.equal(checkAuth({ headers: { 'x-app-key': '' } }).status, 500);
  process.env.APP_PASSWORD = saved;
});

test('credentials: raw JSON, base64 and escaped newlines all work with google-auth-library', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const creds = { client_email: 'bot@proj.iam.gserviceaccount.com', private_key: privateKey };
  const raw = JSON.stringify(creds);
  assert.equal(parseCredentials(raw).client_email, creds.client_email);
  assert.equal(parseCredentials(Buffer.from(raw).toString('base64')).private_key, privateKey);
  assert.throws(() => parseCredentials('{"client_email":"x"}'), /private_key/);

  const { JWT } = require('google-auth-library');
  const escaped = privateKey.replace(/\n/g, '\\n').replace(/\\n/g, '\n');
  const client = new JWT({ email: creds.client_email, key: escaped, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  assert.equal(typeof client.request, 'function');
});

test('API handlers over HTTP (dev server, memory store)', async () => {
  const { createServer } = require('../dev-server');
  const server = createServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const key = { 'x-app-key': 'correct horse battery' };
  const json = { 'content-type': 'application/json' };
  const post = (body, headers = key) => fetch(base + '/api/session', { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(base + '/api/data')).status, 401);
    assert.equal((await fetch(base + '/api/data', { headers: { 'x-app-key': 'wrong' } })).status, 401);
    assert.equal((await post(goodSession(), {})).status, 401);
    assert.equal((await fetch(base + '/api/session', { headers: key })).status, 405);

    const bad = await post({ nope: true });
    assert.equal(bad.status, 400);

    const ok = await post(goodSession());
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, duplicate: false });
    assert.deepEqual(await (await post(goodSession())).json(), { ok: true, duplicate: true });

    const data = await (await fetch(base + '/api/data', { headers: key })).json();
    assert.equal(data.sessions.length, 1);
    assert.equal(data.sets.length, 3);

    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.equal((await fetch(base + '/..%2fpackage.json')).status >= 400, true);
    assert.equal((await fetch(base + '/%2e%2e/package.json')).status >= 400, true);
  } finally {
    server.close();
  }
});
