# TxLINE Observatory

Multi-feed observatory for in-play soccer prediction markets: aligns **TxLINE**
(odds + scores streams), **ESPN**, **worldcup26.ir**, **Polymarket** (REST books +
real-time WS ticks) and **our bot's trades** on one timeline — live during a match,
and replayable after. Per goal it measures the score transition, exact-score source
latencies, sustained Polymarket repricing, outcome price moves, and bot execution.
The Insights panel also measures executable TxLINE-fair versus Polymarket-ask windows.

Zero runtime dependencies: stdlib-only Python server, hand-rolled canvas frontend.

## Run

The committed public repository already contains the normalized 47-match archive. A
fresh clone needs no TxLINE credential or recorder files to use Full, Replay, Insights,
wallet matching, or the deterministic AI fallback:

```bash
cd /path/to/txline-observatory    # or /path/to/rust_bot/observatory
cp .env.example .env              # optional: add OPENAI_API_KEY for live AI answers
python3 server.py                 # http://localhost:8901
```

Only in the original recorder workspace, after new source logs are present, rebuild the
archive with `python3 normalize.py index && python3 normalize.py build all`. Do not run
that rebuild in a standalone clone without configuring the `OBS_*` source paths; the
included data is ready to view as-is.

UI modes (top bar):
- **Upcoming · Prematch** — scheduled fixtures from TxLINE, with kickoff countdown
  and prematch-only TxLINE fair odds plus Polymarket-backed books recorded through
  Jupiter Predict. The first observed schedule is retained so later fixture-time
  changes can be shown as delays; an overdue fixture reads “awaiting kickoff”.
- **Full** — entire recorded match at once, zoom/pan, click moment cards to jump.
- **Replay 60×** — finite match fetch played client-side as it happened (demo theater).
- **Live** — tails the running monitors' output files; auto-discovers live matches.

Event chips filter the flag lanes (goals/reviews and corrections/pens on by default; possession,
set pieces etc. opt-in). Click any flag → Inspector shows the raw feed message
and its neighbours. Solid line = Polymarket best bid; dashed = TxLINE de-margined
fair prob. Hue = outcome (validated CVD-safe palette), line style = source.

## Public bot wallet lens

Click **Bot Wallet** and enter any Polymarket profile/proxy wallet address. This is
read-only: no signature, private key, login, or trading permission is requested. The
server reads the wallet's public Polymarket trade tape and keeps only fills whose
token ID belongs to a main match-outcome market in the 47-match World Cup archive.
Matched fills appear as public-wallet diamonds on the chart, link back to their exact
point on the Observatory timeline, and show the nearest goal when it is within five
minutes. After a wallet is loaded, its server-verified nearby fills are also available
to Ask AI for the selected goal.

The browser persists only the validated public address so it can prefill the next visit;
fill details remain in memory for the current session and can be cleared with **Forget
saved address**. The server keeps a short in-memory response cache and writes no wallet
profile or fills to disk.

The public Data API exposes a bounded recent window, so the endpoint scans up to the
20,000 most-recent fills and says when that window is capped. The built-in `cigarettes`
demo is cross-checked against real fills captured by the recorder with the match archive.
Wallet fills show activity and matched notional only—**they do not establish realized
P&L**. The separate recorded in-play bot card retains the internal event-ledger result
(33 entries, 33 exits, +$22.04) and labels it separately.

## Architecture

```
recorders (already running, unchanged):        observatory/
  goal_latency.py  ── goal_latency.jsonl ──┐   normalize.py  batch: files -> data/<id>.jsonl (+moments)
    ├─ TxLINE /api/odds/stream  ─ tx_odds_raw.jsonl │   server.py     finite /api/match, /api/live/poll,
    ├─ TxLINE /api/scores/stream ─ tx_scores_raw.jsonl ├──▶            /api/wallet, /api/ai-insight, static web/
    └─ poly-ws-watch ─ burst_events.jsonl   │   web/          index.html + app.js (canvas) + style.css
  inplay bots ── inplay*_events.csv ────────┘
```

Unified event schema (one JSON/line, sorted by `t` unix-seconds):
`{t, src: poly|txline|espn|wc26|polyws|bot, kind: book|odds|action|shock|score|tick|burst|trade|decision, ...}`
Outcome labels are canonicalized to Polymarket market labels; TxLINE participant
1/2 is resolved to teams by goal↔score-change correlation votes (plus fixture
snapshot for upcoming matches, PID propagation for 0-0 games).

TxLINE endpoints used (hackathon submission list): `POST /auth/guest/start`,
`GET /api/fixtures/snapshot?competitionId=72`, `GET /api/odds/snapshot/{fid}`,
`GET /api/odds/stream` (SSE), `GET /api/scores/stream` (SSE),
`GET /api/scores/stat-validation` (Merkle proofs).

## Solana anchor verification (Verifiable Resolution UI)

Click any goal moment (or TxLINE action flag) → Inspector → **Verify on Solana**.
`solana_anchor.py` (pure stdlib — no solana/anchor deps) then:
1. fetches the Merkle proof from `/api/scores/stat-validation?fixtureId&seq&statKey`
   (statKey 1/2 = participant 1/2 goals; **use the CONFIRMED goal message's seq** —
   unconfirmed seqs prove value 0 with an unverifiable path, by design: the
   validated tree only includes VAR-confirmed stats);
2. recomputes the chain locally: `leaf = sha256(key‖value‖period as u32le)` →
   statProof → eventStatRoot → subTreeProof → summary.eventStatsSubTreeRoot
   (hash fn + leaf encoding determined empirically against live proofs);
3. derives the `daily_scores_roots` PDA (seeds `["daily_scores_roots", epochDay
   u16le]`, mainnet program `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA`)
   with find_program_address implemented from scratch (incl. ed25519 on-curve
   rejection);
4. reads the account over public RPC: exists, owned by the TxLINE program, and
   reports the latest root-anchor transaction + slot with a Solscan link.
The main-tree root's account layout is undocumented; the receipt reports that
honestly rather than faking a match. CLI: `python3 solana_anchor.py <fid> <seq> <key>`.

## Judge and contributor guides

- [Submission brief and TxLINE feedback](SUBMISSION.md)
- [Five-minute smoke test](TESTING.md)
- [Demo video script](VIDEO_SCRIPT.md)
- [Final UX audit and known limitations](UX_AUDIT.md)
- [AI grounding and security model](AI_INSIGHTS.md)

## Deploy

The standalone public repository includes `render.yaml`. In Render, create a new
Blueprint from the repository and set `OPENAI_API_KEY` and `TXLINE_API_TOKEN` as
secret environment variables. The latter enables the optional live Merkle-proof receipt;
it is never sent to the browser. Render supplies `PORT`; `server.py` binds to it. The included
47-match archive makes Full, Replay, Insights, AI context, and wallet matching work
without access to the private recorder filesystem. A free service can cold-start, so
open the app once before a live demo or judging session.

[Deploy the public repository to Render](https://render.com/deploy?repo=https://github.com/RustyNFT-ai/txline-observatory)

For a temporary preview, run `cloudflared tunnel --url http://localhost:8901`. The
generated URL changes on restart and requires this computer to stay awake, so it is not
the submission deployment.

**Transport note (important):** Cloudflare quick tunnels **buffer SSE
(`text/event-stream`) to death** — the stream never flushes to the browser, so
anything server-streamed shows 0 events over the tunnel while working fine on
localhost. The client therefore avoids SSE entirely: **Live** uses short polling
(`GET /api/live/poll?since=<seq>`, finite JSON bodies) and **Replay** fetches the
whole match (`/api/match/<id>`) and plays it client-side on a timer. Both are
proxy-safe. The old `/api/live` + `/api/stream` SSE endpoints still exist
(low-latency on localhost) but the UI no longer uses them. If you ever add a new
streaming feature, poll — don't SSE — or it'll break for remote judges.

Source paths can be overridden with `OBS_GL`, `OBS_TX_SCORES`, `OBS_TX_ODDS`,
`OBS_BURSTS`, `OBS_BOT_LIVE`, `OBS_BOT_PAPER` (used by the live-sim test:
`scratchpad/live_sim.py` replays a recorded match into scratch files at 30×).

## Extra recorders (both launched detached 2026-07-13, survive session close)

- **`wallet_watch.py`** — polls Polymarket data-api for the fast-crowd wallets
  (RN1, swisstony, cigarettes, mooseborzoi, GoalLineGhost) every 10s →
  `out/wallet_fills.jsonl`. UI: ◆ diamonds at fill price; moments gain
  `whale_dt` ("RN1 filled +Xs after TxLINE's goal message") — the benchmark the
  bot competes with.
- **`jupiter_watch.py`** — polls Jupiter Predict (Solana) orderbooks for WC match
  markets (auto-discovered from the TxLINE fixtures cache) every 15s →
  `out/jupiter_books.jsonl`. UI: dotted line per outcome; moments gain `jup_dt`.
  Honest caveat: Jupiter's beta API aggregates Polymarket/Kalshi liquidity
  (provider "polymarket" on every WC market), so this measures *Solana-side
  routing/refresh lag vs the origin book*, not an independent venue's opinion.
  Unauthenticated rate limit is tight (429s on bursts) — the poller paces itself.

Status check: `pgrep -af "wallet_watch|jupiter_watch"`; logs sit next to the scripts.

## Matchday runbook (France–Spain, 2026-07-14 15:00)

1. **Recorder**: runs under `systemd --user` as `inplay-monitor.service` and is
   already on the patched code (odds raw-logging active since 2026-07-13 22:55).
   If it ever needs a restart: `systemctl --user restart inplay-monitor`
   (NOT kill+relaunch — systemd respawns and you get a duplicate writer).
2. Confirm `wallet_watch.py` and `jupiter_watch.py` are still running (see above);
   relaunch with the setsid lines in their docstrings if not.
3. Start bots as usual (`inplay-bot/run-detached.sh` / live trader).
4. `cd observatory && python3 server.py` → open http://localhost:8901, hit **Live**
   shortly before kickoff. The match appears automatically when ESPN flags it in-play.
5. After the match: `python3 normalize.py index && python3 normalize.py build all`
   → the game is now in the Full/Replay catalog with computed moments
   (including whale_dt / jup_dt for the first time).

## Findings the recorded data already shows (honest, on-screen)

- Across exact-score matches, ESPN registered goals a median **44.1s after TxLINE**.
- The screened archive contains **154 executable ≥5¢ dislocation windows** across
  39 matches, with a **102.7s** median duration and **13.7¢** median maximum gap.
- Edge Finder identifies **39 quiet-book, accepted-goal cases**; 37 positive
  quoted replays span 23 matches, with a **20.4¢** median opening edge and
  **200.0s** median window among those positive replays. All accepted goals,
  including negative replays and goals without a screened edge, remain visible
  in the neutral Goals catalog. Quiet means fewer than 0.25 top-of-book changes per
  minute during the ten minutes before the signal.
- The recorded bot ledger contains 33 entries and 33 exits totaling **+$22.04**.

[AI event analyst](AI_INSIGHTS.md): expand any goal moment and ask OpenAI to explain
its source timing, nearby feed evidence, executable edge, and recorded bot action.
The server rebuilds trusted event context, prematch history, and five similar goal
cases from the archive; credentials and model calls never reach the browser.

## Later extensions

Authenticated bot-ingest API, resolved wallet accounting, and a consumer scoreboard.
