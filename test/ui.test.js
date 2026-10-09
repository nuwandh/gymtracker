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
// No async wait needed: stepper clicks only trigger a synchronous state update + render.
const clickFast = (w, s) => { const el = typeof s === 'string' ? q(w, s) : s; assert.ok(el, 'missing ' + s); el.click(); };
const typeInto = (w, el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };

// jump (kg per stepper click) for each exercise, matching public/plan.js.
const JUMP = {
  'leg-press': 5, 'db-bench': 2, 'cable-row': 2.5, 'hip-thrust': 5, 'face-pull': 2.5,
  'hammer-curl': 1, 'pushdown': 2.5, 'calf-raise': 2.5,
  'goblet-squat': 2, 'lat-pulldown': 2.5, 'db-shoulder-press': 2, 'db-rdl': 2,
  'lying-leg-curl': 2.5, 'lateral-raise': 1, 'rear-delt-fly': 1, 'db-curl': 1, 'oh-triceps': 2.5,
};

// Repeatedly taps the +/- stepper for one field of the active set until it reads `target`.
function stepTo(w, exId, i, field, target, step) {
  for (let guard = 0; guard < 400; guard++) {
    const card = q(w, '.set-active[data-ex="' + exId + '"][data-i="' + i + '"]');
    if (!card) return;
    const stepperDiv = [...card.querySelectorAll('.stepper')].find((st) => st.querySelector('[data-f="' + field + '"]'));
    if (!stepperDiv) return;
    const current = Number(stepperDiv.querySelector('.val').textContent);
    const diff = Math.round((target - current) / step);
    if (diff === 0) return;
    const dir = diff > 0 ? 1 : -1;
    clickFast(w, stepperDiv.querySelector('[data-d="' + dir + '"]'));
  }
}

// Opens each remaining to-do exercise in turn, dials in the stepper values and taps Log,
// until the to-do list is gone (every exercise done -> lands on the summary screen).
async function logAll(w, { weightFor = () => 40, repsFor = () => 12, secondsFor = () => 35, painOn = null } = {}) {
  for (let guard = 0; guard < 80; guard++) {
    let card = q(w, '.set-active');
    if (!card) {
      const todoRow = q(w, '.todo-row:not(.is-done)');
      if (!todoRow) break;
      await click(w, todoRow);
      card = q(w, '.set-active');
      if (!card) break;
    }
    const id = card.dataset.ex;
    const i = Number(card.dataset.i);
    if (painOn === id) {
      const pr = q(w, '.pain-row');
      if (pr && !pr.classList.contains('on')) await click(w, pr);
    }
    if (card.querySelector('[data-f="weight"]')) {
      stepTo(w, id, i, 'weight', weightFor(id), JUMP[id] || 2.5);
      stepTo(w, id, i, 'reps', repsFor(id), 1);
    } else {
      stepTo(w, id, i, 'seconds', secondsFor(id), 5);
    }
    await click(w, '.log-btn');
  }
}

test('full flow: login, workout to-do list + steppers, rest timer, finish, offline queue, resume, progress', async (t) => {
  const server = createServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dom = await openApp(base);
  const w = dom.window;
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.message));
  t.after(() => { w.close(); server.close(); });

  await t.test('shows login, rejects a wrong key, accepts the right one', async () => {
    assert.match(text(w, '#main'), /Welcome back/);
    typeInto(w, q(w, '#key-input'), 'wrong');
    await click(w, '[data-act="save-key"]'); await tick(120);
    assert.match(text(w, '#main'), /Wrong key/);
    assert.match(text(w, '#main'), /not accepted/);
    typeInto(w, q(w, '#key-input'), KEY);
    await click(w, '[data-act="save-key"]'); await tick(150);
    assert.match(text(w, '#main'), /Day A/);
    assert.match(text(w, '#top'), /Synced/);
    assert.equal(qa(w, '#nav button').length, 3);
  });

  await t.test('today: Day A preview matches the plan, week 1 banner shown', async () => {
    assert.match(text(w, '#main'), /Week 1/);
    assert.match(text(w, '#main'), /New moves: 2 sets/);
    const rows = qa(w, '.prev-row');
    assert.equal(rows.length, 5); // 4 shown + "+ 5 more"
    assert.match(rows[0].textContent, /Leg press.*8-12/);
    assert.match(rows[rows.length - 1].textContent, /\+ 5 more/);
  });

  await t.test('workout: to-do list shown, pick an exercise out of order, finish it, see it move to Done, reopen it', async () => {
    await click(w, '[data-act="start"]');
    assert.ok(w.document.body.classList.contains('in-workout'));
    assert.match(text(w, '#main'), /0 of 9 done/);
    assert.equal(qa(w, '.todo-row').length, 9);
    assert.equal(q(w, '.done-section'), null); // nothing done yet, no Done section

    // pick an exercise that is not first in the list
    await click(w, '.todo-row[data-ex="cable-row"]');
    assert.equal(q(w, '.focus-title').textContent, 'Seated cable row');
    assert.equal(q(w, '.set-active').dataset.ex, 'cable-row');
    assert.equal(qa(w, '.set-active, .set-compact').length, 3);

    for (let n = 0; n < 3; n++) {
      stepTo(w, 'cable-row', Number(q(w, '.set-active').dataset.i), 'weight', 20, 2.5);
      stepTo(w, 'cable-row', Number(q(w, '.set-active').dataset.i), 'reps', 10, 1);
      await click(w, '.log-btn');
    }
    // last set logged -> back on the to-do list automatically, exercise moved to Done
    assert.equal(q(w, '.set-active'), null);
    assert.match(text(w, '.rest-label'), /Rest · Seated cable row/);
    assert.match(text(w, '#main'), /1 of 9 done/);
    assert.equal(qa(w, '.todo-row').length, 8);
    assert.match(text(w, '.done-head'), /Done/);
    assert.match(text(w, '.done-head'), /1/);
    assert.equal(q(w, '.done-rows'), null); // collapsed by default

    await click(w, '[data-act="toggle-done"]');
    assert.equal(qa(w, '.done-rows li').length, 1);
    await click(w, '.done-rows button[data-ex="cable-row"]');
    assert.equal(q(w, '.set-active'), null); // all 3 sets done, nothing active
    assert.equal(qa(w, '.set-compact.is-done').length, 3);
    await click(w, '[data-act="to-list"]');

    // leg-press: log one set, leave it half finished
    await click(w, '.todo-row[data-ex="leg-press"]');
    stepTo(w, 'leg-press', 0, 'weight', 40, 5);
    stepTo(w, 'leg-press', 0, 'reps', 10, 1);
    await click(w, '.log-btn');
    assert.ok(q(w, '.set-compact.is-done'));
    assert.match(text(w, '.rest-label'), /Rest · Leg press/);
    assert.equal(text(w, '#rest-time'), '2:00');
    const stored = JSON.parse(w.localStorage.getItem('gt_active'));
    assert.equal(stored.exercises['leg-press'].sets[0].weight, 40);
    await click(w, '[data-act="to-list"]');
    assert.match(text(w, '.todo-row[data-ex="leg-press"]'), /1 of 3 sets/);
  });

  await t.test('rest timer: +15, runs out into a Go state, then dismisses', async () => {
    await click(w, '[data-act="rest-add"][data-s="15"]');
    assert.match(text(w, '#rest-time'), /^2:1[45]$/);
    for (let i = 0; i < 9; i++) await click(w, '[data-act="rest-add"][data-s="-15"]'); // 135 s off a 135 s rest
    assert.equal(text(w, '#rest-time'), 'Go');
    assert.ok(q(w, '.rest-bar.is-done'));
    assert.match(text(w, '.rest-bar'), /Rest over/);
    await click(w, '[data-act="rest-skip"]');
    assert.equal(q(w, '.rest-bar'), null);
    assert.ok(JSON.parse(w.localStorage.getItem('gt_active')));
  });

  await t.test('un-logging a set turns it back into the active set', async () => {
    await click(w, '.todo-row[data-ex="leg-press"]');
    const doneRow = q(w, '.set-compact.is-done .tick-btn');
    assert.ok(doneRow);
    await click(w, doneRow);
    assert.equal(qa(w, '.set-compact.is-done').length, 0);
    assert.equal(q(w, '.set-active').dataset.i, '0');
    stepTo(w, 'leg-press', 0, 'weight', 40, 5);
    stepTo(w, 'leg-press', 0, 'reps', 10, 1);
    await click(w, '.log-btn');
    await click(w, '[data-act="to-list"]');
  });

  await t.test('finish Day A automatically once every exercise is done, hip thrust at the top of the range, pain flagged', async () => {
    await logAll(w, { weightFor: (id) => (id === 'hip-thrust' ? 40 : 20), repsFor: (id) => (id === 'hip-thrust' ? 12 : 10), painOn: 'db-bench' });
    await tick(150);
    assert.match(text(w, '#main'), /Workout done/);
    assert.match(text(w, '#main'), /Saved to your Google Sheet/);
    assert.equal(w.localStorage.getItem('gt_active'), null);
    const data = await (await fetch(base + '/api/data', { headers: { 'x-app-key': KEY } })).json();
    assert.equal(data.sessions.length, 1);
    assert.equal(data.sessions[0].workout, 'A');
    assert.equal(data.sets.length, 23); // week 1: new moves (hammer curl, pushdown, calves) get 2 sets, face pull is 2 by plan
    assert.equal(data.sets.filter((x) => x.exerciseId === 'hammer-curl').length, 2);
    assert.ok(data.sets.some((s) => s.exerciseId === 'db-bench' && s.pain === true));
  });

  await t.test('next is Day B; finishing it while offline queues the session', async () => {
    await click(w, '[data-act="done"]');
    assert.match(text(w, '#main'), /Day B/);
    assert.match(text(w, '#main'), /Last: Day A/);
    await click(w, '[data-act="start"]');
    assert.equal(qa(w, '.todo-row').length, 11);
    assert.equal(q(w, '.todo-row').dataset.ex, 'goblet-squat');
    assert.match(text(w, '#main'), /0 of 11 done/);
    w.__fetch = () => Promise.reject(new TypeError('Failed to fetch')); // phone loses signal
    await logAll(w);
    await tick(150);
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

  await t.test('progression: hip thrust is suggested to go up, and the to-do chip shows the target weight', async () => {
    await click(w, '[data-act="start"]');
    assert.match(text(w, '.todo-row[data-ex="hip-thrust"]'), /45/);
    await click(w, '.todo-row[data-ex="hip-thrust"]');
    assert.match(text(w, '.tip'), /go up to 45 kg/);
    assert.equal(q(w, '.set-active .stepper .val').textContent, '45');
  });

  await t.test('reload mid-workout restores the to-do list, done state and half-finished sets', async () => {
    await click(w, '[data-act="to-list"]');
    await click(w, '.todo-row[data-ex="leg-press"]');
    stepTo(w, 'leg-press', 0, 'weight', 55, 5);
    stepTo(w, 'leg-press', 0, 'reps', 9, 1);
    await click(w, '.log-btn');
    const snapshot = {}; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); snapshot[k] = w.localStorage.getItem(k); }
    const dom2 = await openApp(base, snapshot);
    const w2 = dom2.window;
    try {
      assert.ok(w2.document.body.classList.contains('in-workout'));
      assert.match(text(w2, '#main'), /0 of 9 done/); // reload lands back on the to-do list, not the focused exercise
      assert.match(text(w2, '.todo-row[data-ex="leg-press"]'), /1 of 3 sets/);
      await click(w2, '.todo-row[data-ex="leg-press"]');
      assert.equal(qa(w2, '.set-compact.is-done').length, 1);
      assert.match(text(w2, '.set-compact.is-done'), /55/);
      await click(w2, '[data-act="to-list"]');
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
    assert.match(text(w, '#main'), /Progress/);
    const bars = qa(w, 'svg.chart')[0];
    assert.match(bars.getAttribute('aria-label'), /2 in total, target 3/);
    await click(w, '.filter-chip[data-id="hip-thrust"]');
    const line = qa(w, 'svg.chart')[1];
    assert.match(line.getAttribute('aria-label'), /1 session, from 40 to 40 kg/);
    assert.match(text(w, '.top-set'), /40/);
    await click(w, '.filter-chip[data-id="plank"]');
    assert.match(text(w, '.top-set'), /35/);
    assert.match(text(w, '#main'), /Recent workouts/);
  });

  await t.test('settings: theme toggle and sign out (keeps pending data)', async () => {
    await click(w, '[data-act="tab"][data-v="settings"]');
    await click(w, '[data-act="theme"][data-v="light"]');
    assert.equal(w.document.documentElement.getAttribute('data-theme'), 'light');
    await click(w, '[data-act="theme"][data-v="dark"]');
    assert.equal(JSON.parse(w.localStorage.getItem('gt_pending')).length, 0);
    await click(w, '[data-act="sign-out"]');
    assert.match(text(w, '#main'), /Welcome back/);
    assert.equal(w.localStorage.getItem('gt_key'), null);
  });

  assert.deepEqual(errors, []);
});
