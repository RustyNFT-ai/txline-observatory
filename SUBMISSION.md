# TxLINE Observatory — Submission Brief

## Submission fields

**Track:** Trading Tools and Agents

**Project title:** TxLINE Observatory — Autonomous Event-to-Execution Agent

**Brief explanation:** A deterministic paper agent consumes TxLINE's live World Cup
score and odds streams, compares TxLINE's de-margined fair probability with the
executable Polymarket book, and autonomously enters and exits goal-lag positions. The
TxLINE Observatory is its audit and replay surface: judges can inspect every source
event, price, decision, fill assumption, and outcome across 47 recorded matches, then
compare an opt-in paper ledger with public-wallet activity on the same timeline.

**Most useful submission link:** use the public app URL. It opens directly into the
working product and links to the public repository and documentation from this brief.

**Public app:** `[ADD DURABLE DEPLOY URL]`

**Demo video:** `[ADD PUBLIC LOOM OR YOUTUBE URL]`

**Public repository:** `https://github.com/RustyNFT-ai/txline-observatory`

**Technical documentation:**
`https://github.com/RustyNFT-ai/txline-observatory/blob/main/README.md`

## Problem and product

A goal is not a single timestamp. Score feeds report it at different times, a VAR
decision can reverse it, the market can move before or after the message, and a bot
still has to turn the signal into an executable order. A normal scoreboard hides that
sequence. A raw feed log makes it hard to understand.

Once started, the agent runs without manual intervention. TxLINE score actions are its
primary goal trigger, with ESPN score transitions as a fallback; every candidate still
must pass the same TxLINE-fair versus executable-ask gate. It targets 70% convergence
of the initial gap and exits early on reversal or after 180 seconds. Every entry, exit,
and skip is append-only evidence rather than an opaque claim.

The Observatory normalizes those layers into one event clock. For each goal it shows:

- the TxLINE message and nearby score actions;
- Polymarket top-of-book and TxLINE de-margined fair probability;
- source timing relative to TxLINE, including legitimately negative observations;
- VAR, disallowed-goal, and missing-feed context;
- the 120-second market move and any selected paper-agent outcome;
- public wallet fills that map to the archive's World Cup match-outcome tokens; and
- an AI explanation grounded in a server-built, bounded event evidence packet.

The result is useful for post-match agent debugging, feed benchmarking, strategy
research, and explaining event-driven execution to a non-technical stakeholder.

## Business and technical highlights

- **Evidence before narrative.** Source times, event messages, market prices, and bot
  actions remain inspectable; AI interpretation is labeled separately.
- **Autonomous deterministic operation.** TxLINE goal triggers, a 3¢ minimum executable
  edge, adaptive convergence exit, reversal stop, fixed notional, and hard time limit
  are explicit in [`agent/goal_paper_trader.py`](agent/goal_paper_trader.py).
- **Replayable research.** Forty-seven recorded World Cup matches remain usable after
  the live event, with Full, 60× Replay, Live, and upcoming-prematch modes.
- **Execution-aware analysis.** The screen distinguishes fair probability from an
  executable ask and measures screened dislocation windows, not just theoretical moves.
- **Safe wallet comparison.** The wallet flow accepts only a public Polymarket
  profile/proxy address, requests no signature or private key, and imports only fills
  mapped to World Cup match markets in the archive.
- **Portable implementation.** The server uses Python's standard library and the
  client is vanilla JavaScript/CSS/canvas. The browser uses finite fetches and short
  polling, which works through ordinary hosting proxies.
- **Optional grounded OpenAI integration.** The browser sends a match ID, moment index,
  bounded question, and optionally a validated public-wallet identifier—not facts. The
  server reconstructs trusted context from the archive, adds prematch/nearby evidence
  and similar cases, then calls OpenAI's Responses API. A clearly labeled deterministic
  evidence summary keeps the feature useful when AI is unavailable.

## TxLINE integration

The project uses these TxLINE endpoints:

| Endpoint | Use in the project |
| --- | --- |
| `POST /auth/guest/start` | Obtains the guest JWT used for authorized score/proof access. |
| `GET /api/fixtures/snapshot?competitionId=72` | Discovers World Cup fixtures, participants, start times, and fixture IDs. |
| `GET /api/odds/snapshot/{fixtureId}` | Captures outcome odds snapshots used to derive fair probabilities. |
| `GET /api/odds/stream` | Records live odds updates for the normalized timeline. |
| `GET /api/scores/stream` | Records goal, VAR, score, card, penalty, and match-state actions. |
| `GET /api/scores/stat-validation?fixtureId=…&seq=…&statKey=…` | Retrieves Merkle evidence for the Inspector's Solana verification receipt. |

The public app serves recorded normalized data rather than redistributing TxLINE
credentials. Live collection is a separate recorder process. Replay is explicitly a
historical replay and never presented as a live market.

## Recorded findings shown in the app

- ESPN registered goals a median 44.1 seconds after TxLINE in exact-score cases.
- The screened archive contains 154 executable dislocation windows of at least 5¢
  across 39 matches; median duration is 102.7 seconds.
- Edge Finder identifies 39 quiet-book accepted-goal cases; 37 had positive quoted
  replay outcomes across 23 matches.
- The separate paper-agent event ledger records 33 entries and 33 exits totaling +$22.04.
  This is not presented as arbitrary-wallet P&L.

These are retrospective measurements from the included archive, not promises of live
profitability. Negative source timing means an observation was recorded before the
TxLINE goal message; it does not by itself establish causality or private intent.

## TxLINE feedback

**What worked well:** The combination of a full fixture/odds snapshot with low-latency
odds and score streams made it possible to rebuild an event state instead of reacting
to an isolated webhook. The score action sequence and stat-validation endpoint were
especially valuable: they let us show VAR/reversal context and connect an off-chain
event to independently recomputed Merkle evidence and the TxLINE Solana program.

**Where we hit friction:** Participant IDs had to be mapped back to team and market
labels, especially for historical or 0–0 matches. Repeated/amended score actions needed
careful deduplication, and confirmed versus unconfirmed sequences mattered for valid
stat proofs. We also saw occasional goal-action feed gaps and fixture schedule changes,
so the product preserves source/method notes rather than treating every timestamp as
equivalent. Finally, SSE buffering through common public tunnels led us to keep SSE in
the recorder while using finite JSON fetches and short polling in the judge-facing UI.

## Scope and limitations

- Wallet import is deliberately limited to main match-outcome tokens already mapped to
  the 47-match World Cup archive. Other sports and markets are ignored.
- The public Polymarket Data API returns a bounded recent window; the UI labels capped
  scans and does not infer realized P&L from fills alone.
- AI output is analytical assistance, not trading advice, and cannot claim causality
  beyond the supplied observations.
- A deployed server cannot collect new live matches unless the recorder processes and
  their source logs are also running. Included Full/Replay/Insights data is self-contained.

## Submission checklist

- [ ] Replace the public app placeholder with the durable deployed URL.
- [ ] Add `OPENAI_API_KEY` and `TXLINE_API_TOKEN` as deployment secrets; verify AI and one Solana receipt.
- [ ] Run [TESTING.md](TESTING.md) against the deployed URL.
- [ ] Record and publish the video using [VIDEO_SCRIPT.md](VIDEO_SCRIPT.md).
- [ ] Confirm the video, app, repository, and documentation links work in a private window.
- [ ] Paste the project explanation and feedback above into the submission form.
- [ ] Submit before Sunday, July 19, 2026 at 8:00 PM America/New_York.
