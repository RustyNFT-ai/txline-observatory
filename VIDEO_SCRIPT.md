# Demo Video Script — Target 4:35, Hard Limit 5:00

Record at 1440×900 with the browser zoom at 100%. Close notifications and unrelated
tabs. Preload the links below, load the demo wallet once, and verify AI before recording.
Keep the mouse still when speaking so tooltips do not cover the screen.

## Preflight

1. Open the deployed `/api/health`; confirm 47 matches and `ai_enabled: true`.
2. Open the focused Argentina goal link from [TESTING.md](TESTING.md).
3. In a second tab open France vs Spain; in a third open the repository README.
4. Test the goal modal, AI response, demo wallet, Replay, and Insights once.
5. If Claude is unavailable, use the app's labeled recorded-evidence fallback and say so.
6. If no game is live, do not demo Live. Replay is the reliable substitute.

## 0:00–0:35 — Problem

**Screen:** England vs Argentina, full timeline.

“A goal is not one timestamp. The score feed reports it, VAR may review it, prediction
markets reprice, and a bot still has to execute. Those events can be seconds apart, but
ordinary scoreboards and bot logs hide the sequence. TxLINE Observatory turns that
sequence into one inspectable World Cup timeline.”

Point to the solid Polymarket lines, dashed TxLINE fair probabilities, flags, and goal
cards. Mention that this is a recorded historical replay, not a live market.

## 0:35–1:35 — TxLINE event-to-market evidence

**Action:** Use the already-focused Argentina goal and expand it.

“This Argentina goal is anchored to TxLINE's recorded goal message. RN1's public fill
was recorded 4.1 seconds earlier, Polymarket had already moved 9.2 seconds earlier,
Jupiter refreshed 3.6 seconds after TxLINE, and ESPN followed 58.8 seconds later. The
market moved another 6.3 cents over 120 seconds, and our recorded bot made one entry for
45 dollars and 16 cents on this event.”

“Negative timing only means recorded earlier—it does not claim why. The raw normalized
event and surrounding messages remain available in Inspector.”

Click **Show on chart**, briefly pan the local event window, then expand it again.

## 1:35–2:20 — Context-bounded AI

**Action:** Click **Ask AI insight**.

“The AI analyst cannot roam across the product or accept invented client facts. The
browser sends only this match ID, moment index, and question. The Python server rebuilds
a bounded evidence packet with nearby events, prematch trading, source state, prices,
and bot activity, then asks Claude to separate fact from interpretation. That keeps the
answer focused on exactly where the user asked for insight.”

Point to the provider label and one event-specific sentence. Do not read the full answer.

## 2:20–3:05 — Safe public wallet comparison

**Action:** Close the goal modal, click **Bot Wallet**, load the demo wallet.

“A user can add a public Polymarket profile wallet—never a private key, signature, or
trading permission. The server scans a bounded public fill window and keeps only token
IDs mapped to World Cup match markets in this 47-match archive.”

Point to matched fills, match count, and matched notional. Click one mapped timeline
event and its public-wallet diamonds. Mention that only the public address is remembered;
fill details stay in session memory and can ground AI for the selected goal. Then point
to the separate internal bot ledger card.

“Fill history does not prove realized P&L, so the wallet view reports activity and
notional. Our own event ledger's 33 closed trades and plus 22 dollars and 4 cents remain
separate.”

## 3:05–3:45 — Feed quality and replay

**Screen:** France vs Spain.

Expand the first goal: “Here the goal-action record is missing, so the Observatory says
feed gap and refuses to draw a fake TxLINE latency axis.” Expand the second: “The next
goal preserves its VAR context.”

Switch to Norway vs England Replay: “Every recorded match can be played back at 60×,
which makes event-driven strategy behavior reviewable after kickoff.”

## 3:45–4:20 — Aggregate intelligence

**Action:** Open Insights, then Edge Finder and All Gaps.

“Across the archive, Edge Finder screens accepted goals for quiet books and executable
TxLINE-fair versus Polymarket-ask gaps. The Observatory found 154 five-cent-or-larger
windows across 39 matches, with a 102.7-second median duration. Neutral catalogs keep
the negative and no-edge cases visible so this is not a winners-only dashboard.”

## 4:20–4:35 — TxLINE backend and close

**Screen:** repository README at the endpoint table, then return to app.

“TxLINE powers fixture discovery, odds snapshots and streams, score actions, and Merkle
stat validation. Those feeds are normalized with market and execution evidence into a
working research product judges can test now. This is TxLINE Observatory.”

Stop recording. Do not add a long outro; preserve margin under five minutes.
