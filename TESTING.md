# Five-Minute Judge Smoke Test

Set `APP` to the deployed origin, without a trailing slash. For local testing use
`http://localhost:8901`.

## 1. Service and recorded data (20 seconds)

Open `$APP/api/health`. Expect `ok: true` and `matches: 47`. The submission deployment
intentionally starts with `ai_enabled: false`; Ask AI uses the labeled deterministic
recorded-evidence fallback until a key is added. `txline_verify_enabled: false` leaves
the recorded proof data usable but disables retrieval of a new TxLINE Merkle proof.

## 2. Full match, deep link, and goal detail (75 seconds)

Open:

```text
$APP/#m=england-vs-argentina-2026-07-15&t=1784148363.12
```

Expect England vs Argentina in **Full**, the Argentina goal card selected, the chart
zoomed around the event, and the Inspector open. Each goal card must have a prominent
**Analyze goal** button rather than an icon-only affordance. Open the Argentina 84' goal.
With an empty watchlist, expect no wallet or paper-agent row and an **Add actors** action. Polymarket must
show **−9.2s**, Jupiter **+3.6s**, ESPN **+58.8s**, the 120-second move **+6.3¢**, and the
paper agent must be absent. Negative means the source was recorded before TxLINE's goal
message; it is not a causality claim. Press Escape and confirm the modal closes.

In Inspector, click **Verify on Solana** for the selected goal. Expect the locally
recomputed proof status, TxLINE-owned mainnet anchor account, slot, and Solscan link.

## 3. AI evidence path (35 seconds)

Expand the same Argentina goal and click **Ask AI insight**. Expect a response tied to
Argentina, the selected source times, and market move. Without a key it is labeled
`RECORDED-FACTS FALLBACK` and still contains only server-reconstructed facts. A keyed
response is labeled `OPENAI · EVENT-GROUNDED` with the configured model beside it.

## 4. Feed-gap and VAR states (40 seconds)

Open `$APP/#m=france-vs-spain-2026-07-14`. Expand the first Spain goal. Expect a
**FEED GAP** badge and a note that TxLINE goal-action timing is unavailable instead of a
misleading latency axis. Expand the next Spain goal and expect a **VAR** badge. The third
goal is marked **VAR** and **DISALLOWED**.

## 5. World Cup wallet watchlist (75 seconds)

Click **Watchlist**. Expect the optional TxLINE paper bot plus five leaderboard-wallet
suggestions and an empty initial list. Add the paper bot, close the modal, and reopen the
Argentina 84' goal. Expect a neutrally colored `TxLINE paper bot` row at **+54.9s** and
`ENTER · +$45.16`; it must not use success green. Remove it and confirm every paper-agent
row, legend item, and Insights value disappears.

Add RN1, close the modal, and reopen the Argentina 84' goal analysis. Expect an RN1 row at
**−4.1s** with `BUY Argentina`, size, and price. The **watchlist** chip should count only
RN1 fills. Reopen Watchlist, add all suggestions, and confirm five locally saved entries.
Remove one and confirm its chart markers and waterfall rows disappear. Reload and confirm
the addresses and labels persist.

Enter the recorded demo address `0xd218e474776403a330142299f7796e8ba32eb5c9`
to inspect its current public report. It must appear as **My wallet** across the watchlist,
chart, goal analysis, and Insights. Public API counts and notional can change. No built-in
bot identity may reappear. Custom fill reports remain session-only even though the
watchlist entry persists.

Invalid test: enter `0x1234`. Expect an address-validation message and no request for a
signature, login, private key, or trading permission.

## 6. Modes, routing, and empty handling (50 seconds)

- Open `$APP/#replay=norway-vs-england-2026-07-11`. Expect **Replay 60×** to become
  active and the event count to increase.
- Click **Full**. Expect the same recorded match to load immediately and the URL/title
  to update without a new browser-history entry.
- If a match is actually live, select it and click **Live**; otherwise confirm Live is
  not marked with a red live count and leaves the current state unchanged. Do not imply
  the recorded data is live.
- Select the upcoming France vs England fixture. Expect prematch price history, kickoff
  countdown, and the sticky controls flush beneath the upcoming banner while scrolling.
- Manually enter `$APP/#m=not-a-match`. Expect a graceful fallback to the normal default.
- Pan/zoom to an empty chart region. Expect `no data in view — double-click to fit`.

## 7. Insights and responsive layout (40 seconds)

Click **Insights**. Check Edge Finder, Goals, All Gaps, Reviews, Penalties, Cards, and
Shots. Scroll: the tab row should remain pinned directly under the upcoming banner when
present, with no strip of content showing through. At a 390×844 viewport, confirm all
top controls fit, the goal waterfall has no horizontal overflow, and modals remain
closable.

## Command-line checks

From the repository root:

```bash
node --check web/app.js
python3 -m py_compile server.py normalize.py solana_anchor.py wallet_watch.py jupiter_watch.py
python3 -m py_compile agent/goal_latency.py agent/goal_paper_trader.py
curl -fsS http://localhost:8901/api/health
curl -fsS http://localhost:8901/api/match/england-vs-argentina-2026-07-15 >/dev/null
curl -fsS http://localhost:8901/api/insights >/dev/null
curl -fsS http://localhost:8901/api/wallet >/dev/null
```
