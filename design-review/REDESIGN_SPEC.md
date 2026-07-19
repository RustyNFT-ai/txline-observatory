# Observatory UI redesign — approved spec (2026-07-18)

Approved direction: "broadcast-desk information architecture with terminal restraint."
Screenshots of current state + problems: this directory (rev-*.jpeg).
This file is self-contained: implement from it without prior conversation context.

## Locked product decisions (from the owner)
1. Mobile must be GENUINELY GOOD, not merely unbroken.
2. Insights becomes a FULL-SCREEN exclusive route (match chrome fully hidden; breadcrumb back).
3. Jupiter lane is opt-in by default (it's Polymarket-routed liquidity; label stays honest).
4. Use REAL source names everywhere ("Poly"→"Polymarket" ok; never "Market"/"TV feed").
5. Scoreboard "finding line" is programmatic and factual-only (template from recorded stats,
   e.g. "Argentina equalizer: market repriced 9.2s before TxLINE; RN1 filled −4.1s" only
   when RN1 is on the user's local watchlist).
   No editorializing, no adjectives.

## Architecture facts (do not rediscover)
- Stack: stdlib-Python `server.py` (port 8901) + vanilla JS `web/app.js` (~1280 lines),
  `web/style.css`, `web/index.html`. No build step, no libraries, NO external resources.
- HARD RULE: never use SSE/EventSource or streaming responses — Cloudflare tunnel buffers
  them dead. Live = short-poll `/api/live/poll?since=seq`; Replay = fetch `/api/match/<id>`
  and play client-side. Keep it that way.
- Event schema (per line of data/<id>.jsonl): {t, src, kind, ...}. kinds: book (o:{label:
  [mid,bid,ask,askUsd,bidUsd]}), odds (probs:{label:p}), jbook (bb/ba), tick (bb/ba),
  action (action,team,cs,confirmed,seq,part), score, shock, burst, trade (bot), decision,
  fill (whale/public-wallet). meta.moments[]: {t0, t0_src txline|espn, scorer, benefit, cs,
  seq, part, baseline, poly_dt, espn_dt, wc26_dt, whale_dt, whale_who, jup_dt, delta_120s,
  var, disallowed, bot_*, prices{...}, note}. All *_dt seconds relative to TxLINE goal
  message; NEGATIVE = source moved BEFORE TxLINE (the key finding — never hide it).
- Modes: full / replay(60x client-side) / live(poll) / upcoming(prematch). Hash routes:
  #m=<id>[&t=], #replay=, #live=, #upcoming=. Keep all working, incl. title sync.
- Existing overlays to preserve functionally: goal waterfall modal (+Ask AI → POST
  /api/ai-insight), Wallet Watchlist modal (/api/wallet), Inspector (raw JSON + Solana anchor
  verify via /api/anchor). Server routes: /api/matches, /api/match/<id>, /api/live/now,
  /api/live/poll, /api/upcoming, /api/insights, /api/wallet, /api/ai-insight, /api/anchor.
- Palette (validated, keep): CSS custom props in style.css — s1 #3987e5, s2 #e66767,
  s3 #c98500 (hue = OUTCOME), status colors reserved (good/warn/crit/serious), ink/grid/
  surface tokens. Hue=outcome, line-style=source (poly solid 2px, TxLINE dashed, Jupiter
  dotted) stays.
- Today Jul 18: France vs England kicks off 17:00 EDT — the app will show live data;
  recorders run independently (do NOT touch any running process except restarting
  `python3 server.py` if server changes are needed).

## ESSENTIAL (build in this order)
1. **Scoreboard strip** (new DOM section under header, replaces tiny status as primary):
   teams + score (large), match state chip (FT / 84' / LIVE pulse / kickoff countdown —
   reuse upcoming-hero logic, fold upcoming hero INTO this strip), and the factual finding
   line chosen from the match's moments: prefer the moment with the most negative poly_dt
   or whale_dt (market/actor front-ran feed); else biggest |delta_120s|; else goal count
   summary. Also a mini goal-bar: 0–120' strip with a dot per moment (team hue, ✕ overlay
   if disallowed); click = selectMoment. Keep the compact status (events count, wall time)
   right-aligned small.
2. **Event track**: new ~28px canvas band between plot and x-axis. ALL flag markers move
   there (none floating mid-plot except bot ▲/▼ trades and — when enabled — whale/wallet
   diamonds which sit AT a price). Goals: filled circle in team hue + scorer initial,
   strike-through overlay when disallowed; VAR: amber ◇ outline; cards: small rects
   (amber/red); score-feed msgs: tiny ticks labeled by source on hover; shocks: "!" serious
   color. Kickoff/HT/FT: axis ticks with labels, not verticals. Whale fills: ticks in the
   track that CLUSTER into count pills ("◆12") when they'd overlap (<10px apart at current
   zoom); clusters expand on zoom-in. Full-height verticals: ONLY the selected event (one
   hairline + soft halo); hover = ghost hairline. Hit-testing moves to the track band.
3. **Series defaults / progressive disclosure**: full view default = Polymarket solid +
   TxLINE dashed only. Jupiter + whale markers auto-join when view span < 20 min, or via
   their chips. (Bot trades stay visible always — they're sparse and part of the story.)
4. **Chip regroup**: three labeled groups + overflow popover ("More…"): Match events
   (goals, reviews/corrections, pens, cards) · Market signals (bursts, shocks, Jupiter
   series toggle) · Actors (bot, whales, wallet). shots/set-pieces/possession/misc live in
   More…. Hide zero-count chips. Presets: Essential (default) / Everything. Keep counts,
   keep aria-pressed, keep data-tips.
5. **X-axis in match minutes** when a match context exists (0', 15', HT, 67', 90+'),
   computed from kickoff (first kickoff action or meta.t0) — wall-clock moves into the
   tooltip line. Prematch/upcoming spans: day-aware wall labels ("Thu 20:00"). Replay/live
   keep match-minute axis once kickoff is known.
6. **Interpolation honesty**: TxLINE odds + Jupiter series render as STEP lines
   (horizontal-then-vertical), and any series breaks (no segment) across gaps > 120s.
7. **Insights = full-screen exclusive**: opening hides scoreboard/moments/chips/chart/
   inspector entirely; its own header with "← back to match". Match state must restore
   perfectly on close (mode, view, selection, hash).
8. **Bug fixes**: stuck help-popover after JS-driven clicks (dismiss on any click that
   moves focus/scroll; also hide on scroll); disabled Full/Replay in upcoming mode get a
   visible inline reason (not hover-only); espn vs wc26 glyphs must differ; waterfall
   modal's source bars use neutral ink (amber ONLY for negative/front-ran; never s1 blue).
9. **Mobile (≤700px) — genuinely good**: single-column: scoreboard (compact), goal-bar,
   chart (≥55vh, event track included, pinch/drag works), moments as swipeable cards,
   chips collapse to preset toggle + "Filters" sheet, end-labels KEEP TEAM NAMES (shorten
   to 3-letter codes if needed, never color-only), tooltip becomes tap-to-inspect (tap
   marker = select + detail strip), modals full-screen sheets, no horizontal page scroll,
   44px touch targets. Test at 390×844 AND 320×568.
10. **Detail strip** (replaces JSON-first): one-line human sentence for the selected
    event under the chart ("TxLINE: goal — Argentina (confirmed), 84', seq 831" /
    "RN1 BUY 300 Argentina @ 15¢"), with buttons [Raw JSON] (opens existing inspector)
    and [Verify on Solana] when applicable. Inspector itself stays as-is behind that click.

## HIGH-VALUE POLISH (after all essentials verified)
- Replay controls: pause/resume, 1×/10×/60×/300×, scrub bar, "jump to next goal".
- Loading skeleton/state for match fetch (16k events ≈ 1-2s) — no blank chart flash.
- Auto-fit-y toggle when zoomed (0/100 ghost lines remain).
- prefers-reduced-motion: disable livepulse/aipulse/ripples.
- Keyboard: ←/→ step through visible track events; Enter opens detail; g/G next/prev goal.
- Offscreen text summary (aria-live) of selected event for canvas a11y.
- Day boundary labels in prematch; "PM" de-duplication in wall-time labels.

## OPTIONAL DELIGHT (only if everything above is done and verified)
- One-time ripple when a goal chip appears during replay/live (reduced-motion aware).
- Moment-card hover sparkline (±120s price around t0).

## Verification bar (do not report done without ALL of these)
- Playwright at 1440×900 AND 390×844 AND 320×568, screenshots of: full match
  (england-vs-argentina-2026-07-15), moment selected (its 84' Argentina moment — finding
  line must mention market/RN1 front-running with negative seconds), dense zoom, Insights
  full-screen + back-restore, replay running with controls, upcoming/live view (France vs
  England today), goal modal, mobile chart interaction.
- All hash routes + browser back/refresh still work; title sync intact.
- Full/Replay/Live/Upcoming all function; wallet + AI + anchor verify still work.
- python3 -m py_compile server.py clean if server touched; server restart command:
  kill $(pgrep -f "^python3 server.py"); cd /home/galen/rust_bot/observatory &&
  setsid python3 server.py > /tmp/obs.log 2>&1 < /dev/null &
- NO external resources, NO SSE, NO frameworks, NO reformat-the-world diffs.
- Check the console for errors on every screenshot pass.
