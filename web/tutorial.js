/* RAW AROMA — tutorial.js: the in-app tutorial runner (ticket G4), the vanilla-JS/no-bundler
 * port of ALEMBIC's tutorial engine (packages/domain/src/tutorial/{schema,engine}.ts,
 * apps/web/lib/tutorial/*.js). Loaded after ws-platform.js (index.html) — depends on globals
 * defined in shell.js: tunnel, can, $, st, ROLES, session, openSheet, raConfirm, toast, escHtml,
 * errBox. Classic script, shared global scope (see index.html's own comment) — every top-level
 * `function`/`var` here is a REAL global, same as shell.js's own.
 *
 * Store (TSTORE below) is plain module-level state, NOT localStorage — server-authoritative,
 * re-fetched on load, mirroring ALEMBIC's store.js. The lesson registry itself is fetched from
 * `GET /v1/tutorial/lessons` rather than statically imported: this console has no bundler, so a
 * server round-trip (through the same encrypted tunnel() every other screen already uses) is
 * "loading it appropriately" for this runtime — see backend/api/src/tutorial/tutorial-
 * lessons.ts's header comment for the full reasoning.
 *
 * PERMISSION FILTERING (the ALEMBIC gap this port does not repeat): a lesson is hidden ENTIRELY
 * — never merely disabled — unless `can(perm)` (shell.js) is true for EVERY permission any of
 * its action/verify steps names. See tutorialVisibleLessons() below.
 */
'use strict';

  /* ---------------- store (module-level, re-fetched on load; never localStorage) ---------------- */
  var TSTORE = { lessons: null, progress: null };
  var _tutWelcomeChecked = {};

  // web/shell.js's `st.role` keys (its ROLES table) that map to a tutorial track whose name
  // differs from the role key itself. Every role key not listed here maps to a track of the
  // SAME name (procurement -> procurement, etc.); a role with no entry at all here or below
  // (superadmin, admin, compounding, filling) simply has no tutorial track yet — an honest
  // empty state, not an error.
  var TUTORIAL_ROLE_TRACK = { sales: 'dispatch' };
  function tutorialCurrentTrack() { return TUTORIAL_ROLE_TRACK[st.role] || st.role; }

  function tutorialFetchLessons() {
    if (TSTORE.lessons) return Promise.resolve(TSTORE.lessons);
    return tunnel('/v1/tutorial/lessons').then(function (res) {
      TSTORE.lessons = (res.status < 400 && res.json && res.json.data) ? res.json.data : [];
      return TSTORE.lessons;
    }).catch(function () { TSTORE.lessons = TSTORE.lessons || []; return TSTORE.lessons; });
  }
  function tutorialFetchProgress() {
    return tunnel('/v1/tutorial/progress').then(function (res) {
      TSTORE.progress = (res.status < 400 && res.json && res.json.data) ? res.json.data : [];
      return TSTORE.progress;
    }).catch(function () { TSTORE.progress = TSTORE.progress || []; return TSTORE.progress; });
  }
  function tutorialProgressFor(lessonId, track) {
    var rows = TSTORE.progress || [];
    for (var i = 0; i < rows.length; i++) { if (rows[i].lessonId === lessonId && rows[i].role === track) return rows[i]; }
    return null;
  }
  function tutorialUpsertProgressCache(row) {
    if (!row) return;
    TSTORE.progress = TSTORE.progress || [];
    for (var i = 0; i < TSTORE.progress.length; i++) {
      if (TSTORE.progress[i].lessonId === row.lessonId && TSTORE.progress[i].role === row.role) { TSTORE.progress[i] = row; return; }
    }
    TSTORE.progress.push(row);
  }
  function tutorialLessonPermissions(lesson) {
    var perms = [];
    (lesson.steps || []).forEach(function (s) { if (s.permission) perms.push(s.permission); });
    return perms;
  }
  // Hides a lesson ENTIRELY (not disables one control) unless every permission its action/verify
  // steps reference is held — the fine-grained gate ALEMBIC's own port did not have (ticket G4).
  function tutorialVisibleLessons(track) {
    return (TSTORE.lessons || []).filter(function (l) {
      if (l.track !== track) return false;
      var perms = tutorialLessonPermissions(l);
      for (var i = 0; i < perms.length; i++) { if (!can(perms[i])) return false; }
      return true;
    });
  }
  function tutorialPost(lessonId, role, event) {
    var body = { role: role, event: event };
    return tunnel('/v1/tutorial/progress/' + encodeURIComponent(lessonId), { method: 'POST', body: body });
  }

  /* ---------------- spotlight: getBoundingClientRect() + one dedicated attribute ---------------- */
  var _tutHlEl = null;
  function tutorialClearHighlight() {
    if (_tutHlEl) {
      _tutHlEl.style.boxShadow = _tutHlEl.getAttribute('data-tut-prev-shadow') || '';
      _tutHlEl.style.zIndex = _tutHlEl.getAttribute('data-tut-prev-zindex') || '';
      _tutHlEl.style.position = _tutHlEl.getAttribute('data-tut-prev-position') || '';
      _tutHlEl.removeAttribute('data-tut-prev-shadow'); _tutHlEl.removeAttribute('data-tut-prev-zindex'); _tutHlEl.removeAttribute('data-tut-prev-position');
      _tutHlEl = null;
    }
  }
  // Real spotlight, no SVG mask needed: an oversized second box-shadow dims the whole viewport
  // while the element itself stays a "hole" (box-shadow never paints under its own element).
  // getBoundingClientRect() isn't needed for THIS trick specifically, but is what a future
  // floating tooltip anchored to the target (instead of the shared openSheet() panel this file
  // uses today) would read — kept as the one source of the target's on-screen position so a
  // caller never has to special-case "where is this thing" a second way.
  function tutorialHighlight(targetAttr) {
    tutorialClearHighlight();
    if (!targetAttr) return null;
    var el = document.querySelector('[data-tutorial-target="' + targetAttr + '"]');
    if (!el) return null;
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
    el.getBoundingClientRect(); // forces layout before the shadow reads current position/size
    el.setAttribute('data-tut-prev-shadow', el.style.boxShadow || '');
    el.setAttribute('data-tut-prev-zindex', el.style.zIndex || '');
    el.setAttribute('data-tut-prev-position', el.style.position || '');
    if (!el.style.position || el.style.position === 'static') el.style.position = 'relative';
    el.style.zIndex = '9999';
    el.style.boxShadow = '0 0 0 3px var(--accent), 0 0 0 6000px rgba(20,20,19,.55)';
    el.style.transition = 'box-shadow .2s';
    _tutHlEl = el;
    return el;
  }

  /* ---------------- verify: poll a real GET, assert a real response change ---------------- */
  function tutorialGetPath(obj, path) {
    if (!path) return obj;
    var cur = obj, parts = path.split('.');
    for (var i = 0; i < parts.length; i++) { if (cur === null || cur === undefined) return undefined; cur = cur[parts[i]]; }
    return cur;
  }
  // Returns a stop() function. `onDone(passed)` fires exactly once — passed=false only on timeout.
  function tutorialPollVerify(check, onDone) {
    var stopped = false, haveBaseline = false, baseline = null, startedAt = Date.now();
    var pollMs = check.pollMs || 1500, timeoutMs = check.timeoutMs || 30000;
    function passes(json) {
      var val = tutorialGetPath(json, check.assert.path);
      switch (check.assert.op) {
        case 'exists': return Array.isArray(val) ? val.length > 0 : (val !== undefined && val !== null && val !== '');
        case 'equals': return JSON.stringify(val) === JSON.stringify(check.assert.value);
        case 'matches': try { return new RegExp(check.assert.pattern).test(val === undefined ? '' : String(val)); } catch (e) { return false; }
        case 'changed':
          if (!haveBaseline) { baseline = JSON.stringify(val); haveBaseline = true; return false; }
          return JSON.stringify(val) !== baseline;
        default: return false;
      }
    }
    function tick() {
      if (stopped) return;
      if (Date.now() - startedAt > timeoutMs) { onDone(false); return; }
      tunnel(check.path, { method: check.method || 'GET' }).then(function (res) {
        if (stopped) return;
        var pass = res.status < 400 && passes(res.json || {});
        if (pass) { onDone(true); return; }
        setTimeout(tick, pollMs);
      }).catch(function () { if (!stopped) setTimeout(tick, pollMs); });
    }
    tick();
    return function stop() { stopped = true; };
  }

  /* ---------------- the step runner (a shell.js openSheet() true modal + the spotlight above) ---------------- */
  var _tutRunner = null; // { lesson, m, stopPoll }
  function tutorialCloseRunner(sendDismiss) {
    if (_tutRunner) {
      if (_tutRunner.stopPoll) _tutRunner.stopPoll();
      if (sendDismiss) {
        tutorialPost(_tutRunner.lesson.id, _tutRunner.lesson.track, { type: 'dismiss' }).then(function (res) {
          if (res.status < 400 && res.json) tutorialUpsertProgressCache(res.json.data);
        }).catch(function () {});
      }
      if (_tutRunner.m && _tutRunner.m.close) _tutRunner.m.close();
      _tutRunner = null;
    }
    tutorialClearHighlight();
  }
  function tutorialStepBody(lesson, step, idx, total) {
    var safetyNote = (step.kind === 'action' && step.safety === 'confirm-required')
      ? '<div style="font-size:12px;color:var(--red);font-weight:600;margin-bottom:10px">This action cannot be undone — the app itself will ask you to confirm it before it happens.</div>' : '';
    var verifyNote = step.kind === 'verify'
      ? '<div id="ra-tut-verify" style="font-size:12.5px;color:var(--ink-3);display:flex;align-items:center;gap:8px;margin-bottom:6px"><span style="width:7px;height:7px;border-radius:50%;background:var(--accent);display:inline-block;flex:none"></span>Watching for the change…</div>'
      : '';
    return '<div style="font:700 10.5px/1 var(--font-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);margin-bottom:8px">Step ' + (idx + 1) + ' of ' + total + '</div>' +
      '<p style="font-size:13.5px;color:var(--ink-2);line-height:1.5;margin-bottom:14px">' + escHtml(step.body) + '</p>' +
      safetyNote + verifyNote +
      '<div style="display:flex;gap:8px;margin-top:6px">' +
        '<button type="button" class="btn" id="ra-tut-close" style="flex:1;justify-content:center">Close</button>' +
        (step.kind !== 'verify' ? '<button type="button" class="btn p" id="ra-tut-next" style="flex:1;justify-content:center">' + (idx + 1 >= total ? 'Finish' : 'Next') + '</button>' : '') +
      '</div>';
  }
  function tutorialAdvance(lesson) {
    var btn = _tutRunner && _tutRunner.m && _tutRunner.m.sheet.querySelector('#ra-tut-next');
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    tutorialPost(lesson.id, lesson.track, { type: 'advance', tutorialVersion: lesson.version }).then(function (res) {
      if (res.status === 409) { toast('This tutorial changed — restarting from the beginning.', 'bad'); tutorialRestart(lesson); return; }
      if (res.status >= 400) { toast((res.json && res.json.error && res.json.error.message) || 'Could not save your progress.', 'bad'); if (btn) { btn.disabled = false; btn.textContent = 'Next'; } return; }
      var row = res.json.data; tutorialUpsertProgressCache(row);
      if (row.status === 'completed') { tutorialCloseRunner(false); toast(lesson.title + ' — tutorial complete ✓', 'good'); return; }
      tutorialOpenRunner(lesson, row);
    }).catch(function () { toast('Could not reach the secure channel', 'bad'); if (btn) { btn.disabled = false; btn.textContent = 'Next'; } });
  }
  function tutorialOpenRunner(lesson, progressRow) {
    if (_tutRunner) { if (_tutRunner.stopPoll) _tutRunner.stopPoll(); if (_tutRunner.m && _tutRunner.m.close) _tutRunner.m.close(); }
    var idx = Math.min(progressRow.stepIndex, lesson.steps.length - 1);
    var step = lesson.steps[idx];
    var target = (step.kind === 'target' || step.kind === 'action') ? step.target : null;
    tutorialHighlight(target);
    var m = openSheet({ id: 'ra-tut-sheet', tag: 'div', style: 'max-width:380px', title: step.title || lesson.title, body: tutorialStepBody(lesson, step, idx, lesson.steps.length) });
    _tutRunner = { lesson: lesson, m: m, stopPoll: null };
    var closeBtn = m.sheet.querySelector('#ra-tut-close');
    if (closeBtn) closeBtn.onclick = function () { tutorialCloseRunner(true); };
    var nextBtn = m.sheet.querySelector('#ra-tut-next');
    if (nextBtn) nextBtn.onclick = function () { tutorialAdvance(lesson); };
    if (step.kind === 'verify') {
      _tutRunner.stopPoll = tutorialPollVerify(step.check, function (passed) {
        if (!_tutRunner || _tutRunner.lesson !== lesson) return; // runner was closed/replaced meanwhile
        var noteEl = m.sheet.querySelector('#ra-tut-verify');
        if (passed) { if (noteEl) noteEl.innerHTML = '<span style="color:var(--green)">Confirmed ✓</span>'; tutorialAdvance(lesson); }
        else if (noteEl) { noteEl.innerHTML = 'Still waiting — you can keep going in the app, or close and resume later from Tutorials.'; }
      });
    }
  }
  function tutorialStartOrResume(lesson) {
    tutorialPost(lesson.id, lesson.track, { type: 'start' }).then(function (res) {
      if (res.status >= 400) { toast((res.json && res.json.error && res.json.error.message) || 'Could not start this tutorial.', 'bad'); return; }
      var row = res.json.data; tutorialUpsertProgressCache(row);
      tutorialOpenRunner(lesson, row);
    }).catch(function () { toast('Could not reach the secure channel', 'bad'); });
  }
  function tutorialRestart(lesson) {
    tutorialPost(lesson.id, lesson.track, { type: 'restart' }).then(function (res) {
      if (res.status >= 400) { toast('Could not restart this tutorial.', 'bad'); return; }
      var row = res.json.data; tutorialUpsertProgressCache(row);
      tutorialOpenRunner(lesson, row);
    }).catch(function () { toast('Could not reach the secure channel', 'bad'); });
  }

  /* ---------------- WelcomePanel-equivalent: auto-offer once per track, on first login ---------------- */
  // "No progress row of any status yet for this role" (ALEMBIC's own definition) — a `seen` or
  // `start` event always creates a row (see tutorial-engine.ts), so this never re-fires for a
  // track once the user has answered it even once, across reloads (server-authoritative).
  function tutorialMaybeShowWelcome() {
    var track = tutorialCurrentTrack();
    if (_tutWelcomeChecked[track]) return;
    _tutWelcomeChecked[track] = true;
    Promise.all([tutorialFetchLessons(), tutorialFetchProgress()]).then(function () {
      var lessons = tutorialVisibleLessons(track);
      var candidate = null;
      for (var i = 0; i < lessons.length; i++) { if (!tutorialProgressFor(lessons[i].id, track)) { candidate = lessons[i]; break; } }
      if (!candidate) return;
      var m = openSheet({ id: 'ra-tut-welcome', tag: 'div', style: 'max-width:380px', title: 'New here?', body:
        '<p style="font-size:13.5px;color:var(--ink-2);line-height:1.5;margin-bottom:14px">' + escHtml(candidate.summary) + '</p>' +
        '<div style="display:flex;gap:8px">' +
          '<button type="button" class="btn" id="ra-tut-later" style="flex:1;justify-content:center">Maybe later</button>' +
          '<button type="button" class="btn p" id="ra-tut-start-welcome" style="flex:1;justify-content:center">Take the tour</button>' +
        '</div>' });
      m.sheet.querySelector('#ra-tut-later').onclick = function () {
        m.close();
        tutorialPost(candidate.id, candidate.track, { type: 'seen' }).then(function (res) { if (res.status < 400 && res.json) tutorialUpsertProgressCache(res.json.data); }).catch(function () {});
      };
      m.sheet.querySelector('#ra-tut-start-welcome').onclick = function () { m.close(); tutorialStartOrResume(candidate); };
    }).catch(function () {});
  }

  /* ---------------- library / progress panel (Workspace.jsx-equivalent) ---------------- */
  function loadTutorialView() {
    var V = $('ra-view');
    if (V) V.innerHTML = '<div style="padding:60px;text-align:center;color:var(--ink-3);font-family:var(--font-mono);font-size:var(--t-cap)">LOADING TUTORIALS…</div>';
    Promise.all([tutorialFetchLessons(), tutorialFetchProgress()]).then(function () { tutorialRenderLibrary(); }).catch(function () { if (V) V.innerHTML = errBox('Could not load tutorials.'); });
  }
  function tutorialStatusChip(status) {
    var tone = status === 'completed' ? 'g' : (status === 'in_progress' ? 'b' : (status === 'dismissed' ? 'n' : 'n'));
    var label = status === 'completed' ? 'Completed' : status === 'in_progress' ? 'In progress' : status === 'dismissed' ? 'Dismissed' : 'Not started';
    return '<span class="chip ' + tone + '"><i class="dot"></i>' + label + '</span>';
  }
  function tutorialRenderLibrary() {
    var V = $('ra-view'); if (!V) return;
    var track = tutorialCurrentTrack();
    var lessons = tutorialVisibleLessons(track);
    var cards = lessons.map(function (l) {
      var prog = tutorialProgressFor(l.id, track);
      var status = prog ? prog.status : 'not_started';
      var stepNote = (prog && prog.status === 'in_progress') ? (' · step ' + (prog.stepIndex + 1) + ' of ' + prog.totalSteps) : '';
      var btnLabel = status === 'completed' ? 'Replay' : (status === 'in_progress' ? 'Resume' : 'Start');
      return '<div class="card" style="margin-bottom:12px"><div class="card-hd"><h2>' + escHtml(l.title) + '</h2>' + tutorialStatusChip(status) + '<span class="n">' + stepNote + '</span></div>' +
        '<div class="card-bd"><p style="font-size:13px;color:var(--ink-3);margin:0 0 12px">' + escHtml(l.summary) + '</p>' +
        '<button type="button" class="btn p" data-tut-start="' + escHtml(l.id) + '">' + btnLabel + '</button></div></div>';
    }).join('');
    V.innerHTML = (lessons.length ? cards : '<div class="card empty"><h3>No tutorials yet for this workspace</h3><p>Tutorials appear here as they are added for the permissions your role holds.</p></div>') +
      '<div class="card" style="margin-top:4px"><div class="card-bd"><button type="button" class="btn" id="ra-tut-reset-all" style="color:var(--red)">Reset all my tutorial progress</button>' +
      '<div style="font-size:11.5px;color:var(--ink-3);margin-top:6px">Clears progress across every workspace for your account only. This cannot be undone.</div></div></div>';
    [].forEach.call(V.querySelectorAll('[data-tut-start]'), function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-tut-start');
        var lesson = lessons.filter(function (x) { return x.id === id; })[0];
        var prog = lesson && tutorialProgressFor(lesson.id, track);
        if (lesson && prog && prog.status === 'completed') { tutorialRestart(lesson); }
        else if (lesson) { tutorialStartOrResume(lesson); }
      };
    });
    var resetBtn = $('ra-tut-reset-all');
    if (resetBtn) resetBtn.onclick = function () {
      raConfirm('Reset ALL your tutorial progress, across every workspace? This cannot be undone.', function () {
        tunnel('/v1/tutorial/reset', { method: 'POST' }).then(function (res) {
          if (res.status >= 400) { toast('Could not reset tutorial progress.', 'bad'); return; }
          toast('Tutorial progress reset ✓', 'good');
          TSTORE.progress = [];
          tutorialFetchProgress().then(tutorialRenderLibrary);
        }).catch(function () { toast('Could not reach the secure channel', 'bad'); });
      }, { tone: 'bad', confirmLabel: 'Reset all' });
    };
  }

  // Inert scaffolding hook (shell.js:83-91) — kept for the future render path that comment
  // describes; today's actual dispatch is the explicit `__tutorial__` check loadView() carries
  // (shell.js), since RA_VIEWS is not wired into rendering yet.
  if (window.RA && typeof window.RA.registerViews === 'function') {
    window.RA.registerViews({ tutorial: loadTutorialView });
  }
