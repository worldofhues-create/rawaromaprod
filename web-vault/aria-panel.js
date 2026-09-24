/* ALEMBIC Ask Aria: the vanilla-JS port, for consoles that cannot host React.
 *
 * UX-E. RawProd Factory, Platform and Vault are plain classic scripts with no
 * bundler, so they cannot mount `AriaPanel` (apps/web/lib/console/
 * aria-panel.jsx). This writes the SAME DOM, the same class names and the
 * same behaviour, so apps/web/app/aria-panel.css styles it unchanged and a
 * person moving between an ALEMBIC console and a RawProd one meets one Aria.
 * The contract is in release/ui/ARIA_REFERENCE_MAP.md ("Mount API").
 *
 *   <link rel="stylesheet" href="/ui-contract/aria-panel.css">
 *   <script src="/ui-contract/aria-panel.js"></script>
 *   const aria = AlembicAria.mount({
 *     context: "Factory · Batches",
 *     ask: AlembicAria.httpAsk({ base: "", headers: () => ({}) }),
 *   });
 *   askButton.onclick = () => aria.toggle();
 *
 * WHAT IT WILL NOT DO, and the reasons are the React panel's: it has no
 * answer table of its own and never makes one up. A failed ask says so and
 * offers the same question again. Suggestion cards render only what the host
 * passes. Everything a person or the server wrote reaches the page through
 * `textContent`, never `innerHTML`.
 */
(function (root) {
  "use strict";

  /* The questions the empty state offers. Keep in step with ARIA_PROMPTS in
     aria-panel.jsx: each one is a standing question the ALEMBIC resolver
     answers from rows (orders, lots, enquiries). A RawProd host passes its
     own `prompts` when its own resolver answers different ones. */
  var PROMPTS = [
    "Which orders need attention?",
    "How is stock looking?",
    "Which enquiries are waiting?",
  ];
  var VIA_LABEL = { resolver: "From records", copilot: "From records", refusal: "Not on file", general: "General" };
  var SVG = {
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
    expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>',
    shrink: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M4 14h6v6M20 10h-6V4M10 14l-6 6M14 10l6-6"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 12h13"/><path d="m12.5 5.5 6.5 6.5-6.5 6.5"/></svg>',
    retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.6"/><path d="M20 4v4.6h-4.6"/><path d="M20 12a8 8 0 0 1-13.7 5.6L4 15.4"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="m4.5 12.5 5 5L20 7"/></svg>',
    wand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 20 15.5 8.5"/><path d="M13.6 6.6 17.4 10.4"/><path d="M18 3v3M21.6 5.4l-2.1 2.1M21 10h-3"/></svg>',
  };

  function failureText(reason) {
    if (reason === "http-429") return "Too many questions from here just now. Try again in a minute.";
    if (reason === "http-401" || reason === "http-403") return "Your session has ended. Sign in again to ask Aria.";
    return "I could not reach the service, so I have nothing to answer against. Try again in a moment. I will not guess.";
  }
  function revealMs(text) { return Math.round(Math.min(900, 250 + String(text || "").length * 2.2)); }

  /* el("div.aria-line.me", {attr}, children...) with text children set as
     text nodes. Icons are the only markup ever parsed, and they are constants. */
  function el(spec, attrs) {
    var parts = spec.split(".");
    var node = document.createElement(parts[0] || "div");
    if (parts.length > 1) node.className = parts.slice(1).join(" ");
    var a = attrs || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v == null || v === false) return;
      if (k === "on") Object.keys(v).forEach(function (ev) { node.addEventListener(ev, v[ev]); });
      else if (k === "icon") node.insertAdjacentHTML("afterbegin", SVG[v]);
      else if (k === "style") Object.keys(v).forEach(function (p) { node.style.setProperty(p, v[p]); });
      else node.setAttribute(k, v === true ? "" : String(v));
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }

  /**
   * A ready-made `ask` for the ALEMBIC endpoint, `POST {base}/api/v1/copilot/ask`.
   * `headers` may be a function (read per call) so a host that rotates a
   * session token never hands the panel a stale one.
   */
  function httpAsk(opts) {
    var o = opts || {};
    return function (question, extra) {
      var body = { question: question };
      if (extra && extra.conversationId) body.conversationId = extra.conversationId;
      else if (extra && extra.persist) body.persist = true;
      var ctl = typeof AbortController === "function" ? new AbortController() : null;
      var timer = ctl ? setTimeout(function () { ctl.abort(); }, o.timeoutMs || 15000) : null;
      var h = typeof o.headers === "function" ? o.headers() : (o.headers || {});
      return fetch((o.base || "") + "/api/v1/copilot/ask", {
        method: "POST", credentials: o.credentials || "include",
        headers: Object.assign({ "content-type": "application/json" }, h),
        body: JSON.stringify(body), signal: ctl ? ctl.signal : undefined,
      }).then(function (res) {
        if (!res.ok) return { ok: false, reason: "http-" + res.status };
        return res.json().then(function (b) {
          return { ok: true, text: typeof b.text === "string" ? b.text : "", via: b.via,
            cited: Array.isArray(b.cited) ? b.cited : [],
            conversationId: typeof b.conversationId === "string" ? b.conversationId : null };
        });
      }).catch(function () { return { ok: false, reason: "unreachable" }; })
        .finally(function () { if (timer) clearTimeout(timer); });
    };
  }

  /**
   * Mount the panel. Returns `{ open, close, toggle, isOpen, setContext,
   * setRail, setSuggestions, newChat, destroy, element }`.
   */
  function mount(options) {
    var opt = options || {};
    if (typeof opt.ask !== "function") throw new Error("AlembicAria.mount: `ask` is required");
    var state = {
      open: false, busy: false, log: [], rail: null, applied: {},
      conversationId: null, drawer: false, suggestions: opt.suggestions || [],
      context: opt.context || "this view",
    };
    var prompts = (opt.prompts && opt.prompts.length) ? opt.prompts : PROMPTS;
    function play(n) { try { if (opt.sound && opt.sound[n]) opt.sound[n](); } catch (e) { /* optional */ } }
    function isRail() { return state.rail == null ? !!opt.rail : state.rail; }

    var sub = el("p.t-cap");
    var railBtn = el("button.xp", { type: "button", on: { click: function () { state.rail = !isRail(); frame(); } } });
    var closeBtn = el("button.xp", { type: "button", "aria-label": "Close Aria", icon: "x",
      on: { click: function () { api.close(); } } });
    var head = el("div.aria-hd", null,
      el("span.aria-orb", { "aria-hidden": "true" }),
      el("div.aria-ttl", null, el("h3.t-h3", null, "Aria"), sub),
      el("div.aria-acts", null, railBtn, closeBtn));

    /* New chat, and History when the host gives a `threads` adapter. */
    var bar = null, histBtn = null;
    if (opt.threads) {
      histBtn = el("button.aria-threads-btn", { type: "button", "aria-pressed": "false",
        on: { click: function () { state.drawer = !state.drawer; if (state.drawer) loadHistory(); render(); } } }, "History");
      bar = el("div.aria-threads-bar", { role: "toolbar", "aria-label": "Aria conversations" },
        el("button.aria-threads-btn", { type: "button", "aria-label": "New chat",
          on: { click: function () { api.newChat(); } } }, "＋ New chat"),
        histBtn);
    }
    var body = el("div.aria-bd", { role: "log", "aria-label": "Aria conversation" });
    var input = el("input.aria-in", { placeholder: "Ask Aria…", "aria-label": "Message Aria",
      on: { keydown: function (e) { if (e.key === "Enter") ask(); } } });
    var send = el("button.gbtn.acc", { type: "button", "aria-label": "Send", icon: "arrow",
      on: { click: function () { ask(); } } });
    var dock = el("aside.glass.glass-deep.aria-dock", { "aria-label": "Aria co-pilot", "aria-hidden": "true",
      on: { keydown: function (e) { if (e.key === "Escape") { e.stopPropagation(); api.close(); } } } },
      head, bar, body, el("div.aria-ft", null, input, send));
    (opt.parent || document.body).appendChild(dock);

    var history = { items: [], note: "" };
    function loadHistory() {
      history.note = "Loading…"; render();
      Promise.resolve(opt.threads.list()).then(function (items) {
        history.items = items || []; history.note = history.items.length ? "" : "No saved chats yet.";
        render();
      }).catch(function () { history.note = "Could not load your history just now."; render(); });
    }

    /* The frame: open, rail, busy and the header. */
    function frame() {
      var rail = isRail();
      dock.className = "glass glass-deep aria-dock" + (state.open ? " open" : "")
        + (rail ? " is-rail" : "") + (state.busy ? " is-thinking" : "");
      dock.setAttribute("aria-hidden", state.open ? "false" : "true");
      document.body.classList.toggle("aria-rail", state.open && rail);
      sub.textContent = "Co-working on " + (state.context || "this view");
      railBtn.innerHTML = SVG[rail ? "shrink" : "expand"];
      railBtn.setAttribute("aria-pressed", String(rail));
      railBtn.setAttribute("aria-label", rail ? "Collapse Aria" : "Expand Aria");
      railBtn.title = rail ? "Collapse" : "Expand";
      send.disabled = state.busy;
      if (histBtn) {
        histBtn.className = "aria-threads-btn" + (state.drawer ? " on" : "");
        histBtn.setAttribute("aria-pressed", String(state.drawer));
      }
    }

    function line(m, i) {
      var cls = "aria-line" + (m.who === "me" ? " me" : "") + (m.via === "refusal" ? " is-refusal" : "")
        + (m.err ? " is-failed" : "") + (m.fresh ? " is-fresh" : "");
      var node = el("div", { "data-via": m.via || null,
        style: m.fresh ? { "--aria-t": revealMs(m.text) + "ms" } : null }, el("div.aria-bub", null, m.text));
      node.className = cls;
      if (m.fresh) node.addEventListener("animationend", function (e) {
        if (e.animationName === "ariaWipe") m.fresh = false;
      });
      var facts = (m.facts && m.facts.length) ? m.facts : (m.cites || []).map(function (l) { return { label: l }; });
      var via = m.who === "aria" ? VIA_LABEL[m.via] : null;
      if (m.who === "aria" && (via || facts.length)) {
        var meta = el("div.aria-meta", null, via ? el("span.aria-src", null, via) : null);
        facts.forEach(function (f) {
          var t = [f.value ? f.label + ": " + f.value : f.label, f.source].filter(Boolean).join(" · ");
          var chip = el("span", { title: t }, el("i", { "aria-hidden": "true" }), f.label);
          chip.className = "aria-fact" + (f.kind === "regulatory" ? " is-reg" : "");
          meta.appendChild(chip);
        });
        node.appendChild(meta);
      }
      if (m.err && m.retry && i === state.log.length - 1) {
        node.appendChild(el("button.gbtn.aria-retry", { type: "button", icon: "retry", disabled: state.busy,
          on: { click: function () { ask(m.retry); } } }, " Try again"));
      }
      return node;
    }

    function render() {
      frame();
      body.textContent = "";
      if (state.drawer && opt.threads) {
        var drawer = el("section.aria-threads-drawer", { "aria-label": "Chat history" });
        if (history.note) drawer.appendChild(el("p.aria-threads-note", null, history.note));
        history.items.forEach(function (c) {
          var row = el("div", null, el("button.aria-threads-title", { type: "button", on: { click: function () {
            Promise.resolve(opt.threads.open(c.id)).then(function (lines) {
              state.log = lines || []; state.conversationId = c.id; state.drawer = false; render();
            });
          } } }, c.title));
          row.className = "aria-threads-row" + (c.id === state.conversationId ? " on" : "");
          drawer.appendChild(row);
        });
        body.appendChild(drawer);
        return;
      }
      if (!state.suggestions.length && !state.log.length) {
        var list = el("div.prompts");
        prompts.forEach(function (p) {
          list.appendChild(el("button", { type: "button", on: { click: function () { ask(p); } } }, p));
        });
        body.appendChild(el("div.aria-empty", null,
          el("p", null, "Ask about orders, stock or enquiries. Answers cite the records they use; when nothing is on file, Aria says so."),
          el("span.lbl", null, "Try asking"), list));
      }
      state.suggestions.forEach(function (s) {
        var done = !!state.applied[s.id];
        var acts = el("div", { style: { display: "flex", gap: "6px", "margin-top": "10px" } });
        if (done) acts.appendChild(el("span.gbtn", { icon: "check", style: { "pointer-events": "none" } }, " Applied"));
        else acts.appendChild(el("button.gbtn.acc", { type: "button", icon: "wand", on: { click: function () {
          state.applied[s.id] = true; play("success");
          if (opt.onApply) opt.onApply(s);
          state.log.push({ who: "aria", text: "Done — " + (s.applied || String(s.action).toLowerCase()) + "." });
          render();
        } } }, " " + s.action));
        if (s.alt && !done) acts.appendChild(el("button.gbtn", { type: "button", on: { click: function () {
          state.applied[s.id] = "skip"; render();
        } } }, s.alt));
        body.appendChild(el("div" + (done ? ".acard.applied" : ".acard"), null,
          el("div", { style: { display: "flex", "align-items": "center", gap: "6px", "margin-bottom": "6px" } },
            el("span.t-micro", { style: { color: "var(--ink-2)" } }, s.kind),
            el("span.t-micro", { style: { "margin-left": "auto", color: "var(--ink-3)" } }, s.confidence + "% confidence")),
          el("p.t-h3", { style: { "margin-bottom": "4px" } }, s.title),
          el("p.t-cap", { style: { "line-height": "1.5" } }, s.why),
          acts));
      });
      state.log.forEach(function (m, i) { body.appendChild(line(m, i)); });
      if (state.busy) {
        body.appendChild(el("div.acard", { role: "status", "aria-label": "Aria is answering",
          style: { "align-self": "flex-start" } },
          el("span.think", { "aria-hidden": "true" }, el("i"), el("i"), el("i"))));
      }
      setTimeout(function () { body.scrollTop = body.scrollHeight; }, 30);
    }

    function ask(given) {
      var text = String(typeof given === "string" ? given : input.value).trim();
      if (!text || state.busy) return;
      input.value = "";
      state.log.push({ who: "me", text: text });
      state.busy = true; render();
      Promise.resolve()
        .then(function () {
          return opt.ask(text, { conversationId: state.conversationId, persist: !!opt.threads });
        })
        .catch(function () { return { ok: false, reason: "unreachable" }; })
        .then(function (r) {
          state.busy = false;
          if (r && r.ok) {
            if (r.conversationId) state.conversationId = r.conversationId;
            var facts = Array.isArray(r.cited) ? r.cited.filter(function (f) { return f && typeof f === "object"; }) : [];
            state.log.push({ who: "aria", text: r.text || "", via: r.via, facts: facts,
              cites: facts.map(function (f) { return f.label; }), fresh: true });
            play("whoosh");
          } else {
            state.log.push({ who: "aria", err: true, retry: text, text: failureText(r && r.reason) });
          }
          render();
        });
    }

    var api = {
      element: dock,
      isOpen: function () { return state.open; },
      open: function () {
        state.open = true; render();
        try { if (window.matchMedia("(pointer: fine)").matches) setTimeout(function () { input.focus(); }, 80); }
        catch (e) { /* no matchMedia */ }
      },
      close: function () { state.open = false; frame(); if (opt.onClose) opt.onClose(); },
      toggle: function () { return state.open ? api.close() : api.open(); },
      setContext: function (c) { state.context = c; frame(); },
      /* A view's preference; resets the person's own Expand/Collapse choice. */
      setRail: function (r) { opt.rail = !!r; state.rail = null; frame(); },
      setSuggestions: function (list) { state.suggestions = list || []; render(); },
      newChat: function () { state.log = []; state.conversationId = null; state.drawer = false; render(); },
      destroy: function () {
        document.body.classList.remove("aria-rail");
        if (dock.parentNode) dock.parentNode.removeChild(dock);
      },
    };
    render();
    return api;
  }

  root.AlembicAria = { mount: mount, httpAsk: httpAsk, PROMPTS: PROMPTS, failureText: failureText };
})(typeof window !== "undefined" ? window : globalThis);
