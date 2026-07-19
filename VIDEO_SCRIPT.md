# Demo Video Script — Trading Tools and Agents Track

Target 4:15; hard limit 5:00. Record at 1440×900 and 100% browser zoom. Preload the
deployed app, the Argentina 84' goal, Insights → Edge Finder, and
`agent/goal_paper_trader.py` in the public repository. AI is optional and should not be
shown unless it is configured and already tested.

## Preflight

1. Confirm `/api/health` returns `ok: true` and `matches: 47`.
2. Open `#m=england-vs-argentina-2026-07-15&t=1784148363.12`.
3. Start with an empty browser watchlist.
4. Test adding/removing the TxLINE paper bot and adding the demo wallet once.
5. If no match is live, show Replay. Never present recorded data as live.

## 0:00–0:30 — Problem

**Screen:** England vs Argentina full timeline.

“A goal is not one timestamp. TxLINE reports the score action, odds move, markets
reprice, and an agent still has to decide whether an executable edge exists. Ordinary
scoreboards and bot logs hide that sequence. I built an autonomous goal-lag paper agent,
then built TxLINE Observatory so every decision could be audited.”

## 0:30–1:15 — Autonomous strategy and TxLINE ingestion

**Screen:** public repo, `agent/README.md`, then `agent/goal_paper_trader.py`.

“Once started, the agent needs no manual input. TxLINE's score stream is the primary
goal trigger. Its live odds stream supplies a de-margined fair probability, and the
agent compares that with the executable Polymarket ask. It enters only when fair minus
ask is at least three cents.”

Point to the constants and entry branch.

“The exit is deterministic too: capture 70 percent of convergence, exit immediately if
TxLINE fair reverses below entry, or time out after 180 seconds. Every entry, exit, and
skip is appended to the ledger. This is paper execution against observed bid/ask—not a
claim of live-money fills.”

## 1:15–2:05 — Inspect one event-to-execution path

**Screen:** return to the Argentina 84' goal and click **Analyze goal**.

“With no actors selected, the product does not pretend this is the user's bot. Market
signals stand on their own: Polymarket moved 9.2 seconds before TxLINE's recorded goal,
Jupiter followed 3.6 seconds after, and ESPN followed 58.8 seconds after.”

Open **Watchlist**, add **TxLINE paper bot**, then reopen the goal.

“The selected paper ledger now joins the same waterfall. It entered 54.9 seconds after
TxLINE at 7.7 cents. The neutral color is identity—not a claim that this timing or trade
was good. The recorded paper result on this event was plus $45.16.”

Click **Show on chart** and point to the paper-execution triangle and surrounding prices.

## 2:05–2:45 — Compare with public actors

Open **Watchlist**, remove the paper bot, and enter
`0xd218e474776403a330142299f7796e8ba32eb5c9`.

“A user can add a public Polymarket wallet read-only—no private key, signature, login, or
trading permission. It becomes My wallet across the chart, goal analysis, and Insights.
Public fills show activity and notional, not realized P&L.”

Close the modal and point to **My wallet** markers and the comparison layer.

## 2:45–3:20 — Honest replay and feed quality

**Screen:** France vs Spain, then a 60× Replay.

“The archive preserves uncomfortable cases too. This goal has no valid TxLINE action
baseline, so the product says feed gap instead of drawing fake latency. VAR and
disallowed events stay explicit. Because tournament matches finish before judging,
every recorded match can replay at 60× with the exact event order and agent evidence.”

## 3:20–3:55 — Aggregate strategy research

Open **Insights → Edge Finder**, then **All Gaps**.

“Across 47 matches, the product screens TxLINE-fair versus executable-ask windows and
separates quiet from active books. Edge Finder found 37 positive quoted replays among 39
quiet-book accepted-goal cases. All Gaps keeps negative and no-edge cases visible. These
are retrospective quoted replays before fees and fill uncertainty—not profit claims.”

## 3:55–4:15 — Close

**Screen:** README endpoint table, then app.

“TxLINE powers fixture discovery, odds snapshots and streams, score actions, and Solana
Merkle validation. The public repository contains the agent, deterministic strategy,
47-match evidence archive, and this working judge-facing application. This is TxLINE
Observatory.”

Stop. Leave margin under five minutes.
