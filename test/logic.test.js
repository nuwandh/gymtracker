'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../public/logic.js');
const PLAN = require('../public/plan.js');

const sess = (id, date, workout, week = 1) => ({ sessionId: id, date, workout, week, startedAt: date + 'T10:00:00.000Z', finishedAt: date + 'T11:00:00.000Z' });
const set = (sessionId, exerciseId, setNo, weightKg, reps, extra = {}) => ({ sessionId, exerciseId, setNo, weightKg, reps, seconds: null, variant: '', pain: false, ...extra });
const ex = (id) => [...PLAN.workouts.A.exercises, ...PLAN.workouts.B.exercises].find((e) => e.id === id);

test('plan: ids unique per day, fields sane, matches the agreed plan', () => {
  for (const w of ['A', 'B']) {
    const list = PLAN.workouts[w].exercises;
    assert.equal(new Set(list.map((e) => e.id)).size, list.length);
    for (const e of list) {
      assert.ok(e.name && e.sets >= 2 && e.reps[0] < e.reps[1] && e.rest >= 45, e.id);
      assert.match(e.id, /^[a-z0-9-]{1,40}$/);
    }
  }
  assert.equal(PLAN.workouts.A.exercises.length, 9);
  assert.equal(PLAN.workouts.B.exercises.length, 11);
  assert.equal(ex('leg-press').rest, 120);
  assert.equal(ex('db-rdl').early, 2);
  assert.equal(ex('face-pull').sets, 2);
  assert.equal(ex('rkc-plank').type, 'time');
});

test('nextWorkout alternates and ignores calendar days', () => {
  assert.equal(L.nextWorkout([]), 'A');
  assert.equal(L.nextWorkout([sess('s1', '2026-10-12', 'A')]), 'B');
  assert.equal(L.nextWorkout([sess('s1', '2026-10-12', 'A'), sess('s2', '2026-10-14', 'B')]), 'A');
  // a week with a missed day: A (Mon), B (Wed), then next is A whatever the weekday
  assert.equal(L.nextWorkout([sess('s2', '2026-10-14', 'B'), sess('s1', '2026-10-12', 'A'), sess('s3', '2026-10-21', 'A')]), 'B');
});

test('programWeek counts from the first session', () => {
  assert.equal(L.programWeek([], '2026-10-12'), 1);
  const s = [sess('a', '2026-10-12', 'A')];
  assert.equal(L.programWeek(s, '2026-10-12'), 1);
  assert.equal(L.programWeek(s, '2026-10-18'), 1);
  assert.equal(L.programWeek(s, '2026-10-19'), 2);
  assert.equal(L.programWeek(s, '2026-11-23'), 7);
  assert.equal(L.isDeloadWeek(7), true);
  assert.equal(L.isDeloadWeek(6), false);
  assert.equal(L.isDeloadWeek(14), true);
});

test('setsFor: new exercises start with 2 sets for weeks 1-2', () => {
  assert.equal(L.setsFor(ex('db-rdl'), 1), 2);
  assert.equal(L.setsFor(ex('db-rdl'), 2), 2);
  assert.equal(L.setsFor(ex('db-rdl'), 3), 3);
  assert.equal(L.setsFor(ex('leg-press'), 1), 3);
});

test('suggest: first time, hold, increase, drop', () => {
  const e = ex('db-bench'); // 3 x 8-12, jump 2
  const h = (id, date, rows, week = 3) => L.historyFor('db-bench', [sess(id, date, 'A', week)], rows.map((r, i) => set(id, 'db-bench', i + 1, r[0], r[1])))[0];

  assert.equal(L.suggest(e, []).kind, 'start');

  const hold = L.suggest(e, [h('s1', '2026-10-12', [[14, 12], [14, 11], [14, 9]])]);
  assert.equal(hold.kind, 'hold');
  assert.equal(hold.weight, 14);

  const up = L.suggest(e, [h('s1', '2026-10-12', [[14, 12], [14, 12], [14, 12]])]);
  assert.equal(up.kind, 'increase');
  assert.equal(up.weight, 16);

  // top reps on only two of three sets is not enough
  assert.equal(L.suggest(e, [h('s1', '2026-10-12', [[14, 12], [14, 12]])]).kind, 'hold');

  // stalled 3 sessions at 14 kg -> drop 10% (12.6 -> 12.5)
  const stuck = [
    h('s1', '2026-10-12', [[14, 10], [14, 9], [14, 8]]),
    h('s2', '2026-10-19', [[14, 10], [14, 9], [14, 8]]),
    h('s3', '2026-10-26', [[14, 11], [14, 9], [14, 8]]),
  ];
  const drop = L.suggest(e, stuck);
  assert.equal(drop.kind, 'drop');
  assert.equal(drop.weight, 12.5);
});

test('suggest: 2-set week counts as a full session for new exercises', () => {
  const e = ex('db-curl'); // early 2, reps 10-12, jump 1
  const hist = L.historyFor('db-curl', [sess('s1', '2026-10-12', 'B', 1)], [set('s1', 'db-curl', 1, 8, 12), set('s1', 'db-curl', 2, 8, 12)]);
  const s = L.suggest(e, hist);
  assert.equal(s.kind, 'increase');
  assert.equal(s.weight, 9);
});

test('suggest: time exercises and pain flag', () => {
  const e = ex('plank');
  const hist = L.historyFor('plank', [sess('s1', '2026-10-12', 'A')], [
    { sessionId: 's1', exerciseId: 'plank', setNo: 1, weightKg: null, reps: null, seconds: 30, pain: false },
    { sessionId: 's1', exerciseId: 'plank', setNo: 2, weightKg: null, reps: null, seconds: 32, pain: true },
  ]);
  const s = L.suggest(e, hist);
  assert.equal(s.kind, 'time');
  assert.equal(s.seconds, 37);
  assert.equal(s.pain, true);
});

test('prefill uses suggestion weight and last reps', () => {
  const e = ex('db-bench');
  const hist = L.historyFor('db-bench', [sess('s1', '2026-10-12', 'A')], [set('s1', 'db-bench', 1, 14, 12), set('s1', 'db-bench', 2, 14, 12), set('s1', 'db-bench', 3, 14, 12)]);
  const sg = L.suggest(e, hist);
  const rows = L.prefill(e, hist, sg, 3);
  assert.deepEqual(rows[0], { weight: 16, reps: 8, done: false });
  assert.equal(L.prefill(e, [], L.suggest(e, []), 3)[0].weight, '');
});

test('weeklyCounts buckets by Monday weeks', () => {
  const s = [sess('a', '2026-10-12', 'A'), sess('b', '2026-10-14', 'B'), sess('c', '2026-10-16', 'A'), sess('d', '2026-10-19', 'B')];
  const w = L.weeklyCounts(s, '2026-10-21', 3);
  assert.deepEqual(w.map((x) => x.count), [0, 3, 1]);
  assert.equal(w[2].weekStart, '2026-10-19');
});

test('newPRs only flags real improvements', () => {
  const sessions = [sess('s1', '2026-10-12', 'A')];
  const sets = [set('s1', 'hip-thrust', 1, 40, 10)];
  const cur = { sets: [{ exerciseId: 'hip-thrust', exercise: 'Hip thrust', weightKg: 45, reps: 8 }, { exerciseId: 'leg-press', exercise: 'Leg press', weightKg: 60, reps: 10 }] };
  const prs = L.newPRs(cur, sessions, sets, PLAN);
  assert.equal(prs.length, 1); // leg press has no history yet, so no "PR"
  assert.equal(prs[0].exerciseId, 'hip-thrust');
});
