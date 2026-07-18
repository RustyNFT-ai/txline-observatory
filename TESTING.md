# Five-Minute Judge Smoke Test

Set `APP` to the deployed origin, without a trailing slash. For local testing use
`http://localhost:8901`.

## 1. Service and recorded data (20 seconds)

Open `$APP/api/health`. Expect `ok: true`, `matches: 47`, and `ai_enabled: true`
after the Anthropic secret is configured. `ai_enabled: false` is safe but means Ask AI
will use the labeled recorded-evidence fallback.

## 2. Full match, deep link, and goal detail (75 seconds)

Open:

```text
$APP/#m=england-vs-argentina-2026-07-15&t=1784148363.12
```

Expect England vs Argentina in **Full**, the Argentina goal card selected, the chart
zoomed around the event, and the Inspector open. Click the card's small expand icon.
Expect the Argentina goal detail to show RN1 at **−4.1s**, Polymarket at **−9.2s**,
Jupiter at **+3.6s**, ESPN at **+58.8s**, a **+6.3¢** 120-second move, and the recorded
bot line **1 entry · +$45.16**. Negative means the source was recorded before TxLINE's
goal message; it is not a causality claim. Press Escape and confirm the modal closes.

## 3. AI evidence path (35 seconds)

Expand the same Argentina goal and click **Ask AI insight**. Expect a response tied to
Argentina, the selected source times, market move, and recorded bot action. With a valid
key it is labeled `Claude … · archive-grounded`; without a key it is explicitly labeled
`Recorded-evidence fallback` and still contains only server-reconstructed facts.

## 4. Feed-gap and VAR states (40 seconds)

Open `$APP/#m=france-vs-spain-2026-07-14`. Expand the first Spain goal. Expect a
**FEED GAP** badge and a note that TxLINE goal-action timing is unavailable instead of a
misleading latency axis. Expand the next Spain goal and expect a **VAR** badge. The third
goal is marked **VAR** and **DISALLOWED**.

## 5. World Cup wallet lens (60 seconds)

Click **Bot Wallet**, then **Load demo wallet**. Expect the public address
`0xd218e474776403a330142299f7796e8ba32eb5c9`, a clear read-only/World-Cup-only notice,
and a current result of approximately **74 deduplicated fills**, **2 archive matches**,
and **$7,924.85 matched notional**. Public API history can change, so counts may increase
or the app may label the scan capped. Click a timeline action and confirm the matching
recorded match opens near the nearest goal. The separate internal bot card should remain
**33 entries / 33 exits / +$22.04** and must not be described as wallet P&L.

Invalid test: enter `0x1234`. Expect an address-validation message and no request for a
signature, login, private key, or trading permission.

## 6. Modes, routing, and empty handling (50 seconds)

- Open `$APP/#replay=norway-vs-england-2026-07-11`. Expect **Replay 60×** to become
  active and the event count to increase.
- Click **Full**. Expect the same recorded match to load immediately and the URL/title
  to update without a new browser-history entry.
- If a match is actually live, select it and click **Live**; otherwise confirm Live is
  disabled and do not imply the recorded data is live.
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
curl -fsS http://localhost:8901/api/health
curl -fsS http://localhost:8901/api/match/england-vs-argentina-2026-07-15 >/dev/null
curl -fsS http://localhost:8901/api/insights >/dev/null
curl -fsS http://localhost:8901/api/wallet >/dev/null
```

