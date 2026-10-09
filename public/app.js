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
  const TICK_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12.5 10 17 19 7"></polyline></svg>';
  const BACK_SVG = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 5 8 12 15 19"></polyline></svg>';
  const CHEV_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';
  const arrowGlyph = (kind) => (kind === 'increase' ? '↑' : kind === 'drop' ? '↓' : '=');
  const arrowCls = (kind) => (kind === 'increase' || kind === 'start' ? 'up' : kind === 'drop' ? 'down' : 'hold');
  const tipCardCls = (kind) => (kind === 'increase' || kind === 'start' ? 'increase' : kind === 'drop' ? 'drop' : 'hold');
  function chipLabel(ex, sg) {
    if (sg.kind === 'start') return '—';
    if (ex.type === 'time') return sg.seconds + ' s';
    return kg(sg.weight) + ' kg';
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
  function pillButton() {
    const si = syncInfo();
    if (!si.text) return '';
    return '<button class="sync ' + si.cls + '" data-act="sync" aria-label="Sync now. ' + esc(si.text) + '"><i></i>' + esc(si.text) + '</button>';
  }

  /* ---------------- theme ---------------- */
  function applyTheme() {
    const t = ls.get('gt_theme', '');
    if (t) document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
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
    if (done) {
      el.innerHTML = '<div class="rest-bar is-done"><div class="rest-row">' +
        '<strong id="rest-time">Go</strong>' +
        '<span class="rest-go-body">Rest over<br>' + esc(S.rest.label) + '</span>' +
        '<button class="rest-skip-btn" data-act="rest-skip">OK</button>' +
        '</div></div>';
    } else {
      el.innerHTML = '<div class="rest-bar"><div class="rest-fill" id="rest-fill"></div><div class="rest-fill-line" id="rest-fill-line"></div>' +
        '<div class="rest-row"><div style="flex:1;min-width:0"><span class="rest-label">Rest · ' + esc(S.rest.label) + '</span>' +
        '<strong id="rest-time">' + clock(restLeft()) + '</strong></div>' +
        '<div class="rest-btns"><button data-act="rest-add" data-s="-15" aria-label="15 seconds less">−15</button><button data-act="rest-add" data-s="15" aria-label="15 seconds more">+15</button></div>' +
        '<button class="rest-skip-btn" data-act="rest-skip">Skip</button>' +
        '</div></div>';
    }
    tick();
  }
  function tick() {
    if (S.rest && S.view === 'workout') {
      const left = restLeft();
      const t = $('#rest-time');
      const f = $('#rest-fill');
      const fl = $('#rest-fill-line');
      if (left > 0) {
        if (t) t.textContent = clock(left);
        const pct = Math.min(100, ((S.rest.total - left) / S.rest.total) * 100) + '%';
        if (f) f.style.width = pct;
        if (fl) fl.style.width = pct;
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
      el.textContent = 'WEEK ' + S.active.week + ' · ' + min + ' MIN';
    }
  }

  /* ---------------- workout lifecycle ---------------- */
  function normalizeSets(ex, rows) {
    return rows.map((r) => (ex.type === 'time'
      ? { seconds: Number(r.seconds) || ex.reps[0], done: false }
      : { weight: Number(r.weight) || 0, reps: Number(r.reps) || ex.reps[0], done: false }));
  }

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
        sets: normalizeSets(ex, L.prefill(ex, hist, sg, L.setsFor(ex, week))),
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
  const activeIndex = (e) => e.sets.findIndex((s) => !s.done);

  function stepSet(exId, i, field, dir) {
    const s = S.active.exercises[exId].sets[i];
    if (field === 'weight') {
      const step = EX[exId].jump || 1;
      s.weight = Math.max(0, Math.min(1000, Math.round((s.weight + dir * step) * 100) / 100));
    } else if (field === 'reps') {
      s.reps = Math.max(1, Math.min(500, s.reps + dir));
    } else if (field === 'seconds') {
      s.seconds = Math.max(5, Math.min(3600, s.seconds + dir * 5));
    }
    saveActive();
    render();
  }

  function toggleSet(exId, i) {
    const a = S.active;
    const ex = EX[exId];
    const s = a.exercises[exId].sets[i];
    if (s.done) { s.done = false; saveActive(); render(); return; }

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
    const dots = points.map((p, i) => '<circle class="dot' + (i === points.length - 1 ? ' last' : '') + '" cx="' + x(i).toFixed(1) + '" cy="' + y(p.value).toFixed(1) + '" r="' + (i === points.length - 1 ? 6 : 3) + '"/>').join('');
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
    return '<section class="hero" style="padding-top:28px">' +
      '<h1 style="font-size:34px;line-height:1.1;font-weight:650;letter-spacing:-.02em">' + (S.sync.state === 'auth' ? 'Wrong key' : 'Welcome back') + '</h1>' +
      '<p class="meta">Your key unlocks your plan and training history. It stays on this phone.</p></section>' +
      '<div class="key-field"><label>Access key</label>' +
      '<input id="key-input" type="password" autocomplete="current-password" autocapitalize="none" spellcheck="false" placeholder="Passphrase">' +
      (S.sync.state === 'auth' ? '<span class="err">That key was not accepted.</span>' : '<span class="hint">This is the APP_PASSWORD set on your server.</span>') +
      '</div>' +
      '<button class="btn btn-primary btn-big" data-act="save-key" data-from="login" style="margin-top:24px">Unlock</button>';
  }

  function dayStrip(sessions, today) {
    const names = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const base = new Date(today + 'T00:00:00Z');
    const sessDates = new Set(sessions.map((s) => s.date));
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(base); d.setUTCDate(base.getUTCDate() - i);
      const ds = d.toISOString().slice(0, 10);
      days.push({ l: names[d.getUTCDay()], isToday: ds === today, isDone: ds !== today && sessDates.has(ds) });
    }
    return '<div class="day-strip">' + days.map((d) =>
      '<div><span class="dl' + (d.isToday ? ' today' : '') + '">' + d.l + '</span><span class="day-dot">' +
      (d.isDone ? '<span class="done">' + TICK_SVG + '</span>' : d.isToday ? '<span class="ring"><i></i></span>' : '<span class="rest"></span>') +
      '</span></div>').join('') + '</div>';
  }

  function previewRow(ex, i, m) {
    const h = L.historyFor(ex.id, m.sessions, m.sets);
    const sg = L.suggest(ex, h);
    const unit = ex.type === 'time' ? ' s' : '';
    return '<div class="prev-row"><span class="n mono">' + (i + 1) + '</span><span class="nm">' + esc(ex.name) + '</span>' +
      '<span class="scheme num">' + ex.reps.join('-') + unit + '</span>' +
      '<span class="chip">' + esc(chipLabel(ex, sg)) + '<span class="' + arrowCls(sg.kind) + '">' + arrowGlyph(sg.kind) + '</span></span></div>';
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

    let html = '<p class="eyebrow mono" style="margin-top:4px">' + esc(fmtDate(today)) + '</p>';
    html += '<section class="hero" style="padding-top:4px">';
    if (S.active) {
      html += '<p class="eyebrow">In progress</p><h1 style="font-size:40px">' + esc(PLAN.workouts[S.active.workout].name) + '</h1>' +
        '<p class="meta">Started ' + esc(new Date(S.active.startedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })) + '</p>' +
        '<button class="btn btn-primary btn-big" data-act="resume">Resume workout</button>' +
        '<button class="link" data-act="discard">Discard this workout</button>';
    } else {
      html += '<p class="eyebrow">Next up</p><h1>' + esc(plan.name) + '</h1>' +
        '<p class="meta">' + (last ? 'Last: Day ' + esc(last.workout) + ', ' + esc(fmtDate(last.date)) : 'No workouts logged yet') + ' · Week ' + week + '</p>';
    }
    html += '</section>';

    // banners
    const banners = [];
    if (week <= 2) banners.push({ cls: '', title: 'New moves: 2 sets', body: 'Arms, calves, leg curl, Romanian deadlift and rear delt fly get 2 sets in weeks 1-2. Keep every set 2-3 reps short of failure.' });
    if (week >= 6 && week <= 8) banners.push({ cls: '', title: 'Barbell bench check', body: 'Ask your doctor or physio whether a light barbell flat bench is okay before adding it.' });
    if (L.isDeloadWeek(week)) banners.push({ cls: '', title: 'Deload week', body: 'Keep the exercises but go noticeably lighter and leave more reps in the tank.' });
    const flagged = plan.exercises.filter((ex) => {
      const h = L.historyFor(ex.id, m.sessions, m.sets);
      return h.length && h[h.length - 1].sets.some((s) => s.pain);
    });
    if (flagged.length) banners.push({ cls: 'warn', title: 'Pain flagged last time', body: 'You flagged pain on ' + flagged.map((e) => e.name).join(', ') + '. Go lighter or swap it, and if it keeps happening see your doctor or physio.' });
    if (banners.length) {
      html += banners.map((b) => '<div class="banner' + (b.cls ? ' ' + b.cls : '') + '"><i></i><div class="banner-body"><b>' + esc(b.title) + '</b><span>' + esc(b.body) + '</span></div></div>').join('');
    }

    // this week
    html += '<section class="card"><div class="progress-head" style="margin:0"><span class="eyebrow">This week</span><span class="count num">' + thisWeek + ' of 3</span></div>' + dayStrip(m.sessions, today) + '</section>';

    // preview
    if (!S.active) {
      html += '<div class="progress-head" style="margin-top:24px;margin-bottom:0"><span class="eyebrow">Today\'s exercises</span><span class="mono" style="font-size:12px;color:var(--tx3)">' + plan.exercises.length + '</span></div>' +
        plan.exercises.slice(0, 4).map((ex, i) => previewRow(ex, i, m)).join('') +
        (plan.exercises.length > 4 ? '<div class="prev-row" style="color:var(--tx3);border-bottom:0">+ ' + (plan.exercises.length - 4) + ' more</div>' : '') +
        '<button class="btn btn-primary btn-big" data-act="start" data-w="' + next + '" style="display:flex;justify-content:space-between;align-items:center;margin-top:20px">' +
        '<span>Start ' + esc(plan.name) + '</span><span class="mono" style="font-size:13px;opacity:.7">' + next + ' · ' + plan.exercises.length + ' EX</span></button>' +
        '<button class="link" data-act="pick" data-w="' + (S.pick ? '' : other) + '" style="display:block;margin:4px auto 0">' + (S.pick ? 'Back to the suggested day' : 'Do Day ' + other + ' instead') + '</button>';
    }
    return html;
  }

  function todoRow(ex, isDone) {
    const e = S.active.exercises[ex.id];
    const n = e.sets.length;
    const doneSets = e.sets.filter((s) => s.done).length;
    const unit = ex.type === 'time' ? ' s' : '';
    const partial = !isDone && doneSets > 0;
    const pct = n ? Math.round((doneSets / n) * 100) : 0;
    return '<li><button class="todo-row' + (isDone ? ' is-done' : '') + '" data-act="open" data-ex="' + ex.id + '" aria-label="' +
      esc(ex.name) + (isDone ? ', done. Tap to reopen' : partial ? ', ' + doneSets + ' of ' + n + ' sets done' : '') + '">' +
      '<span class="todo-ring' + (partial ? ' partial' : '') + '"' + (partial ? ' style="--pct:' + pct + '%"' : '') + ' aria-hidden="true">' +
      (isDone ? TICK_SVG : '<i></i>') + '</span>' +
      '<span class="todo-main"><b>' + esc(ex.name) + '</b>' +
      '<small>' + (ex.sub ? esc(ex.sub) + ' · ' : '') + n + ' × ' + ex.reps.join('-') + unit + (partial ? '<span class="pct">· ' + doneSets + ' of ' + n + ' sets</span>' : '') + '</small></span>' +
      (!isDone ? '<span class="chip">' + esc(chipLabel(ex, { kind: e.tipKind, weight: e.sets[0] ? e.sets[0].weight : 0, seconds: e.sets[0] ? e.sets[0].seconds : 0 })) + '<span class="' + arrowCls(e.tipKind) + '">' + arrowGlyph(e.tipKind) + '</span></span>' : '') +
      '</button></li>';
  }

  function doneRow(ex) {
    const e = S.active.exercises[ex.id];
    const summary = ex.type === 'time'
      ? e.sets.map((s) => s.seconds + 's').join(', ')
      : e.sets.map((s) => kg(s.weight) + '×' + s.reps).join(', ');
    return '<li><button data-act="open" data-ex="' + ex.id + '"><span class="tick-sm">' + TICK_SVG + '</span><span class="nm">' + esc(ex.name) + '</span><span class="sum num">' + esc(summary) + '</span></button></li>';
  }

  function viewTodoList() {
    const plan = PLAN.workouts[S.active.workout];
    const list = plan.exercises;
    const doneList = list.filter((ex) => exerciseDone(ex.id));
    const todoList = list.filter((ex) => !exerciseDone(ex.id));
    const left = list.length - doneList.length;

    let html = '<label class="check" style="margin-top:4px"><input type="checkbox" data-role="warmup"' + (S.active.warmup ? ' checked' : '') + '><span>Warm-up done<br><span class="muted">' + esc(PLAN.warmup) + '</span></span></label>' +
      '<div class="progress-head" style="margin-top:18px"><span class="count num">' + doneList.length + ' of ' + list.length + ' done</span><span class="left mono">' + left + ' left</span></div>' +
      '<div class="segs">' + list.map((ex) => '<i class="' + (exerciseDone(ex.id) ? 'on' : '') + '"></i>').join('') + '</div>';

    if (todoList.length) {
      html += '<div class="section-label">Up next</div><ul class="todo-list">' + todoList.map((ex) => todoRow(ex, false)).join('') + '</ul>';
    } else {
      html += '<div class="empty-row"><div class="tick-lg">' + TICK_SVG + '</div><b>Everything&rsquo;s logged</b><span>Finish the workout to save it and sync your sets.</span></div>';
    }

    if (doneList.length) {
      html += '<div class="done-section' + (S.doneOpen ? ' is-open' : '') + '">' +
        '<button class="done-head" data-act="toggle-done" aria-expanded="' + S.doneOpen + '"><span class="eyebrow">Done</span><span class="count">' + doneList.length + '</span><span class="rule"></span>' + CHEV_SVG + '</button>' +
        (S.doneOpen ? '<ul class="done-rows">' + doneList.map((ex) => doneRow(ex)).join('') + '</ul>' : '') +
        '</div>';
    }

    html += '<button class="btn btn-primary btn-big finish" data-act="finish">Finish workout</button>';
    return html;
  }

  function viewFocus(exId) {
    const ex = EX[exId];
    const e = S.active.exercises[exId];
    const n = e.sets.length;
    const isTime = ex.type === 'time';
    const act = activeIndex(e);

    let html = '<button class="link focus-back" data-act="to-list">' + BACK_SVG + 'Workout</button>' +
      '<h2 class="focus-title">' + esc(ex.name) + '</h2>' +
      '<div class="focus-meta">' + n + ' × ' + ex.reps.join('-') + (isTime ? ' s' : '') + (ex.sub ? ' · ' + esc(ex.sub) : '') + ' · rest ' + restLabel(ex.rest) + '</div>' +
      '<div class="tip ' + tipCardCls(e.tipKind) + '"><div class="tip-arrow">' + arrowGlyph(e.tipKind) + '</div><div class="tip-body"><span>' + esc(e.tip) + '</span></div></div>';

    if (e.prevPain) html += '<p class="warn-text">You flagged pain here last time. Go lighter, or swap it.</p>';
    if (ex.warn) html += '<p class="warn-text">' + esc(ex.warn) + '</p>';

    if (ex.variants) {
      html += '<div class="section-label" style="margin-top:22px">Variant</div><div class="variant-seg">' +
        ex.variants.map((v) => '<button data-act="variant" data-ex="' + ex.id + '" data-v="' + esc(v) + '" class="' + (v === e.variant ? 'on' : '') + '">' + esc(v) + '</button>').join('') + '</div>';
    }

    html += '<div class="section-label" style="margin-top:22px">Sets</div><div>';
    e.sets.forEach((s, i) => {
      if (i === act) {
        html += '<div class="set-active" data-ex="' + ex.id + '" data-i="' + i + '">' +
          '<div class="hd"><span class="now">Set ' + (i + 1) + ' · now</span></div>' +
          '<div class="stepper-grid">' +
          (isTime ? '' :
            '<div class="stepper"><span class="lbl">Weight · kg</span><div class="row">' +
            '<button data-act="step" data-ex="' + ex.id + '" data-i="' + i + '" data-f="weight" data-d="-1" aria-label="Decrease weight">−</button>' +
            '<span class="val num">' + kg(s.weight) + '</span>' +
            '<button data-act="step" data-ex="' + ex.id + '" data-i="' + i + '" data-f="weight" data-d="1" aria-label="Increase weight">+</button></div></div>') +
          '<div class="stepper"><span class="lbl">' + (isTime ? 'Seconds' : 'Reps') + '</span><div class="row">' +
          '<button data-act="step" data-ex="' + ex.id + '" data-i="' + i + '" data-f="' + (isTime ? 'seconds' : 'reps') + '" data-d="-1" aria-label="Decrease">−</button>' +
          '<span class="val num">' + (isTime ? s.seconds : s.reps) + '</span>' +
          '<button data-act="step" data-ex="' + ex.id + '" data-i="' + i + '" data-f="' + (isTime ? 'seconds' : 'reps') + '" data-d="1" aria-label="Increase">+</button></div></div>' +
          '</div>' +
          '<button class="log-btn" data-act="set" data-ex="' + ex.id + '" data-i="' + i + '">' + TICK_SVG + 'Log set ' + (i + 1) + '</button>' +
          '</div>';
      } else {
        const clickable = s.done;
        html += '<div class="set-compact' + (s.done ? ' is-done' : '') + '"><span class="num mono">' + (i + 1) + '</span>' +
          '<span class="vals">' + (isTime
            ? '<span class="w">' + s.seconds + '</span><span class="u">s</span>'
            : '<span class="w">' + kg(s.weight) + '</span><span class="u">kg</span><span class="r">× ' + s.reps + '</span>') + '</span>' +
          '<button class="tick-btn' + (s.done ? ' done' : '') + '"' + (clickable ? ' data-act="set" data-ex="' + ex.id + '" data-i="' + i + '"' : ' disabled') +
          ' aria-label="' + (s.done ? 'Undo set ' : 'Upcoming set ') + (i + 1) + '">' + TICK_SVG + '</button></div>';
      }
    });
    html += '</div>';

    html += '<button class="pain-row' + (e.pain ? ' on' : '') + '" data-act="toggle-pain" data-ex="' + ex.id + '">' +
      '<span class="pain-box">' + (e.pain ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12.5 10 17 19 7"></polyline></svg>' : '') + '</span>' +
      '<div class="pain-text"><b>Felt pain or pinching</b><span>' + (e.pain ? 'Flagged for this session.' : 'Tap if something felt off.') + '</span></div></button>';

    html += '<div class="section-label" style="margin-top:22px">Form cue</div><p class="cue">' + esc(ex.cue) + '</p>';
    return html;
  }

  function viewWorkout() {
    return S.focus ? viewFocus(S.focus) : viewTodoList();
  }

  function viewSummary() {
    const sm = S.summary;
    const queued = S.pending.some((p) => p.sessionId === sm.session.sessionId);
    return '<section class="hero" style="padding-top:24px"><div class="tick-lg" style="animation:gtPop .45s ease-out">' + TICK_SVG + '</div>' +
      '<h1 style="margin-top:20px;font-size:40px">Workout done</h1>' +
      '<p class="meta">' + esc(PLAN.workouts[sm.session.workout].name) + ' · Week ' + sm.session.week + ' · ' + esc(fmtDate(sm.session.date)) + '</p>' +
      '<p class="meta" style="margin-top:4px">' + (queued ? 'Saved on this phone. It will sync to your sheet when you are online.' : 'Saved to your Google Sheet.') + '</p></section>' +
      '<div class="stats"><div class="stat"><span class="lbl">Sets</span><span class="big"><b>' + sm.session.sets.length + '</b></span></div>' +
      '<div class="stat"><span class="lbl">Minutes</span><span class="big"><b>' + sm.minutes + '</b></span></div>' +
      '<div class="stat"><span class="lbl">Kg lifted</span><span class="big"><b>' + sm.volume.toLocaleString('en-GB') + '</b></span></div>' +
      '<div class="stat"><span class="lbl">New PRs</span><span class="big"><b>' + sm.prs.length + '</b></span></div></div>' +
      (sm.prs.length ? '<div class="section-label" style="margin-top:26px;color:var(--ac-ink)">New personal records · ' + sm.prs.length + '</div>' +
        sm.prs.map((p) => '<div class="pr-row"><span class="pr-badge">PR</span><div class="nm"><b>' + esc(p.name) + '</b></div><span class="val num">' + kg(p.weight) + ' kg</span></div>').join('') : '') +
      (sm.pain.length ? '<div class="banner warn" style="margin-top:16px"><i></i><div class="banner-body"><span>You flagged pain on ' + esc(sm.pain.join(', ')) + '. Go lighter or swap it next time, and if it keeps happening see your doctor or physio.</span></div></div>' : '') +
      '<button class="btn btn-primary btn-big" data-act="done" style="margin-top:20px">Done</button>';
  }

  function viewProgress() {
    const m = merged();
    const today = L.todayStr();
    const ex = EX[S.progressEx] || EX_LIST[0];
    const hist = L.historyFor(ex.id, m.sessions, m.sets);
    const ser = L.series(hist, ex);
    const unit = ex.type === 'time' ? 's' : 'kg';
    const best = ser.length ? Math.max.apply(null, ser.map((p) => p.value)) : null;
    const change = ser.length > 1 ? ser[ser.length - 1].value - ser[ser.length - 2].value : 0;
    const counts = {};
    m.sets.forEach((s) => { counts[s.sessionId] = (counts[s.sessionId] || 0) + 1; });
    const recent = L.sortSessions(m.sessions).slice(-8).reverse();

    let html = '<h1 style="margin:8px 0 0;font-size:40px;font-weight:700;font-stretch:115%;letter-spacing:-.03em">Progress</h1>' +
      '<section class="card"><h3>Workouts per week</h3><p class="muted" style="font-size:13px">Dashed line is your target of 3.</p>' + barChart(L.weeklyCounts(m.sessions, today, 8), 3) + '</section>' +
      '<div class="chip-row" style="margin-top:16px">' + EX_LIST.map((e) => '<button class="filter-chip' + (e.id === ex.id ? ' on' : '') + '" data-act="pex" data-id="' + e.id + '">' + esc(e.name) + '</button>').join('') + '</div>' +
      '<section class="card">' +
      '<div class="top-set"><div class="top-set-val"><span class="eyebrow">Top set</span><span class="big"><b>' + (best != null ? kg(best) : '—') + '</b><span>' + unit + '</span></span></div>' +
      (change ? '<span class="top-set-change">' + (change > 0 ? '+' : '') + kg(change) + ' ' + unit + '</span>' : '') + '</div>' +
      lineChart(ser, unit) +
      '</section>';
    if (hist.length) {
      html += '<ul class="plist" style="margin-top:12px">' + hist.slice(-6).reverse().map((h) => {
        const txt = ex.type === 'time'
          ? h.sets.map((s) => (s.seconds || 0) + ' s').join(', ')
          : h.sets.map((s) => (s.weightKg ? kg(s.weightKg) : 'BW') + ' × ' + (s.reps || 0)).join(', ');
        return '<li><div class="row"><span>' + esc(fmtDate(h.date)) + '</span><span class="muted" style="font-size:13px">Day ' + esc(h.workout) + '</span></div><small class="num">' + esc(txt) + (h.sets.some((s) => s.pain) ? ' · pain flagged' : '') + '</small></li>';
      }).join('') + '</ul>';
    }

    html += '<section class="card"><h3>Recent workouts</h3>' + (recent.length ? '<ul class="plist">' + recent.map((s) => {
      const mins = Math.max(1, Math.round((Date.parse(s.finishedAt) - Date.parse(s.startedAt)) / 60000));
      return '<li><div class="row"><span>' + esc(fmtDate(s.date)) + ' · Day ' + esc(s.workout) + '</span><span class="muted num">' + (counts[s.sessionId] || 0) + ' set' + ((counts[s.sessionId] || 0) === 1 ? '' : 's') + ' · ' + mins + ' min</span></div></li>';
    }).join('') + '</ul>' : '<p class="empty">Nothing logged yet.</p>') + '</section>';
    return html;
  }

  function viewSettings() {
    const si = syncInfo();
    const at = S.sync.at ? new Date(S.sync.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never';
    const theme = ls.get('gt_theme', '');
    const isLight = theme ? theme === 'light' : !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
    return '<h1 style="margin:8px 0 0;font-size:40px;font-weight:700;font-stretch:115%;letter-spacing:-.03em">Settings</h1>' +
      '<div class="section-label" style="margin-top:26px">Sync</div>' +
      '<div class="card">' +
      '<div class="settings-row" style="padding:0"><b>Status</b><span class="sync ' + si.cls + '"><i></i>' + esc(si.text || 'Idle') + '</span></div>' +
      '<div class="settings-row" style="padding:0;margin-top:8px"><b>Last sync</b><span class="num muted">' + esc(at) + (S.pending.length ? ' · ' + S.pending.length + ' waiting' : '') + '</span></div>' +
      '<button class="btn" data-act="sync" style="width:100%;margin-top:12px">Sync now</button>' +
      '</div>' +
      (S.rejected.length ? '<div class="card"><h3>Could not be saved</h3><p class="warn-text">' + S.rejected.length + ' workout(s) were rejected by the server: ' + esc(S.rejected[S.rejected.length - 1].error) + '</p>' +
        '<div class="row-btns"><button class="btn" data-act="retry-rejected">Try again</button><button class="btn btn-danger" data-act="drop-rejected">Discard</button></div></div>' : '') +
      '<div class="section-label" style="margin-top:26px">Appearance</div>' +
      '<div class="seg2"><button class="' + (isLight ? '' : 'on') + '" data-act="theme" data-v="dark">Dark</button><button class="' + (isLight ? 'on' : '') + '" data-act="theme" data-v="light">Light</button></div>' +
      '<div class="section-label" style="margin-top:26px">Access key</div>' +
      '<div class="card">' +
      '<label class="field">New key<input id="key-input" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Leave empty to keep the current key"></label>' +
      '<div class="row-btns"><button class="btn" data-act="save-key" data-from="settings">Save key</button></div>' +
      '</div>' +
      '<button class="btn btn-danger btn-big" data-act="sign-out" style="margin-top:16px">Sign out of this phone</button>' +
      '<p class="version-note">iPhone: Share, then Add to Home Screen. Android: browser menu, then Install app. Works offline; sets sync when you are back online.</p>';
  }

  /* ---------------- render ---------------- */
  function renderTop() {
    const el = $('#top');
    if (S.view === 'workout' && S.active) {
      el.innerHTML = '<button class="icon-btn" data-act="back" aria-label="Back to home">' + BACK_SVG + '</button>' +
        '<div class="top-title"><strong>' + esc(PLAN.workouts[S.active.workout].name) + '</strong><span class="mono" id="elapsed"></span></div>' +
        '<button class="btn btn-small btn-primary" data-act="finish">Finish</button>';
      tick();
      return;
    }
    if (S.view === 'login') { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="brand"><span class="brand-mark"><span></span></span><b>Gym Tracker</b></div>' + pillButton();
  }

  function renderNav() {
    const icons = {
      today: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"></circle><circle cx="12" cy="12" r="2.5" fill="currentColor"></circle></svg>',
      progress: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="6" y1="19" x2="6" y2="13"></line><line x1="12" y1="19" x2="12" y2="6"></line><line x1="18" y1="19" x2="18" y2="10"></line></svg>',
      settings: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="8" x2="20" y2="8"></line><line x1="4" y1="16" x2="20" y2="16"></line><circle cx="9" cy="8" r="2.5" fill="var(--bg)"></circle><circle cx="15" cy="16" r="2.5" fill="var(--bg)"></circle></svg>',
    };
    const tabs = [['today', 'Today'], ['progress', 'Progress'], ['settings', 'Settings']];
    const show = ['today', 'progress', 'settings'].indexOf(S.view) >= 0;
    $('#nav').innerHTML = show ? tabs.map((t) =>
      '<button data-act="tab" data-v="' + t[0] + '"' + (S.view === t[0] ? ' aria-current="page"' : '') + '><i>' + icons[t[0]] + '</i>' + t[1] + '</button>').join('') : '';
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
      case 'step': stepSet(d.ex, Number(d.i), d.f, Number(d.d)); break;
      case 'variant': if (S.active) { S.active.exercises[d.ex].variant = d.v; saveActive(); render(); } break;
      case 'toggle-pain': if (S.active) { S.active.exercises[d.ex].pain = !S.active.exercises[d.ex].pain; saveActive(); render(); } break;
      case 'finish': finishWorkout(); break;
      case 'done': S.summary = null; S.view = 'today'; render(); window.scrollTo(0, 0); break;
      case 'sync': sync(); break;
      case 'pex': S.progressEx = d.id; render(); break;
      case 'theme': ls.set('gt_theme', d.v); applyTheme(); render(); break;
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

  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (!S.active || !t.dataset) return;
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
    applyTheme();
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
