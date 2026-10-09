(function () {
  'use strict';
  const PLAN = window.GTPlan;
  const L = window.GTLogic;

  /* ---------------- helpers ---------------- */
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  const uid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  const kg = (n) => String(Math.round(n * 100) / 100);
  const clock = (sec) => { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); };
  const restLabel = (s) => (s % 60 === 0 ? s / 60 + ' min' : s + ' sec');
  const toNum = (v) => {
    if (v === '' || v == null) return null;
    const n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };
  function fmtDate(d) {
    const p = d.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
  function fmtShort(d) {
    const p = d.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }

  const EX = {};
  ['A', 'B'].forEach((w) => PLAN.workouts[w].exercises.forEach((e) => { if (!EX[e.id]) EX[e.id] = e; }));
  const EX_LIST = Object.keys(EX).map((id) => EX[id]);

  /* ---------------- state ---------------- */
  const S = {
    key: ls.get('gt_key', ''),
    data: ls.get('gt_data', { sessions: [], sets: [] }),
    pending: ls.get('gt_pending', []),
    rejected: ls.get('gt_rejected', []),
    active: ls.get('gt_active', null),
    rest: ls.get('gt_rest', null),
    view: 'today',
    pick: null,
    focus: null,
    doneOpen: false,
    summary: null,
    progressEx: 'hip-thrust',
    sync: { state: 'idle', msg: '', at: ls.get('gt_sync_at', null) },
  };
  const saveActive = () => (S.active ? ls.set('gt_active', S.active) : ls.del('gt_active'));
  const savePending = () => ls.set('gt_pending', S.pending);
  const saveRest = () => (S.rest ? ls.set('gt_rest', S.rest) : ls.del('gt_rest'));

  // Server history plus workouts still waiting to sync, so the UI is always up to date offline.
  function merged() {
    const ids = new Set(S.data.sessions.map((s) => s.sessionId));
    const sessions = S.data.sessions.slice();
    const sets = S.data.sets.slice();
    S.pending.forEach((p) => {
      if (ids.has(p.sessionId)) return;
      sessions.push({ sessionId: p.sessionId, date: p.date, workout: p.workout, startedAt: p.startedAt, finishedAt: p.finishedAt, week: p.week });
      p.sets.forEach((s) => sets.push(Object.assign({ sessionId: p.sessionId }, s)));
    });
    return { sessions, sets };
  }

  /* ---------------- api + sync ---------------- */
  async function api(path, opts) {
    const res = await fetch(path, Object.assign({
      headers: { 'x-app-key': S.key, 'content-type': 'application/json' },
    }, opts || {}));
    let body = null;
    try { body = await res.json(); } catch (e) { /* no body */ }
    if (res.status === 401) { const e = new Error('Wrong key'); e.auth = true; throw e; }
    if (!res.ok) { const e = new Error((body && body.error) || 'HTTP ' + res.status); e.status = res.status; throw e; }
    return body;
  }

  let syncing = false;
  function setSync(state, msg) {
    S.sync.state = state;
    S.sync.msg = msg || '';
    if (state === 'ok') { S.sync.at = Date.now(); ls.set('gt_sync_at', S.sync.at); }
  }
  async function sync() {
    if (syncing || !S.key) return;
    syncing = true;
    setSync('syncing');
    renderTop();
    try {
      while (S.pending.length) {
        const p = S.pending[0];
        try {
          await api('/api/session', { method: 'POST', body: JSON.stringify(p) });
        } catch (e) {
          if (e.status === 400) { // the server will never accept this one; park it instead of blocking the queue
            S.rejected.push({ session: p, error: e.message });
            ls.set('gt_rejected', S.rejected);
          } else throw e;
        }
        S.pending.shift();
        savePending();
      }
      S.data = await api('/api/data');
      ls.set('gt_data', S.data);
      setSync('ok');
    } catch (e) {
      if (e.auth) {
        setSync('auth', e.message);
        if (S.view !== 'workout') S.view = 'login'; // never pull someone out of a workout
      } else if (e.name === 'TypeError' || navigator.onLine === false) setSync('offline');
      else setSync('error', e.message);
    } finally {
      syncing = false;
      if (S.view === 'workout') renderTop(); else render();
    }
  }
  function syncInfo() {
    const n = S.pending.length;
    switch (S.sync.state) {
      case 'syncing': return { cls: 'busy', text: 'Syncing…' };
      case 'auth': return { cls: 'bad', text: 'Key needed' };
      case 'offline': return { cls: 'warn', text: n ? n + ' to sync (offline)' : 'Offline' };
      case 'error': return { cls: 'bad', text: 'Sync error' };
      default:
        if (n) return { cls: 'warn', text: n + ' to sync' };
        return S.sync.state === 'ok' ? { cls: 'ok', text: 'Synced' } : { cls: '', text: '' };
    }
  }

  /* ---------------- toast, sound, wake lock ---------------- */
  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  let audioCtx = null;
  function primeAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* audio is optional */ }
  }
  function beep() {
    try {
      primeAudio();
      if (!audioCtx) return;
      [0, 0.2, 0.4].forEach((t, i) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.frequency.value = i === 2 ? 1040 : 880;
        o.connect(g); g.connect(audioCtx.destination);
        const now = audioCtx.currentTime + t;
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.3, now + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
        o.start(now); o.stop(now + 0.17);
      });
    } catch (e) { /* ignore */ }
  }

  let wakeLock = null;
  async function holdScreen() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { /* not supported or denied */ }
  }
  function releaseScreen() {
    try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignore */ }
    wakeLock = null;
  }

  /* ---------------- rest timer ---------------- */
  function startRest(sec, label) {
    S.rest = { endsAt: Date.now() + sec * 1000, total: sec, label, fired: false };
    saveRest();
    primeAudio();
    renderRest();
  }
  function restLeft() { return S.rest ? Math.ceil((S.rest.endsAt - Date.now()) / 1000) : 0; }
  function renderRest() {
    const el = $('#rest');
    if (!S.rest || S.view !== 'workout') { el.innerHTML = ''; return; }
    const done = restLeft() <= 0;
    el.innerHTML =
      '<div class="rest-bar' + (done ? ' is-done' : '') + '">' +
        '<div class="rest-fill" id="rest-fill"></div>' +
        '<div class="rest-row">' +
          '<div><span class="rest-label">' + (done ? 'Rest over' : 'Rest') + ' · ' + esc(S.rest.label) + '</span>' +
          '<strong id="rest-time">' + (done ? 'Go!' : clock(restLeft())) + '</strong></div>' +
          '<div class="rest-btns">' +
            (done ? '' : '<button data-act="rest-add" data-s="-15" aria-label="15 seconds less">-15</button><button data-act="rest-add" data-s="15" aria-label="15 seconds more">+15</button>') +
            '<button data-act="rest-skip">' + (done ? 'OK' : 'Skip') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    tick();
  }
  function tick() {
    if (S.rest && S.view === 'workout') {
      const left = restLeft();
      const t = $('#rest-time');
      const f = $('#rest-fill');
      if (left > 0) {
        if (t) t.textContent = clock(left);
        if (f) f.style.width = Math.min(100, ((S.rest.total - left) / S.rest.total) * 100) + '%';
      } else if (!S.rest.fired) {
        S.rest.fired = true;
        saveRest();
        beep();
        if (navigator.vibrate) { try { navigator.vibrate([250, 120, 250, 120, 400]); } catch (e) { /* ignore */ } }
        renderRest();
      }
    }
    const el = $('#elapsed');
    if (el && S.active) {
      const min = Math.floor((Date.now() - Date.parse(S.active.startedAt)) / 60000);
      el.textContent = 'Week ' + S.active.week + ' · ' + min + ' min in';
    }
  }

  /* ---------------- workout lifecycle ---------------- */
  function startWorkout(w) {
    const m = merged();
    const today = L.todayStr();
    const week = L.programWeek(m.sessions, today);
    const a = { sessionId: uid(), workout: w, date: today, startedAt: new Date().toISOString(), week, warmup: false, exercises: {} };
    PLAN.workouts[w].exercises.forEach((ex) => {
      const hist = L.historyFor(ex.id, m.sessions, m.sets);
      const sg = L.suggest(ex, hist);
      const last = hist[hist.length - 1];
      let variant = ex.variants ? ex.variants[0] : '';
      if (ex.variants && last) {
        const used = last.sets.map((s) => s.variant).filter(Boolean);
        if (used.length && ex.variants.indexOf(used[0]) >= 0) variant = used[0];
      }
      a.exercises[ex.id] = {
        variant, pain: false, tip: sg.text, tipKind: sg.kind, prevPain: !!sg.pain,
        sets: L.prefill(ex, hist, sg, L.setsFor(ex, week)),
      };
    });
    S.active = a;
    S.pick = null;
    S.focus = null;
    S.doneOpen = false;
    S.view = 'workout';
    saveActive();
    holdScreen();
    render();
    window.scrollTo(0, 0);
  }

  const exerciseDone = (id) => S.active.exercises[id].sets.every((s) => s.done);

  function toggleSet(exId, i) {
    const a = S.active;
    const ex = EX[exId];
    const s = a.exercises[exId].sets[i];
    if (s.done) { s.done = false; saveActive(); render(); return; }

    let ok = true;
    if (ex.type === 'time') {
      const sec = toNum(s.seconds);
      ok = sec != null && sec >= 1 && sec <= 3600 && sec === Math.floor(sec);
    } else {
      const reps = toNum(s.reps);
      const w = toNum(s.weight);
      ok = reps != null && reps >= 1 && reps <= 500 && reps === Math.floor(reps) && (s.weight === '' || (w != null && w >= 0 && w <= 1000));
    }
    if (!ok) {
      const row = document.querySelector('.set[data-ex="' + exId + '"][data-i="' + i + '"]');
      if (row) row.classList.add('err');
      toast(ex.type === 'time' ? 'Enter the seconds you held' : 'Enter your reps (and weight in kg)');
      return;
    }

    s.done = true;
    const justFinished = exerciseDone(exId);
    saveActive();

    const allDone = PLAN.workouts[a.workout].exercises.every((e) => exerciseDone(e.id));
    if (justFinished) S.focus = null; // back to the to-do list automatically
    if (allDone) {
      S.rest = null; saveRest();
      finishWorkout();
      return;
    }
    startRest(ex.rest, ex.name);
    render();
  }

  function buildSession(a) {
    const sets = [];
    PLAN.workouts[a.workout].exercises.forEach((ex) => {
      const e = a.exercises[ex.id];
      e.sets.forEach((s, i) => {
        if (!s.done) return;
        const isTime = ex.type === 'time';
        sets.push({
          exerciseId: ex.id,
          exercise: ex.name,
          setNo: i + 1,
          weightKg: isTime ? null : toNum(s.weight),
          reps: isTime ? null : Math.round(toNum(s.reps)),
          seconds: isTime ? Math.round(toNum(s.seconds)) : null,
          variant: e.variant || '',
          pain: !!e.pain,
        });
      });
    });
    return { sessionId: a.sessionId, date: a.date, workout: a.workout, startedAt: a.startedAt, finishedAt: new Date().toISOString(), week: a.week, sets };
  }

  function finishWorkout() {
    const a = S.active;
    const session = buildSession(a);
    if (!session.sets.length) {
      if (window.confirm('No sets logged yet. Discard this workout?')) discardWorkout();
      return;
    }
    const planned = PLAN.workouts[a.workout].exercises.length;
    const untouched = PLAN.workouts[a.workout].exercises.filter((ex) => !a.exercises[ex.id].sets.some((s) => s.done)).length;
    if (untouched && !window.confirm(untouched + ' of ' + planned + ' exercises have no sets logged. Finish anyway?')) return;

    const m = merged();
    const prs = L.newPRs(session, m.sessions, m.sets, PLAN);
    S.pending.push(session);
    savePending();
    S.summary = {
      session, prs,
      minutes: Math.max(1, Math.round((Date.parse(session.finishedAt) - Date.parse(session.startedAt)) / 60000)),
      volume: Math.round(session.sets.reduce((t, s) => t + (s.weightKg || 0) * (s.reps || 0), 0)),
      pain: PLAN.workouts[a.workout].exercises.filter((ex) => a.exercises[ex.id].pain && a.exercises[ex.id].sets.some((s) => s.done)).map((ex) => ex.name),
    };
    S.active = null; saveActive();
    S.rest = null; saveRest();
    S.pick = null;
    S.focus = null;
    S.doneOpen = false;
    releaseScreen();
    S.view = 'summary';
    render();
    window.scrollTo(0, 0);
    sync();
  }

  function discardWorkout() {
    S.active = null; saveActive();
    S.rest = null; saveRest();
    S.focus = null;
    S.doneOpen = false;
    releaseScreen();
    S.view = 'today';
    render();
  }

  /* ---------------- charts ---------------- */
  function lineChart(points, unit) {
    if (!points.length) return '<p class="empty">No data yet. Log this exercise to see your trend.</p>';
    const W = 320, H = 170, pl = 38, pr = 12, pt = 14, pb = 26;
    const vals = points.map((p) => p.value);
    let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (lo === hi) { lo -= 1; hi += 1; }
    const span = hi - lo;
    lo = Math.max(0, lo - span * 0.15); hi += span * 0.15;
    const tickLabel = (v) => (span < 10 ? String(Math.round(v * 10) / 10) : String(Math.round(v)));
    const x = (i) => (points.length === 1 ? (pl + W - pr) / 2 : pl + (i * (W - pl - pr)) / (points.length - 1));
    const y = (v) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
    const path = points.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.value).toFixed(1)).join(' ');
    const dots = points.map((p, i) => '<circle class="dot" cx="' + x(i).toFixed(1) + '" cy="' + y(p.value).toFixed(1) + '" r="' + (i === points.length - 1 ? 5 : 3) + '"/>').join('');
    const first = points[0], last = points[points.length - 1];
    const label = 'Best ' + (unit === 's' ? 'hold' : 'weight') + ' per session, ' + points.length + ' session' + (points.length === 1 ? '' : 's') + ', from ' + kg(first.value) + ' to ' + kg(last.value) + ' ' + unit;
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(label) + '">' +
      '<line class="ax" x1="' + pl + '" y1="' + (H - pb) + '" x2="' + (W - pr) + '" y2="' + (H - pb) + '"/>' +
      '<text x="' + (pl - 6) + '" y="' + (y(hi) + 8) + '" text-anchor="end">' + tickLabel(hi) + '</text>' +
      '<text x="' + (pl - 6) + '" y="' + (y(lo) + 3) + '" text-anchor="end">' + tickLabel(lo) + '</text>' +
      (points.length > 1 ? '<path class="ln" d="' + path + '"/>' : '') + dots +
      '<text x="' + pl + '" y="' + (H - 8) + '">' + esc(fmtShort(first.date)) + '</text>' +
      (points.length > 1 ? '<text x="' + (W - pr) + '" y="' + (H - 8) + '" text-anchor="end">' + esc(fmtShort(last.date)) + '</text>' : '') +
      '</svg>';
  }

  function barChart(weeks, target) {
    const W = 320, H = 150, pl = 8, pr = 8, pt = 18, pb = 22;
    const max = Math.max(target, Math.max.apply(null, weeks.map((w) => w.count)));
    const bw = (W - pl - pr) / weeks.length;
    const y = (v) => pt + (1 - v / max) * (H - pt - pb);
    const bars = weeks.map((w, i) => {
      const bx = pl + i * bw + bw * 0.18, ww = bw * 0.64;
      const h = (H - pb) - y(w.count);
      const p = w.weekStart.split('-');
      return '<rect class="bar' + (w.count < target ? ' low' : '') + '" x="' + bx.toFixed(1) + '" y="' + y(w.count).toFixed(1) + '" width="' + ww.toFixed(1) + '" height="' + Math.max(h, w.count ? 2 : 0).toFixed(1) + '" rx="3"/>' +
        '<text class="val" x="' + (bx + ww / 2).toFixed(1) + '" y="' + (y(w.count) - 4).toFixed(1) + '" text-anchor="middle">' + w.count + '</text>' +
        '<text x="' + (bx + ww / 2).toFixed(1) + '" y="' + (H - 7) + '" text-anchor="middle">' + Number(p[2]) + '/' + Number(p[1]) + '</text>';
    }).join('');
    const total = weeks.reduce((t, w) => t + w.count, 0);
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Workouts per week over the last ' + weeks.length + ' weeks: ' + total + ' in total, target ' + target + ' per week">' +
      '<line class="tgt" x1="' + pl + '" y1="' + y(target).toFixed(1) + '" x2="' + (W - pr) + '" y2="' + y(target).toFixed(1) + '"/>' +
      '<line class="ax" x1="' + pl + '" y1="' + (H - pb) + '" x2="' + (W - pr) + '" y2="' + (H - pb) + '"/>' + bars + '</svg>';
  }

  /* ---------------- views ---------------- */
  function viewLogin() {
    return '<section class="hero"><p class="eyebrow">Gym Tracker</p><h1>Sign in</h1>' +
      '<p class="muted">Enter the key you set as APP_PASSWORD on Vercel. It stays on this phone.</p></section>' +
      '<section class="card"><label class="field">Key<input id="key-input" type="password" autocomplete="current-password" autocapitalize="none" spellcheck="false"></label>' +
      (S.sync.state === 'auth' ? '<p class="warn-text" style="margin-top:8px">That key was not accepted.</p>' : '') +
      '<div class="row-btns"><button class="btn btn-primary" data-act="save-key" data-from="login">Continue</button></div></section>';
  }

  function viewToday() {
    const m = merged();
    const today = L.todayStr();
    const week = L.programWeek(m.sessions, today);
    const next = S.pick || L.nextWorkout(m.sessions);
    const sorted = L.sortSessions(m.sessions);
    const last = sorted[sorted.length - 1];
    const thisWeek = L.weeklyCounts(m.sessions, today, 1)[0].count;
    const plan = PLAN.workouts[next];
    const other = next === 'A' ? 'B' : 'A';

    let html = '<section class="hero"><p class="eyebrow">Week ' + week + (S.active ? ' · in progress' : ' · up next') + '</p>';
    if (S.active) {
      html += '<h1>' + esc(PLAN.workouts[S.active.workout].name) + '</h1>' +
        '<p class="muted">Started ' + esc(new Date(S.active.startedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })) + '</p>' +
        '<button class="btn btn-primary btn-big" data-act="resume">Resume workout</button>' +
        '<button class="link" data-act="discard">Discard this workout</button></section>';
    } else {
      html += '<h1>' + esc(plan.name) + '</h1><p class="muted">' +
        (last ? 'Last: Day ' + esc(last.workout) + ', ' + esc(fmtDate(last.date)) : 'No workouts logged yet') + '</p>' +
        '<button class="btn btn-primary btn-big" data-act="start" data-w="' + next + '">Start ' + esc(plan.name) + '</button>' +
        '<button class="link" data-act="pick" data-w="' + (S.pick ? '' : other) + '">' + (S.pick ? 'Back to the suggested day' : 'Do Day ' + other + ' instead') + '</button></section>';
    }

    // banners
    if (week <= 2) html += '<div class="banner">Weeks 1-2: the newer moves (arms, calves, leg curl, Romanian deadlift, rear delt fly) get 2 sets. Keep every set 2-3 reps short of failure.</div>';
    if (week >= 6 && week <= 8) html += '<div class="banner">Barbell bench check: ask your doctor or physio whether a light barbell flat bench is okay before adding it.</div>';
    if (L.isDeloadWeek(week)) html += '<div class="banner">Deload week: keep the exercises but go noticeably lighter and leave more reps in the tank.</div>';
    const flagged = plan.exercises.filter((ex) => {
      const h = L.historyFor(ex.id, m.sessions, m.sets);
      return h.length && h[h.length - 1].sets.some((s) => s.pain);
    });
    if (flagged.length) html += '<div class="banner warn">You flagged pain on ' + esc(flagged.map((e) => e.name).join(', ')) + ' last time. Go lighter or swap it, and if it keeps happening see your doctor or physio.</div>';

    // this week
    let dots = '';
    for (let i = 0; i < Math.max(3, thisWeek); i++) dots += '<i class="' + (i < thisWeek ? 'on' : '') + '"></i>';
    html += '<section class="card"><h3>This week</h3><div class="dots" role="img" aria-label="' + thisWeek + ' of 3 workouts this week">' + dots + '<span>' + thisWeek + ' of 3</span></div></section>';

    // preview
    html += '<section class="card"><h3>' + esc(plan.name) + ' plan</h3><p class="muted" style="font-size:14px;margin-bottom:10px">Warm-up: ' + esc(PLAN.warmup) + '</p><ul class="plist">' +
      plan.exercises.map((ex) => {
        const h = L.historyFor(ex.id, m.sessions, m.sets);
        const sg = L.suggest(ex, h);
        return '<li><div class="row"><span>' + esc(ex.name) + '</span><span class="muted num">' + L.setsFor(ex, week) + ' × ' + ex.reps.join('-') + (ex.type === 'time' ? ' s' : '') + '</span></div><small>' + esc(sg.text) + '</small></li>';
      }).join('') + '</ul></section>';
    return html;
  }

  function todoRow(ex, isDone) {
    const e = S.active.exercises[ex.id];
    const n = e.sets.length;
    const doneSets = e.sets.filter((s) => s.done).length;
    const unit = ex.type === 'time' ? ' s' : '';
    const partial = !isDone && doneSets > 0;
    return '<li><button class="todo-row' + (isDone ? ' is-done' : '') + '" data-act="open" data-ex="' + ex.id + '" aria-label="' +
      esc(ex.name) + (isDone ? ', done. Tap to reopen' : partial ? ', ' + doneSets + ' of ' + n + ' sets done' : '') + '">' +
      '<span class="todo-chk" aria-hidden="true">' + (isDone ? '✓' : '') + '</span>' +
      '<span class="todo-main"><b>' + esc(ex.name) + '</b>' +
      '<small>' + (ex.sub ? esc(ex.sub) + ' · ' : '') + n + ' × ' + ex.reps.join('-') + unit + (e.tip ? ' · ' + esc(e.tip) : '') + '</small></span>' +
      (partial ? '<span class="todo-badge">' + doneSets + ' of ' + n + ' sets</span>' : '') +
      '</button></li>';
  }

  function viewTodoList() {
    const plan = PLAN.workouts[S.active.workout];
    const list = plan.exercises;
    const doneList = list.filter((ex) => exerciseDone(ex.id));
    const todoList = list.filter((ex) => !exerciseDone(ex.id));

    let html = '<section class="card" style="margin-top:0"><label class="check" style="margin:0"><input type="checkbox" data-role="warmup"' + (S.active.warmup ? ' checked' : '') + '><span>Warm-up done<br><span class="muted">' + esc(PLAN.warmup) + '</span></span></label></section>' +
      '<p class="todo-progress num" aria-live="polite">' + doneList.length + ' of ' + list.length + ' done</p>' +
      '<ul class="todo-list">' + (todoList.length
        ? todoList.map((ex) => todoRow(ex, false)).join('')
        : '<li class="empty-row">All exercises done. Finish when you are ready.</li>') + '</ul>';

    if (doneList.length) {
      html += '<section class="done-section' + (S.doneOpen ? ' is-open' : '') + '">' +
        '<button class="done-head" data-act="toggle-done" aria-expanded="' + S.doneOpen + '">Done (' + doneList.length + ')</button>' +
        (S.doneOpen ? '<ul class="todo-list">' + doneList.map((ex) => todoRow(ex, true)).join('') + '</ul>' : '') +
        '</section>';
    }

    html += '<button class="btn btn-primary btn-big finish" data-act="finish">Finish workout</button>';
    return html;
  }

  function viewFocus(exId) {
    const ex = EX[exId];
    const e = S.active.exercises[exId];
    const n = e.sets.length;
    const doneSets = e.sets.filter((s) => s.done).length;
    let html = '<button class="link focus-back" data-act="to-list">‹ Back to list</button>' +
      '<section class="card focus-card" data-ex="' + ex.id + '">' +
      '<h2 class="focus-title">' + esc(ex.name) + '</h2>' +
      '<p class="muted num" aria-live="polite">' + n + ' × ' + ex.reps.join('-') + (ex.type === 'time' ? ' s' : '') +
        ' · ' + doneSets + ' of ' + n + ' done · rest ' + restLabel(ex.rest) + '</p>' +
      '<p class="tip ' + esc(e.tipKind) + '">' + esc(e.tip) + '</p>' +
      '<p class="cue">' + esc(ex.cue) + '</p>';
    if (ex.warn) html += '<p class="warn-text">' + esc(ex.warn) + '</p>';
    if (e.prevPain) html += '<p class="warn-text">You flagged pain here last time. Go lighter, or swap it.</p>';
    if (ex.variants) {
      html += '<label class="variant">Which one today?<select data-role="variant" data-ex="' + ex.id + '">' +
        ex.variants.map((v) => '<option' + (v === e.variant ? ' selected' : '') + '>' + esc(v) + '</option>').join('') + '</select></label>';
    }
    e.sets.forEach((s, i) => {
      const field = (name, val, label, mode) =>
        '<label class="f"><span>' + label + '</span><input type="text" inputmode="' + mode + '" enterkeyhint="done" autocomplete="off" data-f="' + name + '" value="' + esc(val) + '" aria-label="Set ' + (i + 1) + ' ' + label + '"></label>';
      html += '<div class="set' + (s.done ? ' is-done' : '') + '" data-ex="' + ex.id + '" data-i="' + i + '"><span class="set-n">' + (i + 1) + '</span>' +
        (ex.type === 'time' ? field('seconds', s.seconds, 'seconds', 'numeric') : field('weight', s.weight, 'kg', 'decimal') + field('reps', s.reps, 'reps', 'numeric')) +
        '<button class="set-ok" data-act="set" data-ex="' + ex.id + '" data-i="' + i + '" aria-pressed="' + !!s.done + '" aria-label="' + (s.done ? 'Undo set ' : 'Log set ') + (i + 1) + '">' + (s.done ? '✓ Done' : 'Log') + '</button></div>';
    });
    html += '<label class="check"><input type="checkbox" data-role="pain" data-ex="' + ex.id + '"' + (e.pain ? ' checked' : '') + '> Felt pain or pinching here</label>' +
      '</section>';
    return html;
  }

  function viewWorkout() {
    return S.focus ? viewFocus(S.focus) : viewTodoList();
  }

  function viewSummary() {
    const sm = S.summary;
    const queued = S.pending.some((p) => p.sessionId === sm.session.sessionId);
    return '<section class="hero"><p class="eyebrow">Workout saved</p><h1>Nice work</h1>' +
      '<p class="muted">' + (queued ? 'Saved on this phone. It will sync to your sheet when you are online.' : 'Saved to your Google Sheet.') + '</p></section>' +
      '<div class="stats"><div class="stat"><b>' + sm.session.sets.length + '</b><span>sets</span></div><div class="stat"><b>' + sm.minutes + '</b><span>minutes</span></div><div class="stat"><b>' + sm.volume.toLocaleString('en-GB') + '</b><span>kg lifted</span></div></div>' +
      (sm.prs.length ? '<section class="card"><h3>New bests</h3><ul class="plist">' + sm.prs.map((p) => '<li><div class="row"><span>' + esc(p.name) + '</span><span class="num"><b>' + kg(p.weight) + ' kg</b></span></div></li>').join('') + '</ul></section>' : '') +
      (sm.pain.length ? '<div class="banner warn">You flagged pain on ' + esc(sm.pain.join(', ')) + '. Go lighter or swap it next time, and if it keeps happening see your doctor or physio.</div>' : '') +
      '<div class="row-btns"><button class="btn btn-primary" data-act="done">Done</button></div>';
  }

  function viewProgress() {
    const m = merged();
    const today = L.todayStr();
    const ex = EX[S.progressEx] || EX_LIST[0];
    const hist = L.historyFor(ex.id, m.sessions, m.sets);
    const ser = L.series(hist, ex);
    const unit = ex.type === 'time' ? 's' : 'kg';
    const best = ser.length ? Math.max.apply(null, ser.map((p) => p.value)) : null;
    const counts = {};
    m.sets.forEach((s) => { counts[s.sessionId] = (counts[s.sessionId] || 0) + 1; });
    const recent = L.sortSessions(m.sessions).slice(-8).reverse();

    let html = '<section class="hero"><p class="eyebrow">Progress</p><h1>' + m.sessions.length + ' workout' + (m.sessions.length === 1 ? '' : 's') + '</h1></section>' +
      '<section class="card"><h3>Workouts per week</h3><p class="muted" style="font-size:13px">Dashed line is your target of 3.</p>' + barChart(L.weeklyCounts(m.sessions, today, 8), 3) + '</section>' +
      '<section class="card"><label class="field">Exercise<select id="pex">' +
      EX_LIST.map((e) => '<option value="' + e.id + '"' + (e.id === ex.id ? ' selected' : '') + '>' + esc(e.name) + '</option>').join('') + '</select></label>' +
      lineChart(ser, unit) +
      (best != null ? '<p class="muted" style="font-size:14px;margin-top:6px">Best so far: <b class="num" style="color:var(--text)">' + kg(best) + ' ' + unit + '</b></p>' : '');
    if (hist.length) {
      html += '<ul class="plist" style="margin-top:12px">' + hist.slice(-6).reverse().map((h) => {
        const txt = ex.type === 'time'
          ? h.sets.map((s) => (s.seconds || 0) + ' s').join(', ')
          : h.sets.map((s) => (s.weightKg ? kg(s.weightKg) : 'BW') + ' × ' + (s.reps || 0)).join(', ');
        return '<li><div class="row"><span>' + esc(fmtDate(h.date)) + '</span><span class="muted" style="font-size:13px">Day ' + esc(h.workout) + '</span></div><small class="num">' + esc(txt) + (h.sets.some((s) => s.pain) ? ' · pain flagged' : '') + '</small></li>';
      }).join('') + '</ul>';
    }
    html += '</section>';

    html += '<section class="card"><h3>Recent workouts</h3>' + (recent.length ? '<ul class="plist">' + recent.map((s) => {
      const mins = Math.max(1, Math.round((Date.parse(s.finishedAt) - Date.parse(s.startedAt)) / 60000));
      return '<li><div class="row"><span>' + esc(fmtDate(s.date)) + ' · Day ' + esc(s.workout) + '</span><span class="muted num">' + (counts[s.sessionId] || 0) + ' set' + ((counts[s.sessionId] || 0) === 1 ? '' : 's') + ' · ' + mins + ' min</span></div></li>';
    }).join('') + '</ul>' : '<p class="empty">Nothing logged yet.</p>') + '</section>';
    return html;
  }

  function viewSettings() {
    const si = syncInfo();
    const at = S.sync.at ? new Date(S.sync.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never';
    return '<section class="hero"><p class="eyebrow">Settings</p><h1>Sync</h1></section>' +
      '<section class="card"><h3>Status</h3><p>' + esc(si.text || 'Idle') + (S.sync.msg ? ' · <span class="muted">' + esc(S.sync.msg) + '</span>' : '') + '</p>' +
      '<p class="muted" style="font-size:14px">Last synced: ' + esc(at) + '. Waiting to upload: ' + S.pending.length + '.</p>' +
      '<div class="row-btns"><button class="btn btn-primary" data-act="sync">Sync now</button></div></section>' +
      (S.rejected.length ? '<section class="card"><h3>Could not be saved</h3><p class="warn-text">' + S.rejected.length + ' workout(s) were rejected by the server: ' + esc(S.rejected[S.rejected.length - 1].error) + '</p>' +
        '<div class="row-btns"><button class="btn" data-act="retry-rejected">Try again</button><button class="btn btn-danger" data-act="drop-rejected">Discard</button></div></section>' : '') +
      '<section class="card"><h3>Key</h3><label class="field">New key<input id="key-input" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Leave empty to keep the current key"></label>' +
      '<div class="row-btns"><button class="btn" data-act="save-key" data-from="settings">Save key</button><button class="btn btn-danger" data-act="sign-out">Sign out</button></div></section>' +
      '<section class="card"><h3>Install on your phone</h3><p class="muted" style="font-size:14px">iPhone: Share, then Add to Home Screen. Android: browser menu, then Install app. It opens full screen and works offline; sets sync when you are back online.</p></section>';
  }

  /* ---------------- render ---------------- */
  function renderTop() {
    const el = $('#top');
    if (S.view === 'workout' && S.active) {
      el.innerHTML = '<button class="icon-btn" data-act="back" aria-label="Back to home">‹</button>' +
        '<div class="top-title"><strong>' + esc(PLAN.workouts[S.active.workout].name) + '</strong><span class="muted" id="elapsed"></span></div>' +
        '<button class="btn btn-small btn-primary" data-act="finish">Finish</button>';
      tick();
      return;
    }
    const si = syncInfo();
    el.innerHTML = '<div class="brand">GYM</div>' + (si.text && S.view !== 'login'
      ? '<button class="sync ' + si.cls + '" data-act="sync" aria-label="Sync now. ' + esc(si.text) + '"><i></i>' + esc(si.text) + '</button>' : '');
  }

  function renderNav() {
    const tabs = [['today', '●', 'Today'], ['progress', '▲', 'Progress'], ['settings', '⚙', 'Settings']];
    const show = ['today', 'progress', 'settings'].indexOf(S.view) >= 0;
    $('#nav').innerHTML = show ? tabs.map((t) =>
      '<button data-act="tab" data-v="' + t[0] + '"' + (S.view === t[0] ? ' aria-current="page"' : '') + '><b aria-hidden="true">' + t[1] + '</b>' + t[2] + '</button>').join('') : '';
  }

  function render() {
    if (!S.key && S.view !== 'login') S.view = 'login';
    if (S.view === 'workout' && !S.active) S.view = 'today';
    document.body.classList.toggle('in-workout', S.view === 'workout');
    renderTop();
    renderNav();
    const views = { login: viewLogin, today: viewToday, workout: viewWorkout, summary: viewSummary, progress: viewProgress, settings: viewSettings };
    $('#main').innerHTML = views[S.view]();
    renderRest();
  }

  /* ---------------- events ---------------- */
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-act]');
    if (!t) return;
    const d = t.dataset;
    switch (d.act) {
      case 'tab': S.view = d.v; render(); window.scrollTo(0, 0); break;
      case 'start': startWorkout(d.w); break;
      case 'pick': S.pick = d.w || null; render(); break;
      case 'resume': S.view = 'workout'; holdScreen(); render(); break;
      case 'back': S.view = 'today'; S.focus = null; render(); break;
      case 'discard': if (window.confirm('Discard this workout? Logged sets will be lost.')) discardWorkout(); break;
      case 'open': S.focus = d.ex; render(); window.scrollTo(0, 0); break;
      case 'to-list': S.focus = null; render(); window.scrollTo(0, 0); break;
      case 'toggle-done': S.doneOpen = !S.doneOpen; render(); break;
      case 'set': toggleSet(d.ex, Number(d.i)); break;
      case 'finish': finishWorkout(); break;
      case 'done': S.summary = null; S.view = 'today'; render(); window.scrollTo(0, 0); break;
      case 'sync': sync(); break;
      case 'rest-add':
        if (S.rest) { S.rest.endsAt += Number(d.s) * 1000; S.rest.total = Math.max(15, S.rest.total + Number(d.s)); S.rest.fired = false; saveRest(); renderRest(); }
        break;
      case 'rest-skip': S.rest = null; saveRest(); renderRest(); break;
      case 'save-key': {
        const v = ($('#key-input').value || '').trim();
        if (!v) { if (d.from === 'settings') toast('Key unchanged'); else toast('Enter your key'); break; }
        S.key = v; ls.set('gt_key', v);
        S.sync.state = 'idle';
        if (d.from === 'login') S.view = 'today';
        render(); sync();
        toast('Key saved');
        break;
      }
      case 'sign-out':
        if (window.confirm('Sign out? Workouts waiting to sync stay on this phone.')) { S.key = ''; ls.del('gt_key'); S.view = 'login'; render(); }
        break;
      case 'retry-rejected':
        S.rejected.forEach((r) => S.pending.push(r.session)); S.rejected = []; ls.set('gt_rejected', []); savePending(); render(); sync();
        break;
      case 'drop-rejected': S.rejected = []; ls.set('gt_rejected', []); render(); break;
      default: break;
    }
  });

  // Typing only updates saved state. No re-render, so the keyboard never closes.
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (!t.dataset || !t.dataset.f || !S.active) return;
    const row = t.closest('.set');
    if (!row) return;
    S.active.exercises[row.dataset.ex].sets[Number(row.dataset.i)][t.dataset.f] = t.value;
    row.classList.remove('err');
    saveActive();
  });

  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.id === 'pex') { S.progressEx = t.value; render(); return; }
    if (!S.active || !t.dataset) return;
    if (t.dataset.role === 'variant') { S.active.exercises[t.dataset.ex].variant = t.value; saveActive(); }
    if (t.dataset.role === 'pain') { S.active.exercises[t.dataset.ex].pain = t.checked; saveActive(); }
    if (t.dataset.role === 'warmup') { S.active.warmup = t.checked; saveActive(); }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.id === 'key-input') {
      const btn = document.querySelector('[data-act="save-key"]');
      if (btn) btn.click();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (S.active && S.view === 'workout') holdScreen();
    tick();
    if (S.key && (!S.sync.at || Date.now() - S.sync.at > 60000 || S.pending.length)) sync();
  });
  window.addEventListener('online', () => { if (S.key) sync(); });

  /* ---------------- boot ---------------- */
  function boot() {
    if (S.rest && Date.now() - S.rest.endsAt > 10 * 60 * 1000) { S.rest = null; saveRest(); }
    if (S.active) { S.view = 'workout'; S.focus = null; holdScreen(); }
    render();
    setInterval(tick, 500);
    if (S.key) sync();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* offline shell is a bonus */ });
    }
  }
  boot();
})();
