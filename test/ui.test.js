'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

process.env.APP_PASSWORD = 'gym-secret-123';
process.env.ALLOW_MEMORY_STORE = '1';
const { createServer } = require('../dev-server');

const KEY = 'gym-secret-123';
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function openApp(base, storage = {}) {
  const dom = await JSDOM.fromURL(base + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = (u, o) => w.__fetch(new URL(u, base), o);
      w.__fetch = (u, o) => fetch(u, o);
      w.confirm = () => true;
      w.scrollTo = () => {};
      Object.entries(storage).forEach(([k, v]) => w.localStorage.setItem(k, v));
    },
  });
  await new Promise((r) => dom.window.addEventListener('load', r));
  await tick(80);
  return dom;
}

const q = (w, s) => w.document.querySelector(s);
const qa = (w, s) => [...w.document.querySelectorAll(s)];
const text = (w, s) => (q(w, s) ? q(w, s).textContent.replace(/\s+/g, ' ').trim() : null);
const click = async (w, s) => { const el = typeof s === 'string' ? q(w, s) : s; assert.ok(el, 'missing ' + s); el.click(); await tick(); };
const typeInto = (w, el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };

// Log every set of the open workout. weightFor/repsFor choose values per exercise id.
async function logAll(w, { weightFor = () => 40, repsFor = () => 12, secondsFor = () => 35, painOn = null } = {}) {
  for (let guard = 0; guard < 80; guard++) {
    const card = q(w, '.ex.is-open');
    if (!card) break;
    const id = card.dataset.ex;
    if (painOn === id && !card.querySelector('[data-role="pain"]').checked) {
      const c = card.querySelector('[data-role="pain"]'); c.checked = true; c.dispatchEvent(new w.Event('change', { bubbles: true }));
    }
    const row = [...card.querySelectorAll('.set')].find((r) => !r.classList.contains('is-done'));
    if (!row) break;
    const wi = row.querySelector('[data-f="weight"]');
    const ri = row.querySelector('[data-f="reps"]');
    const si = row.querySelector('[data-f="seconds"]');
    if (wi) typeInto(w, wi, String(weightFor(id)));
    if (ri) typeInto(w, ri, String(repsFor(id)));
    if (si) typeInto(w, si, String(secondsFor(id)));
    row.querySelector('.set-ok').click();
    await tick(5);
  }
}

test('full flow: login, workout, rest timer, finish, offline queue, resume, progress', async (t) => {
  const server = createServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dom = await openApp(base);
  const w = dom.window;
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.message));
  t.after(() => { w.close(); server.close(); });

  await t.test('shows login, rejects a wrong key, accepts the right one', async () => {
    assert.match(text(w, '#main'), /Sign in/);
    typeInto(w, q(w, '#key-input'), 'wrong');
    await click(w, '[data-act="save-key"]'); await tick(120);
    assert.match(text(w, '#main'), /Sign in/);
    assert.match(text(w, '#main'), /not accepted/);
    typeInto(w, q(w, '#key-input'), KEY);
    await click(w, '[data-act="save-key"]'); await tick(150);
    assert.match(text(w, '#main'), /Day A/);
    assert.match(text(w, '#top'), /Synced/);
    assert.equal(qa(w, '#nav button').length, 3);
  });

  await t.test('today: Day A preview matches the plan, week 1 banner shown', async () => {
    assert.match(text(w, '#main'), /Week 1/);
    assert.match(text(w, '#main'), /newer moves/);
    const items = qa(w, '.plist li').map((li) => li.textContent);
    assert.equal(items.length, 9);
    assert.match(items[0], /Leg press.*3 × 8-12/);
    assert.match(items.find((s) => /hammer/i.test(s)), /2 × 10-12/); // new move: 2 sets in week 1
    assert.match(items.find((s) => /Plank/.test(s)), /3 × 30-45 s/);
  });

  await t.test('workout: first exercise open, rejects empty reps, logs a set and starts the rest timer', async () => {
    await click(w, '[data-act="start"]');
    assert.ok(w.document.body.classList.contains('in-workout'));
    assert.equal(q(w, '.ex.is-open').dataset.ex, 'leg-press');
    assert.equal(qa(w, '.ex.is-open .set').length, 3);

    await click(w, '.ex.is-open .set-ok');       // nothing entered
    assert.ok(q(w, '.ex.is-open .set.err'));
    assert.match(text(w, '#toast'), /Enter your reps/);
    assert.equal(q(w, '.rest-bar'), null);

    const row = q(w, '.ex.is-open .set');
    typeInto(w, row.querySelector('[data-f="weight"]'), '40,5');
    typeInto(w, row.querySelector('[data-f="reps"]'), '10');
    await click(w, '.ex.is-open .set-ok');
    assert.ok(q(w, '.ex.is-open .set.is-done'));
    assert.match(text(w, '.rest-label'), /Rest · Leg press/);
    assert.equal(text(w, '#rest-time'), '2:00');
    const stored = JSON.parse(w.localStorage.getItem('gt_active'));
    assert.equal(stored.exercises['leg-press'].sets[0].weight, '40,5');
  });

  await t.test('rest timer: +15, runs out into a Go state, then dismisses', async () => {
    await click(w, '[data-act="rest-add"][data-s="15"]');
    assert.match(text(w, '#rest-time'), /^2:1[45]$/);
    for (let i = 0; i < 9; i++) await click(w, '[data-act="rest-add"][data-s="-15"]'); // 135 s off a 135 s rest
    assert.equal(text(w, '#rest-time'), 'Go!');
    assert.ok(q(w, '.rest-bar.is-done'));
    assert.match(text(w, '.rest-label'), /Rest over/);
    assert.equal(q(w, '[data-act="rest-add"]'), null); // +/- hidden once finished
    await click(w, '[data-act="rest-skip"]');
    assert.equal(q(w, '.rest-bar'), null);
    assert.ok(JSON.parse(w.localStorage.getItem('gt_active')));
  });

  await t.test('un-logging a set works and the escape of odd input is safe', async () => {
    await click(w, '.ex.is-open .set.is-done .set-ok');
    assert.equal(qa(w, '.ex.is-open .set.is-done').length, 0);
    typeInto(w, q(w, '.ex.is-open [data-f="weight"]'), '12"><b id="pwn">x</b>');
    await click(w, '.ex-head[data-ex="leg-press"]'); // close
    await click(w, '.ex-head[data-ex="leg-press"]'); // reopen -> re-render
    assert.equal(q(w, '#pwn'), null);
    typeInto(w, q(w, '.ex.is-open [data-f="weight"]'), '40');
  });

  await t.test('finish Day A with every set logged, hip thrust at the top of the range', async () => {
    await logAll(w, { weightFor: (id) => (id === 'hip-thrust' ? 40 : 20), repsFor: (id) => (id === 'hip-thrust' ? 12 : 10), painOn: 'db-bench' });
    assert.equal(q(w, '.ex.is-open'), null);
    assert.match(text(w, '#main'), /sets logged/);
    await click(w, '[data-act="finish"].finish'); await tick(150);
    assert.match(text(w, '#main'), /Workout saved/);
    assert.match(text(w, '#main'), /Saved to your Google Sheet/);
    assert.match(text(w, '#main'), /flagged pain on Dumbbell bench press/);
    assert.equal(w.localStorage.getItem('gt_active'), null);
    const data = await (await fetch(base + '/api/data', { headers: { 'x-app-key': KEY } })).json();
    assert.equal(data.sessions.length, 1);
    assert.equal(data.sessions[0].workout, 'A');
    assert.equal(data.sets.length, 23); // week 1: new moves (hammer curl, pushdown, calves) get 2 sets, face pull is 2 by plan
    assert.equal(data.sets.filter((x) => x.exerciseId === 'hammer-curl').length, 2);
    assert.ok(data.sets.some((s) => s.exerciseId === 'plank' && s.seconds === 35 && s.weightKg === null));
    assert.ok(data.sets.some((s) => s.exerciseId === 'db-bench' && s.pain === true));
  });

  await t.test('next is Day B; finishing it while offline queues the session', async () => {
    await click(w, '[data-act="done"]');
    assert.match(text(w, '#main'), /Day B/);
    assert.match(text(w, '#main'), /Last: Day A/);
    await click(w, '[data-act="start"]');
    assert.equal(q(w, '.ex.is-open').dataset.ex, 'goblet-squat');
    w.__fetch = () => Promise.reject(new TypeError('Failed to fetch')); // phone loses signal
    await logAll(w);
    await click(w, '[data-act="finish"].finish'); await tick(150);
    assert.match(text(w, '#main'), /Saved on this phone/);
    assert.match(text(w, '#top'), /1 to sync \(offline\)/);
    assert.equal(JSON.parse(w.localStorage.getItem('gt_pending')).length, 1);
    await click(w, '[data-act="done"]');
    assert.match(text(w, '#main'), /Day A/);            // queued session already counts
    assert.match(text(w, '#main'), /2 of 3|1 of 3/);
  });

  await t.test('back online: queue uploads once, no duplicates', async () => {
    w.__fetch = (u, o) => fetch(u, o);
    await click(w, '[data-act="sync"]'); await tick(200);
    assert.match(text(w, '#top'), /Synced/);
    assert.equal(JSON.parse(w.localStorage.getItem('gt_pending')).length, 0);
    await click(w, '[data-act="sync"]'); await tick(150);
    const data = await (await fetch(base + '/api/data', { headers: { 'x-app-key': KEY } })).json();
    assert.equal(data.sessions.length, 2);
  });

  await t.test('progression: Day A preview now says go up for hip thrust, and warns about pain', async () => {
    const items = qa(w, '.plist li').map((li) => li.textContent);
    assert.match(items.find((s) => /Hip thrust/.test(s)), /go up to 45 kg/);
    assert.match(text(w, '#main'), /flagged pain on Dumbbell bench press/);
    await click(w, '[data-act="start"]');
    // hip thrust is the 4th exercise; open it and check the prefill
    await click(w, '.ex-head[data-ex="hip-thrust"]');
    const first = q(w, '.ex.is-open .set');
    assert.equal(first.querySelector('[data-f="weight"]').value, '45');
    assert.equal(first.querySelector('[data-f="reps"]').value, '8');
    assert.match(text(w, '.ex.is-open .tip'), /go up to 45 kg/);
  });

  await t.test('reload mid-workout resumes the same workout with logged sets', async () => {
    await click(w, '.ex-head[data-ex="leg-press"]');
    const row = q(w, '.ex.is-open .set');
    typeInto(w, row.querySelector('[data-f="weight"]'), '55');
    typeInto(w, row.querySelector('[data-f="reps"]'), '9');
    await click(w, '.ex.is-open .set-ok');
    const snapshot = {}; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); snapshot[k] = w.localStorage.getItem(k); }
    const dom2 = await openApp(base, snapshot);
    const w2 = dom2.window;
    try {
      assert.ok(w2.document.body.classList.contains('in-workout'));
      assert.equal(qa(w2, '.ex.is-open .set.is-done').length, 1);
      assert.equal(q(w2, '.ex.is-open [data-f="weight"]').value, '55');
      await click(w2, '[data-act="back"]');
      assert.match(text(w2, '#main'), /Resume workout/);
    } finally { w2.close(); }
  });

  await t.test('discarding the workout returns to Today', async () => {
    await click(w, '[data-act="back"]');
    await click(w, '[data-act="discard"]');
    assert.equal(w.localStorage.getItem('gt_active'), null);
    assert.match(text(w, '#main'), /Start Day A/);
  });

  await t.test('progress: charts render with the right data', async () => {
    await click(w, '[data-act="tab"][data-v="progress"]');
    assert.match(text(w, '#main'), /2 workouts/);
    const bars = qa(w, 'svg.chart')[0];
    assert.match(bars.getAttribute('aria-label'), /2 in total, target 3/);
    const sel = q(w, '#pex');
    sel.value = 'hip-thrust'; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
    await tick();
    const line = qa(w, 'svg.chart')[1];
    assert.match(line.getAttribute('aria-label'), /1 session, from 40 to 40 kg/);
    assert.match(text(w, '#main'), /Best so far: 40 kg/);
    sel.value = 'plank'; 
    q(w, '#pex').value = 'plank'; q(w, '#pex').dispatchEvent(new w.Event('change', { bubbles: true }));
    await tick();
    assert.match(text(w, '#main'), /Best so far: 35 s/);
    assert.match(text(w, '#main'), /Recent workouts/);
  });

  await t.test('settings: sign out clears the key but keeps pending data', async () => {
    await click(w, '[data-act="tab"][data-v="settings"]');
    assert.match(text(w, '#main'), /Waiting to upload: 0/);
    await click(w, '[data-act="sign-out"]');
    assert.match(text(w, '#main'), /Sign in/);
    assert.equal(w.localStorage.getItem('gt_key'), null);
  });

  assert.deepEqual(errors, []);
});
