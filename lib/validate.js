'use strict';

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const EX_ID = /^[a-z0-9-]{1,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const fail = (error) => ({ ok: false, error });
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const isIso = (v) => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Returns { ok:true, value } with only whitelisted, normalised fields, or { ok:false, error }.
function validateSession(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return fail('Body must be a JSON object');
  if (!ID.test(b.sessionId || '')) return fail('Bad sessionId');
  if (!DATE.test(b.date || '') || Number.isNaN(Date.parse(b.date + 'T00:00:00Z'))) return fail('Bad date');
  if (b.workout !== 'A' && b.workout !== 'B') return fail('workout must be A or B');
  if (!isIso(b.startedAt) || !isIso(b.finishedAt)) return fail('Bad startedAt/finishedAt');
  if (!isInt(b.week, 1, 1000)) return fail('Bad week');
  if (!Array.isArray(b.sets) || b.sets.length < 1 || b.sets.length > 60) {
    return fail('sets must be an array of 1-60 items');
  }

  const sets = [];
  for (const s of b.sets) {
    if (!s || typeof s !== 'object') return fail('Bad set');
    if (!EX_ID.test(s.exerciseId || '')) return fail('Bad exerciseId');
    if (!isInt(s.setNo, 1, 20)) return fail('Bad setNo');
    const weightKg = s.weightKg == null ? null : s.weightKg;
    const reps = s.reps == null ? null : s.reps;
    const seconds = s.seconds == null ? null : s.seconds;
    if (weightKg !== null && !isNum(weightKg, 0, 1000)) return fail('Bad weightKg');
    if (reps !== null && !isInt(reps, 0, 500)) return fail('Bad reps');
    if (seconds !== null && !isInt(seconds, 0, 3600)) return fail('Bad seconds');
    if (reps === null && seconds === null) return fail('Each set needs reps or seconds');
    sets.push({
      exerciseId: s.exerciseId,
      exercise: clean(s.exercise, 80),
      setNo: s.setNo,
      weightKg,
      reps,
      seconds,
      variant: clean(s.variant, 40),
      pain: s.pain === true,
    });
  }

  return {
    ok: true,
    value: {
      sessionId: b.sessionId,
      date: b.date,
      workout: b.workout,
      startedAt: b.startedAt,
      finishedAt: b.finishedAt,
      week: b.week,
      sets,
    },
  };
}

module.exports = { validateSession };
