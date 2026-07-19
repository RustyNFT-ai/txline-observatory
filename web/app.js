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
const WATCH_COLORS = ["#79b4fa", "#f3c969", "#b99cff", "#64c7e8", "#f08fb4", "#aebbc9", "#ef9b68"];
const PAPER_BOT_ID = "txline-paper-bot";

// ── filter groups: chip -> predicate over an event ──────────────────────────
// [name, defaultOn, predicate, section]  sections: match | market | actors | more
// "jupiter" is a series toggle (no event predicate) and auto-joins whenever
// the visible span is under 20 minutes. Wallet fills follow the user's watchlist.
const GROUPS = [
  ["goals",   true,  (e) => e.kind === "action" && /^(goal|own_goal|penalty_goal|goal_disallowed)$/.test(e.action), "match"],
  ["reviews/corrections", true, (e) => e.kind === "action" && /^(var|var_end|action_discarded|action_amend)$/.test(e.action), "match"],
  ["pens",    true,  (e) => e.kind === "action" && /penalty/.test(e.action) && e.action !== "penalty_goal", "match"],
  ["cards",   false, (e) => e.kind === "action" && /card/.test(e.action), "match"],
  ["bursts",  true,  (e) => e.kind === "burst", "market"],
  ["shocks",  true,  (e) => e.kind === "shock", "market"],
  ["jupiter", false, null, "market"],
  ["watchlist", true, (e) => (e.kind === "fill" && isWatchlistedFill(e)) ||
    (e.src === "bot" && paperBotSelected()), "actors"],
  ["shots",   false, (e) => e.kind === "action" && /^(shot|possible)$/.test(e.action), "more"],
  ["set pieces", false, (e) => e.kind === "action" && /^(free_kick|corner|throw_in|goal_kick)$/.test(e.action), "more"],
  ["possession", false, (e) => e.kind === "action" && /possession/.test(e.action), "more"],
  ["misc",    false, (e) => e.kind === "action" && /^(substitution|injury|kickoff|additional_time|clock_adjustment|status|comment|standby|penalty_shootout)$/.test(e.action), "more"],
  ["scores",  true,  (e) => e.kind === "score", "more"],
];
const SECTION_LABEL = { match: "Match events", market: "Market signals", actors: "Actors", more: "More" };
const GROUP_TIPS = {
  goals: "Goal, own-goal, penalty-goal, and disallowed-goal messages.",
  "reviews/corrections": "VAR lifecycle and feed correction or amendment messages.",
  pens: "Penalty events other than the scored penalty-goal message.",
  cards: "Yellow and red card events.", shots: "Shots and possible-chance messages.",
  "set pieces": "Free kicks, corners, throw-ins, and goal kicks.",
  possession: "Possession updates from the event feed.", misc: "Substitutions, injuries, clock, status, and other feed events.",
  scores: "Observed score transitions from ESPN, wc26, and TxLINE.", bursts: "Rapid Polymarket websocket repricing bursts.",
  shocks: "Large single-step market moves.",
  watchlist: "Public fills and optional paper actors on your locally saved watchlist.",
  jupiter: "Jupiter Predict best bid — Polymarket-routed liquidity. Auto-joins when zoomed under 20 minutes.",
};
const GLYPH = {
  goal: "●", own_goal: "●", penalty_goal: "●", goal_disallowed: "✕",
  var: "V", var_end: "v", action_discarded: "✕", action_amend: "±",
  yellow_card: "▮", red_card: "▮", shot: "•", possible: "?",
  free_kick: "F", corner: "C", throw_in: "t", goal_kick: "g",
  substitution: "s", injury: "+", kickoff: "K",
};

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
  walletAddress: null, walletFillsByMatch: new Map(), walletReports: new Map(), watchlist: [],
  fitY: false, replay: null, trackHits: [], plotHits: [], hoverHit: null,
  insightsData: null, insightTab: "edge",
  preset: "essential", moreOpen: false,
};
const AUTOJOIN_SPAN = 1200;                    // <20 min → Jupiter joins
const TOOLTIP_FILL_LIMIT = 8;
const autoJoin = () => !!S.view && (S.view[1] - S.view[0]) < AUTOJOIN_SPAN;
const isMobile = () => matchMedia("(max-width: 700px)").matches;
const isCoarse = () => matchMedia("(pointer: coarse)").matches;
const GOAL_ACTOR_WINDOW = 300;                 // match server-side "goal-linked" wallet scope
const GOAL_ACTOR_LIMIT = 5;

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
  S.sel = null; S.hoverHit = null; S._anchorsCache = null;
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
  renderDetail(null);
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
    if (e.kind === "action" && e.cs != null) S._anchorsCache = null;   // clock anchors changed
  }
}

function loadFull(id, focusT = null) {
  stopStream();
  const loadSeq = S.loadSeq;
  S.currentId = id;
  S.mode = "full"; setModeButtons();
  $("match-select").value = id;
  $("chart-wrap").classList.add("loading");
  syncPageState(focusT);
  fetch(`/api/match/${id}`).then((r) => r.json()).then((d) => {
    if (loadSeq !== S.loadSeq || S.mode !== "full") return;
    resetData(d.meta);
    d.events.forEach(addEvent);
    addWalletFillsToCurrent(id);
    // series must be time-sorted (book rows and ws ticks interleave)
    for (const s of S.series.values()) { s.poly.sort((x, y) => x[0] - y[0]); s.tx.sort((x, y) => x[0] - y[0]); }
    S.view = [d.meta.t0 - 60, d.meta.t1 + 60];
    S.follow = false; S.sel = null;
    $("chart-wrap").classList.remove("loading");
    renderMoments(); renderChips(); renderLegend(); statusLine();
    if (Number.isFinite(focusT)) focusMomentAt(focusT);
    else { syncPageState(); draw(); }
  }).catch(() => { if (loadSeq === S.loadSeq) $("chart-wrap").classList.remove("loading"); });
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
  // upcoming state now lives inside the scoreboard strip
  $("sb-countdown-wrap").hidden = !S.upcomingMatch || S.mode !== "upcoming";
  renderScoreboard();
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

// ── scoreboard strip ─────────────────────────────────────────────────────────
const teamCode = (name) => (name || "").toLowerCase() === "draw" ? "DRW"
  : (name || "?").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "?";
const teamHue = (name) => {
  const hit = S.labels.find(([lab]) => lab === name);
  return hit ? hit[1] : (S.labels.find(([lab]) => lab !== "draw" && overlapWords(lab, name))?.[1] ?? INK.ink2);
};
function overlapWords(a, b) {
  const w = (s) => new Set((s || "").toLowerCase().normalize("NFD").replace(/[^a-z ]/g, " ").split(/\s+/).filter((x) => x.length > 2));
  return [...w(a)].some((x) => w(b).has(x));
}

// Programmatic, factual-only finding line built from recorded moment stats.
function findingText(mo) {
  const head = [mo.scorer || "Goal", fmtClock(mo.cs), mo.score_before && mo.score_after ? `(${mo.score_before}→${mo.score_after})` : ""].filter(Boolean).join(" ");
  if (mo.t0_src === "espn") return `${head}: TxLINE goal-action timing unavailable; ESPN detection is the recorded baseline.`;
  const facts = [];
  if (mo.poly_dt != null) facts.push(mo.poly_dt < 0
    ? `Polymarket repriced ${Math.abs(mo.poly_dt).toFixed(1)}s before TxLINE`
    : `Polymarket repriced ${mo.poly_dt.toFixed(1)}s after TxLINE`);
  const watched = watchedGoalFills(mo);
  if (watched.length) facts.push(`${watched[0].label} filled ${fmtDt(watched[0].dt)}${watched.length > 1 ? ` (${watched.length} watched fills)` : ""}`);
  if (!facts.length && mo.delta_120s != null)
    facts.push(`price moved ${(mo.delta_120s >= 0 ? "+" : "−")}${Math.abs(mo.delta_120s * 100).toFixed(1)}¢ within 120s`);
  if (mo.disallowed) facts.push("goal disallowed");
  return facts.length ? `${head}: ${facts.join("; ")}` : head;
}

function bestFindingMoment() {
  const moments = S.meta?.moments || [];
  if (!moments.length) return null;
  const watchedDt = (moment) => watchedGoalFills(moment)[0]?.dt ?? Infinity;
  const front = moments.filter((m) => Math.min(m.poly_dt ?? Infinity, watchedDt(m)) < 0);
  if (front.length) return front.reduce((a, b) =>
    Math.min(b.poly_dt ?? Infinity, watchedDt(b)) < Math.min(a.poly_dt ?? Infinity, watchedDt(a)) ? b : a);
  const withDelta = moments.filter((m) => m.delta_120s != null);
  if (withDelta.length) return withDelta.reduce((a, b) => Math.abs(b.delta_120s) > Math.abs(a.delta_120s) ? b : a);
  return null;
}

function selectedMoment() {
  if (!S.sel?.synthetic) return null;
  return (S.meta?.moments || []).find((m) => m.t0 === S.sel.t0) || null;
}

function renderScoreboard() {
  const sb = $("scoreboard");
  if (!S.meta) { sb.hidden = true; return; }
  sb.hidden = false;
  const up = S.mode === "upcoming" ? S.upcomingMatch : null;
  const teams = up ? [up.t1, up.t2] : (S.meta.teams?.length ? S.meta.teams : (S.meta.match || "").split(" vs "));
  $("sb-team1").textContent = teams[0] || "—";
  $("sb-team2").textContent = teams[1] || "—";
  const score = S.lastBook?.score || "";
  $("sb-nums").textContent = up ? "vs" : (score || "–");
  const st = $("sb-state");
  st.className = "sb-state";
  if (up) { st.classList.add("upcoming"); st.textContent = up.start - Date.now() / 1000 >= 0 ? "UPCOMING" : "AWAITING KICKOFF"; }
  else if (S.mode === "live") { st.classList.add("live"); st.innerHTML = `<span class="dot"></span>LIVE${S.lastBook?.clock ? " " + esc(S.lastBook.clock) : ""}`; }
  else if (S.mode === "replay") { st.classList.add("replay"); st.textContent = `REPLAY ${S.lastBook?.clock || ""}`.trim(); }
  else st.textContent = "FT";
  // finding line: the selected moment if any, else the strongest recorded fact
  const mo = selectedMoment() || bestFindingMoment();
  const moments = S.meta.moments || [];
  $("sb-finding").textContent = up
    ? `Scheduled ${new Date(up.start * 1000).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })} · TxLINE fixture time`
    : mo ? findingText(mo)
    : moments.length ? `${moments.length} recorded goal${moments.length === 1 ? "" : "s"}${score ? ` · final ${score}` : ""}`
    : S.mode === "live" ? liveGoalSummary(score)
    : "No goal moments recorded in this match.";
  renderGoalbar(moments);
}

// Live mode has no computed moments yet — summarize goal actions seen so far
// honestly instead of claiming "no goals" beside a non-zero score.
function liveGoalSummary(score) {
  const goals = S.flags.filter((e) => e.kind === "action"
    && /^(goal|own_goal|penalty_goal)$/.test(e.action) && e.confirmed);
  if (goals.length) {
    const last = goals[goals.length - 1];
    return `${goals.length} goal${goals.length === 1 ? "" : "s"} detected live` +
      (last.team ? ` · latest: ${last.team}` : "") +
      " · full latency analysis after full-time";
  }
  return score && score !== "0-0"
    ? `Score ${score} · goal happened before this session connected · full analysis after full-time`
    : "No goals yet · latency analysis appears after full-time";
}

function renderGoalbar(moments) {
  const bar = $("sb-goalbar");
  const key = S.currentId + ":" + moments.map((m) => `${m.t0}${m.disallowed ? "x" : ""}`).join(",") + ":" + (selectedMoment()?.t0 ?? "");
  if (bar.dataset.key === key) return;
  bar.dataset.key = key;
  bar.innerHTML = `<span class="gb-line"></span>` +
    [45, 90].map((m) => `<span class="gb-tick" style="left:${m / 120 * 100}%"></span>`).join("");
  bar.hidden = !moments.length;
  const selT = selectedMoment()?.t0;
  moments.forEach((mo, i) => {
    const d = document.createElement("button");
    d.type = "button";
    d.className = "gb-dot" + (mo.disallowed ? " disallowed" : "") + (mo.t0 === selT ? " sel" : "");
    d.style.left = `${Math.min(1, Math.max(0, (mo.cs ?? 0) / (120 * 60))) * 100}%`;
    d.style.setProperty("--hue", teamHue(mo.benefit || mo.scorer));
    d.setAttribute("aria-label", `${mo.scorer || "Goal"} ${fmtClock(mo.cs)}${mo.disallowed ? ", disallowed" : ""}; show on chart`);
    d.onclick = () => { hideHelp(); selectMoment(mo, document.querySelectorAll(".moment")[i]); };
    bar.appendChild(d);
  });
}

// Client-side replay: fetch the whole match (finite JSON — proxy-safe) and play
// events on a wall-clock timer scaled by the chosen speed. No server-paced SSE,
// so it works over Cloudflare / any proxy exactly like Full mode.
// The engine keeps the full event list so pause / speed / scrub / jump-to-goal
// all replay client-side without another fetch.
function startReplay(id, speed = 60) {
  stopStream();
  const loadSeq = S.loadSeq;
  S.currentId = id;
  S.mode = "replay"; setModeButtons();
  $("match-select").value = id;
  S.follow = true;
  $("chart-wrap").classList.add("loading");
  syncPageState();
  fetch(`/api/match/${id}`).then((r) => r.json()).then((d) => {
    if (loadSeq !== S.loadSeq || S.mode !== "replay") return;
    resetData(d.meta);
    S.view = [d.meta.t0 - 30, d.meta.t0 + 600];
    $("chart-wrap").classList.remove("loading");
    renderMoments(); renderChips(); renderLegend(); statusLine(); syncPageState();
    const evs = [...(d.events || []), ...walletTimelineEvents(id, d.events || [])].sort((a, b) => a.t - b.t);
    if (!evs.length) { S.mode = "full"; setModeButtons(); syncPageState(); return; }
    S.replay = { evs, i: 0, simT: evs[0].t, speed, paused: false, loadSeq,
                 t0: evs[0].t, t1: evs[evs.length - 1].t, lastWall: performance.now() };
    renderReplayControls();
    replayTick();
  }).catch(() => { if (loadSeq === S.loadSeq) { $("chart-wrap").classList.remove("loading"); S.mode = "full"; setModeButtons(); syncPageState(); } });
}

function replayTick() {
  const R = S.replay;
  if (!R || R.loadSeq !== S.loadSeq || S.mode !== "replay") return;
  const now = performance.now();
  if (!R.paused) R.simT += (now - R.lastWall) / 1000 * R.speed;
  R.lastWall = now;
  while (R.i < R.evs.length && R.evs[R.i].t <= R.simT) { addEvent(R.evs[R.i]); R.i++; }
  statusLine(); updateReplayControls();
  if (R.i < R.evs.length) S._replayTimer = setTimeout(replayTick, 100);
  else endReplay();
}

function endReplay() {
  S.replay = null; renderReplayControls();
  S.mode = "full"; setModeButtons(); syncPageState(); statusLine();
}

// Seek: backwards rebuilds state from scratch (cheap — pure array replay).
function replaySeek(t) {
  const R = S.replay;
  if (!R) return;
  t = Math.max(R.t0, Math.min(R.t1, t));
  if (t < R.simT) {
    const keep = { evs: R.evs, speed: R.speed, paused: R.paused, loadSeq: R.loadSeq, t0: R.t0, t1: R.t1 };
    resetData(S.meta);
    Object.assign(R, keep, { i: 0, simT: t, lastWall: performance.now() });
  } else { R.simT = t; }
  while (R.i < R.evs.length && R.evs[R.i].t <= R.simT) { addEvent(R.evs[R.i]); R.i++; }
  for (const s of S.series.values()) { s.poly.sort((a, b) => a[0] - b[0]); s.tx.sort((a, b) => a[0] - b[0]); if (s.jup) s.jup.sort((a, b) => a[0] - b[0]); }
  renderChips(); statusLine(); updateReplayControls();
}

function renderReplayControls() {
  let bar = $("replay-controls");
  if (!S.replay) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "replay-controls";
    bar.innerHTML = `
      <button type="button" id="rp-pause" data-tip="Pause or resume the client-side replay clock.">⏸</button>
      <span class="rp-speeds" role="group" aria-label="Replay speed">${[1, 10, 60, 300].map((x) => `<button type="button" data-speed="${x}">${x}×</button>`).join("")}</span>
      <input type="range" id="rp-scrub" min="0" max="1000" value="0" aria-label="Replay position">
      <span id="rp-clock"></span>
      <button type="button" id="rp-goal" data-tip="Jump the replay clock to 30 seconds before the next recorded goal.">next goal ⏵</button>`;
    $("chart-wrap").appendChild(bar);
    bar.querySelector("#rp-pause").onclick = () => { const R = S.replay; if (!R) return; R.paused = !R.paused; R.lastWall = performance.now(); updateReplayControls(); };
    bar.querySelectorAll("[data-speed]").forEach((b) => b.onclick = () => { const R = S.replay; if (!R) return; R.speed = Number(b.dataset.speed); updateReplayControls(); });
    bar.querySelector("#rp-scrub").oninput = (ev) => { const R = S.replay; if (!R) return; replaySeek(R.t0 + (R.t1 - R.t0) * ev.target.value / 1000); };
    bar.querySelector("#rp-goal").onclick = () => {
      const R = S.replay; if (!R) return;
      const next = (S.meta?.moments || []).map((m) => m.t0).sort((a, b) => a - b).find((t) => t > R.simT + 5);
      if (next) replaySeek(next - 30);
    };
  }
  updateReplayControls();
}

function updateReplayControls() {
  const bar = $("replay-controls"), R = S.replay;
  if (!bar || !R) return;
  bar.querySelector("#rp-pause").textContent = R.paused ? "▶" : "⏸";
  bar.querySelectorAll("[data-speed]").forEach((b) => b.classList.toggle("active", Number(b.dataset.speed) === R.speed));
  const scrub = bar.querySelector("#rp-scrub");
  if (document.activeElement !== scrub) scrub.value = Math.round((R.simT - R.t0) / (R.t1 - R.t0) * 1000);
  bar.querySelector("#rp-clock").textContent = `${R.speed}× · ${new Date(R.simT * 1000).toLocaleTimeString()}`;
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
  S.replay = null; renderReplayControls();
}

// ── moments strip ────────────────────────────────────────────────────────────
const fmtClock = (cs) => cs == null ? "" : `${Math.floor(cs / 60)}'`;
const fmtDt = (v) => v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}s`;
function watchedGoalFills(mo) {
  if (mo?.t0 == null) return [];
  const candidates = S.flags.filter((event) => event.kind === "fill" && isWatchlistedFill(event) &&
    event.t >= mo.t0 - GOAL_ACTOR_WINDOW && event.t <= mo.t0 + GOAL_ACTOR_WINDOW)
    .sort((a, b) => Math.abs(a.t - mo.t0) - Math.abs(b.t - mo.t0) || a.t - b.t);
  return candidates.map((fill) => ({...fill, label: watchNameForFill(fill), dt: fill.t - mo.t0}));
}

function paperGoalActivity(mo) {
  if (!paperBotSelected() || mo?.t0 == null) return [];
  return S.flags.filter((event) => event.src === "bot" && event.kind === "trade" &&
    event.t >= mo.t0 - GOAL_ACTOR_WINDOW && event.t <= mo.t0 + GOAL_ACTOR_WINDOW)
    .sort((a, b) => Math.abs(a.t - mo.t0) - Math.abs(b.t - mo.t0) || a.t - b.t)
    .map((event) => ({...event, dt: event.t - mo.t0}));
}

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
    const watched = watchedGoalFills(mo);
    const d = document.createElement("div");
    d.className = "moment";
    d.tabIndex = 0;
    d.setAttribute("role", "button");
    d.setAttribute("aria-label", `${mo.scorer || "Goal"} ${fmtClock(mo.cs) || "recorded goal"}; click to show on chart or analyze the goal`);
    const tags =
      (mo.disallowed ? `<span class="tag disallowed">DISALLOWED</span>` : mo.var ? `<span class="tag var">VAR</span>` : "") +
      (mo.t0_src === "espn" ? `<span class="tag espn-only" data-tip="${esc(mo.note || "TxLINE goal-action timing is unavailable for this goal.")}">feed gap</span>` : "");
    const botActor = paperBotEntry();
    const pnl = botActor && mo.bot_pnl != null ? `<span class="pnl actor-pnl" style="--actor-color:${watchColor(botActor)}">${esc(botActor.name)} · paper ${mo.bot_pnl >= 0 ? "+" : "−"}$${Math.abs(mo.bot_pnl).toFixed(2)}</span>` : "";
    const d120 = mo.delta_120s != null ? `<span><b>${(mo.delta_120s >= 0 ? "+" : "") + (mo.delta_120s * 100).toFixed(0)}¢</b><i>@120s</i></span>` : "";
    const wallet = watched.length ? `<span><b>${fmtDt(watched[0].dt)}</b><i>Watch · ${esc(watched[0].label)}${watched.length > 1 ? ` +${watched.length - 1} fills` : ""}</i></span>` : "";
    const bot = botActor && mo.bot_action ? `<span><b>${fmtDt(mo.bot_dt)}</b><i>${esc(botActor.name)} · ${esc(mo.bot_action)}</i></span>` : "";
    const jup = mo.jup_dt != null ? `<span><b>${fmtDt(mo.jup_dt)}</b><i>Jupiter</i></span>` : "";
    d.innerHTML = `
      <div class="head"><b><span style="color:var(--good)">●</span> ${esc(mo.scorer || "?")}</b><span class="clock">${fmtClock(mo.cs)}</span>${tags}${pnl}</div>
      <div class="lags">
        <span><b>${mo.t0_src === "txline" ? "0.0s" : "—"}</b><i data-tip="The reference time: TxLINE's recorded goal message.">TxLINE</i></span>
        <span><b>${fmtDt(mo.poly_dt)}</b><i data-tip="First sustained Polymarket move of at least 3¢, relative to TxLINE.">Polymarket</i></span>
        <span><b>${fmtDt(mo.espn_dt)}</b><i data-tip="ESPN score detection relative to TxLINE.">ESPN</i></span>
        ${bot}${wallet}${jup}${d120}
      </div>
      <div class="moment-actions"><span>Click card to show on chart</span><button type="button" class="moment-detail" aria-label="Analyze ${esc(mo.scorer || "goal")}" data-tip="Open the source-timing waterfall, watched-wallet activity, and recorded trading context.">Analyze goal <b aria-hidden="true">↗</b></button></div>`;
    d.onclick = () => selectMoment(mo, d);
    d.onkeydown = (ev) => { if (ev.target === d && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); selectMoment(mo, d); } };
    d.querySelector(".moment-detail").onclick = (ev) => { ev.stopPropagation(); openGoalDetail(mo, d, index); };
    d.onmouseenter = () => momentSpark(d, mo);
    el.appendChild(d);
  }
}

// Hover sparkline: benefiting team's Polymarket price ±120s around the goal.
// Drawn once per card on first hover; decorative only (full data is on the chart).
function momentSpark(card, mo) {
  if (card.querySelector(".moment-spark") || mo.t0 == null || !mo.benefit) return;
  const s = S.series.get(mo.benefit);
  const pts = (s?.poly || []).filter((p) => p[0] >= mo.t0 - 120 && p[0] <= mo.t0 + 120);
  if (pts.length < 2) return;
  const W = 120, H = 24, dpr = window.devicePixelRatio || 1;
  const cv = document.createElement("canvas");
  cv.className = "moment-spark";
  cv.setAttribute("aria-hidden", "true");
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext("2d");
  ctx.scale(dpr, dpr);
  let lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
  if (hi - lo < 0.02) { const mid = (hi + lo) / 2; lo = mid - 0.01; hi = mid + 0.01; }
  const x = (t) => (t - (mo.t0 - 120)) / 240 * W;
  const y = (p) => H - 2 - (p - lo) / (hi - lo) * (H - 4);
  ctx.strokeStyle = "rgba(140,140,130,.55)";
  ctx.beginPath(); ctx.moveTo(x(mo.t0) + .5, 0); ctx.lineTo(x(mo.t0) + .5, H); ctx.stroke();
  ctx.strokeStyle = s.color; ctx.lineWidth = 1.5;
  ctx.beginPath();
  pts.forEach((p, i) => i ? ctx.lineTo(x(p[0]), y(p[1])) : ctx.moveTo(x(p[0]), y(p[1])));
  ctx.stroke();
  card.appendChild(cv);
}

function openGoalDetail(mo, card, index) {
  const overlay = $("goal-overlay"), out = $("goal-modal-content");
  const badge = (label, cls) => `<span class="tag ${cls}">${label}</span>`;
  const badges = `${mo.var ? badge("VAR", "var") : ""}${mo.disallowed ? badge("DISALLOWED", "disallowed") : ""}${mo.t0_src === "espn" ? badge("FEED GAP", "espn-only") : ""}`;
  const minute = mo.cs == null ? "recorded goal" : `${Math.floor(mo.cs / 60)}'`;
  const botActor = paperBotEntry();
  const footer = [
    mo.delta_120s == null ? "" : `<div><span>Price move at 120s</span><strong class="${mo.delta_120s >= 0 ? "pos" : "neg"}">${mo.delta_120s >= 0 ? "+" : "−"}${Math.abs(mo.delta_120s * 100).toFixed(1)}¢</strong></div>`,
    !botActor || (mo.bot_entries == null && mo.bot_pnl == null) ? "" : `<div class="actor-result" style="--actor-color:${watchColor(botActor)}"><span>${esc(botActor.name)} · paper ledger</span><strong>${esc(mo.bot_action || `${mo.bot_entries} entr${mo.bot_entries === 1 ? "y" : "ies"}`)}${mo.bot_pnl == null ? "" : ` · ${mo.bot_pnl >= 0 ? "+" : "−"}$${Math.abs(mo.bot_pnl).toFixed(2)}`}</strong></div>`,
  ].filter(Boolean).join("");
  let body;
  if (mo.t0_src === "espn") {
    body = `<div class="feed-gap"><strong>Latency unavailable for this goal</strong><p>${esc(mo.note || "TxLINE goal-action recording was unavailable, so source lags cannot be measured honestly.")}</p><p>The chart still shows the surrounding market and feed data using ESPN detection as the recorded baseline.</p></div>`;
  } else {
    const marketSources = [
      {label: "TxLINE", value: 0},
      {label: "Polymarket", value: mo.poly_dt},
      {label: "Jupiter", value: mo.jup_dt},
      {label: "ESPN", value: mo.espn_dt},
      {label: "wc26", value: mo.wc26_dt},
    ].filter((source, i) => i === 0 || source.value != null);
    const watched = watchedGoalFills(mo);
    const walletSources = watched.slice(0, GOAL_ACTOR_LIMIT).map((fill) => ({
      label: fill.label, value: fill.dt, fill,
    }));
    const nearbyBot = paperGoalActivity(mo);
    const botSources = nearbyBot.length ? nearbyBot.slice(0, GOAL_ACTOR_LIMIT).map((event) => ({
      label: botActor.name, value: event.dt,
      bot: {action: event.action, team: event.team, price: event.price, pnl: event.pnl,
        reason: event.reason, actor: botActor},
    })) : botActor && mo.bot_action && mo.bot_dt != null ? [{label: botActor.name, value: mo.bot_dt,
      bot: {action: mo.bot_action, team: mo.benefit, price: mo.bot_price, actor: botActor}}] : [];
    const values = [...marketSources, ...botSources, ...walletSources].map((source) => source.value);
    const min = Math.floor(Math.min(-5, ...values));
    const max = Math.ceil(Math.max(60, ...values));
    const pct = (value) => (value - min) / (max - min) * 100;
    const zero = pct(0);
    const row = ({label, value, fill, bot}) => {
      const x = pct(value), left = Math.min(zero, x), width = Math.abs(x - zero);
      const front = value < 0;
      const color = fill ? watchColorForFill(fill) : bot ? watchColor(bot.actor) : null;
      const detail = fill ? `<small>${esc(String(fill.side || "fill").toUpperCase())} ${esc(fill.team || "outcome")}${fill.size == null ? "" : ` · ${Number(fill.size).toLocaleString(undefined, {maximumFractionDigits: 2})}`}${fill.price == null ? "" : ` @ ${(Number(fill.price) * 100).toFixed(1)}¢`}</small>` :
        bot ? `<small>${esc(bot.action)}${bot.team ? ` ${esc(bot.team)}` : ""}${bot.price == null ? "" : ` @ ${(Number(bot.price) * 100).toFixed(1)}¢`}${bot.pnl == null ? "" : ` · ${bot.pnl >= 0 ? "+" : "−"}$${Math.abs(bot.pnl).toFixed(2)}`}${bot.reason ? ` · ${esc(bot.reason)}` : ""}</small>` : "";
      const glyph = fill ? "◆" : bot ? bot.action === "EXIT" ? "▼" : "▲" : "";
      return `<div class="waterfall-row"><span><b>${glyph ? `<i class="actor-glyph" style="color:${color}">${glyph}</i>` : ""}${esc(label)}</b>${detail}</span><div class="waterfall-track" style="--zero:${zero}%;${color ? `--actor-color:${color};` : ""}"><i class="waterfall-bar ${front ? "front" : ""}${fill || bot ? " actor" : ""}" style="left:${left}%;width:${Math.max(width, value === 0 ? .6 : 0)}%"></i></div><strong class="${front ? "front" : ""}">${value === 0 ? "0.0s" : fmtDt(value)}</strong></div>`;
    };
    const walletBody = walletSources.length
      ? walletSources.map(row).join("") + (watched.length > walletSources.length ? `<div class="waterfall-more">+${watched.length - walletSources.length} more watched fill${watched.length - walletSources.length === 1 ? "" : "s"}</div>` : "")
      : "";
    const botBody = botSources.map(row).join("") + (nearbyBot.length > botSources.length
      ? `<div class="waterfall-more">+${nearbyBot.length - botSources.length} more paper execution${nearbyBot.length - botSources.length === 1 ? "" : "s"}</div>` : "");
    const actorBody = botBody || walletBody ? `${botBody}${walletBody}` : `<p class="waterfall-empty">${S.watchlist.length ? "No watched actor activity within five minutes of this goal." : "Add an actor to compare its goal-reaction activity."}</p>`;
    body = `<div class="waterfall" aria-label="Source and watched-actor timing relative to TxLINE"><div class="waterfall-axis"><span>${fmtDt(min)}</span><span>TxLINE 0</span><span>${fmtDt(max)}</span></div><div class="waterfall-group-label">Market signals</div>${marketSources.map(row).join("")}<div class="waterfall-group-label"><span>Watchlist</span><button type="button" id="goal-open-watchlist">${S.watchlist.length ? "Manage watchlist" : "+ Add actors"}</button></div>${actorBody}</div><p class="waterfall-note"><span class="front-key"></span> Negative means the source or actor activity arrived before TxLINE's recorded goal message.</p>`;
  }
  out.innerHTML = `<header class="goal-modal-head"><div><span class="eyebrow">GOAL MOMENT · ${esc(mo.score_before || "?")} → ${esc(mo.score_after || "?")}</span><h2 id="goal-modal-title">${esc(mo.scorer || "Unknown")} goal, ${minute}</h2><div class="goal-badges">${badges}</div></div></header>${body}<div class="goal-modal-footer">${footer}<span class="footer-spacer"></span><button type="button" id="goal-ask-ai" class="ai-trigger">✦ Ask AI insight</button><button type="button" id="goal-show-chart">Show on chart</button></div><section id="ai-panel" aria-live="polite" hidden></section>`;
  $("goal-show-chart").onclick = () => { closeGoalDetail(); if (!$("insights").hidden) toggleInsights(); selectMoment(mo, card || document.querySelectorAll(".moment")[index]); };
  $("goal-ask-ai").onclick = () => requestAiInsight(mo, index, `Explain this goal moment. Focus on why source timing differed, whether any recorded gap was tradable${botActor ? `, and what ${botActor.name} did` : ""}.`);
  if ($("goal-open-watchlist")) $("goal-open-watchlist").onclick = () => { closeGoalDetail(); openWallet(); };
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
  // JS click handlers often re-render or scroll; never leave a popover pinned
  // to a target that got detached or lost focus.
  setTimeout(() => { if (helpTarget && (!helpTarget.isConnected || (document.activeElement !== helpTarget && !helpTarget.matches(":hover")))) hideHelp(); }, 0);
});
document.addEventListener("scroll", () => hideHelp(), { capture: true, passive: true });
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  hideHelp();
  if (!$("goal-overlay").hidden) closeGoalDetail();
  if (!$("wallet-overlay").hidden) closeWallet();
  if (!$("filter-overlay").hidden) { $("filter-overlay").hidden = true; document.body.classList.remove("modal-open"); }
});

function renderAiResult(mo, index, question, data) {
  const panel = $("ai-panel");
  if (!panel || panel.dataset.selection !== `${S.currentId}:${index}`) return;
  const provider = data.provider === "openai" ? "OPENAI · EVENT-GROUNDED" : `${String(data.provider || "AI").toUpperCase()} · EVENT-GROUNDED`;
  const actorPrompt = paperBotSelected() ? `<button type="button" data-question="What exactly did the selected paper bot do around this goal?">Paper-bot activity?</button>` : "";
  panel.innerHTML = `<div class="ai-panel-head"><div><span class="eyebrow">${data.fallback ? "RECORDED-FACTS FALLBACK" : esc(provider)}</span><h3>AI event analyst</h3></div><span class="ai-model">${esc(data.model || "local archive")}${data.cached ? " · cached" : ""}</span></div><div class="ai-answer"></div>${data.warning ? `<p class="ai-warning">${esc(data.warning)}</p>` : ""}<div class="ai-prompts"><button type="button" data-question="Why did the market move before TxLINE, and what evidence limits that conclusion?">Why market first?</button><button type="button" data-question="Was the recorded price gap still tradable after a five-second delay?">Tradable after 5s?</button>${actorPrompt}</div><form id="ai-question-form"><label for="ai-question">Ask about this selected goal</label><div><input id="ai-question" maxlength="240" placeholder="e.g. What happened in the minute before the goal?"><button type="submit">Ask</button></div></form><p class="ai-disclaimer">Trusted archive context only · interpretation is not betting advice.</p>`;
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
  panel.innerHTML = `<div class="ai-loading"><span>✦</span><div><strong>Analyzing the selected goal…</strong><p>Loading server-verified timing, pre-event prices, nearby feed evidence${paperBotSelected() ? ", and the selected paper ledger" : ""}.</p></div></div>`;
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  if (S._aiAbort) S._aiAbort.abort();
  const controller = new AbortController();
  S._aiAbort = controller;
  const timer = setTimeout(() => controller.abort(), 36000);
  const request = {match_id: S.currentId, moment_index: index, question};
  if (S.walletAddress) request.wallet_address = S.walletAddress;
  const walletAddresses = S.watchlist.filter((entry) => entry.kind !== "bot").slice(0, 10).map((entry) => entry.address);
  if (walletAddresses.length) request.watchlist = walletAddresses;
  if (paperBotSelected()) request.include_bot = true;
  fetch("/api/ai-insight", {
    method: "POST", signal: controller.signal, headers: {"Content-Type": "application/json"},
    body: JSON.stringify(request),
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
const WATCHLIST_STORAGE_KEY = "txline-observatory-watchlist";
const LEGACY_WALLET_STORAGE_KEY = "txline-observatory-wallet";
const shortWallet = (address) => address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "—";
const walletMoney = (value) => `$${Number(value || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;

function rememberedWatchlist() {
  try {
    const parsed = JSON.parse(localStorage.getItem(WATCHLIST_STORAGE_KEY) || "[]");
    const valid = Array.isArray(parsed) ? parsed.filter((entry) =>
      (entry?.kind === "bot" && entry.id === PAPER_BOT_ID && typeof entry.name === "string") ||
      (/^0x[a-f0-9]{40}$/.test(entry?.address) && typeof entry.name === "string")) : [];
    if (valid.length) return valid.map((entry) => entry.kind === "bot"
      ? {...entry, kind: "bot"}
      : {...entry, kind: "wallet", address: entry.address.toLowerCase()});
    const legacy = (localStorage.getItem(LEGACY_WALLET_STORAGE_KEY) || "").toLowerCase();
    return /^0x[a-f0-9]{40}$/.test(legacy)
      ? [{kind: "wallet", address: legacy, name: "My wallet", curated: false, description: "Custom public wallet"}]
      : [];
  } catch (_) { return []; }
}

function persistWatchlist() {
  try {
    localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(S.watchlist));
    localStorage.removeItem(LEGACY_WALLET_STORAGE_KEY);
  } catch (_) {}
}

function watchlistEntry(address) {
  const normalized = String(address || "").toLowerCase();
  return S.watchlist.find((entry) => entry.kind !== "bot" && entry.address === normalized) || null;
}

function watchKey(entry) { return entry?.kind === "bot" ? entry.id : entry?.address; }
function watchedActor(key) { return S.watchlist.find((entry) => watchKey(entry) === key) || null; }
function paperBotEntry() { return watchedActor(PAPER_BOT_ID); }
function paperBotSelected() { return !!paperBotEntry(); }

function watchEntryForFill(fill) {
  if (!fill) return null;
  const direct = watchlistEntry(fill.wallet_address || fill.watch_address);
  if (direct) return direct;
  const who = String(fill.who || fill.watch_name || "").toLowerCase();
  return S.watchlist.find((entry) => entry.curated && entry.name.toLowerCase() === who) || null;
}

function watchColor(entryOrKey) {
  const key = typeof entryOrKey === "string" ? entryOrKey :
    watchKey(entryOrKey) || entryOrKey?.name || "watchlist";
  let hash = 0;
  for (const char of String(key).toLowerCase()) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return WATCH_COLORS[Math.abs(hash) % WATCH_COLORS.length];
}

function watchColorForFill(fill) {
  return watchColor(watchEntryForFill(fill) || fill?.wallet_address || fill?.who || "watchlist");
}

function isWatchlistedFill(fill) {
  if (!fill || fill.kind !== "fill") return false;
  return !!watchEntryForFill(fill);
}

function watchNameForFill(fill) {
  return watchEntryForFill(fill)?.name || fill.watch_name || fill.who || "Watched wallet";
}

function walletFillKey(fill) {
  return `${fill.wallet_address || fill.watch_address || fill.who || ""}:${Math.round(Number(fill.t ?? fill.timestamp) || 0)}:${fill.side || ""}:${Number(fill.price || 0).toFixed(6)}:${Number(fill.size || 0).toFixed(6)}`;
}

function walletTimelineEvents(matchId, existing = S.events) {
  const fills = S.walletFillsByMatch.get(matchId) || [];
  const seen = new Set(existing.filter((x) => x.kind === "fill").map(walletFillKey));
  const events = [];
  for (const fill of fills) {
    const event = {t: fill.timestamp, src: "public-wallet", kind: "fill",
      who: fill.watch_name || shortWallet(fill.watch_address), wallet_address: fill.watch_address,
      team: fill.team || fill.outcome, side: fill.side, price: fill.price, size: fill.size,
      notional: fill.notional, market_title: fill.market_title, fill_source: fill.source};
    const key = walletFillKey(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  return events;
}

function addWalletFillsToCurrent(matchId = S.currentId) {
  const events = walletTimelineEvents(matchId);
  events.forEach(addEvent);
  return events.length;
}

function removePublicWalletFills() {
  S.events = S.events.filter((x) => x.src !== "public-wallet");
  S.flags = S.flags.filter((x) => x.src !== "public-wallet");
  S.lastT = Math.max(0, ...S.events.map((x) => x.t || 0));
}

function rebuildWalletFillIndex() {
  S.walletFillsByMatch = new Map();
  for (const [address, report] of S.walletReports) {
    const entry = watchlistEntry(address);
    if (!entry || entry.curated) continue; // the normalized archive already carries curated fills
    for (const raw of report.fills || []) {
      const fill = {...raw, watch_address: address, watch_name: entry.name};
      const list = S.walletFillsByMatch.get(fill.match_id) || [];
      list.push(fill); S.walletFillsByMatch.set(fill.match_id, list);
    }
  }
}

function refreshWatchlistViews() {
  if (S.mode === "full" && S.currentId) {
    removePublicWalletFills(); rebuildWalletFillIndex(); addWalletFillsToCurrent();
  }
  if (S.sel?.kind === "fill" && !isWatchlistedFill(S.sel)) S.sel = null;
  if (S.sel?.src === "bot" && !paperBotSelected()) S.sel = null;
  renderDetail(S.sel);
  renderMoments(); renderChips(); renderLegend(); renderComparisonBar(); statusLine(); draw();
  if (S.insightsData && !$('insights').hidden) renderInsightTab(S.insightTab, S.insightsData);
}

function renderComparisonBar() {
  const root = $("comparison-bar"), header = $("btn-wallet");
  if (!root || !header) return;
  header.innerHTML = `Watchlist${S.watchlist.length ? ` <span class="header-watch-count">${S.watchlist.length}</span>` : ""}`;
  header.classList.toggle("has-watchlist", S.watchlist.length > 0);
  if (!S.meta || S.mode === "upcoming") { root.hidden = true; return; }
  const actors = S.watchlist.map((entry) => {
    const isBot = entry.kind === "bot";
    const count = isBot
      ? S.flags.filter((event) => event.src === "bot" && event.kind === "trade").length
      : S.flags.filter((event) => event.kind === "fill" && watchEntryForFill(event)?.address === entry.address).length;
    const noun = isBot ? `paper execution${count === 1 ? "" : "s"}` : `fill${count === 1 ? "" : "s"}`;
    return `<span class="comparison-source" style="--actor-color:${watchColor(entry)}"><b><i>${isBot ? "▲▼" : "◆"}</i> ${esc(entry.name)}</b><span>${count} ${noun}</span></span>`;
  }).join("");
  root.hidden = false;
  root.innerHTML = `<span class="comparison-label">Watchlist layer</span>${actors}<button type="button" id="comparison-manage">${S.watchlist.length ? "Manage watchlist" : "+ Add actors"}</button>`;
  $("comparison-manage").onclick = openWallet;
}

function addWatchEntry(entry, refresh = true) {
  if (entry.kind === "bot") {
    if (entry.id !== PAPER_BOT_ID || watchedActor(entry.id)) return false;
    S.watchlist.push({id: entry.id, kind: "bot", name: entry.name || "TxLINE paper bot",
      description: entry.description || "Recorded paper-execution ledger", curated: true});
    persistWatchlist();
    if (refresh) refreshWatchlistViews();
    return true;
  }
  const address = String(entry.address || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address) || watchlistEntry(address)) return false;
  S.watchlist.push({kind: "wallet", address, name: entry.name || shortWallet(address),
    description: entry.description || "Custom public wallet", curated: !!entry.curated});
  persistWatchlist();
  if (refresh) refreshWatchlistViews();
  return true;
}

function removeWatchEntry(key) {
  const normalized = String(key || "").toLowerCase();
  const entry = watchedActor(normalized) || watchlistEntry(normalized);
  S.watchlist = S.watchlist.filter((item) => item !== entry);
  if (entry?.address) S.walletReports.delete(entry.address);
  if (S.walletAddress === entry?.address) S.walletAddress = null;
  persistWatchlist(); refreshWatchlistViews(); renderWatchlist();
}

function rememberWalletReport(report, preferCustom = false) {
  const address = report.address.toLowerCase();
  const suggestion = preferCustom ? null : (walletConfig?.suggested_wallets || []).find((entry) => entry.address === address);
  S.walletReports.set(address, report);
  S.walletAddress = address; // most recently inspected wallet supplies optional AI context
  const existing = watchlistEntry(address);
  if (preferCustom && existing) {
    const hasAnotherCustom = S.watchlist.some((entry) => entry !== existing && entry.kind !== "bot" && !entry.curated);
    Object.assign(existing, {kind: "wallet", name: hasAnotherCustom ? shortWallet(address) : "My wallet",
      description: "Custom public wallet", curated: false});
  } else {
    addWatchEntry(suggestion ? {...suggestion, curated: true} : {
      address,
      name: S.watchlist.some((entry) => entry.kind !== "bot" && !entry.curated) ? shortWallet(address) : "My wallet",
      description: "Custom public wallet", curated: false,
    }, false);
  }
  persistWatchlist(); refreshWatchlistViews(); renderWatchlist();
}

S.watchlist = rememberedWatchlist();

function renderWatchlist() {
  const current = $("watchlist-current"), suggestionsRoot = $("watchlist-suggestions");
  if (!current || !suggestionsRoot) return;
  $("watchlist-count").textContent = `${S.watchlist.length} actor${S.watchlist.length === 1 ? "" : "s"}`;
  current.innerHTML = S.watchlist.length ? S.watchlist.map((entry) => {
    const isBot = entry.kind === "bot", reportLoaded = !isBot && S.walletReports.has(entry.address);
    return `<div class="watchlist-item" style="--actor-color:${watchColor(entry)}"><span class="watchlist-glyph">${isBot ? "▲▼" : "◆"}</span><div><strong>${esc(entry.name)}</strong><span>${esc(entry.description || "Public wallet")}</span><code>${isBot ? "paper simulation · no wallet address" : esc(shortWallet(entry.address))}</code></div><span class="watchlist-origin">${isBot ? "paper bot" : entry.curated ? "suggested" : "custom"}</span>${isBot || entry.curated ? "" : `<button type="button" data-watch-refresh="${entry.address}">${reportLoaded ? "Refresh fills" : "Load fills"}</button>`}<button type="button" class="watchlist-remove" data-watch-remove="${watchKey(entry)}" aria-label="Remove ${esc(entry.name)} from watchlist">×</button></div>`;
  }).join("") : `<p class="wallet-empty">No actors yet. Add a suggestion below or enter a wallet address.</p>`;
  const suggestions = [...(walletConfig?.suggested_bots || []), ...(walletConfig?.suggested_wallets || [])];
  suggestionsRoot.innerHTML = suggestions.length ? suggestions.map((entry) => {
    const key = entry.kind === "bot" ? entry.id : entry.address;
    const watched = !!(entry.kind === "bot" ? watchedActor(key) : watchlistEntry(key));
    return `<div class="watchlist-suggestion${watched ? " watched" : ""}${entry.kind === "bot" ? " paper-bot" : ""}"><div><strong>${entry.kind === "bot" ? "▲▼ " : ""}${esc(entry.name)}</strong><span>${esc(entry.description)}</span><code>${entry.kind === "bot" ? "optional paper simulation" : esc(shortWallet(entry.address))}</code></div><button type="button" data-watch-add="${key}" ${watched ? "disabled" : ""}>${watched ? "Following" : "+ Add"}</button></div>`;
  }).join("") : `<p class="wallet-empty">Suggestions are temporarily unavailable.</p>`;
  current.querySelectorAll("[data-watch-remove]").forEach((button) => button.onclick = () => removeWatchEntry(button.dataset.watchRemove));
  current.querySelectorAll("[data-watch-refresh]").forEach((button) => button.onclick = () => loadWallet(button.dataset.watchRefresh));
  suggestionsRoot.querySelectorAll("[data-watch-add]").forEach((button) => button.onclick = () => {
    const entry = suggestions.find((item) => (item.kind === "bot" ? item.id : item.address) === button.dataset.watchAdd);
    if (entry) { addWatchEntry({...entry, curated: true}); renderWatchlist(); }
  });
  const walletSuggestions = walletConfig?.suggested_wallets || [];
  const remaining = walletSuggestions.filter((entry) => !watchlistEntry(entry.address));
  $("watchlist-add-all").disabled = !remaining.length;
  $("watchlist-add-all").textContent = remaining.length ? `Add suggested wallets (${remaining.length})` : "Suggested wallets added";
}

function applyWalletConfig(config) {
  walletConfig = config;
  let changed = false;
  S.watchlist = S.watchlist.map((entry) => {
    if (entry.kind === "bot") {
      const suggestion = (config.suggested_bots || []).find((item) => item.id === entry.id);
      return suggestion ? {...entry, ...suggestion, curated: true} : entry;
    }
    // A wallet explicitly entered as custom remains the user's local identity even
    // when its address is also in our research cohort. This also keeps its fetched
    // report indexed instead of switching to name-only archive matching mid-load.
    if (!entry.curated) return entry;
    const suggestion = (config.suggested_wallets || []).find((item) => item.address === entry.address);
    if (!suggestion) return entry;
    if (!entry.curated || entry.name !== suggestion.name || entry.description !== suggestion.description) changed = true;
    return {...entry, ...suggestion, curated: true};
  });
  if (changed) { persistWatchlist(); refreshWatchlistViews(); }
  renderWatchlist();
}

let walletConfigPromise = null;
function ensureWalletConfig() {
  if (walletConfig) return Promise.resolve(walletConfig);
  if (!walletConfigPromise) walletConfigPromise = fetch("/api/wallet").then((response) => response.json()).then((config) => {
    applyWalletConfig(config); return config;
  }).catch((error) => {
    walletConfigPromise = null;
    $("watchlist-suggestions").innerHTML = `<p class="wallet-error">Watchlist suggestions are unavailable.</p>`;
    throw error;
  });
  return walletConfigPromise;
}

function openWallet() {
  hideHelp();
  walletReturnFocus = document.activeElement;
  $("wallet-overlay").hidden = false;
  document.body.classList.add("modal-open");
  renderWatchlist();
  if (walletConfig) { if (!isCoarse()) $("wallet-address").focus(); return; }
  ensureWalletConfig().then(() => { if (!isCoarse()) $("wallet-address").focus(); }).catch(() => {});
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
  const actor = watchlistEntry(report.address);
  out.innerHTML = `<div class="wallet-result-head"><div><span class="eyebrow">PUBLIC WALLET · ${report.demo ? "RECORDED DEMO" : "READ ONLY"}</span><h3>${esc(actor?.name || shortWallet(report.address))}</h3><p>${esc(shortWallet(report.address))} · ${esc(report.scope)}</p></div><span>${coverage}${report.cached ? " · cached" : ""}</span></div><div class="wallet-tiles"><div><span>Matched fills</span><strong>${report.matched_fills}</strong></div><div><span>Archive matches</span><strong>${report.matched_matches}</strong></div><div><span>Matched notional</span><strong>${walletMoney(report.matched_notional)}</strong></div></div><p class="wallet-pnl-note">${esc(report.pnl_note)}</p>${groups}${fills}`;
  out.querySelectorAll(".wallet-jump").forEach((button) => button.onclick = () => {
    const match = button.dataset.match, t = Number(button.dataset.t);
    closeWallet(); if (!$("insights").hidden) toggleInsights(); loadFull(match, t);
  });
}

function fetchWalletReport(address) {
  return fetch(`/api/wallet?address=${encodeURIComponent(address)}`).then(async (response) => {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Wallet lookup failed");
    return data;
  });
}

function loadWallet(address, preferCustom = false) {
  const normalized = address.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
    $("wallet-results").innerHTML = `<p class="wallet-error">Enter a 0x address with 40 hexadecimal characters.</p>`;
    return;
  }
  $("wallet-address").value = normalized;
  $("wallet-results").innerHTML = `<div class="wallet-loading"><span>◆</span><div><strong>Matching public fills…</strong><p>Checking only token IDs from the 2026 World Cup archive. This can take a few seconds.</p></div></div>`;
  fetchWalletReport(normalized).then((report) => { rememberWalletReport(report, preferCustom); renderWalletReport(report); }).catch((error) => {
    $("wallet-results").innerHTML = `<p class="wallet-error">${esc(error.message)}</p>`;
  });
}

function hydrateCustomWatchlist() {
  for (const entry of S.watchlist) {
    if (entry.kind === "bot" || entry.curated || S.walletReports.has(entry.address)) continue;
    fetchWalletReport(entry.address).then(rememberWalletReport).catch(() => {});
  }
}

$("btn-wallet").onclick = openWallet;
$("wallet-modal-close").onclick = closeWallet;
$("wallet-overlay").onclick = (ev) => { if (ev.target === $("wallet-overlay")) closeWallet(); };
$("wallet-form").onsubmit = (ev) => { ev.preventDefault(); loadWallet($("wallet-address").value, true); };
$("watchlist-add-all").onclick = () => {
  for (const entry of walletConfig?.suggested_wallets || []) addWatchEntry({...entry, curated: true}, false);
  persistWatchlist(); refreshWatchlistViews(); renderWatchlist();
};

function selectMoment(mo, card, viewT = mo.t0) {
  hideHelp();
  S.view = [viewT - 120, viewT + 420];
  S.follow = false;
  S.sel = { synthetic: true, ...mo };
  document.querySelectorAll(".moment").forEach((x) => x.classList.remove("sel"));
  if (card) card.classList.add("sel");
  renderDetail(S.sel);
  renderScoreboard();
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
  renderDetail(null); renderScoreboard();
  syncPageState(t);
  draw();
}

// ── detail strip: one-line human sentence for the selected event ─────────────
function describeEvent(e) {
  const cents = (v) => v == null ? "—" : `${(v * 100).toFixed(1)}¢`;
  const clock = e.cs != null ? `, ${fmtClock(e.cs)}` : "";
  if (e.synthetic) {
    const watched = watchedGoalFills(e);
    return `Goal moment — ${e.scorer || "?"}${clock}${e.score_before ? ` (${e.score_before}→${e.score_after})` : ""}: ${e.t0_src === "espn" ? "ESPN-detected baseline" : `Polymarket ${fmtDt(e.poly_dt)}${watched.length ? ` · ${watched[0].label} ${fmtDt(watched[0].dt)}${watched.length > 1 ? ` (+${watched.length - 1} watched fills)` : ""}` : ""}${e.jup_dt != null ? ` · Jupiter ${fmtDt(e.jup_dt)}` : ""}`}`;
  }
  if (e.src === "bot" && e.kind === "trade")
    return `${paperBotEntry()?.name || "Paper bot"} ${e.action || "trade"}${e.team ? ` ${e.team}` : ""}${e.size != null ? ` ×${e.size}` : ""} @ ${cents(e.price)}${e.reason ? ` (${e.reason})` : ""}${e.pnl != null ? ` · paper ${e.pnl >= 0 ? "+" : "−"}$${Math.abs(e.pnl).toFixed(2)}` : ""}`;
  if (e.kind === "fill")
    return `${e.who || "Tracked wallet"} ${e.side || "fill"}${e.size != null ? ` ${Number(e.size).toLocaleString()}` : ""}${e.team ? ` ${e.team}` : ""} @ ${cents(e.price)}${e.src === "public-wallet" ? " · public wallet fill" : ""}`;
  if (e.kind === "score") {
    const srcName = e.src === "espn" ? "ESPN" : e.src === "wc26" ? "wc26" : "TxLINE";
    return `${srcName}: score ${e.score || "change"}${clock}`;
  }
  if (e.kind === "shock") return `Polymarket shock${e.team ? ` — ${e.team}` : ""}${e.move != null ? ` ${fmtDt ? "" : ""}${(e.move * 100).toFixed(0)}¢ step` : ""} at ${new Date(e.t * 1000).toLocaleTimeString()}`;
  if (e.kind === "burst") return `Polymarket repricing burst${e.n ? ` — ${e.n} updates` : ""} at ${new Date(e.t * 1000).toLocaleTimeString()}`;
  if (e.kind === "action")
    return `TxLINE: ${(e.action || "event").replaceAll("_", " ")}${e.team ? ` — ${e.team}` : ""}${e.confirmed != null ? ` (${e.confirmed ? "confirmed" : "unconfirmed"})` : ""}${clock}${e.seq != null ? `, seq ${e.seq}` : ""}`;
  return `${e.src || "event"}: ${e.kind}${e.team ? ` — ${e.team}` : ""} at ${new Date(e.t * 1000).toLocaleTimeString()}`;
}

function renderDetail(e) {
  const strip = $("detail-strip");
  if (!strip) return;
  if (!e) { strip.hidden = true; $("sr-live").textContent = ""; return; }
  strip.hidden = false;
  const text = describeEvent(e);
  $("detail-text").textContent = text;
  $("sr-live").textContent = `Selected: ${text}`;
  const fid = e.fid || S.meta?.fid;
  $("detail-verify").hidden = !(e.seq != null && fid);
  $("detail-json").onclick = () => { $("inspector").classList.add("open"); openInspector(e); resize(); };
  $("detail-verify").onclick = () => {
    $("inspector").classList.add("open"); openInspector(e); resize();
    $("insp-anchor").querySelector("button")?.click();
  };
}

// ── chips: three labeled groups + More… overflow + presets ──────────────────
function chipCount(name, pred) {
  if (name === "jupiter") return S.hasJup ? [...S.series.values()].reduce((n, s) => n + (s.jup?.length || 0), 0) : 0;
  return S.flags.filter(pred).length;
}

function applyPreset(preset) {
  for (const [name, on] of GROUPS.map(([n, d]) => [n, preset === "everything" ? true : d])) S.filters.set(name, on);
  S.preset = preset;
  renderChips(); renderLegend(); draw();
}

function makeChip(name, pred) {
  const n = chipCount(name, pred);
  // One-time ripple when the goals count grows during replay/live; a drop or
  // zero means the stream was (re)started, so re-baseline silently.
  let ripple = false;
  if (name === "goals" && (S.mode === "replay" || S.mode === "live")) {
    if (S._goalChipN != null && n > S._goalChipN) S._goalRippleT = performance.now();
    S._goalChipN = n;
    ripple = n > 0 && S._goalRippleT != null && performance.now() - S._goalRippleT < 900;
  }
  if (n === 0 && !(name === "wallet" && S.walletAddress)) return null;   // hide zero-count chips
  const on = S.filters.get(name);
  const auto = !on && name === "jupiter" && autoJoin();
  const c = document.createElement("span");
  c.className = "chip" + (on ? " on" : "") + (auto ? " auto" : "") + (ripple ? " ripple" : "");
  c.innerHTML = `${name} <span class="n">${auto ? "auto" : n}</span>`;
  c.tabIndex = 0; c.setAttribute("role", "button"); c.setAttribute("aria-pressed", String(on));
  c.dataset.tip = GROUP_TIPS[name];
  c.onclick = () => { S.filters.set(name, !S.filters.get(name)); S.preset = null; renderChips(); renderLegend(); draw(); };
  c.onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); c.click(); } };
  return c;
}

function renderChipGroups(root, { moreAsPopover }) {
  root.innerHTML = "";
  for (const section of ["match", "market", "actors"]) {
    const wrap = document.createElement("span");
    wrap.className = "chip-group";
    wrap.innerHTML = `<span class="lbl">${SECTION_LABEL[section]}</span>`;
    let any = false;
    for (const [name, , pred, sec] of GROUPS) {
      if (sec !== section) continue;
      const c = makeChip(name, pred);
      if (c) { wrap.appendChild(c); any = true; }
    }
    if (any) root.appendChild(wrap);
  }
  const moreChips = GROUPS.filter(([, , , sec]) => sec === "more").map(([name, , pred]) => makeChip(name, pred)).filter(Boolean);
  if (!moreChips.length) return;
  if (!moreAsPopover) {
    const wrap = document.createElement("span");
    wrap.className = "chip-group";
    wrap.innerHTML = `<span class="lbl">${SECTION_LABEL.more}</span>`;
    moreChips.forEach((c) => wrap.appendChild(c));
    root.appendChild(wrap);
    return;
  }
  const wrap = document.createElement("span");
  wrap.className = "chip-group chip-more";
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "chip chip-more-btn";
  const onCount = GROUPS.filter(([n, , , sec]) => sec === "more" && S.filters.get(n) && chipCount(n, GROUPS.find(([g]) => g === n)[2])).length;
  btn.innerHTML = `More… <span class="n">${onCount}</span>`;
  btn.setAttribute("aria-expanded", String(!!S.moreOpen));
  btn.onclick = (ev) => { ev.stopPropagation(); S.moreOpen = !S.moreOpen; renderChips(); };
  wrap.appendChild(btn);
  if (S.moreOpen) {
    const pop = document.createElement("span");
    pop.className = "chip-popover";
    moreChips.forEach((c) => pop.appendChild(c));
    wrap.appendChild(pop);
  }
  root.appendChild(wrap);
}

function renderChips() {
  const el = $("chips");
  el.innerHTML = "";
  const presets = document.createElement("span");
  presets.className = "chip-group chip-presets";
  for (const [id, label] of [["essential", "Essential"], ["everything", "Everything"]]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip preset" + (S.preset === id ? " on" : "");
    b.textContent = label;
    b.dataset.tip = id === "essential" ? "Goals, reviews, market signals, and your selected watchlist actors." : "Every recorded event type, including feed minutiae.";
    b.setAttribute("aria-pressed", String(S.preset === id));
    b.onclick = () => applyPreset(id);
    presets.appendChild(b);
  }
  el.appendChild(presets);
  const sheetBtn = document.createElement("button");
  sheetBtn.type = "button"; sheetBtn.id = "btn-filters"; sheetBtn.className = "chip";
  sheetBtn.textContent = "Filters";
  sheetBtn.onclick = () => { hideHelp(); $("filter-overlay").hidden = false; document.body.classList.add("modal-open"); renderChipGroups($("chips-sheet"), { moreAsPopover: false }); };
  el.appendChild(sheetBtn);
  const groups = document.createElement("span");
  groups.className = "chip-groups";
  renderChipGroups(groups, { moreAsPopover: true });
  el.appendChild(groups);
  if (!$("filter-overlay").hidden) renderChipGroups($("chips-sheet"), { moreAsPopover: false });
}
$("filter-close").onclick = () => { $("filter-overlay").hidden = true; document.body.classList.remove("modal-open"); };
$("filter-overlay").onclick = (ev) => { if (ev.target === $("filter-overlay")) $("filter-close").click(); };
document.addEventListener("click", (ev) => { if (S.moreOpen && !ev.target.closest?.(".chip-more")) { S.moreOpen = false; renderChips(); } });

function flagVisible(e) {
  for (const [name, , pred] of GROUPS) {
    if (!pred || !pred(e)) continue;
    return S.filters.get(name);
  }
  return false;
}
const jupiterVisible = () => S.hasJup && (S.filters.get("jupiter") || autoJoin());

// ── legend / status ──────────────────────────────────────────────────────────
function renderLegend() {
  const botActor = paperBotEntry();
  const botVisible = S.flags.some((event) => event.src === "bot" && event.kind === "trade" && flagVisible(event));
  const walletKeys = S.filters.get("watchlist") ? S.watchlist.filter((entry) => entry.kind !== "bot").map((entry) => ({entry,
    count: S.flags.filter((event) => event.kind === "fill" && watchEntryForFill(event)?.address === entry.address).length,
  })).filter((item) => item.count) : [];
  $("legend").innerHTML =
    S.labels.map(([lab, c]) =>
      `<span class="it" data-tip="Polymarket best bid for this outcome."><span class="line" style="border-color:${c}"></span>${esc(lab)}</span>`).join("") +
    (S.labels.length ? `<span class="it" data-tip="TxLINE de-margined fair probability."><span class="line dash" style="border-color:${INK.muted}"></span>TxLINE</span>` : "") +
    (jupiterVisible() ? `<span class="it" data-tip="Jupiter Predict best bid; this archive observed Polymarket-routed liquidity."><span class="line dot" style="border-color:${INK.muted}"></span>Jupiter</span>` : "") +
    (botVisible && botActor ? `<span class="it bot-key" style="--actor-color:${watchColor(botActor)}" data-tip="${esc(botActor.name)} paper executions: upward triangles are entries; downward triangles are exits."><span>▲▼</span>${esc(botActor.name)}</span>` : "") +
    walletKeys.map(({entry, count}) => `<span class="it wallet-key" data-tip="${esc(entry.name)} public fills. Filled diamonds are buys; outlined diamonds are sells."><span style="color:${watchColor(entry)}">◆◇</span>${esc(entry.name)} <small>${count}</small></span>`).join("");
}

function statusLine() {
  const b = S.lastBook;
  $("status").innerHTML = S.mode === "upcoming"
    ? `${S.events.length.toLocaleString()} prematch updates<span class="status-detail"> · data through ${S.lastT ? new Date(S.lastT*1000).toLocaleTimeString() : "—"}</span>`
    : b
    ? `${b.clock || ""} <span class="score">${b.score || ""}</span><span class="status-detail"> · ${new Date(S.lastT * 1e3).toLocaleTimeString()} · ${S.events.length.toLocaleString()} events</span>`
    : `${S.events.length.toLocaleString()} events`;
  renderScoreboard();
  renderComparisonBar();
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
const TRACK_H = 28;                                 // event track band height
const M = { l: 46, r: 116, t: 16, b: 30 + TRACK_H }; // b = track + axis labels

function resize() {
  const r = cv.parentElement.getBoundingClientRect();
  M.l = r.width <= 700 ? 38 : 46;
  M.r = r.width <= 700 ? 84 : 116;
  cv.width = r.width * devicePixelRatio; cv.height = r.height * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  draw();
}
window.addEventListener("resize", resize);
new ResizeObserver(() => resize()).observe(cv.parentElement);

let YR = [0, 1];                                    // y range (auto-fit aware)
const X = (t) => M.l + (t - S.view[0]) / (S.view[1] - S.view[0]) * (cv.clientWidth - M.l - M.r);
const T = (x) => S.view[0] + (x - M.l) / (cv.clientWidth - M.l - M.r) * (S.view[1] - S.view[0]);
const Y = (v) => M.t + (1 - (v - YR[0]) / (YR[1] - YR[0])) * (cv.clientHeight - M.t - M.b);
const plotBottom = () => cv.clientHeight - M.b;      // top of the event track

function niceStep(spanSec) {
  const steps = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400];
  const maxTicks = Math.max(3, Math.floor((cv.clientWidth - M.l - M.r) / 90));
  return steps.find((s) => spanSec / s <= maxTicks) || 172800;
}

// ── match-clock anchors: TxLINE actions carry cs (game-clock seconds) ────────
// The raw cs stream is noisy: out-of-order feed messages step backwards a few
// seconds, goal corrections replay ~100s, halftime resets the clock to exactly
// 2700, and the FT status resets it to 0. Cleaning rules:
//  · drops any backwards step (noise/corrections) EXCEPT a reset to exactly
//    2700 after the clock passed 2700 — that is the second-half kickoff (era++)
//  · interpolation clamps to the next anchor's cs, so clock stalls (halftime,
//    VAR replays) never overrun the recorded minute
//  · halftime = the big wall-time stall while cs sits near 2700
function clockAnchors() {
  if (S._anchorsCache) return S._anchorsCache;
  const raw = S.flags
    .filter((e) => e.kind === "action" && e.src === "txline" && e.cs != null)
    .map((e) => [e.t, e.cs]).sort((a, b) => a[0] - b[0]);
  const pts = [];               // [t, cs, era]  era 0 = first half, ≥1 = later
  let era = 0;
  for (const [t, cs] of raw) {
    const last = pts[pts.length - 1];
    if (!last) { pts.push([t, cs, era]); continue; }
    if (cs === last[1]) continue;
    if (cs < last[1]) {
      if (cs === 2700 && last[1] > 2700) { era++; pts.push([t, cs, era]); }
      continue;                 // out-of-order noise, corrections, FT reset
    }
    pts.push([t, cs, era]);
  }
  let htSpan = null;            // wall span where the clock stalls at ~45'
  for (let i = 1; i < pts.length && !htSpan; i++) {
    if (pts[i][2] !== pts[i - 1][2]) continue;
    const wall = pts[i][0] - pts[i - 1][0], game = pts[i][1] - pts[i - 1][1];
    if (wall - game > 600 && pts[i][1] >= 2650 && pts[i][1] <= 2940)
      htSpan = [pts[i - 1][0] + game, pts[i][0] - 1];
  }
  return (S._anchorsCache = { pts, htSpan });
}

function minuteInfo(t) {
  const A = clockAnchors();
  if (!A.pts.length || t < A.pts[0][0] - 120) return null;
  if (A.htSpan && t >= A.htSpan[0] && t <= A.htSpan[1]) return { label: "HT", ht: true };
  let i = A.pts.length - 1;
  while (i > 0 && A.pts[i][0] > t) i--;
  let cs = Math.max(0, A.pts[i][1] + (t - A.pts[i][0]));
  const next = A.pts[i + 1];
  if (next && next[2] === A.pts[i][2]) cs = Math.min(cs, next[1]);   // clamp stalls
  const half = A.pts[i][2] >= 1 || A.pts[i][1] >= 2700 ? 2 : 1;
  return { label: minuteLabel(Math.floor(cs / 60), half), cs, half };
}
const minuteLabel = (m, half) =>
  half === 1 && m > 45 ? `45+${m - 45}'` : half === 2 && m > 90 ? `90+${m - 90}'` : `${m}'`;

// tick positions for a given minute step, honest across restarts and halftime
function matchMinuteTicks(stepMin) {
  const A = clockAnchors(), ticks = [], seen = new Set();
  for (let i = 0; i < A.pts.length; i++) {
    const [ta, cs0, era] = A.pts[i];
    const next = A.pts[i + 1];
    const sameEra = next && next[2] === era;
    // clamp to the next anchor's clock inside an era (stalls produce no ticks);
    // the final anchor of the data extrapolates freely to the right edge
    const tEnd = next ? next[0] : Math.max(S.view[1], S.lastT + 1);
    const csEnd = sameEra ? next[1] : (next ? cs0 : cs0 + (tEnd - ta));
    const half = era >= 1 || cs0 >= 2700 ? 2 : 1;
    for (let m = Math.max(0, Math.ceil(cs0 / 60 / stepMin) * stepMin); m * 60 <= (i + 1 === A.pts.length ? cs0 + (tEnd - ta) : csEnd); m += stepMin) {
      const t = ta + (m * 60 - cs0);
      if (t < ta - 0.001 || t >= tEnd) continue;
      const label = minuteLabel(m, half);
      if (seen.has(label)) continue;
      seen.add(label);
      if (t >= S.view[0] && t <= S.view[1]) ticks.push([t, label]);
    }
  }
  return ticks;
}

function fitYRange() {
  if (!S.fitY) return [0, 1];
  let lo = Infinity, hi = -Infinity;
  const scan = (pts) => { if (pts) for (const p of pts) { if (p[0] < S.view[0] || p[0] > S.view[1]) continue; if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1]; } };
  for (const s of S.series.values()) { scan(s.poly); scan(s.tx); if (jupiterVisible()) scan(s.jup); }
  if (!Number.isFinite(lo) || hi - lo < 0.02) return [0, 1];
  const pad = (hi - lo) * 0.12;
  return [Math.max(0, lo - pad), Math.min(1, hi + pad)];
}

function draw() {
  if (!S.view) return;
  const W = cv.clientWidth, H = cv.clientHeight;
  const PB = plotBottom();                        // plot ends; track starts here
  YR = fitYRange();
  const aj = autoJoin();
  if (aj !== S._lastAuto) { S._lastAuto = aj; renderLegend(); renderChips(); }
  ctx.clearRect(0, 0, W, H);
  ctx.font = "11px system-ui";
  S.trackHits = []; S.plotHits = [];

  // grid + y axis (0/100 ghost lines always remain, even when auto-fit)
  ctx.strokeStyle = INK.grid; ctx.fillStyle = INK.muted; ctx.lineWidth = 1;
  const yTicks = S.fitY ? niceYTicks() : [0, 0.25, 0.5, 0.75, 1];
  for (const v of yTicks) {
    const y = Y(v);
    if (y < M.t - 1 || y > PB + 1) continue;
    ctx.beginPath(); ctx.moveTo(M.l, y + 0.5); ctx.lineTo(W - M.r, y + 0.5); ctx.stroke();
    ctx.textAlign = "right"; ctx.fillText((v * 100).toFixed(0) + "¢", M.l - 6, y + 4);
  }
  if (S.fitY) {                                   // ghost bounds when zoomed in y
    ctx.strokeStyle = INK.axis; ctx.setLineDash([2, 4]);
    for (const v of [0, 1]) { if (v >= YR[0] && v <= YR[1]) { ctx.beginPath(); ctx.moveTo(M.l, Y(v) + 0.5); ctx.lineTo(W - M.r, Y(v) + 0.5); ctx.stroke(); } }
    ctx.setLineDash([]);
  }
  drawXAxis(W, H, PB);

  // series (progressive disclosure: Jupiter joins under 20 min or via chip)
  ctx.save();
  ctx.beginPath(); ctx.rect(M.l, M.t - 4, W - M.l - M.r, PB - M.t + 8); ctx.clip();
  for (const [lab] of S.labels) {
    const s = S.series.get(lab);
    if (!s) continue;
    drawLine(s.tx, s.color, [5, 4], 1.6, true);          // TxLINE: honest steps
    if (jupiterVisible() && s.jup) drawLine(s.jup, s.color, [2, 3], 1.3, true);
    drawLine(s.poly, s.color, [], 2, false);
  }
  drawBots();
  drawWhales();
  // now cursor
  if (S.mode !== "full" && S.lastT) {
    ctx.strokeStyle = INK.ink2; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(X(S.lastT) + 0.5, M.t); ctx.lineTo(X(S.lastT) + 0.5, PB); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();

  drawTrack(W, PB);
  drawSelection(PB);

  // direct labels at right edge (text in ink, swatch carries hue;
  // mobile keeps team identity via 3-letter codes — never color-only)
  ctx.textAlign = "left";
  let usedY = [];
  for (const [lab] of S.labels) {
    const s = S.series.get(lab);
    const last = s && [...s.poly].reverse().find((p) => p[0] <= S.view[1]);
    if (!last) continue;
    let y = Math.max(M.t + 8, Math.min(PB - 4, Y(Math.max(YR[0], Math.min(YR[1], last[1])))));
    while (usedY.some((u) => Math.abs(u - y) < 13)) y += 13;
    usedY.push(y);
    const mobile = W <= 700;
    ctx.fillStyle = s.color; ctx.fillRect(W - M.r + (mobile ? 3 : 6), y - 4, 8, 8);
    ctx.fillStyle = INK.ink2;
    const endLabel = mobile ? `${teamCode(lab)} ${(last[1] * 100).toFixed(1)}¢` : `${lab} ${(last[1] * 100).toFixed(1)}¢`;
    ctx.fillText(endLabel, W - M.r + (mobile ? 14 : 18), y + 4);
  }
  if (!S.events.some((e) => e.t >= S.view[0] && e.t <= S.view[1])) {
    ctx.fillStyle = INK.muted;
    ctx.font = "13px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("no data in view — double-click to fit", W / 2, (M.t + PB) / 2);
    ctx.font = "11px system-ui";
  }
  // crosshair
  if (S.hover && !isCoarse()) drawCrosshair(PB);
}

function niceYTicks() {
  const span = YR[1] - YR[0];
  const step = [0.01, 0.02, 0.05, 0.1, 0.25][[0.06, 0.12, 0.3, 0.6, 2].findIndex((s) => span <= s)] ?? 0.25;
  const out = [];
  for (let v = Math.ceil(YR[0] / step) * step; v <= YR[1] + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

// x axis: match minutes once a kickoff clock exists; day-aware wall time before
function drawXAxis(W, H, PB) {
  const axisY = PB + TRACK_H;
  const A = S.mode !== "upcoming" ? clockAnchors() : { pts: [] };
  ctx.textAlign = "center";
  if (A.pts.length) {
    const pxPerSec = (W - M.l - M.r) / (S.view[1] - S.view[0]);
    const stepMin = [1, 2, 5, 10, 15, 30, 45].find((m) => m * 60 * pxPerSec >= 64) || 45;
    for (const [t, label] of matchMinuteTicks(stepMin)) {
      ctx.strokeStyle = INK.grid;
      ctx.beginPath(); ctx.moveTo(X(t) + 0.5, M.t); ctx.lineTo(X(t) + 0.5, PB); ctx.stroke();
      ctx.strokeStyle = INK.axis;
      ctx.beginPath(); ctx.moveTo(X(t) + 0.5, axisY); ctx.lineTo(X(t) + 0.5, axisY + 4); ctx.stroke();
      ctx.fillStyle = INK.muted;
      ctx.fillText(label, X(t), H - 8);
    }
    // halftime: a labeled span on the axis, not a vertical
    if (A.htSpan) {
      const mid = (Math.max(A.htSpan[0], S.view[0]) + Math.min(A.htSpan[1], S.view[1])) / 2;
      if (A.htSpan[1] > S.view[0] && A.htSpan[0] < S.view[1] && (Math.min(A.htSpan[1], S.view[1]) - Math.max(A.htSpan[0], S.view[0])) * pxPerSec > 26) {
        ctx.fillStyle = INK.ink2; ctx.fillText("HT", X(mid), H - 8);
      }
    }
  } else {
    const step = niceStep(S.view[1] - S.view[0]);
    const dayAware = S.view[1] - S.view[0] > 6 * 3600 || new Date(S.view[0] * 1000).getDate() !== new Date(S.view[1] * 1000).getDate();
    let prevSuffix = null;
    for (let t = Math.ceil(S.view[0] / step) * step; t < S.view[1]; t += step) {
      ctx.strokeStyle = INK.grid;
      ctx.beginPath(); ctx.moveTo(X(t) + 0.5, M.t); ctx.lineTo(X(t) + 0.5, PB); ctx.stroke();
      ctx.fillStyle = INK.muted;
      const d = new Date(t * 1e3);
      let label;
      if (dayAware) {
        label = `${d.toLocaleDateString([], { weekday: "short" })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;
      } else {
        label = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const m2 = label.match(/\s?[AP]M$/i);         // de-dup repeated AM/PM
        if (m2 && prevSuffix === m2[0]) label = label.slice(0, -m2[0].length);
        else if (m2) prevSuffix = m2[0];
      }
      ctx.fillText(label, X(t), H - 8);
    }
  }
  // axis base sits under the event track
  ctx.strokeStyle = INK.axis;
  ctx.beginPath(); ctx.moveTo(M.l, axisY + 0.5); ctx.lineTo(W - M.r, axisY + 0.5); ctx.stroke();
}

function drawLine(pts, color, dash, width, step) {
  if (!pts.length) return;
  const [v0, v1] = S.view;
  const GAP = 120;                       // honesty: break lines across data gaps
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
  ctx.beginPath();
  let started = false, prev = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p[0] < v0 && (i + 1 >= pts.length || pts[i + 1][0] < v0)) continue;
    const broke = prev && p[0] - prev[0] > GAP;
    if (!started || broke) { ctx.moveTo(X(p[0]), Y(p[1])); started = true; }
    else if (step) { ctx.lineTo(X(p[0]), Y(prev[1])); ctx.lineTo(X(p[0]), Y(p[1])); }
    else ctx.lineTo(X(p[0]), Y(p[1]));
    prev = p;
    if (p[0] > v1) break;
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

// ── event track: one 28px band between the plot and the x axis ───────────────
// Every flag marker lives here (bot trades and enabled whale diamonds are the
// only at-price exceptions). Hit-testing happens against S.trackHits.
function drawTrack(W, PB) {
  const yMid = PB + TRACK_H / 2;
  ctx.fillStyle = CSSV("--surface");
  ctx.fillRect(M.l, PB, W - M.l - M.r, TRACK_H);
  ctx.strokeStyle = INK.grid;
  ctx.beginPath(); ctx.moveTo(M.l, PB + 0.5); ctx.lineTo(W - M.r, PB + 0.5); ctx.stroke();

  ctx.save();
  ctx.beginPath(); ctx.rect(M.l, PB, W - M.l - M.r, TRACK_H); ctx.clip();
  ctx.textAlign = "center";

  // whale + wallet fills: ticks that cluster into count pills when they overlap
  const fills = S.flags.filter((e) => e.kind === "fill" && flagVisible(e) && e.t >= S.view[0] && e.t <= S.view[1]).sort((a, b) => a.t - b.t);
  const clusters = [];
  for (const e of fills) {
    const x = X(e.t);
    const last = clusters[clusters.length - 1];
    if (last && x - last.x1 < 10) { last.events.push(e); last.x1 = x; }
    else clusters.push({ events: [e], x0: x, x1: x });
  }
  ctx.font = "10px system-ui";
  for (const c of clusters) {
    const cx = (c.x0 + c.x1) / 2;
    if (c.events.length === 1) {
      const e = c.events[0];
      const col = S.series.get(e.team)?.color || INK.ink2;
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(c.x0, yMid - 5); ctx.lineTo(c.x0, yMid + 5); ctx.stroke();
      S.trackHits.push({ x0: c.x0 - 4, x1: c.x0 + 4, e });
    } else {
      const label = `◆${c.events.length}`;
      const w = ctx.measureText(label).width + 10;
      ctx.fillStyle = CSSV("--surface-2");
      ctx.strokeStyle = INK.axis; ctx.lineWidth = 1;
      roundRect(cx - w / 2, yMid - 8, w, 16, 8); ctx.fill(); ctx.stroke();
      ctx.fillStyle = INK.ink2;
      ctx.fillText(label, cx, yMid + 3.5);
      S.trackHits.push({ x0: cx - w / 2, x1: cx + w / 2, cluster: c.events });
    }
  }

  // everything else, drawn on top of fill ticks
  for (const e of S.flags) {
    if (e.kind === "fill" || e.t < S.view[0] || e.t > S.view[1] || !flagVisible(e)) continue;
    if (e.src === "bot" && e.kind === "trade" && e.price != null) continue;   // lives at price

    const x = X(e.t);
    let hitW = 6;
    if (e.kind === "action" && /^(goal|own_goal|penalty_goal|goal_disallowed)$/.test(e.action)) {
      const col = S.series.get(e.team)?.color || (e.benefit && S.series.get(e.benefit)?.color) || STATUS.good;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(x, yMid, 6.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = CSSV("--page");
      ctx.font = "700 8px system-ui";
      ctx.fillText((e.team || "?")[0].toUpperCase(), x, yMid + 3);
      ctx.font = "10px system-ui";
      if (e.action === "goal_disallowed" || e.disallowed) {
        ctx.strokeStyle = STATUS.crit; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x - 8, yMid + 8); ctx.lineTo(x + 8, yMid - 8); ctx.stroke();
      }
      hitW = 8;
    } else if (e.kind === "action" && /^var/.test(e.action)) {
      ctx.strokeStyle = STATUS.warn; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, yMid - 6); ctx.lineTo(x + 5, yMid); ctx.lineTo(x, yMid + 6); ctx.lineTo(x - 5, yMid); ctx.closePath(); ctx.stroke();
    } else if (e.kind === "action" && /card/.test(e.action)) {
      ctx.fillStyle = /red/.test(e.action) ? STATUS.crit : STATUS.warn;
      ctx.fillRect(x - 2.5, yMid - 5, 5, 10);
    } else if (e.kind === "score") {
      // distinct glyphs per source: ESPN = tick + filled dot, wc26 = tick +
      // hollow square, TxLINE = plain tall tick
      ctx.strokeStyle = INK.ink2; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, yMid - 4); ctx.lineTo(x, yMid + 6); ctx.stroke();
      if (e.src === "espn") { ctx.fillStyle = INK.ink2; ctx.beginPath(); ctx.arc(x, yMid - 7, 2.5, 0, Math.PI * 2); ctx.fill(); }
      else if (e.src === "wc26") { ctx.strokeStyle = INK.ink2; ctx.lineWidth = 1.2; ctx.strokeRect(x - 2.5, yMid - 9.5, 5, 5); }
    } else if (e.kind === "shock") {
      ctx.fillStyle = STATUS.serious; ctx.font = "700 12px system-ui";
      ctx.fillText("!", x, yMid + 4);
      ctx.font = "10px system-ui";
    } else if (e.kind === "burst") {
      ctx.fillStyle = COLORS.s1;
      ctx.beginPath(); ctx.moveTo(x, yMid - 4); ctx.lineTo(x + 4, yMid + 4); ctx.lineTo(x - 4, yMid + 4); ctx.closePath(); ctx.fill();
    } else if (e.src === "bot") {
      ctx.fillStyle = STATUS.good; ctx.font = "9px system-ui";
      ctx.fillText(e.kind === "decision" ? "d" : "b", x, yMid + 3);
      ctx.font = "10px system-ui";
    } else if (e.kind === "action") {
      ctx.fillStyle = flagColor(e);
      ctx.fillText(GLYPH[e.action] || "·", x, yMid + 3);
    } else {
      ctx.fillStyle = INK.muted;
      ctx.fillText("·", x, yMid + 3);
    }
    S.trackHits.push({ x0: x - hitW, x1: x + hitW, e });
  }
  ctx.restore();
  ctx.font = "11px system-ui";
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// full-height verticals: ONLY the selection (hairline + soft halo); hover ghost
function drawSelection(PB) {
  const selT = S.sel ? (S.sel.t ?? S.sel.t0) : null;
  if (selT != null && selT >= S.view[0] && selT <= S.view[1]) {
    const x = X(selT);
    ctx.strokeStyle = INK.ink; ctx.globalAlpha = 0.08; ctx.lineWidth = 9;
    ctx.beginPath(); ctx.moveTo(x, M.t); ctx.lineTo(x, PB + TRACK_H); ctx.stroke();
    ctx.globalAlpha = 0.75; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + 0.5, M.t); ctx.lineTo(x + 0.5, PB + TRACK_H); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  const hov = S.hoverHit;
  const hovT = hov && !hov.cluster ? hov.e.t : null;
  if (hovT != null && hovT !== selT) {
    const x = X(hovT);
    ctx.strokeStyle = INK.ink2; ctx.globalAlpha = 0.3; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + 0.5, M.t); ctx.lineTo(x + 0.5, PB + TRACK_H); ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawBots() {
  const botActor = paperBotEntry();
  if (!botActor) return;
  for (const e of S.flags) {
    if (e.src !== "bot" || e.kind !== "trade" || !flagVisible(e)) continue;
    if (e.t < S.view[0] || e.t > S.view[1] || e.price == null) continue;
    const x = X(e.t), y = Y(e.price);
    ctx.fillStyle = watchColor(botActor);
    ctx.beginPath();
    if (e.action === "ENTER") { ctx.moveTo(x, y - 6); ctx.lineTo(x - 5, y + 4); ctx.lineTo(x + 5, y + 4); }
    else { ctx.moveTo(x, y + 6); ctx.lineTo(x - 5, y - 4); ctx.lineTo(x + 5, y - 4); }
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = CSSV("--surface"); ctx.lineWidth = 1.5; ctx.stroke();  // 2px surface ring
    S.plotHits.push({ x, y, e });
  }
}

function drawWhales() {
  // at-price diamonds only for fills on the enabled local watchlist
  for (const e of S.flags) {
    if (e.kind !== "fill" || !flagVisible(e)) continue;
    if (e.t < S.view[0] || e.t > S.view[1] || e.price == null) continue;
    const x = X(e.t), y = Y(e.price);
    const color = watchColorForFill(e);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y);
    ctx.closePath();
    if (String(e.side || "").toUpperCase() === "BUY") ctx.fill();
    // Surface halo first, then the outcome-colored edge. This keeps hollow SELL
    // diamonds legible against both chart lines and the dark plot background.
    ctx.strokeStyle = CSSV("--surface"); ctx.lineWidth = 3; ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
    S.plotHits.push({ x, y, e });
  }
}

function drawCrosshair(PB) {
  const { x } = S.hover;
  if (x < M.l || x > cv.clientWidth - M.r) return;
  ctx.strokeStyle = INK.axis; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(x + 0.5, M.t); ctx.lineTo(x + 0.5, PB); ctx.stroke();
  ctx.setLineDash([]);
}

// ── hover / tooltip / selection ──────────────────────────────────────────────
// Hit-testing runs against the event track band plus the at-price markers
// (bot triangles, enabled whale diamonds) recorded during draw().
function hitAt(x, y) {
  const PB = plotBottom();
  if (y >= PB && y <= PB + TRACK_H) {
    let best = null, bd = Infinity;
    for (const h of S.trackHits) {
      if (x < h.x0 - 3 || x > h.x1 + 3) continue;
      const d = Math.abs(x - (h.x0 + h.x1) / 2);
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  }
  let best = null, bd = 8;
  for (const h of S.plotHits) {
    const d = Math.hypot(h.x - x, h.y - y);
    if (d < bd) { bd = d; best = h; }
  }
  return best;
}

function selectHit(hit) {
  if (!hit) return;
  if (hit.cluster) {                     // count pill → zoom in; it expands
    const ts = hit.cluster.map((e) => e.t);
    S.view = [Math.min(...ts) - 30, Math.max(...ts) + 30];
    S.follow = false;
    draw();
    return;
  }
  S.sel = hit.e;
  document.querySelectorAll(".moment").forEach((x) => x.classList.remove("sel"));
  renderDetail(hit.e);
  if ($("inspector").classList.contains("open")) openInspector(hit.e);
  renderScoreboard();
  draw();
}

function valAt(pts, t) {
  if (!pts.length || t < pts[0][0]) return null;
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (pts[m][0] <= t) lo = m; else hi = m - 1; }
  return pts[lo][1];
}

function hoverLabel(fl) {
  if (fl.kind === "fill") return `<b style="color:${watchColorForFill(fl)}">◆ ${esc(watchNameForFill(fl))} ${esc(String(fl.side || "fill").toUpperCase())}</b>${fl.team ? " — " + esc(fl.team) : ""}${fl.price != null ? " @" + (fl.price * 100).toFixed(1) + "¢" : ""}${fl.size != null ? " ×" + Number(fl.size).toLocaleString(undefined, {maximumFractionDigits: 2}) : ""}`;
  const srcName = { txline: "TxLINE", espn: "ESPN", wc26: "wc26", polyws: "Polymarket", poly: "Polymarket", bot: paperBotEntry()?.name || "Paper bot", jupiter: "Jupiter" }[fl.src] || esc(fl.src || "");
  return `<b>${srcName}: ${esc(fl.kind === "action" ? (fl.action || "").replaceAll("_", " ") : fl.kind)}</b>${fl.team ? " — " + esc(fl.team) : ""}${fl.price != null ? " @" + (fl.price * 100).toFixed(0) + "¢" : ""}${fl.reason ? " (" + esc(fl.reason) + ")" : ""}`;
}

function fillClusterTooltip(fills) {
  const shown = fills.slice(0, TOOLTIP_FILL_LIMIT);
  const rows = shown.map((fl) => {
    const side = String(fl.side || "fill").toUpperCase();
    const sideClass = side === "BUY" ? "buy" : side === "SELL" ? "sell" : "other";
    const wall = new Date(fl.t * 1e3).toLocaleTimeString([], {hour: "numeric", minute: "2-digit", second: "2-digit"});
    const size = fl.size == null ? "—" : Number(fl.size).toLocaleString(undefined, {maximumFractionDigits: 2});
    const price = fl.price == null ? "—" : `${(Number(fl.price) * 100).toFixed(1)}¢`;
    return `<div class="fill-row" style="--actor-color:${watchColorForFill(fl)}"><span class="fill-time">${esc(wall)}</span><span class="fill-side ${sideClass}">${esc(side)}</span><span class="fill-actor"><b>◆ ${esc(watchNameForFill(fl))}</b>${fl.team ? ` · ${esc(fl.team)}` : ""}</span><span class="fill-terms">${size} @ ${price}</span></div>`;
  }).join("");
  const remaining = fills.length - shown.length;
  return `<div class="fill-cluster-head"><b>◆${fills.length} fills</b><span>click to zoom in and expand</span></div><div class="fill-list">${rows}${remaining > 0 ? `<div class="fill-more">+${remaining} more fill${remaining === 1 ? "" : "s"}</div>` : ""}</div>`;
}

function timeLabel(t) {
  const mi = S.mode !== "upcoming" ? minuteInfo(t) : null;
  const wall = new Date(t * 1e3).toLocaleTimeString();
  return mi ? `${mi.label} · ${wall}` : wall;
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
  const hit = hitAt(x, y);
  S.hoverHit = hit;
  cv.style.cursor = hit ? "pointer" : "crosshair";
  const tip = $("tooltip");
  let html = `<div class="t">${timeLabel(t)}</div>`;
  if (hit && hit.cluster) {
    html += fillClusterTooltip(hit.cluster);
  } else if (hit) {
    html += `<div>${hoverLabel(hit.e)}</div>`;
  } else {
    for (const [lab, color] of S.labels) {
      const s = S.series.get(lab);
      const pv = valAt(s.poly, t), tv = valAt(s.tx, t);
      html += `<div class="row"><span><span class="sw" style="background:${color}"></span>${esc(lab)}</span>
        <span class="v">${pv != null ? (pv * 100).toFixed(1) + "¢" : "—"} / ${tv != null ? (tv * 100).toFixed(1) + "¢" : "—"}</span></div>`;
    }
    html += `<div class="t">Polymarket bid / TxLINE fair</div>`;
  }
  tip.innerHTML = html;
  tip.style.display = "block";
  const pad = 8, tw = tip.offsetWidth, th = tip.offsetHeight;
  const left = Math.max(pad, Math.min(x + 14, cv.clientWidth - tw - pad));
  let top = y + 12;
  if (top + th > cv.clientHeight - pad) top = y - th - 12;
  // Replay controls float over the chart. Treat their top edge as a UI-space
  // boundary so event details remain fully readable above the control bar.
  const replayBar = S.mode === "replay" ? $("replay-controls") : null;
  if (replayBar) {
    const wrapTop = $("chart-wrap").getBoundingClientRect().top;
    const controlsTop = replayBar.getBoundingClientRect().top - wrapTop;
    top = Math.min(top, controlsTop - th - 12);
  }
  tip.style.left = left + "px";
  tip.style.top = Math.max(pad, Math.min(top, cv.clientHeight - th - pad)) + "px";
  draw();
});
cv.addEventListener("mouseleave", () => { S.hover = null; S.hoverHit = null; $("tooltip").style.display = "none"; draw(); });
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
  if (!moved) selectHit(hitAt(x, y));
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

// ── touch: 1-finger pan (tap = inspect), 2-finger pinch zoom ────────────────
let TCH = null;
cv.addEventListener("touchstart", (ev) => {
  if (!S.view) return;
  const r = cv.getBoundingClientRect();
  if (ev.touches.length === 1) {
    const t = ev.touches[0];
    TCH = { mode: "pan", x: t.clientX - r.left, y: t.clientY - r.top, v0: S.view[0], v1: S.view[1], t0: performance.now(), moved: false };
  } else if (ev.touches.length === 2) {
    const [a, b] = ev.touches;
    TCH = { mode: "pinch", cx: (a.clientX + b.clientX) / 2 - r.left, span: Math.abs(a.clientX - b.clientX), v0: S.view[0], v1: S.view[1] };
  }
}, { passive: true });
cv.addEventListener("touchmove", (ev) => {
  if (!TCH || !S.view) return;
  ev.preventDefault();
  const r = cv.getBoundingClientRect();
  if (TCH.mode === "pan" && ev.touches.length === 1) {
    const x = ev.touches[0].clientX - r.left;
    if (Math.abs(x - TCH.x) > 8) TCH.moved = true;
    const dt = (TCH.x - x) * (TCH.v1 - TCH.v0) / (cv.clientWidth - M.l - M.r);
    S.view = [TCH.v0 + dt, TCH.v1 + dt];
    S.follow = false;
    draw();
  } else if (TCH.mode === "pinch" && ev.touches.length === 2) {
    const [a, b] = ev.touches;
    const span = Math.max(24, Math.abs(a.clientX - b.clientX));
    const f = Math.max(0.05, Math.min(20, TCH.span / span));
    const tC = TCH.v0 + (TCH.cx - M.l) / (cv.clientWidth - M.l - M.r) * (TCH.v1 - TCH.v0);
    let v0 = tC - (tC - TCH.v0) * f, v1 = tC + (TCH.v1 - tC) * f;
    if (v1 - v0 >= 20) { S.view = [v0, v1]; S.follow = false; draw(); }
  }
}, { passive: false });
cv.addEventListener("touchend", (ev) => {
  if (TCH?.mode === "pan" && !TCH.moved && performance.now() - TCH.t0 < 500 && ev.touches.length === 0) {
    selectHit(hitAt(TCH.x, TCH.y));      // tap-to-inspect → detail strip
  }
  if (ev.touches.length === 0) TCH = null;
}, { passive: true });

// ── keyboard: ←/→ step visible track events, Enter = raw JSON, g/G goals ────
function visibleTrackEvents() {
  return S.flags
    .filter((e) => flagVisible(e) && e.t >= S.view[0] && e.t <= S.view[1])
    .sort((a, b) => a.t - b.t);
}
document.addEventListener("keydown", (ev) => {
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || "")) return;
  if (!$("goal-overlay").hidden || !$("wallet-overlay").hidden || !$("insights").hidden) return;
  if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
    const evs = visibleTrackEvents();
    if (!evs.length) return;
    ev.preventDefault();
    const selT = S.sel ? (S.sel.t ?? S.sel.t0) : null;
    let next;
    if (ev.key === "ArrowRight") next = evs.find((e) => selT == null || e.t > selT) || evs[0];
    else next = [...evs].reverse().find((e) => selT == null || e.t < selT) || evs[evs.length - 1];
    selectHit({ e: next });
  } else if (ev.key === "Enter" && S.sel) {
    $("inspector").classList.add("open"); openInspector(S.sel); resize();
  } else if (ev.key === "g" || ev.key === "G") {
    const moments = S.meta?.moments || [];
    if (!moments.length) return;
    const selT = selectedMoment()?.t0 ?? (S.sel ? (S.sel.t ?? S.sel.t0) : null);
    const sorted = [...moments].sort((a, b) => a.t0 - b.t0);
    const mo = ev.key === "g"
      ? sorted.find((m) => selT == null || m.t0 > selT) || sorted[0]
      : [...sorted].reverse().find((m) => selT == null || m.t0 < selT) || sorted[sorted.length - 1];
    const i = (S.meta.moments || []).indexOf(mo);
    selectMoment(mo, document.querySelectorAll(".moment")[i]);
  }
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
$("btn-inspector").onclick = () => { $("inspector").classList.toggle("open"); resize(); };
document.querySelector(".insp-close-x").onclick = () => { $("inspector").classList.remove("open"); resize(); };

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

function insightWatchFills(data) {
  const fills = [], seen = new Set();
  const add = (fill, entry) => {
    const t = Number(fill.t ?? fill.timestamp);
    if (!entry || !Number.isFinite(t)) return;
    const normalized = {...fill, t, who: entry.name, wallet_address: entry.address,
      match_id: fill.match_id, match: fill.match, color: watchColor(entry)};
    const key = `${entry.address}:${normalized.match_id || normalized.match}:${Math.round(t * 10)}:${normalized.side || ""}:${Number(normalized.price || 0).toFixed(5)}:${Number(normalized.size || 0).toFixed(3)}`;
    if (!seen.has(key)) { seen.add(key); fills.push(normalized); }
  };
  for (const fill of data.wallet_fills || []) {
    const who = String(fill.who || "").toLowerCase();
    const entry = S.watchlist.find((item) => item.curated && item.name.toLowerCase() === who);
    add(fill, entry);
  }
  for (const [address, report] of S.walletReports) {
    const entry = watchlistEntry(address);
    if (!entry) continue;
    for (const fill of report.fills || []) add(fill, entry);
  }
  return fills.sort((a, b) => a.t - b.t);
}

function insightBaseline(item) {
  return Number(item.txline_t ?? item.goal_t ?? item.espn_t ?? item.t);
}

function insightWatchNear(data, item, before = GOAL_ACTOR_WINDOW, after = GOAL_ACTOR_WINDOW) {
  const baseline = insightBaseline(item);
  if (!Number.isFinite(baseline)) return [];
  return insightWatchFills(data).filter((fill) =>
    (item.match_id ? fill.match_id === item.match_id : fill.match === item.match) &&
    fill.t >= baseline - before && fill.t <= baseline + after);
}

function insightWatchCell(data, item) {
  if (!S.watchlist.length) return `<span>Add actors above</span>`;
  const baseline = insightBaseline(item), fills = insightWatchNear(data, item);
  const actor = paperBotEntry();
  const edge = item.edge || {};
  const botAction = item.bot_action || edge.bot_action;
  const botDt = item.bot_entry_dt ?? item.bot_dt ?? edge.bot_entry_dt ?? edge.bot_dt;
  const botPrice = item.bot_price ?? edge.bot_price;
  const botReason = item.bot_reason || edge.bot_reason;
  const bot = actor && botAction ? `<span class="insight-watch-fill" style="--actor-color:${watchColor(actor)}"><b>▲▼ ${esc(actor.name)}</b><small>paper ${esc(botAction)}${botDt == null ? "" : ` · ${fmtSeconds(botDt)}`}${botPrice == null ? "" : ` @ ${fmtPrice(botPrice)}`}${botReason ? ` · ${esc(botReason)}` : ""}</small></span>` : "";
  const shown = fills.slice(0, bot ? 2 : 3).map((fill) => {
    const dt = fill.t - baseline;
    const terms = `${String(fill.side || "fill").toUpperCase()}${fill.team ? ` ${esc(fill.team)}` : ""}${fill.price == null ? "" : ` @ ${fmtPrice(Number(fill.price))}`}${fill.size == null ? "" : ` ×${Number(fill.size).toLocaleString(undefined, {maximumFractionDigits: 1})}`}`;
    return `<span class="insight-watch-fill" style="--actor-color:${fill.color}"><b>◆ ${esc(fill.who)}</b><small>${fmtSeconds(dt)} · ${terms}</small></span>`;
  }).join("");
  const limit = bot ? 2 : 3;
  if (!bot && !shown) return `<span>No nearby watchlist activity</span>`;
  return `${bot}${shown}${fills.length > limit ? `<span class="insight-watch-more">+${fills.length - limit} more fills</span>` : ""}`;
}

function insightMatchLink(item) {
  const t = insightBaseline(item);
  if (!item.match_id || !Number.isFinite(t)) return esc(item.match || "—");
  return `<button type="button" class="insight-jump" data-insight-match="${esc(item.match_id)}" data-insight-t="${t}">${esc(item.match || "—")} ↗</button>`;
}

function renderInsightComparison(data) {
  const root = $("insight-comparison");
  if (!root) return;
  const fills = insightWatchFills(data), bot = data.summary.bot || {};
  const actors = S.watchlist.map((entry) => {
    const isBot = entry.kind === "bot";
    const count = isBot ? (bot.entries || 0) + (bot.exits || 0) : fills.filter((fill) => fill.wallet_address === entry.address).length;
    return `<span class="comparison-source" style="--actor-color:${watchColor(entry)}"><b><i>${isBot ? "▲▼" : "◆"}</i> ${esc(entry.name)}</b><span>${count} archive ${isBot ? `paper execution${count === 1 ? "" : "s"}` : `fill${count === 1 ? "" : "s"}`}</span></span>`;
  }).join("");
  root.innerHTML = `<span class="comparison-label">Archive watchlist</span>${actors}<button type="button" data-open-watchlist>${S.watchlist.length ? "Manage watchlist" : "+ Add actors"}</button><p>Public-wallet fills establish activity, not realized P&amp;L. Any selected paper bot is a simulated execution ledger, not an on-chain wallet.</p>`;
}

function wireInsightActions(root) {
  root.querySelectorAll("[data-open-watchlist]").forEach((button) => button.onclick = openWallet);
  root.querySelectorAll("[data-insight-match]").forEach((button) => button.onclick = () => {
    const match = button.dataset.insightMatch, t = Number(button.dataset.insightT);
    toggleInsights(); loadFull(match, Number.isFinite(t) ? t : null);
  });
}

function goalEdgeTable(items, data) {
  const rows = items.map((x) => {
    const gross25 = x.gross_per_share == null ? null : 25 / x.poly_ask * x.gross_per_share;
    return `<tr><td>${insightMatchLink(x)}<br><span>${x.goal_score || x.score || "—"} · ${x.clock || "—"}</span></td><td>${x.label}</td><td><strong>${x.activity_regime}</strong><br><span>${x.pre_activity.toFixed(2)} changes/min</span></td><td>${fmtPrice(x.tx_fair)}</td><td>${fmtPrice(x.poly_ask)}</td><td class="edge">${fmtCents(x.initial_gap)}</td><td>$${Math.round(x.ask_depth || 0).toLocaleString()}</td><td>${fmtDuration(x.duration)}</td><td>${fmtPrice(x.exit_bid)}<br><span>${fmtCents(x.gross_per_share)}/share${gross25 == null ? "" : ` · ${fmtMoney(gross25)} on $25`}</span></td><td class="insight-watch-cell">${insightWatchCell(data, x)}</td></tr>`;
  });
  return insightTable(["Match / goal", "Outcome", "Pre-signal book", "TxLINE fair", "Poly ask", "Edge", "Ask depth", "Window", "Quoted exit", "Watchlist"], rows);
}
function sourceRaceTable(goals, data) {
  const rows = goals.map((x) => {
    const market = x.poly_dt == null ? "—" : `<span class="${x.poly_dt < 0 ? "market-first" : ""}">${fmtSeconds(x.poly_dt)}</span>`;
    return `<tr><td>${insightMatchLink(x)}</td><td><strong>${x.scorer || "Goal"}${x.disallowed ? " · DISALLOWED" : ""}</strong><br>${x.score_before || "?"} → ${x.score_after || "?"}</td><td>${fmtGameClock(x.cs)}</td><td>${market}</td><td>${fmtSeconds(x.espn_dt)}</td><td>${fmtSeconds(x.wc26_dt)}</td><td class="insight-watch-cell">${insightWatchCell(data, x)}</td><td>${priceMoves(x)}</td></tr>`;
  });
  return insightTable(["Match", "Goal / score", "Clock", "Market ≥3¢", "ESPN", "WC26", "Watchlist", "Prices by TxLINE"], rows);
}
function neutralGoalsTable(goals, data) {
  const rows = goals.map((x) => {
    const edge = x.edge;
    const edgeResult = !edge ? "No screened edge" :
      `<span class="${x.edge_status === "winner" ? "edge-win" : "edge-loss"}">${x.edge_status === "winner" ? "Positive" : "Negative"} replay · ${fmtCents(edge.gross_per_share)}/share</span><br><span>${fmtCents(edge.initial_gap)} opening · ${edge.activity_regime} · ${fmtDuration(edge.duration)}</span>`;
    const timing = x.recorded_source === "txline" ? `TxLINE<br><span>ESPN ${fmtSeconds(x.espn_dt)} · WC26 ${fmtSeconds(x.wc26_dt)}</span>` :
      "—";
    const market = x.market_dt == null ? "—" : `${fmtSeconds(x.market_dt)} from ${x.recorded_source === "txline" ? "TxLINE" : "recorded baseline"}`;
    return `<tr><td>${insightMatchLink(x)}</td><td><strong>${x.scorer}</strong><br>${x.score_before} → ${x.score_after}</td><td>${x.clock || "—"}</td><td>${timing}</td><td>${market}</td><td>${priceMoves(x)}</td><td>${edgeResult}</td><td class="insight-watch-cell">${insightWatchCell(data, x)}</td></tr>`;
  });
  return insightTable(["Match", "Goal / score", "Clock", "Recorded timing", "Market reaction", "Price movement", "Quoted edge result", "Watchlist"], rows);
}
function renderInsightTab(name, d) {
  S.insightTab = name;
  document.querySelectorAll(".insight-tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  const out = $("insight-content");
  renderInsightComparison(d);
  if (name === "edge") {
    const edge = d.summary.edge_finder;
    const winners = d.goal_edges.filter((x) => x.activity_regime === "quiet" && x.gross_per_share > 0).sort((a, b) => b.initial_gap - a.initial_gap);
    out.innerHTML = `<div class="insight-tiles">
      <div class="insight-tile"><h3>Positive replays</h3><strong>${edge.positive_quiet}</strong><span>from ${edge.quiet_cases} accepted-goal quiet-book signals · ${edge.quiet_matches} matches</span></div>
      <div class="insight-tile"><h3>Median window</h3><strong>${fmtDuration(edge.median_duration)}</strong><span>from ≥5¢ signal until convergence</span></div>
      <div class="insight-tile"><h3>Median opening edge</h3><strong>${fmtCents(edge.median_opening_gap)}</strong><span>TxLINE fair minus executable ask</span></div>
      <div class="insight-tile"><h3>Quoted convergence</h3><strong class="pnl pos">${fmtCents(edge.median_gross_per_share)}/share</strong><span>median gross · ${fmtMoney(edge.median_25_pnl)} on a $25 entry</span></div>
    </div><div class="insight-section-head"><div><h3>Quiet-book Edge Finder</h3><p>Positive quoted replays ranked by opening edge, with activity from your selected watchlist actors shown as separate evidence.</p></div></div>${goalEdgeTable(winners, d)}<p class="insight-method">Derived winner view. Quoted replay only: recorded ask entry, recorded bid exit at convergence; excludes fees and fill uncertainty.</p>`;
  } else if (name === "goals") {
    const counts = Object.fromEntries(["winner", "loser", "none"].map((status) => [status, d.goals.filter((x) => x.edge_status === status).length]));
    out.innerHTML = `<div class="insight-section-head"><div><h3>All recorded goals</h3><p>${d.goals.length} accepted goals reconciled to the recorded final scores · ${counts.winner} positive quoted replays · ${counts.loser} negative · ${counts.none} without a screened edge.</p></div></div>${neutralGoalsTable(d.goals, d)}
      <p class="insight-method">Neutral catalog. Replay results use the recorded ask entry and bid at convergence; they are not proof of any actor's execution.</p>
      <details class="insight-details"><summary>Source race · ${d.source_races.length} TxLINE-anchored score signals</summary><p>All times are relative to TxLINE’s goal message. A negative market or fill time means it moved first.</p>${sourceRaceTable(d.source_races, d)}</details>`;
  } else if (name === "opportunities") {
    const replayClass = (v) => v > 0 ? "edge-win" : v < 0 ? "edge-loss" : "";
    const positive = d.opportunities.filter((x) => x.gross_per_share > 0).length;
    const negative = d.opportunities.filter((x) => x.gross_per_share < 0).length;
    const entries = paperBotSelected() ? d.opportunities.filter((x) => x.bot_entry_dt != null).length : null;
    const rows = d.opportunities.map((x) => {
      const depth = x.ask_depth == null ? "—" : `$${Math.round(x.ask_depth).toLocaleString()}`;
      return `<tr><td>${insightMatchLink(x)}<br><span>${x.score || "—"} · ${x.clock || "—"}</span></td><td>${x.label}</td><td>${fmtPrice(x.tx_fair)}</td><td>${fmtPrice(x.poly_ask)}<br><span>${depth} depth</span></td><td>${fmtCents(x.initial_gap)}</td><td>${fmtCents(x.max_gap)}</td><td>${fmtPrice(x.entry_5s_ask)}</td><td>${fmtDuration(x.duration)}</td><td>${fmtPrice(x.exit_bid)}<br><span class="${replayClass(x.gross_per_share)}">Immediate ${fmtCents(x.gross_per_share)}/share</span><br><span class="${replayClass(x.gross_5s_per_share)}">After 5s ${fmtCents(x.gross_5s_per_share)}/share</span></td><td>${x.activity_regime}<br><span>${x.pre_activity.toFixed(2)}/min</span></td><td class="insight-watch-cell">${insightWatchCell(d, x)}</td></tr>`;
    });
    out.innerHTML = `<div class="insight-section-head"><div><h3>All screened price gaps</h3><p>${d.opportunities.length} retrospective closed gaps · ${positive} positive quoted replays · ${negative} negative${entries == null ? "" : ` · ${entries} rows with a selected paper-bot entry`}.</p></div></div>
      <p class="insight-method">A signal opens when TxLINE fair exceeds the recorded ask by at least 5¢ and closes below a 2¢ gap. Opening values were observable at the time; maximum gap, duration, exit bid, and replay result are hindsight. Green/red applies only to recorded ask-to-bid replay results, not to the signal gap.</p>
      ${insightTable(["Match / state", "Outcome", "TxLINE fair", "Entry ask / depth", "Opening gap", "Max gap", "Ask after 5s", "Window", "Quoted replay", "Book activity", "Watchlist"], rows)}
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
  wireInsightActions(out);
  wireInsightActions($("insight-comparison"));
}
function renderInsights(d) {
  S.insightsData = d;
  const s = d.summary;
  $("insights").innerHTML = `<div class="insights-head"><div><h2>TxLINE Trading Intelligence</h2><p>${s.goals} final-score goals across ${s.matches} recorded matches</p></div><button type="button" id="btn-insights-close">Close</button></div>
    <nav class="insight-tabs" aria-label="Insight event type">
      ${[["edge","Edge Finder"],["goals","Goals"],["opportunities","All Gaps"],["reviews","Reviews"],["penalties","Penalties"],["cards","Cards"],["shots","Shots"]].map(([id,label]) => `<button type="button" class="insight-tab" data-tab="${id}">${label}</button>`).join("")}
    </nav><div id="insight-comparison" class="comparison-bar"></div><div id="insight-content"></div>`;
  $("btn-insights-close").onclick = toggleInsights;
  document.querySelectorAll(".insight-tab").forEach((x) => x.onclick = () => renderInsightTab(x.dataset.tab, d));
  syncInsightsBack();
  renderInsightTab("edge", d);
}
function syncInsightsBack() {
  const btn = $("btn-insights-close");
  if (btn) btn.textContent = `← Back to ${S.meta?.match || "match"}`;
}
// Insights is a full-screen exclusive view: all match chrome hides while open
// (CSS keys off body.insights-open); closing restores the untouched match
// state — mode, view, selection, and hash were never mutated.
function toggleInsights() {
  const panel = $("insights"), opening = panel.hidden;
  panel.hidden = !opening;
  document.body.classList.toggle("insights-open", opening);
  $("btn-insights").classList.toggle("active", opening);
  if (opening && !panel.dataset.loaded) {
    panel.innerHTML = "<p>Loading insights…</p>";
    fetch("/api/insights").then((r) => r.json()).then((d) => { renderInsights(d); panel.dataset.loaded = "true"; })
      .catch(() => { panel.innerHTML = "<p>Insights unavailable.</p>"; });
  }
  if (opening) {
    hydrateCustomWatchlist();
    if (panel.dataset.loaded && S.insightsData) renderInsightTab(S.insightTab, S.insightsData);
    syncInsightsBack();
  }
  if (!opening) { resize(); renderScoreboard(); }
}
$("btn-insights").onclick = toggleInsights;
$("brand-home").onclick = (ev) => {
  ev.preventDefault();
  hideHelp();
  if (!$("insights").hidden) toggleInsights();
  syncPageState();
  window.scrollTo({top: 0, behavior: "auto"});
};

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
  // disabled buttons carry a visible inline reason, not a hover-only tip
  $("mode-note").hidden = S.mode !== "upcoming";
  if (S.mode !== "upcoming") { document.body.classList.remove("prematch"); $("sb-countdown-wrap").hidden = true; }
}
$("btn-fity").onclick = () => {
  S.fitY = !S.fitY;
  $("btn-fity").classList.toggle("active", S.fitY);
  $("btn-fity").setAttribute("aria-pressed", String(S.fitY));
  draw();
};
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

window.OBS = { S, clockAnchors, matchMinuteTicks, minuteInfo };   // console debugging

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
