// Pure logic, no DOM. Works in the browser (window.GTLogic) and in Node for tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GTLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var pad = function (n) { return (n < 10 ? '0' : '') + n; };

  // Local calendar date as YYYY-MM-DD.
  function todayStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function utc(dateStr) {
    var p = dateStr.split('-').map(Number);
    return Date.UTC(p[0], p[1] - 1, p[2]);
  }
  function daysBetween(a, b) { return Math.round((utc(b) - utc(a)) / 86400000); }
  function addDays(dateStr, n) {
    var d = new Date(utc(dateStr) + n * 86400000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  // Monday of the week containing dateStr.
  function weekStart(dateStr) {
    var dow = new Date(utc(dateStr)).getUTCDay(); // 0 = Sunday
    return addDays(dateStr, -((dow + 6) % 7));
  }

  function sortSessions(sessions) {
    return sessions.slice().sort(function (a, b) {
      return (a.startedAt || '').localeCompare(b.startedAt || '') || (a.date || '').localeCompare(b.date || '');
    });
  }

  // The next workout is simply the one you did not do last. Missed days never break the order.
  function nextWorkout(sessions) {
    var s = sortSessions(sessions);
    if (!s.length) return 'A';
    return s[s.length - 1].workout === 'A' ? 'B' : 'A';
  }

  // Week 1 starts on the date of your first logged session.
  function programWeek(sessions, today) {
    if (!sessions.length) return 1;
    var first = sessions.map(function (s) { return s.date; }).sort()[0];
    return Math.max(1, Math.floor(daysBetween(first, today) / 7) + 1);
  }

  function setsFor(ex, week) {
    return week <= 2 && ex.early ? ex.early : ex.sets;
  }

  // Every deload week is the 7th, 14th, 21st... week of the programme.
  function isDeloadWeek(week) { return week >= 7 && week % 7 === 0; }

  function historyFor(exId, sessions, sets) {
    var bySession = {};
    sets.forEach(function (s) {
      if (s.exerciseId === exId) (bySession[s.sessionId] = bySession[s.sessionId] || []).push(s);
    });
    return sortSessions(sessions)
      .filter(function (s) { return bySession[s.sessionId]; })
      .map(function (s) {
        return {
          sessionId: s.sessionId, date: s.date, workout: s.workout, week: s.week,
          sets: bySession[s.sessionId].slice().sort(function (a, b) { return a.setNo - b.setNo; }),
        };
      });
  }

  var roundHalf = function (x) { return Math.round(x * 2) / 2; };
  var maxWeight = function (h) {
    return Math.max.apply(null, h.sets.map(function (s) { return s.weightKg || 0; }));
  };
  var bestSeconds = function (h) {
    return Math.max.apply(null, h.sets.map(function (s) { return s.seconds || 0; }));
  };
  var fmt = function (n) { return String(Math.round(n * 100) / 100); };

  // Progression rules from the plan:
  //  - every set at the top of the rep range (with 1-2 reps left) -> add the smallest jump
  //  - stuck on the same weight for 3 sessions -> drop ~10% and build back up
  // Returns { kind, weight?, seconds?, text, pain }.
  function suggest(ex, hist) {
    var last = hist[hist.length - 1];
    if (!last) {
      return {
        kind: 'start', pain: false,
        text: ex.type === 'time'
          ? 'First time: hold with good form and stop when your lower back sags.'
          : 'First time: pick a weight that leaves 2-3 reps in the tank.',
      };
    }
    var pain = last.sets.some(function (s) { return s.pain; });

    if (ex.type === 'time') {
      var best = bestSeconds(last);
      var top = ex.reps[1];
      if (best >= top) {
        return { kind: 'time', seconds: top, pain: pain, text: 'Last best ' + best + ' s, top of the range. Keep it clean.' };
      }
      var target = Math.min(top, Math.max(ex.reps[0], best + 5));
      return { kind: 'time', seconds: target, pain: pain, text: 'Last best ' + best + ' s. Aim for ' + target + ' s.' };
    }

    var W = maxWeight(last);
    var topReps = ex.reps[1];
    if (W === 0) {
      return { kind: 'hold', weight: 0, pain: pain, text: 'Bodyweight last time. Add a little weight once you hit ' + topReps + ' reps on every set.' };
    }
    var atW = last.sets.filter(function (s) { return (s.weightKg || 0) === W; });
    var need = setsFor(ex, last.week || 99);
    var full = atW.length >= need && atW.every(function (s) { return (s.reps || 0) >= topReps; });
    if (full) {
      var up = roundHalf(W + ex.jump);
      return {
        kind: 'increase', weight: up, pain: pain,
        text: 'Hit ' + topReps + ' reps on every set at ' + fmt(W) + ' kg. If you had 1-2 reps left, go up to ' + fmt(up) + ' kg.',
      };
    }
    if (hist.length >= 3) {
      var stuck = hist.slice(-3).every(function (h) { return maxWeight(h) === W; });
      if (stuck) {
        var down = roundHalf(W * 0.9);
        return {
          kind: 'drop', weight: down, pain: pain,
          text: 'Stuck at ' + fmt(W) + ' kg for 3 sessions. Drop about 10% to ' + fmt(down) + ' kg and build back up.',
        };
      }
    }
    return { kind: 'hold', weight: W, pain: pain, text: 'Repeat ' + fmt(W) + ' kg and aim for ' + topReps + ' reps on every set.' };
  }

  // Starting values for the set rows of a new workout.
  function prefill(ex, hist, sg, n) {
    var last = hist[hist.length - 1];
    var rows = [];
    for (var i = 0; i < n; i++) {
      var ref = last ? (last.sets[i] || last.sets[last.sets.length - 1]) : null;
      if (ex.type === 'time') {
        rows.push({ seconds: sg.seconds != null ? sg.seconds : (ref && ref.seconds) || '', done: false });
      } else {
        var w = sg.weight != null ? sg.weight : (ref && ref.weightKg != null ? ref.weightKg : '');
        var r = '';
        if (ref && ref.reps != null) r = sg.kind === 'increase' ? ex.reps[0] : ref.reps;
        rows.push({ weight: w, reps: r, done: false });
      }
    }
    return rows;
  }

  // Chart data: best weight (or best hold in seconds) per session, oldest first.
  function series(hist, ex) {
    return hist.map(function (h) {
      return { date: h.date, value: ex.type === 'time' ? bestSeconds(h) : maxWeight(h) };
    });
  }

  // Sessions per week for the last n weeks (Monday start), oldest first.
  function weeklyCounts(sessions, today, n) {
    n = n || 8;
    var thisWeek = weekStart(today);
    var out = [];
    for (var i = n - 1; i >= 0; i--) out.push({ weekStart: addDays(thisWeek, -7 * i), count: 0 });
    sessions.forEach(function (s) {
      var ws = weekStart(s.date);
      out.forEach(function (w) { if (w.weekStart === ws) w.count++; });
    });
    return out;
  }

  // Exercises where this session beat every earlier max weight (first-ever sessions don't count).
  function newPRs(session, sessions, sets, plan) {
    var prs = [];
    var seen = {};
    session.sets.forEach(function (s) {
      if (seen[s.exerciseId] || s.weightKg == null || s.weightKg <= 0) return;
      seen[s.exerciseId] = true;
      var prior = historyFor(s.exerciseId, sessions, sets);
      if (!prior.length) return;
      var before = Math.max.apply(null, prior.map(maxWeight));
      var now = Math.max.apply(null, session.sets
        .filter(function (x) { return x.exerciseId === s.exerciseId; })
        .map(function (x) { return x.weightKg || 0; }));
      if (now > before) prs.push({ exerciseId: s.exerciseId, name: s.exercise, weight: now });
    });
    return prs;
  }

  return {
    todayStr: todayStr, daysBetween: daysBetween, addDays: addDays, weekStart: weekStart,
    sortSessions: sortSessions, nextWorkout: nextWorkout, programWeek: programWeek,
    setsFor: setsFor, isDeloadWeek: isDeloadWeek, historyFor: historyFor,
    suggest: suggest, prefill: prefill, series: series, weeklyCounts: weeklyCounts,
    newPRs: newPRs, maxWeight: maxWeight, bestSeconds: bestSeconds,
  };
});
