/* TxLINE Observatory — hand-rolled canvas timeline.
   Encoding: hue = outcome (fixed per match), line style = source
   (solid = Polymarket best bid, dashed = TxLINE de-margined prob). */
"use strict";

const $ = (id) => document.getElementById(id);
const CSSV = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const COLORS = { s1: CSSV("--s1"), s2: CSSV("--s2"), s3: CSSV("--s3") };
const STATUS = { good: CSSV("--good"), warn: CSSV("--warn"), crit: CSSV("--crit"), serious: CSSV("--serious") };
const INK = { ink: CSSV("--ink"), ink2: CSSV("--ink-2"), muted: CSSV("--muted"), grid: CSSV("--grid"), axis: CSSV("--axis") };

// ── filter groups: chip -> predicate over an event ──────────────────────────
const GROUPS = [
  ["goals",   true,  (e) => e.kind === "action" && /^(goal|own_goal|penalty_goal|goal_disallowed)$/.test(e.action)],
  ["reviews/corrections", true, (e) => e.kind === "action" && /^(var|var_end|action_discarded|action_amend)$/.test(e.action)],
  ["pens",    true,  (e) => e.kind === "action" && /penalty/.test(e.action) && e.action !== "penalty_goal"],
  ["cards",   false, (e) => e.kind === "action" && /card/.test(e.action)],
  ["shots",   false, (e) => e.kind === "action" && /^(shot|possible)$/.test(e.action)],
  ["set pieces", false, (e) => e.kind === "action" && /^(free_kick|corner|throw_in|goal_kick)$/.test(e.action)],
  ["possession", false, (e) => e.kind === "action" && /possession/.test(e.action)],
  ["misc",    false, (e) => e.kind === "action" && /^(substitution|injury|kickoff|additional_time|clock_adjustment|status|comment|standby|penalty_shootout)$/.test(e.action)],
  ["scores",  true,  (e) => e.kind === "score"],
  ["bursts",  true,  (e) => e.kind === "burst"],
  ["shocks",  true,  (e) => e.kind === "shock"],
  ["bot",     true,  (e) => e.src === "bot"],
  ["whales",  true,  (e) => e.kind === "fill"],
];
const GROUP_TIPS = {
  goals: "Goal, own-goal, penalty-goal, and disallowed-goal messages.",
  "reviews/corrections": "VAR lifecycle and feed correction or amendment messages.",
  pens: "Penalty events other than the scored penalty-goal message.",
  cards: "Yellow and red card events.", shots: "Shots and possible-chance messages.",
  "set pieces": "Free kicks, corners, throw-ins, and goal kicks.",
  possession: "Possession updates from the event feed.", misc: "Substitutions, injuries, clock, status, and other feed events.",
  scores: "Observed score transitions.", bursts: "Rapid Polymarket websocket repricing bursts.",
  shocks: "Large single-step market moves.", bot: "Recorded bot decisions, entries, and exits.",
  whales: "Public fills from tracked Polymarket wallets.",
};
const GLYPH = {
  goal: "●", own_goal: "●", penalty_goal: "●", goal_disallowed: "✕",
  var: "V", var_end: "v", action_discarded: "✕", action_amend: "±",
  yellow_card: "▮", red_card: "▮", shot: "•", possible: "?",
  free_kick: "F", corner: "C", throw_in: "t", goal_kick: "g",
  substitution: "s", injury: "+", kickoff: "K",
};
const MAJOR = (e) =>
  (e.kind === "action" && /^(goal|own_goal|penalty_goal|goal_disallowed|var)$/.test(e.action)) ||
  e.kind === "score" || e.kind === "shock";

// ── state ────────────────────────────────────────────────────────────────────
const S = {
  idx: [], meta: null, events: [], flags: [],
  series: new Map(),          // label -> {poly:[[t,v]], tx:[[t,v]], color}
  labels: [], view: null, hover: null, sel: null,
  filters: new Map(GROUPS.map(([n, on]) => [n, on])),
  mode: "full", es: null, follow: false, lastT: 0,
  live: [], liveWant: null,
  upcoming: [], upcomingMatch: null,
  currentId: null, loadSeq: 0, ready: false,
};

function syncPageState(t = null) {
  let hash = "", match = null;
  if (t != null && S.currentId) {
    hash = `#m=${encodeURIComponent(S.currentId)}&t=${encodeURIComponent(t)}`;
    match = S.idx.find((x) => x.id === S.currentId)?.match || S.meta?.match;
  } else if (S.mode === "full" && S.currentId) {
    hash = `#m=${encodeURIComponent(S.currentId)}`;
    match = S.idx.find((x) => x.id === S.currentId)?.match || S.meta?.match;
  } else if (S.mode === "replay" && S.currentId) {
    hash = `#replay=${encodeURIComponent(S.currentId)}`;
    match = S.idx.find((x) => x.id === S.currentId)?.match || S.meta?.match;
  } else if (S.mode === "live" && S.liveWant) {
    hash = `#live=${encodeURIComponent(S.liveWant)}`;
    match = S.liveWant;
  } else if (S.mode === "upcoming" && S.upcomingMatch) {
    hash = `#upcoming=${encodeURIComponent(S.upcomingMatch.fid)}`;
    match = S.upcomingMatch.match;
  }
  document.title = match ? `${S.mode === "live" ? "LIVE: " : ""}${match} — TxLINE Observatory` : "TxLINE Observatory";
  if (hash && location.hash !== hash) history.replaceState(null, "", hash);
}

// ── data plumbing ────────────────────────────────────────────────────────────
function labelColors(meta) {
  const labs = meta.labels || [];
  const teams = meta.teams || [];
  const w = (s) => new Set((s || "").toLowerCase().normalize("NFD").replace(/[^a-z ]/g, " ").split(/\s+/).filter((x) => x.length > 2));
  const overlap = (a, b) => [...w(a)].some((x) => w(b).has(x));
  const out = [];
  const nonDraw = labs.filter((l) => l !== "draw");
  const a = nonDraw.find((l) => overlap(l, teams[0])) ?? nonDraw[0];
  const b = nonDraw.find((l) => l !== a) ?? nonDraw[1];
  if (a) out.push([a, COLORS.s1]);
  if (b) out.push([b, COLORS.s2]);
  if (labs.includes("draw")) out.push(["draw", COLORS.s3]);
  return out;
}

function resetData(meta) {
  S.meta = meta;
  S.events = []; S.flags = [];
  S.sel = null;
  S.lastT = 0; S.lastBook = null; S.hasJup = false;
  S.series = new Map();
  S.labels = labelColors(meta);
  for (const [lab, color] of S.labels) S.series.set(lab, { poly: [], tx: [], jup: [], color });
  if ($("inspector")) {
    $("inspector").classList.remove("open");
    $("insp-json").textContent = "click a flag or moment";
    $("insp-anchor").innerHTML = "";
    $("insp-ctx").innerHTML = "";
  }
}

function bid(rec) { return rec[1] || rec[0]; }   // hollow-book guard: bid, fallback mid

function addEvent(e) {
  S.events.push(e);
  S.lastT = Math.max(S.lastT, e.t);
  if (e.kind === "book") {
    for (const [lab, rec] of Object.entries(e.o || {})) {
      const s = S.series.get(lab);
      if (s && rec) s.poly.push([e.t, bid(rec)]);
    }
    S.lastBook = e;
  } else if (e.kind === "tick") {
    const s = S.series.get(e.team);
    if (s && e.bb != null) s.poly.push([e.t, e.bb]);
  } else if (e.kind === "odds") {
    for (const [lab, v] of Object.entries(e.probs || {})) {
      const s = S.series.get(lab);
      if (s && v != null) s.tx.push([e.t, v]);
    }
  } else if (e.kind === "jbook") {
    const s = S.series.get(e.team);
    if (s && e.bb != null) { (s.jup = s.jup || []).push([e.t, e.bb]); S.hasJup = true; }
  } else {
    S.flags.push(e);
  }
}

function loadFull(id, focusT = null) {
  stopStream();
  const loadSeq = S.loadSeq;
  S.currentId = id;
  S.mode = "full"; setModeButtons();
  $("match-select").value = id;
  syncPageState(focusT);
  fetch(`/api/match/${id}`).then((r) => r.json()).then((d) => {
    if (loadSeq !== S.loadSeq || S.mode !== "full") return;
    resetData(d.meta);
    d.events.forEach(addEvent);
    // series must be time-sorted (book rows and ws ticks interleave)
    for (const s of S.series.values()) { s.poly.sort((x, y) => x[0] - y[0]); s.tx.sort((x, y) => x[0] - y[0]); }
    S.view = [d.meta.t0 - 60, d.meta.t1 + 60];
    S.follow = false; S.sel = null;
    renderMoments(); renderChips(); renderLegend(); statusLine();
    if (Number.isFinite(focusT)) focusMomentAt(focusT);
    else { syncPageState(); draw(); }
  });
}

function selectUpcoming(fid) {
  stopStream();
  const m = S.upcoming.find((x) => String(x.fid) === String(fid));
  if (!m) return;
  $("match-select").value = "upcoming:" + fid;
  S.mode = "upcoming"; S.upcomingMatch = m; setModeButtons();
  resetData({ match: m.match, teams: [m.t1, m.t2], labels: m.labels,
              moments: [], t0: m.events[0]?.t || Date.now() / 1000 - 3600, t1: m.start });
  m.events.forEach(addEvent);
  for (const s of S.series.values()) { s.poly.sort((a,b) => a[0]-b[0]); s.tx.sort((a,b) => a[0]-b[0]); }
  const first = m.events[0]?.t || Date.now() / 1000 - 3600;
  S.view = [first - 60, Math.max(Date.now() / 1000, first + 300)];
  S.follow = false; S.sel = null;
  document.body.classList.add("prematch");
  renderUpcoming(); renderMoments(); renderChips(); renderLegend(); statusLine(); draw();
  syncPageState();
}

function renderUpcoming() {
  const m = S.upcomingMatch, hero = $("upcoming-hero");
  hero.hidden = !m || S.mode !== "upcoming";
  if (!m || S.mode !== "upcoming") return;
  $("upcoming-title").textContent = m.match;
  $("upcoming-kickoff").textContent = `Scheduled ${new Date(m.start * 1000).toLocaleString([], {weekday:"short", month:"short", day:"numeric", hour:"numeric", minute:"2-digit", timeZoneName:"short"})} · TxLINE fixture time`;
  updateCountdown();
}

function updateCountdown() {
  const m = S.upcomingMatch;
  if (!m || S.mode !== "upcoming") return;
  const dt = m.start - Date.now() / 1000, abs = Math.abs(dt);
  const h = Math.floor(abs / 3600), min = Math.floor(abs % 3600 / 60), sec = Math.floor(abs % 60);
  $("upcoming-countdown").textContent = dt >= 0 ? `${h ? h + "h " : ""}${String(min).padStart(2,"0")}m ${String(sec).padStart(2,"0")}s` : `Awaiting kickoff · ${h ? h + "h " : ""}${min}m late`;
  const delay = (m.start || 0) - (m.planned_start || m.start || 0);
  $("upcoming-delay").textContent = delay > 30 ? `Schedule moved ${Math.round(delay/60)} minutes later` : "No schedule change reported";
}
setInterval(updateCountdown, 1000);

// Client-side replay: fetch the whole match (finite JSON — proxy-safe) and play
// events on a wall-clock timer scaled by `speed`. No server-paced SSE, so it
// works over Cloudflare / any proxy exactly like Full mode.
function startReplay(id, speed = 60) {
  stopStream();
  const loadSeq = S.loadSeq;
  S.currentId = id;
  S.mode = "replay"; setModeButtons();
  $("match-select").value = id;
  S.follow = true;
  syncPageState();
  fetch(`/api/match/${id}`).then((r) => r.json()).then((d) => {
    if (loadSeq !== S.loadSeq || S.mode !== "replay") return;
    resetData(d.meta);
    S.view = [d.meta.t0 - 30, d.meta.t0 + 600];
    renderMoments(); renderChips(); renderLegend(); statusLine(); syncPageState();
    const evs = d.events || [];
    if (!evs.length) { S.mode = "full"; setModeButtons(); syncPageState(); return; }
    let i = 0;
    const t0 = evs[0].t;
    const startWall = performance.now();
    const step = () => {
      if (loadSeq !== S.loadSeq || S.mode !== "replay") return;
      const simElapsed = (performance.now() - startWall) / 1000 * speed;
      const until = t0 + simElapsed;
      while (i < evs.length && evs[i].t <= until) { addEvent(evs[i]); i++; }
      statusLine();
      if (i < evs.length) S._replayTimer = setTimeout(step, 100);
      else { S.mode = "full"; setModeButtons(); syncPageState(); }
    };
    step();
  }).catch(() => { if (loadSeq === S.loadSeq) { S.mode = "full"; setModeButtons(); syncPageState(); } });
}

function startLive(matchName) {
  stopStream();
  S.mode = "live"; setModeButtons();
  S.liveWant = matchName;
  resetData({ match: matchName, labels: [], teams: (matchName || "").split(" vs ").map((s) => s.trim()),
              moments: [], t0: Date.now() / 1e3, t1: Date.now() / 1e3 });
  S.view = [Date.now() / 1e3 - 600, Date.now() / 1e3 + 60];
  S.follow = true; S.pollSeq = -1;             // -1 → first poll backfills recent history
  renderMoments(); renderChips(); renderLegend(); statusLine();
  syncPageState();
  pollLive();
}

// Short-poll transport: each poll is a finite JSON body, so it survives
// Cloudflare / corporate proxies that buffer SSE streams to death.
function pollLive() {
  if (S.mode !== "live") return;
  const loadSeq = S.loadSeq;
  const wasBackfill = S.pollSeq === -1;
  fetch(`/api/live/poll?since=${S.pollSeq}`)
    .then((r) => r.json())
    .then((d) => {
      if (loadSeq !== S.loadSeq || S.mode !== "live") return;
      S.pollSeq = d.seq;
      for (const ev of d.events || []) handleLiveEvent(ev);
      if (wasBackfill) {                         // backfill batches by source; re-sort once
        for (const s of S.series.values()) {
          s.poly.sort((a, b) => a[0] - b[0]);
          s.tx.sort((a, b) => a[0] - b[0]);
          if (s.jup) s.jup.sort((a, b) => a[0] - b[0]);
        }
      }
      statusLine();
    })
    .catch(() => {})
    .finally(() => { if (loadSeq === S.loadSeq && S.mode === "live") S._pollTimer = setTimeout(pollLive, 1200); });
}

function handleLiveEvent(d) {
  if (d.type) return;
  if (d.match && !S.live.some((x) => x.match === d.match)) {
    S.live.push({ match: d.match });          // a new match kicked off mid-stream
    rebuildSelect();
  }
  if (d.match !== S.liveWant) return;
  if (d.kind === "book") {                     // labels/teams arrive with the data
    for (const lab of Object.keys(d.o || {})) {
      if (!S.series.has(lab)) {
        S.meta.labels.push(lab);
        S.meta.teams = (S.liveWant || "").split(" vs ").map((s) => s.trim());
        S.labels = labelColors(S.meta);
        for (const [l2, color] of S.labels) if (!S.series.has(l2)) S.series.set(l2, { poly: [], tx: [], jup: [], color });
        renderLegend();
      }
    }
  }
  addEvent(d);
}

function stopStream() {
  S.loadSeq++;
  if (S.es) { S.es.close(); S.es = null; }
  if (S._pollTimer) { clearTimeout(S._pollTimer); S._pollTimer = null; }
  if (S._replayTimer) { clearTimeout(S._replayTimer); S._replayTimer = null; }
}

// ── moments strip ────────────────────────────────────────────────────────────
const fmtClock = (cs) => cs == null ? "" : `${Math.floor(cs / 60)}'`;
const fmtDt = (v) => v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}s`;

function renderMoments() {
  const el = $("moments");
  el.innerHTML = "";
  const moments = S.meta?.moments || [];
  if (!moments.length) {
    const empty = document.createElement("div");
    empty.className = "moment-empty";
    empty.textContent = "no goal moments in this match";
    el.appendChild(empty);
    return;
  }
  for (const [index, mo] of moments.entries()) {
    const d = document.createElement("div");
    d.className = "moment";
    d.tabIndex = 0;
    d.setAttribute("role", "button");
    d.setAttribute("aria-label", `${mo.scorer || "Goal"} ${fmtClock(mo.cs) || "recorded goal"}; show on chart`);
    const tags =
      (mo.disallowed ? `<span class="tag disallowed">DISALLOWED</span>` : mo.var ? `<span class="tag var">VAR</span>` : "") +
      (mo.t0_src === "espn" ? `<span class="tag espn-only" data-tip="${esc(mo.note || "TxLINE goal-action timing is unavailable for this goal.")}">feed gap</span>` : "");
    const pnl = mo.bot_pnl != null ? `<span class="pnl ${mo.bot_pnl >= 0 ? "pos" : "neg"}">bot ${mo.bot_pnl >= 0 ? "+" : ""}$${mo.bot_pnl.toFixed(2)}</span>` : "";
    const d120 = mo.delta_120s != null ? `<span><b>${(mo.delta_120s >= 0 ? "+" : "") + (mo.delta_120s * 100).toFixed(0)}¢</b><i>@120s</i></span>` : "";
    const whale = mo.whale_dt != null ? `<span><b>${fmtDt(mo.whale_dt)}</b><i>${mo.whale_who || "whale"}</i></span>` : "";
    const jup = mo.jup_dt != null ? `<span><b>${fmtDt(mo.jup_dt)}</b><i>Jupiter</i></span>` : "";
    d.innerHTML = `
      <div class="head"><b><span style="color:var(--good)">●</span> ${esc(mo.scorer || "?")}</b><span class="clock">${fmtClock(mo.cs)}</span>${tags}${pnl}<button type="button" class="moment-detail" aria-label="Open ${esc(mo.scorer || "goal")} latency detail" data-tip="Open the source-latency waterfall and recorded trading context.">⧉</button></div>
      <div class="lags">
        <span><b>${mo.t0_src === "txline" ? "0.0s" : "—"}</b><i data-tip="The reference time: TxLINE's recorded goal message.">TxLINE</i></span>
        <span><b>${fmtDt(mo.poly_dt)}</b><i data-tip="First sustained Polymarket move of at least 3¢, relative to TxLINE.">Poly</i></span>
        <span><b>${fmtDt(mo.espn_dt)}</b><i data-tip="ESPN score detection relative to TxLINE.">ESPN</i></span>
        ${whale}${jup}${d120}
      </div>`;
    d.onclick = () => selectMoment(mo, d);
    d.onkeydown = (ev) => { if (ev.target === d && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); selectMoment(mo, d); } };
    d.querySelector(".moment-detail").onclick = (ev) => { ev.stopPropagation(); openGoalDetail(mo, d, index); };
    el.appendChild(d);
  }
}

function openGoalDetail(mo, card, index) {
  const overlay = $("goal-overlay"), out = $("goal-modal-content");
  const badge = (label, cls) => `<span class="tag ${cls}">${label}</span>`;
  const badges = `${mo.var ? badge("VAR", "var") : ""}${mo.disallowed ? badge("DISALLOWED", "disallowed") : ""}${mo.t0_src === "espn" ? badge("FEED GAP", "espn-only") : ""}`;
  const minute = mo.cs == null ? "recorded goal" : `${Math.floor(mo.cs / 60)}'`;
  const footer = [
    mo.delta_120s == null ? "" : `<div><span>Price move at 120s</span><strong class="${mo.delta_120s >= 0 ? "pos" : "neg"}">${mo.delta_120s >= 0 ? "+" : "−"}${Math.abs(mo.delta_120s * 100).toFixed(1)}¢</strong></div>`,
    mo.bot_entries == null && mo.bot_pnl == null ? "" : `<div><span>Recorded bot</span><strong class="${(mo.bot_pnl || 0) >= 0 ? "pos" : "neg"}">${esc(mo.bot_action || `${mo.bot_entries} entr${mo.bot_entries === 1 ? "y" : "ies"}`)}${mo.bot_pnl == null ? "" : ` · ${mo.bot_pnl >= 0 ? "+" : "−"}$${Math.abs(mo.bot_pnl).toFixed(2)}`}</strong></div>`,
  ].filter(Boolean).join("");
  let body;
  if (mo.t0_src === "espn") {
    body = `<div class="feed-gap"><strong>Latency unavailable for this goal</strong><p>${esc(mo.note || "TxLINE goal-action recording was unavailable, so source lags cannot be measured honestly.")}</p><p>The chart still shows the surrounding market and feed data using ESPN detection as the recorded baseline.</p></div>`;
  } else {
    const sources = [
      ["TxLINE", 0],
      [mo.whale_who || "Tracked wallet", mo.whale_dt],
      ["Polymarket", mo.poly_dt],
      ["Jupiter", mo.jup_dt],
      ["ESPN", mo.espn_dt],
      ["wc26", mo.wc26_dt],
    ].filter(([, value], i) => i === 0 || value != null);
    const values = sources.map(([, value]) => value);
    const min = Math.floor(Math.min(-5, ...values));
    const max = Math.ceil(Math.max(60, ...values));
    const pct = (value) => (value - min) / (max - min) * 100;
    const zero = pct(0);
    const rows = sources.map(([label, value]) => {
      const x = pct(value), left = Math.min(zero, x), width = Math.abs(x - zero);
      const front = value < 0;
      return `<div class="waterfall-row"><span>${esc(label)}</span><div class="waterfall-track" style="--zero:${zero}%"><i class="waterfall-bar ${front ? "front" : ""}" style="left:${left}%;width:${Math.max(width, value === 0 ? .6 : 0)}%"></i></div><strong class="${front ? "front" : ""}">${value === 0 ? "0.0s" : fmtDt(value)}</strong></div>`;
    }).join("");
    body = `<div class="waterfall" aria-label="Source timing relative to TxLINE"><div class="waterfall-axis"><span>${fmtDt(min)}</span><span>TxLINE 0</span><span>${fmtDt(max)}</span></div>${rows}</div><p class="waterfall-note"><span class="front-key"></span> Negative means the source moved before TxLINE's recorded goal message.</p>`;
  }
  out.innerHTML = `<header class="goal-modal-head"><div><span class="eyebrow">GOAL MOMENT · ${esc(mo.score_before || "?")} → ${esc(mo.score_after || "?")}</span><h2 id="goal-modal-title">${esc(mo.scorer || "Unknown")} goal, ${minute}</h2><div class="goal-badges">${badges}</div></div></header>${body}<div class="goal-modal-footer">${footer}<span class="footer-spacer"></span><button type="button" id="goal-ask-ai" class="ai-trigger">✦ Ask AI insight</button><button type="button" id="goal-show-chart">Show on chart</button></div><section id="ai-panel" aria-live="polite" hidden></section>`;
  $("goal-show-chart").onclick = () => { closeGoalDetail(); if (!$("insights").hidden) toggleInsights(); selectMoment(mo, card || document.querySelectorAll(".moment")[index]); };
  $("goal-ask-ai").onclick = () => requestAiInsight(mo, index, "Explain this goal moment. Focus on why source timing differed, whether any recorded gap was tradable, and what the bot did.");
  goalReturnFocus = document.activeElement;
  overlay.hidden = false;
  document.body.classList.add("modal-open");
  $("goal-modal-close").focus();
}

let goalReturnFocus = null;
function closeGoalDetail() {
  if (S._aiAbort) { S._aiAbort.abort(); S._aiAbort = null; }
  $("goal-overlay").hidden = true;
  document.body.classList.remove("modal-open");
  if (goalReturnFocus?.isConnected) goalReturnFocus.focus();
  goalReturnFocus = null;
}
$("goal-modal-close").onclick = closeGoalDetail;
$("goal-overlay").onclick = (ev) => { if (ev.target === $("goal-overlay")) closeGoalDetail(); };

// One accessible popover for mouse, keyboard, and touch help targets.
let helpTarget = null;
function hideHelp() { $("help-popover").hidden = true; helpTarget = null; }
function showHelp(target) {
  const tip = target.closest("[data-tip]");
  if (!tip) return;
  const pop = $("help-popover"), r = tip.getBoundingClientRect();
  helpTarget = tip;
  pop.textContent = tip.dataset.tip;
  pop.hidden = false;
  const pr = pop.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(innerWidth - pr.width - 8, r.left + r.width / 2 - pr.width / 2))}px`;
  pop.style.top = `${r.bottom + pr.height + 8 < innerHeight ? r.bottom + 7 : r.top - pr.height - 7}px`;
}
document.addEventListener("mouseover", (ev) => { if (ev.target.closest?.("[data-tip]")) showHelp(ev.target); });
document.addEventListener("mouseout", (ev) => { if (helpTarget && !ev.relatedTarget?.closest?.("[data-tip]")) hideHelp(); });
document.addEventListener("focusin", (ev) => { if (ev.target.closest?.("[data-tip]")) showHelp(ev.target); });
document.addEventListener("focusout", (ev) => { if (helpTarget) hideHelp(); });
document.addEventListener("click", (ev) => {
  const tip = ev.target.closest?.("[data-tip]");
  if (!tip) { hideHelp(); return; }
  if (helpTarget === tip && !$("help-popover").hidden) hideHelp(); else showHelp(tip);
});
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  hideHelp();
  if (!$("goal-overlay").hidden) closeGoalDetail();
  if (!$("wallet-overlay").hidden) closeWallet();
});

function renderAiResult(mo, index, question, data) {
  const panel = $("ai-panel");
  if (!panel || panel.dataset.selection !== `${S.currentId}:${index}`) return;
  panel.innerHTML = `<div class="ai-panel-head"><div><span class="eyebrow">${data.fallback ? "RECORDED-FACTS FALLBACK" : "CLAUDE · EVENT-GROUNDED"}</span><h3>AI event analyst</h3></div><span class="ai-model">${esc(data.model || "local archive")}${data.cached ? " · cached" : ""}</span></div><div class="ai-answer"></div>${data.warning ? `<p class="ai-warning">${esc(data.warning)}</p>` : ""}<div class="ai-prompts"><button type="button" data-question="Why did the market move before TxLINE, and what evidence limits that conclusion?">Why market first?</button><button type="button" data-question="Was the recorded price gap still tradable after a five-second delay?">Tradable after 5s?</button><button type="button" data-question="What exactly did the recorded bot do around this goal?">What did the bot do?</button></div><form id="ai-question-form"><label for="ai-question">Ask about this selected goal</label><div><input id="ai-question" maxlength="240" placeholder="e.g. What happened in the minute before the goal?"><button type="submit">Ask</button></div></form><p class="ai-disclaimer">Trusted archive context only · interpretation is not betting advice.</p>`;
  panel.querySelector(".ai-answer").textContent = data.answer;
  panel.querySelectorAll("[data-question]").forEach((button) => button.onclick = () => requestAiInsight(mo, index, button.dataset.question));
  $("ai-question-form").onsubmit = (ev) => {
    ev.preventDefault();
    const value = $("ai-question").value.trim();
    if (value.length >= 8) requestAiInsight(mo, index, value);
  };
}

function requestAiInsight(mo, index, question) {
  hideHelp();
  const panel = $("ai-panel");
  panel.hidden = false;
  panel.dataset.selection = `${S.currentId}:${index}`;
  panel.innerHTML = `<div class="ai-loading"><span>✦</span><div><strong>Analyzing the selected goal…</strong><p>Loading server-verified timing, pre-event prices, nearby feed evidence, and bot records.</p></div></div>`;
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  if (S._aiAbort) S._aiAbort.abort();
  const controller = new AbortController();
  S._aiAbort = controller;
  const timer = setTimeout(() => controller.abort(), 36000);
  fetch("/api/ai-insight", {
    method: "POST", signal: controller.signal, headers: {"Content-Type": "application/json"},
    body: JSON.stringify({match_id: S.currentId, moment_index: index, question}),
  }).then(async (response) => {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "AI insight request failed");
    return data;
  }).then((data) => renderAiResult(mo, index, question, data))
    .catch((error) => {
      if (error.name === "AbortError" && !$("goal-overlay").hidden) {
        panel.innerHTML = `<p class="ai-error">The insight timed out. Try once more.</p>`;
      } else if (error.name !== "AbortError" && panel.dataset.selection === `${S.currentId}:${index}`) {
        panel.innerHTML = `<p class="ai-error">${esc(error.message)}</p>`;
      }
    }).finally(() => { clearTimeout(timer); if (S._aiAbort === controller) S._aiAbort = null; });
}

// ── public World Cup wallet lens ─────────────────────────────────────────────
let walletConfig = null, walletReturnFocus = null;
const shortWallet = (address) => address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "—";
const walletMoney = (value) => `$${Number(value || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;

function renderRecordedBot(config) {
  const bot = config.recorded_bot || {};
  $("recorded-bot-summary").innerHTML = `<div><span class="eyebrow">RECORDED IN-PLAY BOT · INTERNAL EVENT LEDGER</span><strong class="${(bot.pnl || 0) >= 0 ? "pos" : "neg"}">${bot.pnl >= 0 ? "+" : "−"}$${Math.abs(bot.pnl || 0).toFixed(2)}</strong><p>${bot.entries || 0} entries · ${bot.exits || 0} exits · ${bot.captured_windows || 0} screened windows captured</p></div><p>This verified bot result stays separate from wallet activity. Public fills alone cannot establish realized P&amp;L.</p>`;
  $("wallet-demo").textContent = `Use recorded demo · ${config.demo_name}`;
}

function openWallet() {
  hideHelp();
  walletReturnFocus = document.activeElement;
  $("wallet-overlay").hidden = false;
  document.body.classList.add("modal-open");
  if (walletConfig) { renderRecordedBot(walletConfig); $("wallet-address").focus(); return; }
  $("recorded-bot-summary").innerHTML = `<div class="wallet-loading">Loading archive scope…</div>`;
  fetch("/api/wallet").then((response) => response.json()).then((config) => {
    walletConfig = config; renderRecordedBot(config); $("wallet-address").focus();
  }).catch(() => { $("recorded-bot-summary").innerHTML = `<p class="wallet-error">Wallet configuration is unavailable.</p>`; });
}

function closeWallet() {
  $("wallet-overlay").hidden = true;
  document.body.classList.remove("modal-open");
  if (walletReturnFocus?.isConnected) walletReturnFocus.focus();
  walletReturnFocus = null;
}

function walletGoalLabel(goal) {
  if (!goal) return "No goal within 5m";
  const who = goal.scorer || "goal";
  return `${fmtDt(goal.dt)} ${esc(who)}${goal.clock == null ? "" : ` ${goal.clock}'`}${goal.disallowed ? " · disallowed" : ""}`;
}

function renderWalletReport(report) {
  const out = $("wallet-results");
  const coverage = report.public_rows_scanned
    ? `${report.public_rows_scanned.toLocaleString()} recent public fills scanned${report.recorded_crosscheck ? ` · ${report.recorded_crosscheck} recorder cross-checks` : ""}${report.recorded_only ? ` · ${report.recorded_only} archive-only` : ""}${report.truncated ? " · API window capped" : ""}${report.partial ? " · partial response" : ""}`
    : "Recorded archive fallback";
  const groups = report.matches.length ? `<div class="wallet-table-wrap"><table><thead><tr><th>World Cup match</th><th>Fills</th><th>Matched notional</th><th>Goal-window fills</th><th>Last fill</th></tr></thead><tbody>${report.matches.map((match) => `<tr><td><button type="button" class="wallet-jump" data-match="${esc(match.match_id)}" data-t="${match.last}">${esc(match.match)}</button><span>${esc(match.date)}</span></td><td>${match.fills}</td><td>${walletMoney(match.notional)}</td><td>${match.goal_linked}</td><td>${new Date(match.last * 1000).toLocaleString()}</td></tr>`).join("")}</tbody></table></div>` : `<div class="wallet-no-match"><strong>No matching World Cup fills found.</strong><p>This only checks the ${report.archive_matches}-match Observatory archive and its main match-outcome tokens. The wallet may be inactive, trade other markets, or have relevant fills older than the public API window.</p></div>`;
  const fills = report.fills.length ? `<div class="wallet-fill-head"><h3>Matched fills</h3><span>Newest ${Math.min(report.fills.length, 500)} shown</span></div><div class="wallet-fills">${report.fills.map((fill) => `<div class="wallet-fill"><div><strong>${esc(fill.match)}</strong><span>${new Date(fill.timestamp * 1000).toLocaleString()} · ${esc(fill.source)}</span></div><div><strong>${esc(fill.side || "fill")} ${fill.size == null ? "—" : Number(fill.size).toLocaleString()} @ ${fill.price == null ? "—" : (fill.price * 100).toFixed(1) + "¢"}</strong><span>${esc(fill.market_title || fill.outcome || "outcome")}${fill.market_title && fill.outcome ? ` · ${esc(fill.outcome)}` : ""} · ${walletMoney(fill.notional)}</span></div><div><span>${walletGoalLabel(fill.goal)}</span><button type="button" class="wallet-jump" data-match="${esc(fill.match_id)}" data-t="${fill.timestamp}">View timeline</button></div></div>`).join("")}</div>` : "";
  out.innerHTML = `<div class="wallet-result-head"><div><span class="eyebrow">PUBLIC WALLET · ${report.demo ? "RECORDED DEMO" : "READ ONLY"}</span><h3>${shortWallet(report.address)}</h3><p>${esc(report.scope)}</p></div><span>${coverage}${report.cached ? " · cached" : ""}</span></div><div class="wallet-tiles"><div><span>Matched fills</span><strong>${report.matched_fills}</strong></div><div><span>Archive matches</span><strong>${report.matched_matches}</strong></div><div><span>Matched notional</span><strong>${walletMoney(report.matched_notional)}</strong></div></div><p class="wallet-pnl-note">${esc(report.pnl_note)}</p>${groups}${fills}`;
  out.querySelectorAll(".wallet-jump").forEach((button) => button.onclick = () => {
    const match = button.dataset.match, t = Number(button.dataset.t);
    closeWallet(); if (!$("insights").hidden) toggleInsights(); loadFull(match, t);
  });
}

function loadWallet(address) {
  const normalized = address.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
    $("wallet-results").innerHTML = `<p class="wallet-error">Enter a 0x address with 40 hexadecimal characters.</p>`;
    return;
  }
  $("wallet-address").value = normalized;
  $("wallet-results").innerHTML = `<div class="wallet-loading"><span>◆</span><div><strong>Matching public fills…</strong><p>Checking only token IDs from the 2026 World Cup archive. This can take a few seconds.</p></div></div>`;
  fetch(`/api/wallet?address=${encodeURIComponent(normalized)}`).then(async (response) => {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Wallet lookup failed");
    return data;
  }).then(renderWalletReport).catch((error) => {
    $("wallet-results").innerHTML = `<p class="wallet-error">${esc(error.message)}</p>`;
  });
}

$("btn-wallet").onclick = openWallet;
$("wallet-modal-close").onclick = closeWallet;
$("wallet-overlay").onclick = (ev) => { if (ev.target === $("wallet-overlay")) closeWallet(); };
$("wallet-form").onsubmit = (ev) => { ev.preventDefault(); loadWallet($("wallet-address").value); };
$("wallet-demo").onclick = () => { if (walletConfig) loadWallet(walletConfig.demo_address); };

function selectMoment(mo, card, viewT = mo.t0) {
  S.view = [viewT - 120, viewT + 420];
  S.follow = false;
  S.sel = { synthetic: true, ...mo };
  document.querySelectorAll(".moment").forEach((x) => x.classList.remove("sel"));
  if (card) card.classList.add("sel");
  openInspector(S.sel);
  syncPageState(viewT);
  draw();
}

function focusMomentAt(t) {
  const moments = S.meta?.moments || [];
  let nearest = null, nearestIndex = -1, distance = Infinity;
  moments.forEach((mo, i) => {
    const d = Math.abs(mo.t0 - t);
    if (d < distance) { nearest = mo; nearestIndex = i; distance = d; }
  });
  if (nearest && distance <= 300) {
    selectMoment(nearest, document.querySelectorAll(".moment")[nearestIndex], t);
    return;
  }
  S.view = [t - 120, t + 420];
  S.sel = null; S.follow = false;
  document.querySelectorAll(".moment").forEach((x) => x.classList.remove("sel"));
  syncPageState(t);
  draw();
}

// ── chips ────────────────────────────────────────────────────────────────────
function renderChips() {
  const el = $("chips");
  el.innerHTML = `<span class="lbl">events:</span>`;
  for (const [name, , pred] of GROUPS) {
    const n = S.flags.filter(pred).length;
    const c = document.createElement("span");
    c.className = "chip" + (S.filters.get(name) ? " on" : "");
    c.innerHTML = `${name} <span class="n">${n}</span>`;
    c.tabIndex = 0; c.setAttribute("role", "button"); c.setAttribute("aria-pressed", String(S.filters.get(name)));
    c.dataset.tip = GROUP_TIPS[name];
    c.onclick = () => { S.filters.set(name, !S.filters.get(name)); renderChips(); draw(); };
    c.onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); c.click(); } };
    el.appendChild(c);
  }
}

function flagVisible(e) {
  for (const [name, , pred] of GROUPS) if (pred(e)) return S.filters.get(name);
  return false;
}

// ── legend / status ──────────────────────────────────────────────────────────
function renderLegend() {
  $("legend").innerHTML =
    S.labels.map(([lab, c]) =>
      `<span class="it" data-tip="Polymarket best bid for this outcome."><span class="line" style="border-color:${c}"></span>${esc(lab)}</span>`).join("") +
    (S.labels.length ? `<span class="it" data-tip="TxLINE de-margined fair probability."><span class="line dash" style="border-color:${INK.muted}"></span>TxLINE</span>` : "") +
    (S.hasJup ? `<span class="it" data-tip="Jupiter Predict best bid; this archive observed Polymarket-routed liquidity."><span class="line dot" style="border-color:${INK.muted}"></span>Jupiter</span>` : "");
}

function statusLine() {
  const b = S.lastBook;
  $("status").innerHTML = S.mode === "upcoming"
    ? `${S.events.length.toLocaleString()} prematch updates<span class="status-detail"> · data through ${S.lastT ? new Date(S.lastT*1000).toLocaleTimeString() : "—"}</span>`
    : b
    ? `${b.clock || ""} <span class="score">${b.score || ""}</span><span class="status-detail"> · ${new Date(S.lastT * 1e3).toLocaleTimeString()} · ${S.events.length.toLocaleString()} events</span>`
    : `${S.events.length.toLocaleString()} events`;
  if (S.mode !== "full" && !S._raf) tickFollow();
}

function tickFollow() {
  S._raf = true;
  requestAnimationFrame(() => {
    S._raf = false;
    if (S.follow && S.lastT) {
      const span = S.view[1] - S.view[0];
      S.view = [S.lastT - span * 0.85, S.lastT + span * 0.15];
    }
    draw();
    if ((S._chipTick = (S._chipTick || 0) + 1) % 10 === 0) renderChips();
    if (S.mode !== "full") setTimeout(tickFollow, 250);
  });
}

// ── chart ────────────────────────────────────────────────────────────────────
const cv = $("chart"), ctx = cv.getContext("2d");
const M = { l: 46, r: 116, t: 16, b: 58 };

function resize() {
  const r = cv.parentElement.getBoundingClientRect();
  M.l = r.width <= 700 ? 38 : 46;
  M.r = r.width <= 700 ? 52 : 116;
  cv.width = r.width * devicePixelRatio; cv.height = r.height * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  draw();
}
window.addEventListener("resize", resize);
new ResizeObserver(() => resize()).observe(cv.parentElement);

const X = (t) => M.l + (t - S.view[0]) / (S.view[1] - S.view[0]) * (cv.clientWidth - M.l - M.r);
const T = (x) => S.view[0] + (x - M.l) / (cv.clientWidth - M.l - M.r) * (S.view[1] - S.view[0]);
const Y = (v) => M.t + (1 - v) * (cv.clientHeight - M.t - M.b);

function niceStep(spanSec) {
  const steps = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  const maxTicks = Math.max(3, Math.floor((cv.clientWidth - M.l - M.r) / 90));
  return steps.find((s) => spanSec / s <= maxTicks) || 14400;
}

function draw() {
  if (!S.view) return;
  const W = cv.clientWidth, H = cv.clientHeight;
  ctx.clearRect(0, 0, W, H);
  ctx.font = "11px system-ui";

  // grid + y axis
  ctx.strokeStyle = INK.grid; ctx.fillStyle = INK.muted; ctx.lineWidth = 1;
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    ctx.beginPath(); ctx.moveTo(M.l, Y(v) + 0.5); ctx.lineTo(W - M.r, Y(v) + 0.5); ctx.stroke();
    ctx.textAlign = "right"; ctx.fillText((v * 100).toFixed(0) + "¢", M.l - 6, Y(v) + 4);
  }
  // x ticks
  const step = niceStep(S.view[1] - S.view[0]);
  ctx.textAlign = "center";
  for (let t = Math.ceil(S.view[0] / step) * step; t < S.view[1]; t += step) {
    ctx.strokeStyle = INK.grid;
    ctx.beginPath(); ctx.moveTo(X(t) + 0.5, M.t); ctx.lineTo(X(t) + 0.5, H - M.b); ctx.stroke();
    ctx.fillStyle = INK.muted;
    ctx.fillText(new Date(t * 1e3).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), X(t), H - 8);
  }
  // axis base
  ctx.strokeStyle = INK.axis;
  ctx.beginPath(); ctx.moveTo(M.l, H - M.b + 0.5); ctx.lineTo(W - M.r, H - M.b + 0.5); ctx.stroke();

  // series
  ctx.save();
  ctx.beginPath(); ctx.rect(M.l, M.t - 4, W - M.l - M.r, H - M.t - M.b + 8); ctx.clip();
  for (const [lab] of S.labels) {
    const s = S.series.get(lab);
    if (!s) continue;
    drawLine(s.tx, s.color, [5, 4], 1.6);
    if (s.jup) drawLine(s.jup, s.color, [2, 3], 1.3);
    drawLine(s.poly, s.color, [], 2);
  }
  // flags
  drawFlags(H);
  // bot markers
  drawBots();
  // whale fills
  drawWhales();
  // now cursor
  if (S.mode !== "full" && S.lastT) {
    ctx.strokeStyle = INK.ink2; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(X(S.lastT) + 0.5, M.t); ctx.lineTo(X(S.lastT) + 0.5, H - M.b); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();

  // direct labels at right edge (text in ink, swatch carries hue)
  ctx.textAlign = "left";
  let usedY = [];
  for (const [lab] of S.labels) {
    const s = S.series.get(lab);
    const last = s && [...s.poly].reverse().find((p) => p[0] <= S.view[1]);
    if (!last) continue;
    let y = Math.max(M.t + 8, Math.min(H - M.b - 4, Y(last[1])));
    while (usedY.some((u) => Math.abs(u - y) < 13)) y += 13;
    usedY.push(y);
    ctx.fillStyle = s.color; ctx.fillRect(W - M.r + 6, y - 4, 8, 8);
    ctx.fillStyle = INK.ink2;
    const endLabel = W <= 700 ? `${(last[1] * 100).toFixed(1)}¢` : `${lab} ${(last[1] * 100).toFixed(1)}¢`;
    ctx.fillText(endLabel, W - M.r + 18, y + 4);
  }
  if (!S.events.some((e) => e.t >= S.view[0] && e.t <= S.view[1])) {
    ctx.fillStyle = INK.muted;
    ctx.font = "13px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("no data in view — double-click to fit", W / 2, (M.t + H - M.b) / 2);
    ctx.font = "11px system-ui";
  }
  // crosshair
  if (S.hover) drawCrosshair();
}

function drawLine(pts, color, dash, width) {
  if (!pts.length) return;
  const [v0, v1] = S.view;
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p[0] < v0 && (i + 1 >= pts.length || pts[i + 1][0] < v0)) continue;
    if (p[0] > v1 && started) { ctx.lineTo(X(p[0]), Y(p[1])); break; }
    if (!started) { ctx.moveTo(X(p[0]), Y(p[1])); started = true; }
    else ctx.lineTo(X(p[0]), Y(p[1]));
  }
  ctx.stroke(); ctx.setLineDash([]);
}

function flagColor(e) {
  if (e.kind === "action") {
    if (/disallowed|discarded/.test(e.action)) return STATUS.crit;
    if (/^var/.test(e.action) || /amend/.test(e.action)) return STATUS.warn;
    if (/goal|penalty_goal|own_goal/.test(e.action)) return STATUS.good;
    if (/yellow_card/.test(e.action)) return STATUS.warn;
    if (/red_card/.test(e.action)) return STATUS.crit;
    return INK.muted;
  }
  if (e.kind === "score") return INK.ink2;
  if (e.kind === "shock") return STATUS.serious;
  if (e.kind === "burst") return CSSV("--s1");
  return INK.muted;
}

function drawFlags(H) {
  const laneY = { txline: H - M.b + 14, espn: H - M.b + 14, wc26: H - M.b + 14, polyws: H - M.b + 27, bot: H - M.b + 27, poly: H - M.b + 27 };
  ctx.textAlign = "center"; ctx.font = "10px system-ui";
  for (const e of S.flags) {
    if (e.t < S.view[0] || e.t > S.view[1] || !flagVisible(e)) continue;
    const x = X(e.t);
    const col = flagColor(e);
    if (MAJOR(e)) {
      ctx.strokeStyle = col; ctx.globalAlpha = 0.45;
      ctx.beginPath(); ctx.moveTo(x + 0.5, M.t); ctx.lineTo(x + 0.5, H - M.b); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const y = laneY[e.src] ?? H - M.b + 34;
    ctx.fillStyle = col;
    const glyph = e.kind === "action" ? (GLYPH[e.action] || "·")
      : e.kind === "score" ? "SC" : e.kind === "shock" ? "!" : e.kind === "burst" ? "▲"
      : e.kind === "fill" ? "◆" : "·";
    ctx.fillText(glyph, x, y);
    if (S.sel && S.sel === e) {
      ctx.strokeStyle = INK.ink;
      ctx.strokeRect(x - 7, y - 10, 14, 14);
    }
  }
  ctx.font = "11px system-ui";
}

function drawBots() {
  for (const e of S.flags) {
    if (e.src !== "bot" || e.kind !== "trade" || !flagVisible(e)) continue;
    if (e.t < S.view[0] || e.t > S.view[1] || e.price == null) continue;
    const x = X(e.t), y = Y(e.price);
    ctx.fillStyle = e.action === "ENTER" ? STATUS.good : (e.pnl ?? 0) >= 0 ? STATUS.good : STATUS.crit;
    ctx.beginPath();
    if (e.action === "ENTER") { ctx.moveTo(x, y - 6); ctx.lineTo(x - 5, y + 4); ctx.lineTo(x + 5, y + 4); }
    else { ctx.moveTo(x, y + 6); ctx.lineTo(x - 5, y - 4); ctx.lineTo(x + 5, y - 4); }
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = CSSV("--surface"); ctx.lineWidth = 1.5; ctx.stroke();  // 2px surface ring
  }
}

function drawWhales() {
  for (const e of S.flags) {
    if (e.kind !== "fill" || !flagVisible(e)) continue;
    if (e.t < S.view[0] || e.t > S.view[1] || e.price == null) continue;
    const x = X(e.t), y = Y(e.price);
    const s = S.series.get(e.team);
    ctx.fillStyle = s ? s.color : INK.ink2;
    ctx.beginPath();
    ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y);
    ctx.closePath();
    if (e.side === "BUY") { ctx.fill(); }
    ctx.strokeStyle = s ? s.color : INK.ink2; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.strokeStyle = CSSV("--surface"); ctx.lineWidth = 1; ctx.stroke();
  }
}

function drawCrosshair() {
  const { x } = S.hover;
  const H = cv.clientHeight;
  if (x < M.l || x > cv.clientWidth - M.r) return;
  ctx.strokeStyle = INK.axis; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(x + 0.5, M.t); ctx.lineTo(x + 0.5, H - M.b); ctx.stroke();
  ctx.setLineDash([]);
}

// ── hover / tooltip / selection ──────────────────────────────────────────────
function nearestFlag(x, y) {
  const H = cv.clientHeight;
  if (y < H - M.b + 4 || y > H - M.b + 34) return null;
  let best = null, bd = 9;
  for (const e of S.flags) {
    if (!flagVisible(e) || e.t < S.view[0] || e.t > S.view[1]) continue;
    const d = Math.abs(X(e.t) - x);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

function valAt(pts, t) {
  if (!pts.length || t < pts[0][0]) return null;
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (pts[m][0] <= t) lo = m; else hi = m - 1; }
  return pts[lo][1];
}

cv.addEventListener("mousemove", (ev) => {
  if (!S.view) return;
  const r = cv.getBoundingClientRect();
  const x = ev.clientX - r.left, y = ev.clientY - r.top;
  if (S.drag) {
    const dt = (S.drag.x - x) * (S.view[1] - S.view[0]) / (cv.clientWidth - M.l - M.r);
    S.view = [S.drag.v0 + dt, S.drag.v1 + dt];
    S.follow = false;
    draw();
    return;
  }
  S.hover = { x, y };
  const t = T(x);
  const fl = nearestFlag(x, y);
  cv.style.cursor = fl ? "pointer" : "crosshair";
  const tip = $("tooltip");
  let html = `<div class="t">${new Date(t * 1e3).toLocaleTimeString()}</div>`;
  if (fl) {
    html += `<div><b>${fl.kind === "fill" ? (fl.who || "whale") + " " + (fl.side || "") : fl.src + ":" + (fl.kind === "action" ? fl.action : fl.kind)}</b>${fl.team ? " — " + fl.team : ""}${fl.price != null ? " @" + (fl.price * 100).toFixed(0) + "¢" : ""}${fl.size != null ? " ×" + fl.size : ""}${fl.reason ? " (" + fl.reason + ")" : ""}</div>`;
  } else {
    for (const [lab, color] of S.labels) {
      const s = S.series.get(lab);
      const pv = valAt(s.poly, t), tv = valAt(s.tx, t);
      html += `<div class="row"><span><span class="sw" style="background:${color}"></span>${lab}</span>
        <span class="v">${pv != null ? (pv * 100).toFixed(1) + "¢" : "—"} / ${tv != null ? (tv * 100).toFixed(1) + "¢" : "—"}</span></div>`;
    }
    html += `<div class="t">poly bid / TxLINE fair</div>`;
  }
  tip.innerHTML = html;
  tip.style.display = "block";
  tip.style.left = Math.min(x + 14, cv.clientWidth - 310) + "px";
  tip.style.top = Math.min(y + 12, cv.clientHeight - 120) + "px";
  draw();
});
cv.addEventListener("mouseleave", () => { S.hover = null; $("tooltip").style.display = "none"; draw(); });
cv.addEventListener("mousedown", (ev) => {
  if (!S.view) return;
  const r = cv.getBoundingClientRect();
  S.drag = { x: ev.clientX - r.left, v0: S.view[0], v1: S.view[1], moved: false };
});
window.addEventListener("mouseup", (ev) => {
  if (!S.drag) return;
  const r = cv.getBoundingClientRect();
  const x = ev.clientX - r.left, y = ev.clientY - r.top;
  const moved = Math.abs(x - S.drag.x) > 4;
  S.drag = null;
  if (!moved) {
    const fl = nearestFlag(x, y);
    if (fl) { S.sel = fl; openInspector(fl); draw(); }
  }
});
cv.addEventListener("wheel", (ev) => {
  if (!S.view) return;
  ev.preventDefault();
  const r = cv.getBoundingClientRect();
  const t = T(ev.clientX - r.left);
  const f = ev.deltaY > 0 ? 1.25 : 0.8;
  let v0 = t - (t - S.view[0]) * f, v1 = t + (S.view[1] - t) * f;
  if (v1 - v0 < 20) return;
  S.view = [v0, v1]; S.follow = false;
  draw();
}, { passive: false });
cv.addEventListener("dblclick", () => {
  if (S.meta) S.view = [S.meta.t0 - 60, S.meta.t1 + 60];
  S.follow = S.mode !== "full";
  draw();
});

// ── inspector ────────────────────────────────────────────────────────────────
function openInspector(e) {
  $("inspector").classList.add("open");
  $("insp-json").textContent = JSON.stringify(e, null, 1);
  renderAnchor(e);
  const ctxEl = $("insp-ctx");
  ctxEl.innerHTML = "";
  if (e.synthetic) return;
  const i = S.events.indexOf(e);
  if (i < 0) return;
  for (let j = Math.max(0, i - 8); j < Math.min(S.events.length, i + 9); j++) {
    const x = S.events[j];
    if (x.kind === "book" || x.kind === "tick" || x.kind === "odds") continue;
    const d = document.createElement("div");
    d.className = "ev" + (x === e ? " sel" : "");
    d.textContent = `${new Date(x.t * 1e3).toLocaleTimeString()} ${x.src}:${x.kind === "action" ? x.action : x.kind}${x.team ? " " + x.team : ""}`;
    d.onclick = () => { S.sel = x; openInspector(x); draw(); };
    ctxEl.appendChild(d);
  }
}
$("btn-inspector").onclick = () => $("inspector").classList.toggle("open");

const fmtSeconds = (v) => v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}s`;
const fmtDuration = (v) => v == null ? "—" : `${v.toFixed(1)}s`;
const fmtMoney = (v) => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;
const fmtCents = (v) => v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)}¢`;
const fmtPrice = (v) => v == null ? "—" : `${(v * 100).toFixed(1)}¢`;
const fmtGameClock = (cs) => cs == null ? "—" : `${Math.floor(cs / 60)}:${String(Math.floor(cs % 60)).padStart(2, "0")}`;
function insightTable(headings, rows) {
  return `<table><thead><tr>${headings.map((x) => `<th scope="col">${x}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}
function priceMoves(goal) {
  const before = goal.prices?.before?.outcomes || {}, at = goal.prices?.txline?.outcomes || {};
  return Object.keys(before).filter((x) => at[x]?.bid != null && before[x]?.bid != null)
    .map((x) => `${x} ${fmtCents(at[x].bid - before[x].bid)}`).join(" · ") || "—";
}
function goalEdgeTable(items) {
  const rows = items.map((x) => {
    const bot = x.bot_action ? `${x.bot_action}${x.bot_reason ? ` · ${x.bot_reason}` : ""}` : "Replay candidate";
    const gross25 = x.gross_per_share == null ? null : 25 / x.poly_ask * x.gross_per_share;
    return `<tr><td>${x.match}<br><span>${x.goal_score || x.score || "—"} · ${x.clock || "—"}</span></td><td>${x.label}</td><td><strong>${x.activity_regime}</strong><br><span>${x.pre_activity.toFixed(2)} changes/min</span></td><td>${fmtPrice(x.tx_fair)}</td><td>${fmtPrice(x.poly_ask)}</td><td class="edge">${fmtCents(x.initial_gap)}</td><td>$${Math.round(x.ask_depth || 0).toLocaleString()}</td><td>${fmtDuration(x.duration)}</td><td>${fmtPrice(x.exit_bid)}<br><span>${fmtCents(x.gross_per_share)}/share${gross25 == null ? "" : ` · ${fmtMoney(gross25)} on $25`}</span></td><td>${bot}</td></tr>`;
  });
  return insightTable(["Match / goal", "Outcome", "Pre-signal book", "TxLINE fair", "Poly ask", "Edge", "Ask depth", "Window", "Quoted exit", "Bot"], rows);
}
function sourceRaceTable(goals) {
  const rows = goals.map((x) => {
    const market = x.poly_dt == null ? "—" : `<span class="${x.poly_dt < 0 ? "market-first" : ""}">${fmtSeconds(x.poly_dt)}</span>`;
    const bot = x.bot_action ? `${x.bot_action} ${fmtSeconds(x.bot_dt)}${x.bot_price != null ? ` @ ${fmtPrice(x.bot_price)}` : ""}${x.bot_pnl != null ? ` · ${fmtMoney(x.bot_pnl)}` : ""}` : "—";
    return `<tr><td>${x.match}</td><td><strong>${x.scorer || "Goal"}${x.disallowed ? " · DISALLOWED" : ""}</strong><br>${x.score_before || "?"} → ${x.score_after || "?"}</td><td>${fmtGameClock(x.cs)}</td><td>${market}</td><td>${fmtSeconds(x.espn_dt)}</td><td>${fmtSeconds(x.wc26_dt)}</td><td>${bot}</td><td>${priceMoves(x)}</td></tr>`;
  });
  return insightTable(["Match", "Goal / score", "Clock", "Market ≥3¢", "ESPN", "WC26", "Bot", "Prices by TxLINE"], rows);
}
function neutralGoalsTable(goals) {
  const rows = goals.map((x) => {
    const edge = x.edge;
    const edgeResult = !edge ? "No screened edge" :
      `<span class="${x.edge_status === "winner" ? "edge-win" : "edge-loss"}">${x.edge_status === "winner" ? "Positive" : "Negative"} replay · ${fmtCents(edge.gross_per_share)}/share</span><br><span>${fmtCents(edge.initial_gap)} opening · ${edge.activity_regime} · ${fmtDuration(edge.duration)}</span>`;
    const bot = x.bot_action ? `${x.bot_action}${x.bot_dt != null ? ` ${fmtSeconds(x.bot_dt)}` : ""}${x.bot_pnl != null ? ` · ${fmtMoney(x.bot_pnl)}` : ""}` :
      edge?.bot_action ? `${edge.bot_action}${edge.bot_reason ? ` · ${edge.bot_reason}` : ""}` : "No recorded action";
    const timing = x.recorded_source === "txline" ? `TxLINE<br><span>ESPN ${fmtSeconds(x.espn_dt)} · WC26 ${fmtSeconds(x.wc26_dt)}</span>` :
      "—";
    const market = x.market_dt == null ? "—" : `${fmtSeconds(x.market_dt)} from ${x.recorded_source === "txline" ? "TxLINE" : "recorded baseline"}`;
    return `<tr><td>${x.match}</td><td><strong>${x.scorer}</strong><br>${x.score_before} → ${x.score_after}</td><td>${x.clock || "—"}</td><td>${timing}</td><td>${market}</td><td>${priceMoves(x)}</td><td>${edgeResult}</td><td>${bot}</td></tr>`;
  });
  return insightTable(["Match", "Goal / score", "Clock", "Recorded timing", "Market reaction", "Price movement", "Quoted edge result", "Bot"], rows);
}
function renderInsightTab(name, d) {
  document.querySelectorAll(".insight-tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  const out = $("insight-content");
  if (name === "edge") {
    const edge = d.summary.edge_finder;
    const winners = d.goal_edges.filter((x) => x.activity_regime === "quiet" && x.gross_per_share > 0).sort((a, b) => b.initial_gap - a.initial_gap);
    out.innerHTML = `<div class="insight-tiles">
      <div class="insight-tile"><h3>Positive replays</h3><strong>${edge.positive_quiet}</strong><span>from ${edge.quiet_cases} accepted-goal quiet-book signals · ${edge.quiet_matches} matches</span></div>
      <div class="insight-tile"><h3>Median window</h3><strong>${fmtDuration(edge.median_duration)}</strong><span>from ≥5¢ signal until convergence</span></div>
      <div class="insight-tile"><h3>Median opening edge</h3><strong>${fmtCents(edge.median_opening_gap)}</strong><span>TxLINE fair minus executable ask</span></div>
      <div class="insight-tile"><h3>Quoted convergence</h3><strong class="pnl pos">${fmtCents(edge.median_gross_per_share)}/share</strong><span>median gross · ${fmtMoney(edge.median_25_pnl)} on a $25 entry</span></div>
    </div><div class="insight-section-head"><div><h3>Quiet-book Edge Finder</h3><p>Positive quoted replays ranked by opening edge, with fewer than 0.25 top-of-book changes per minute before the opportunity.</p></div></div>${goalEdgeTable(winners)}<p class="insight-method">Derived winner view. Quoted replay only: recorded ask entry, recorded bid exit at convergence; excludes fees and fill uncertainty.</p>`;
  } else if (name === "goals") {
    const counts = Object.fromEntries(["winner", "loser", "none"].map((status) => [status, d.goals.filter((x) => x.edge_status === status).length]));
    out.innerHTML = `<div class="insight-section-head"><div><h3>All recorded goals</h3><p>${d.goals.length} accepted goals reconciled to the recorded final scores · ${counts.winner} positive quoted replays · ${counts.loser} negative · ${counts.none} without a screened edge.</p></div></div>${neutralGoalsTable(d.goals)}
      <p class="insight-method">Neutral catalog. Replay results use the recorded ask entry and bid at convergence; they are not recorded bot trades.</p>
      <details class="insight-details"><summary>Source race · ${d.source_races.length} TxLINE-anchored score signals</summary><p>All times are relative to TxLINE’s goal message. A negative market time means Polymarket moved first.</p>${sourceRaceTable(d.source_races)}</details>`;
  } else if (name === "opportunities") {
    const replayClass = (v) => v > 0 ? "edge-win" : v < 0 ? "edge-loss" : "";
    const positive = d.opportunities.filter((x) => x.gross_per_share > 0).length;
    const negative = d.opportunities.filter((x) => x.gross_per_share < 0).length;
    const entries = d.opportunities.filter((x) => x.bot_entry_dt != null).length;
    const rows = d.opportunities.map((x) => {
      const bot = x.bot_entry_dt != null ? `<strong>Recorded entry</strong><br><span>${fmtSeconds(x.bot_entry_dt)} @ ${fmtPrice(x.bot_price)}</span>` :
        x.bot_action ? `No trade<br><span>${x.bot_action}${x.bot_reason ? ` · ${x.bot_reason}` : ""}</span>` : "No recorded trade";
      const depth = x.ask_depth == null ? "—" : `$${Math.round(x.ask_depth).toLocaleString()}`;
      return `<tr><td>${x.match}<br><span>${x.score || "—"} · ${x.clock || "—"}</span></td><td>${x.label}</td><td>${fmtPrice(x.tx_fair)}</td><td>${fmtPrice(x.poly_ask)}<br><span>${depth} depth</span></td><td>${fmtCents(x.initial_gap)}</td><td>${fmtCents(x.max_gap)}</td><td>${fmtPrice(x.entry_5s_ask)}</td><td>${fmtDuration(x.duration)}</td><td>${fmtPrice(x.exit_bid)}<br><span class="${replayClass(x.gross_per_share)}">Immediate ${fmtCents(x.gross_per_share)}/share</span><br><span class="${replayClass(x.gross_5s_per_share)}">After 5s ${fmtCents(x.gross_5s_per_share)}/share</span></td><td>${x.activity_regime}<br><span>${x.pre_activity.toFixed(2)}/min</span></td><td>${bot}</td></tr>`;
    });
    out.innerHTML = `<div class="insight-section-head"><div><h3>All screened price gaps</h3><p>${d.opportunities.length} retrospective closed gaps · ${positive} positive quoted replays · ${negative} negative · ${entries} rows with a recorded bot entry.</p></div></div>
      <p class="insight-method">A signal opens when TxLINE fair exceeds the recorded ask by at least 5¢ and closes below a 2¢ gap. Opening values were observable at the time; maximum gap, duration, exit bid, and replay result are hindsight. Green/red applies only to recorded ask-to-bid replay results, not to the signal gap.</p>
      ${insightTable(["Match / state", "Outcome", "TxLINE fair", "Entry ask / depth", "Opening gap", "Max gap", "Ask after 5s", "Window", "Quoted replay", "Book activity", "Bot execution"], rows)}
      <p class="insight-method">Quoted replay only; does not establish a fill or trading profit and excludes fees, latency, slippage, and fill uncertainty. Rows may overlap or represent mutually exclusive outcomes.</p>`;
  } else if (name === "reviews") {
    const rows = d.events.reviews.map((x) => `<tr><td>${x.match}</td><td>${fmtGameClock(x.cs)}</td><td>${fmtDuration(x.duration)}</td><td>${x.decision}</td></tr>`);
    out.innerHTML = `<div class="insight-section-head"><div><h3>Reviews and reversals</h3><p>${d.events.reviews.length} deduplicated VAR starts · ${d.events.corrections} separate feed correction messages</p></div></div>${insightTable(["Match", "Clock", "Review duration", "Recorded result"], rows)}`;
  } else if (name === "penalties" || name === "cards") {
    const data = d.events[name];
    const rows = data.map((x) => `<tr><td>${x.match}</td><td>${x.team || "—"}</td><td>${fmtGameClock(x.cs)}</td><td>${(x.action || "").replaceAll("_", " ")}</td></tr>`);
    out.innerHTML = `<div class="insight-section-head"><div><h3>${name === "cards" ? "Cards" : "Penalty events"}</h3><p>Deduplicated TxLINE event messages across recorded matches.</p></div></div>${insightTable(["Match", "Team", "Clock", "Event"], rows)}`;
  } else {
    const rows = d.events.shots.map((x) => `<tr><td>${x.match}</td><td>${x.total}</td><td>${Object.entries(x.teams).map(([team, total]) => `${team} ${total}`).join(" · ")}</td></tr>`);
    out.innerHTML = `<div class="insight-section-head"><div><h3>Shots and possible chances</h3><p>Event totals by match and team.</p></div></div>${insightTable(["Match", "Events", "By team"], rows)}`;
  }
}
function renderInsights(d) {
  const s = d.summary;
  $("insights").innerHTML = `<div class="insights-head"><div><h2>TxLINE Trading Intelligence</h2><p>${s.goals} final-score goals across ${s.matches} recorded matches</p></div><button type="button" id="btn-insights-close">Close</button></div>
    <nav class="insight-tabs" aria-label="Insight event type">
      ${[["edge","Edge Finder"],["goals","Goals"],["opportunities","All Gaps"],["reviews","Reviews"],["penalties","Penalties"],["cards","Cards"],["shots","Shots"]].map(([id,label]) => `<button type="button" class="insight-tab" data-tab="${id}">${label}</button>`).join("")}
    </nav><div id="insight-content"></div>`;
  $("btn-insights-close").onclick = toggleInsights;
  document.querySelectorAll(".insight-tab").forEach((x) => x.onclick = () => renderInsightTab(x.dataset.tab, d));
  renderInsightTab("edge", d);
}
function toggleInsights() {
  const panel = $("insights"), opening = panel.hidden;
  panel.hidden = !opening;
  $("chart-wrap").hidden = opening;
  $("inspector").hidden = opening;
  $("btn-insights").classList.toggle("active", opening);
  if (opening && !panel.dataset.loaded) {
    panel.innerHTML = "<p>Loading insights…</p>";
    fetch("/api/insights").then((r) => r.json()).then((d) => { renderInsights(d); panel.dataset.loaded = "true"; })
      .catch(() => { panel.innerHTML = "<p>Insights unavailable.</p>"; });
  }
  if (!opening) resize();
}
$("btn-insights").onclick = toggleInsights;

// ── Solana anchor receipt (Verifiable Resolution UI) ─────────────────────────
function renderAnchor(e) {
  const el = $("insp-anchor");
  el.innerHTML = "";
  const fid = e.fid || (S.meta && S.meta.fid);
  if (e.seq == null || !fid) return;
  const btn = document.createElement("button");
  btn.textContent = "Verify on Solana";
  btn.onclick = () => {
    btn.disabled = true; btn.textContent = "verifying…";
    const key = e.part === 2 ? 2 : 1;
    fetch(`/api/anchor?fid=${fid}&seq=${e.seq}&statKey=${key}`)
      .then((r) => r.json())
      .then((a) => {
        if (!a.ok) { el.innerHTML = `<div class="a-bad">✕ ${a.error || "no proof"}</div>`; return; }
        const ok = (b) => b ? `<span class="a-ok">✓</span>` : `<span class="a-bad">✕</span>`;
        el.innerHTML = `
          <div class="a-row">${ok(a.local.stat_path_ok)} stat Merkle path (sha256, ${a.proof_sizes.statProof} nodes)</div>
          <div class="a-row">${ok(a.local.subtree_path_ok)} fixture subtree path (${a.proof_sizes.subTreeProof} nodes)</div>
          <div class="a-row">${ok(a.account && a.account.exists && a.account.owner === a.program)} anchor account on mainnet, owned by TxLINE program</div>
          <div class="a-kv">stat: key ${a.stat.key} = ${a.stat.value} (period ${a.stat.period})</div>
          <div class="a-kv">PDA: <span class="mono">${a.pda}</span></div>
          ${a.last_update ? `<div class="a-kv">last root anchor: slot ${a.last_update.slot} · <a href="${a.explorer}" target="_blank">solscan ↗</a></div>` : ""}
          <div class="a-kv muted">${a.root_match ? "main root matched in account data ✓" : "account layout undocumented — receipt shows proof + live anchor account"}</div>`;
      })
      .catch((err) => { el.innerHTML = `<div class="a-bad">✕ ${err}</div>`; });
  };
  el.appendChild(btn);
}

// ── controls ─────────────────────────────────────────────────────────────────
function setModeButtons() {
  $("btn-full").classList.toggle("active", S.mode === "full");
  $("btn-replay").classList.toggle("active", S.mode === "replay");
  $("btn-live").classList.toggle("active", S.mode === "live");
  $("btn-live").classList.toggle("live-on", S.mode === "live");
  $("btn-full").disabled = S.mode === "upcoming";
  $("btn-replay").disabled = S.mode === "upcoming";
  if (S.mode !== "upcoming") { document.body.classList.remove("prematch"); $("upcoming-hero").hidden = true; }
}
$("btn-full").onclick = () => { const v = curMatchValue(); if (v) loadFull(v); };
$("btn-replay").onclick = () => { const v = curMatchValue(); if (v) startReplay(v); };
$("btn-live").onclick = () => { if (S.live.length) selectLive(S.live[0].match); };
$("match-select").onchange = () => {
  const v = $("match-select").value;
  if (v.startsWith("live:")) selectLive(v.slice(5));
  else if (v.startsWith("upcoming:")) selectUpcoming(v.slice(9));
  else loadFull(v);
};

// value that Full/Replay should act on: the id of the selected past game, or —
// if a live entry is selected — that live match's most recent built id (if any)
function curMatchValue() {
  const v = $("match-select").value;
  if (v.startsWith("upcoming:")) return null;
  if (!v.startsWith("live:")) return v;
  const name = v.slice(5);
  const built = [...S.idx].sort((a, b) => b.t0 - a.t0).find((m) => m.match === name);
  return built ? built.id : null;
}

function selectLive(name) {
  $("match-select").value = "live:" + name;
  startLive(name);
}

function routeFromHash() {
  const raw = location.hash.replace(/^#/, "");
  if (!raw) return false;
  const params = new URLSearchParams(raw);
  if (params.has("m")) {
    const id = params.get("m");
    if (!S.idx.some((x) => x.id === id)) return false;
    const rawT = params.get("t"), parsedT = Number(rawT);
    loadFull(id, rawT !== null && rawT !== "" && Number.isFinite(parsedT) ? parsedT : null);
    return true;
  }
  if (params.has("replay")) {
    const id = params.get("replay");
    if (!S.idx.some((x) => x.id === id)) return false;
    startReplay(id);
    return true;
  }
  if (params.has("live")) {
    const name = params.get("live");
    if (!S.live.some((x) => x.match === name)) return false;
    selectLive(name);
    return true;
  }
  if (params.has("upcoming")) {
    const fid = params.get("upcoming");
    if (!S.upcoming.some((x) => String(x.fid) === fid)) return false;
    selectUpcoming(fid);
    return true;
  }
  return false;
}

function openDefault() {
  if (S.live.length) {
    // a match is in-play → open it live immediately (what the user came for)
    selectLive(S.live[0].match);
  } else if (S.upcoming.length) {
    rebuildSelect(); $("match-select").value = "upcoming:" + S.upcoming[0].fid; selectUpcoming(S.upcoming[0].fid);
  } else {
    const preferred = [...S.idx].sort((a, b) => b.t0 - a.t0).find((m) => m.fid) || S.idx[S.idx.length - 1];
    if (preferred) { $("match-select").value = preferred.id; loadFull(preferred.id); }
    else { S.meta = null; document.title = "TxLINE Observatory"; }
  }
}

window.addEventListener("hashchange", () => {
  if (S.ready && !routeFromHash()) openDefault();
});

// one picker: live matches pinned on top (🔴), then the recorded catalog
function rebuildSelect() {
  const sel = $("match-select");
  const keep = sel.value;
  sel.innerHTML = "";
  if (S.live.length) {
    const g = document.createElement("optgroup"); g.label = "● LIVE NOW";
    for (const lm of S.live) {
      const o = document.createElement("option");
      o.value = "live:" + lm.match;
      o.textContent = `🔴 ${lm.match}  ${lm.score || ""} ${lm.clock || ""}`.trimEnd();
      g.appendChild(o);
    }
    sel.appendChild(g);
  }
  if (S.upcoming.length) {
    const g = document.createElement("optgroup"); g.label = "UPCOMING · PREMATCH";
    for (const m of S.upcoming) {
      const o = document.createElement("option"); o.value = "upcoming:" + m.fid;
      o.textContent = `◷ ${new Date(m.start*1000).toLocaleTimeString([], {hour:"numeric", minute:"2-digit"})}  ${m.match}`;
      g.appendChild(o);
    }
    sel.appendChild(g);
  }
  const g2 = document.createElement("optgroup"); g2.label = "RECORDED";
  for (const m of [...S.idx].sort((a, b) => b.t0 - a.t0)) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = `${m.date}  ${m.match}${m.fid ? " ⚡" : ""}`;
    g2.appendChild(o);
  }
  sel.appendChild(g2);
  if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

function fetchLive() {
  return fetch("/api/live/now").then((r) => r.json()).then((d) => {
    S.live = d.matches || [];
    $("btn-live").classList.toggle("has-live", S.live.length > 0);
    $("btn-live").textContent = S.live.length ? `🔴 Live (${S.live.length})` : "Live";
    rebuildSelect();
  }).catch(() => {});
}

Promise.all([fetch("/api/matches").then((r) => r.json()), fetch("/api/upcoming").then((r) => r.json())]).then(async ([idx, up]) => {
  S.idx = idx;
  S.upcoming = up.matches || [];
  S.hasJup = false;
  await fetchLive();
  S.ready = true;
  if (!routeFromHash()) openDefault();
  setInterval(fetchLive, 30000);   // surface matches that kick off while open
  resize();
});
resize();
