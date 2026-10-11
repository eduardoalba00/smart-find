// Smart Find content script: a Spotlight-style panel that asks Jev which passages of the page
// answer your question, highlights them, and jumps between them.
// Injected on demand (toolbar button or shortcut); running it again toggles the panel.

(() => {
  if (window.__smartFind) {
    window.__smartFind.toggle();
    return;
  }

  // ------------------------------------------------------------------ settings

  const CUTOFF = 0.6; // below this a passage doesn't count as answering the question
  const MAX_RESULTS = 6;
  const MIN_CHARS = 3;
  const MIN_WORDS = 80; // merge small neighbouring blocks under the same heading up to this
  const MAX_WORDS = 250; // split longer blocks at sentence boundaries
  const MAX_PASSAGES = 1500; // cost guard for enormous pages; nearest to the viewport win

  const BLOCK_TAGS = new Set([
    "P", "LI", "PRE", "BLOCKQUOTE", "DD", "DT", "TR", "TD", "TH", "FIGCAPTION", "SUMMARY",
    "H1", "H2", "H3", "H4", "H5", "H6", "DIV", "SECTION", "ARTICLE", "MAIN", "UL", "OL", "TABLE",
    "TBODY", "THEAD", "DL", "FIGURE", "DETAILS", "ASIDE", "HEADER", "FOOTER", "NAV", "FORM",
  ]);
  const HEADING = /^H([1-6])$/;
  const SKIP = [
    "script", "style", "noscript", "template", "svg", "canvas", "iframe", "nav", "header", "footer", "aside",
    "form", "button", "select", "textarea", "input", "smart-find-ui", "[aria-hidden=true]", "[hidden]",
    ".navbox", ".reflist", ".references", ".mw-editsection", "sup.reference", ".sidebar", ".hatnote",
    ".metadata", ".mw-jump-link", ".catlinks", "#toc", ".toc", ".headerlink",
  ].join(",");

  const words = (s) => s.split(/\s+/).filter(Boolean).length;
  const clean = (s) => s.replace(/\s+/g, " ").trim();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ------------------------------------------------------------------ reading the page

  function mainContent() {
    return (
      document.querySelector("#mw-content-text") ||
      document.querySelector("main") ||
      document.querySelector("article") ||
      document.querySelector("[role=main]") ||
      document.body
    );
  }

  const containsBlock = (el) => {
    for (const c of el.children) if (BLOCK_TAGS.has(c.tagName) || containsBlock(c)) return true;
    return false;
  };

  const visible = (el) => (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : true);

  function textOf(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.data;
    if (node.nodeType !== Node.ELEMENT_NODE || node.matches(SKIP)) return "";
    let s = "";
    for (const c of node.childNodes) s += textOf(c);
    return s;
  }

  // Collects text units in reading order. A unit is either a leaf block element or a run of
  // loose text and inline elements inside a container (comment threads often put the first
  // paragraph straight in a <div>). Each unit keeps a Range for highlighting and an element
  // for scrolling.
  function collectUnits(root) {
    const units = [];
    const headings = [];
    const path = () => headings.filter(Boolean).join(" › ");

    const pushUnit = (text, range, anchor) => {
      text = clean(text);
      if (text.length > 1) units.push({ path: path(), text, range, anchor });
    };

    const walk = (el) => {
      let run = [];
      const flushRun = () => {
        if (!run.length) return;
        const text = run.map(textOf).join("");
        if (clean(text)) {
          const range = document.createRange();
          range.setStartBefore(run[0]);
          range.setEndAfter(run[run.length - 1]);
          pushUnit(text, range, el);
        }
        run = [];
      };

      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (child.data.trim() || run.length) run.push(child);
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (child.matches(SKIP) || !visible(child)) continue;

        const h = child.tagName.match(HEADING);
        if (h) {
          flushRun();
          const level = Number(h[1]);
          headings.length = level - 1;
          headings[level - 1] = clean(textOf(child));
          continue;
        }
        const isBlock = BLOCK_TAGS.has(child.tagName);
        const hasBlocks = containsBlock(child);
        if (!isBlock && !hasBlocks) {
          run.push(child); // inline element, part of the current run
        } else if (!hasBlocks) {
          flushRun();
          const range = document.createRange();
          range.selectNodeContents(child);
          pushUnit(textOf(child), range, child);
        } else {
          flushRun();
          walk(child);
        }
      }
      flushRun();
    };
    walk(root);
    return units;
  }

  function splitLong(text) {
    if (words(text) <= MAX_WORDS) return [text];
    const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [text];
    const parts = [];
    let cur = "";
    for (const s of sentences) {
      if (cur && words(cur + s) > MAX_WORDS) {
        parts.push(cur.trim());
        cur = "";
      }
      cur += s;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  }

  function readPage() {
    const units = collectUnits(mainContent());
    const passages = [];
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      const text = clean(buf.map((u) => u.text).join(" "));
      for (const part of splitLong(text)) {
        passages.push({
          id: passages.length,
          path: buf[0].path,
          text: part,
          ranges: buf.map((u) => u.range),
          anchor: buf[0].anchor,
        });
      }
      buf = [];
    };
    for (const u of units) {
      if (buf.length && u.path !== buf[0].path) flush();
      buf.push(u);
      if (words(buf.map((b) => b.text).join(" ")) >= MIN_WORDS) flush();
    }
    flush();
    passages.forEach((p, i) => {
      const prev = passages[i - 1]?.text ?? "";
      p.previous = clean((prev.match(/[^.!?]+[.!?]*\s*$/) ?? [prev])[0]).slice(-200);
    });
    return { title: document.title, passages };
  }

  // Nearest to what the reader is looking at goes first, so visible results land first.
  function byViewportDistance(passages) {
    const mid = innerHeight / 2;
    return passages
      .map((p) => {
        const r = p.ranges[0].getBoundingClientRect();
        return { p, d: Math.abs(r.top + r.height / 2 - mid) };
      })
      .sort((a, b) => a.d - b.d)
      .map((x) => x.p);
  }

  // ------------------------------------------------------------------ page highlights

  const pageStyle = document.createElement("style");
  pageStyle.textContent = `
    ::highlight(smart-find-strong) { background-color: rgba(255, 204, 0, 0.55); }
    ::highlight(smart-find-medium) { background-color: rgba(255, 204, 0, 0.32); }
    ::highlight(smart-find-weak)   { background-color: rgba(255, 204, 0, 0.16); }
    ::highlight(smart-find-active) { background-color: rgba(255, 159, 10, 0.75); color: #1d1d1f; }
  `;
  const TIERS = ["strong", "medium", "weak"];
  const tierOf = (score) => (score >= 0.85 ? "strong" : score >= 0.72 ? "medium" : "weak");
  const highlightsSupported = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined";

  function paintHighlights() {
    if (!highlightsSupported) return;
    const groups = { strong: [], medium: [], weak: [] };
    for (const [id, score] of state.scores) {
      if (score < CUTOFF) continue;
      groups[tierOf(score)].push(...state.page.passages[id].ranges);
    }
    for (const t of TIERS) CSS.highlights.set(`smart-find-${t}`, new Highlight(...groups[t]));
    const active = state.results[state.selected];
    const h = new Highlight(...(active != null ? state.page.passages[active].ranges : []));
    h.priority = 1;
    CSS.highlights.set("smart-find-active", h);
  }

  function clearHighlights() {
    if (!highlightsSupported) return;
    for (const t of [...TIERS, "active"]) CSS.highlights.delete(`smart-find-${t}`);
  }

  // ------------------------------------------------------------------ panel

  const host = document.createElement("smart-find-ui");
  host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
<style>
  :host {
    --panel: rgba(246, 246, 248, 0.82);
    --panel-solid: #f6f6f8;
    --fg: #1d1d1f;
    --muted: #6e6e73;
    --hair: rgba(0, 0, 0, 0.1);
    --row-hover: rgba(0, 0, 0, 0.05);
    --accent: #0a7aff;
    --accent-fg: #ffffff;
    --heat: #ffb800;
    --shadow: 0 28px 80px rgba(0, 0, 0, 0.28), 0 2px 10px rgba(0, 0, 0, 0.08);
    --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :host {
      --panel: rgba(38, 38, 42, 0.78);
      --panel-solid: #26262a;
      --fg: #f5f5f7;
      --muted: #a1a1a6;
      --hair: rgba(255, 255, 255, 0.12);
      --row-hover: rgba(255, 255, 255, 0.06);
      --accent: #0a84ff;
      --shadow: 0 28px 80px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.06);
    }
  }
  * { box-sizing: border-box; }
  .panel {
    pointer-events: auto;
    position: fixed; left: 50%; top: 16vh; transform: translateX(-50%);
    width: min(680px, calc(100vw - 32px));
    background: var(--panel);
    -webkit-backdrop-filter: blur(40px) saturate(180%); backdrop-filter: blur(40px) saturate(180%);
    border: 1px solid var(--hair); border-radius: 16px; box-shadow: var(--shadow);
    color: var(--fg); font: 15px/1.4 var(--font); overflow: hidden;
    animation: pop 0.16s ease-out;
  }
  @supports not (backdrop-filter: blur(1px)) { .panel { background: var(--panel-solid); } }
  @keyframes pop { from { opacity: 0; transform: translateX(-50%) scale(0.98); } }
  .panel.collapsed { top: 12px; }
  .bar { display: flex; align-items: center; gap: 12px; height: 58px; padding: 0 18px; }
  .bar svg { flex: none; width: 22px; height: 22px; color: var(--muted); }
  input {
    flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--fg);
    font: 22px/1.2 var(--font); letter-spacing: -0.01em; padding: 0;
  }
  input::placeholder { color: var(--muted); opacity: 0.8; }
  .meta { flex: none; font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .progress { height: 2px; background: transparent; position: relative; }
  .progress > span { position: absolute; inset: 0 auto 0 0; background: var(--accent); transition: width 0.15s ease-out, opacity 0.3s; }
  .list { border-top: 1px solid var(--hair); max-height: min(52vh, 460px); overflow-y: auto; padding: 6px; display: grid; gap: 2px; }
  .collapsed .list, .collapsed .foot { display: none; }
  .row {
    display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 12px; align-items: start;
    padding: 9px 12px; border-radius: 10px; cursor: pointer;
  }
  .row:hover { background: var(--row-hover); }
  .row[aria-selected="true"] { background: var(--accent); color: var(--accent-fg); }
  .row[aria-selected="true"] .sec { color: inherit; opacity: 0.8; }
  .ring { width: 18px; height: 18px; margin-top: 2px; }
  .ring circle { fill: none; stroke-width: 3; }
  .ring .track { stroke: var(--hair); }
  .ring .fill { stroke: var(--heat); stroke-linecap: round; transform: rotate(-90deg); transform-origin: center; }
  .row[aria-selected="true"] .ring .track { stroke: rgba(255, 255, 255, 0.3); }
  .row[aria-selected="true"] .ring .fill { stroke: #fff; }
  .sec { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .snip { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .note { padding: 14px 12px; color: var(--muted); display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
  .note button {
    font: 600 13px var(--font); border: 0; border-radius: 8px; padding: 7px 12px; cursor: pointer;
    background: var(--accent); color: var(--accent-fg);
  }
  .foot {
    display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    border-top: 1px solid var(--hair); padding: 8px 18px; font-size: 12px; color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  kbd { font: inherit; border: 1px solid var(--hair); border-radius: 4px; padding: 0 4px; }
  .strip { position: fixed; top: 0; right: 0; bottom: 0; width: 10px; pointer-events: none; }
  .strip i {
    position: absolute; right: 2px; width: 6px; min-height: 3px; border-radius: 2px;
    background: var(--heat); pointer-events: auto; cursor: pointer;
  }
  .strip i.on { background: #ff9f0a; right: 0; width: 10px; }
  button:focus-visible, .row:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { .panel { animation: none; } .progress > span { transition: none; } }
</style>
<div class="strip" part="strip"></div>
<div class="panel" role="dialog" aria-label="Smart Find">
  <div class="bar">
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 15.5 20 20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    <input type="text" placeholder="Ask this page anything" aria-label="Ask this page a question" autocomplete="off" spellcheck="false">
    <span class="meta" aria-live="polite"></span>
  </div>
  <div class="progress"><span style="width:0;opacity:0"></span></div>
  <div class="list" role="listbox" hidden></div>
  <div class="foot" hidden><span><kbd>↑</kbd> <kbd>↓</kbd> select · <kbd>↵</kbd> jump · <kbd>esc</kbd> close</span><span class="stats"></span></div>
</div>`;

  const $ = (sel) => shadow.querySelector(sel);
  const panel = $(".panel");
  const input = $("input");
  const meta = $(".meta");
  const bar = $(".progress > span");
  const list = $(".list");
  const foot = $(".foot");
  const stats = $(".stats");
  const strip = $(".strip");

  const state = {
    open: false,
    page: { title: "", passages: [] },
    scores: new Map(),
    results: [], // passage ids, best first
    selected: 0,
    query: "",
    seq: 0,
    phase: "idle", // idle | running | done | error
    error: null,
    done: null,
    collapsed: false,
  };

  // ------------------------------------------------------------------ search

  let port = null;
  function connect() {
    if (port) return port;
    port = chrome.runtime.connect({ name: "smart-find" });
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => (port = null));
    return port;
  }

  function search(q) {
    q = q.trim();
    if (q === state.query && state.phase !== "error") return;
    state.query = q;
    state.seq += 1;
    state.scores.clear();
    state.results = [];
    state.selected = 0;
    state.error = null;
    state.done = null;
    clearHighlights();
    if (q.length < MIN_CHARS) {
      state.phase = "idle";
      port?.postMessage({ type: "cancel" });
      return render();
    }
    state.page = readPage();
    const ordered = byViewportDistance(state.page.passages).slice(0, MAX_PASSAGES);
    state.phase = "running";
    state.total = ordered.length;
    render();
    const msg = {
      type: "search",
      seq: state.seq,
      title: state.page.title,
      question: q,
      passages: ordered.map(({ id, path, previous, text }) => ({ id, path, previous, text })),
    };
    try {
      connect().postMessage(msg);
    } catch {
      port = null;
      connect().postMessage(msg); // the service worker restarted; reconnect once
    }
  }

  let frame = 0;
  const scheduleRender = () => {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); });
  };

  function onMessage(msg) {
    if (msg.seq !== state.seq) return;
    if (msg.type === "scores") {
      for (const [id, score] of msg.scores) state.scores.set(id, score);
      const prevTop = state.results[state.selected];
      state.results = [...state.scores]
        .filter(([, s]) => s >= CUTOFF)
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => id);
      // Keep the reader's selection stable while results stream in.
      const keep = state.results.indexOf(prevTop);
      state.selected = keep >= 0 && state.collapsed ? keep : 0;
      paintHighlights();
      scheduleRender();
    } else if (msg.type === "done") {
      state.phase = "done";
      state.done = msg;
      scheduleRender();
    } else if (msg.type === "error") {
      state.phase = "error";
      state.error = msg;
      scheduleRender();
    }
  }

  // ------------------------------------------------------------------ rendering

  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const ring = (score) => {
    const c = 2 * Math.PI * 7;
    const f = Math.max(0.08, (score - CUTOFF) / (1 - CUTOFF));
    return `<svg class="ring" viewBox="0 0 18 18" aria-hidden="true"><circle class="track" cx="9" cy="9" r="7"/><circle class="fill" cx="9" cy="9" r="7" stroke-dasharray="${c * f} ${c}"/></svg>`;
  };
  const section = (p) => {
    const parts = p.path ? p.path.split(" › ") : [];
    return parts.length ? parts.slice(-2).join(" › ") : "Top of page";
  };
  const snippet = (text) => (text.length > 220 ? `${text.slice(0, 220).replace(/\s+\S*$/, "")}…` : text);

  function render() {
    panel.classList.toggle("collapsed", state.collapsed);
    const n = state.results.length;
    const scored = state.scores.size;

    // meta text at the right of the search bar
    const edited = input.value.trim() && input.value.trim() !== state.query;
    if (edited && state.phase !== "running") meta.textContent = "Press ↵ to search";
    else if (state.phase === "running") meta.textContent = `Reading ${state.total} passages`;
    else if (state.collapsed && n) meta.textContent = `${state.selected + 1} of ${n}`;
    else if (state.phase === "done") meta.textContent = n ? `${n} match${n === 1 ? "" : "es"}` : "";
    else meta.textContent = "";

    // progress hairline
    const running = state.phase === "running";
    bar.style.width = running ? `${Math.round((scored / Math.max(1, state.total)) * 100)}%` : bar.style.width;
    bar.style.opacity = running ? "1" : "0";

    // list
    let html = "";
    if (state.phase === "error") {
      const needsKey = state.error.code === "no-key" || state.error.code === "bad-key";
      html = `<div class="note"><span>${esc(state.error.message)}</span>${needsKey ? `<button data-act="options">Open options</button>` : `<button data-act="retry">Try again</button>`}</div>`;
    } else if (n) {
      html = state.results.slice(0, MAX_RESULTS).map((id, i) => {
        const p = state.page.passages[id];
        return `<div class="row" role="option" data-i="${i}" aria-selected="${i === state.selected}">${ring(state.scores.get(id))}<div><div class="sec">${esc(section(p))}</div><div class="snip">${esc(snippet(p.text))}</div></div></div>`;
      }).join("");
    } else if (state.phase === "done") {
      html = `<div class="note"><span>Nothing on this page seems to answer that.</span></div>`;
    }
    list.innerHTML = html;
    list.hidden = !html;

    foot.hidden = !n;
    if (state.done) {
      stats.textContent = `${(state.done.ms / 1000).toFixed(2)} s · ${state.done.requests} Jev calls · $${state.done.cost.toFixed(4)}`;
    } else stats.textContent = running ? "Asking Jev…" : "";

    renderStrip();
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }

  function renderStrip() {
    const docH = document.documentElement.scrollHeight || 1;
    const marks = state.results.map((id, i) => {
      const r = state.page.passages[id].ranges[0].getBoundingClientRect();
      const top = ((r.top + scrollY) / docH) * 100;
      const h = Math.max(0.3, (r.height / docH) * 100);
      return `<i data-i="${i}" class="${i === state.selected ? "on" : ""}" style="top:${top}%;height:${h}%;opacity:${0.45 + 0.55 * ((state.scores.get(id) - CUTOFF) / (1 - CUTOFF))}"></i>`;
    });
    strip.innerHTML = marks.join("");
  }

  // ------------------------------------------------------------------ actions

  // Scrolls the passage's own text into view. A loose-text passage's container can be huge
  // (a whole comment tree), so centring the container would land far from the text.
  function scrollToRange(range, fallback) {
    const behavior = reducedMotion ? "auto" : "smooth";
    let el = range.startContainer;
    el = el.nodeType === Node.ELEMENT_NODE ? el : el.parentElement;
    // Bring it on screen first, in case it sits inside its own scrolling box.
    for (let box = el?.parentElement; box && box !== document.body; box = box.parentElement) {
      const { overflowY } = getComputedStyle(box);
      if (/(auto|scroll)/.test(overflowY) && box.scrollHeight > box.clientHeight) {
        el.scrollIntoView({ block: "nearest" });
        break;
      }
    }
    const r = range.getBoundingClientRect();
    if (!r.height && !r.width) return (el ?? fallback).scrollIntoView({ block: "center", behavior });
    // Land the text a little above centre, clear of the collapsed search bar. Long jumps are
    // instant: animating tens of thousands of pixels is slow and can stall mid-way.
    const delta = r.top - innerHeight * 0.35;
    window.scrollBy({ top: delta, behavior: Math.abs(delta) > innerHeight * 2 ? "auto" : behavior });
  }

  function jump(i) {
    if (!state.results.length) return;
    state.selected = (i + state.results.length) % state.results.length;
    const p = state.page.passages[state.results[state.selected]];
    scrollToRange(p.ranges[0], p.anchor);
    state.collapsed = true;
    paintHighlights();
    render();
  }

  // Searches run on Enter only; typing just edits the question.
  input.addEventListener("input", () => {
    state.collapsed = false;
    if (!input.value.trim()) search("");
    else render();
  });

  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // keep the page's own shortcuts from firing while typing
    const n = state.results.length;
    if (e.key === "Escape") {
      e.preventDefault();
      if (state.collapsed || !n) close();
      else { state.collapsed = true; render(); }
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!n) return;
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      if (state.collapsed) jump(state.selected + step);
      else {
        state.selected = (state.selected + step + Math.min(n, MAX_RESULTS)) % Math.min(n, MAX_RESULTS);
        paintHighlights();
        render();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (input.value.trim() !== state.query) search(input.value);
      else if (n) jump(e.shiftKey ? state.selected - 1 : state.collapsed ? state.selected + 1 : state.selected);
    }
  });
  for (const type of ["keyup", "keypress"]) input.addEventListener(type, (e) => e.stopPropagation());

  list.addEventListener("click", (e) => {
    const row = e.target.closest(".row");
    if (row) return jump(Number(row.dataset.i));
    const act = e.target.closest("button")?.dataset.act;
    if (act === "options") chrome.runtime.sendMessage({ type: "open-options" });
    if (act === "retry") { state.query = ""; search(input.value); }
  });
  strip.addEventListener("click", (e) => {
    const mark = e.target.closest("i");
    if (mark) jump(Number(mark.dataset.i));
  });
  panel.addEventListener("click", () => {
    if (state.collapsed) { state.collapsed = false; render(); }
    input.focus();
  });

  // Clicking the page tucks the panel away so it doesn't cover what you're reading.
  const onPageDown = (e) => {
    if (!state.open || e.composedPath().includes(host)) return;
    if (state.results.length) { state.collapsed = true; render(); }
  };
  const onResize = () => state.open && renderStrip();

  function open() {
    state.open = true;
    state.collapsed = false;
    document.documentElement.append(host);
    (document.head ?? document.documentElement).append(pageStyle);
    addEventListener("mousedown", onPageDown, true);
    addEventListener("resize", onResize);
    if (state.query) paintHighlights();
    render();
    input.focus();
    input.select();
  }

  function close() {
    state.open = false;
    port?.postMessage({ type: "cancel" });
    clearHighlights();
    host.remove();
    pageStyle.remove();
    removeEventListener("mousedown", onPageDown, true);
    removeEventListener("resize", onResize);
  }

  function toggle() {
    if (!state.open) return open();
    // A second press while the panel is tucked away or unfocused brings it back.
    if (state.collapsed || shadow.activeElement !== input) {
      state.collapsed = false;
      render();
      input.focus();
      input.select();
    } else close();
  }

  window.__smartFind = { toggle, readPage, state };
  open();
})();
