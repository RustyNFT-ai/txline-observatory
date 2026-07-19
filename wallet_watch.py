"""Whale-wallet fill recorder: polls Polymarket's public data-api for named
wallets' trades and appends new fills to a jsonl the observatory can lane.

Wallets: the fast-crowd roster from the leaderboard study (RN1 etc.). Their
fills against TxLINE goal timestamps show, per goal, how fast the fastest
public money actually is — the benchmark our bot competes with.

Run detached (survives session close):
  cd observatory && setsid python3 wallet_watch.py >> wallet_watch.log 2>&1 < /dev/null &

Output: research/leaderboard_study/out/wallet_fills.jsonl (override: OBS_WALLETS)
One line per fill: raw data-api record + {"seen": <poll unix ts>}.
All fills are recorded (whales trade many sports); the observatory filters to
the match's token ids at normalize/live time. Dedupe key: txhash+asset+ts+size.
"""
import json
import os
import sys
import time

import requests

from wallet_roster import WATCH

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_PATH = os.environ.get(
    "OBS_WALLETS",
    os.path.join(ROOT, "research", "leaderboard_study", "out", "wallet_fills.jsonl"))
DATA_API = "https://data-api.polymarket.com/trades"
POLL = 10.0          # full sweep interval (all wallets); ~30 req/min total
LIMIT = 50

S = requests.Session()
S.headers.update({"User-Agent": "obs-wallet-watch/1.0"})


def fill_key(t):
    return f'{t.get("transactionHash")}|{t.get("asset")}|{t.get("timestamp")}|{t.get("size")}'


def seed_seen():
    """Warm the dedupe set from fills already on disk (restart-safe)."""
    seen = set()
    if os.path.exists(OUT_PATH):
        with open(OUT_PATH) as f:
            for line in f:
                try:
                    seen.add(fill_key(json.loads(line)))
                except Exception:
                    continue
    return seen


def main():
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    seen = seed_seen()
    first_sweep = not seen     # on a cold start, don't backfill history as "new"
    print(f"wallet-watch: {len(WATCH)} wallets -> {OUT_PATH} ({len(seen)} fills seeded)")
    while True:
        t_sweep = time.time()
        for addr, name in WATCH.items():
            try:
                r = S.get(DATA_API, params={"user": addr, "limit": LIMIT}, timeout=12)
                if r.status_code != 200:
                    continue
                fresh = 0
                for t in r.json() or []:
                    k = fill_key(t)
                    if k in seen:
                        continue
                    seen.add(k)
                    if first_sweep:
                        continue          # cold-start backfill: dedupe only, don't log
                    rec = {kk: t.get(kk) for kk in
                           ("proxyWallet", "side", "asset", "conditionId", "size", "price",
                            "timestamp", "title", "slug", "eventSlug", "outcome",
                            "outcomeIndex", "transactionHash")}
                    rec["who"] = name
                    rec["seen"] = round(time.time(), 2)
                    with open(OUT_PATH, "a") as f:
                        f.write(json.dumps(rec) + "\n")
                    fresh += 1
                if fresh:
                    print(f'{time.strftime("%H:%M:%S")} {name}: {fresh} new fill(s)')
            except Exception as e:
                print(f"poll error {name}: {e}", file=sys.stderr)
            time.sleep(0.5)   # stagger wallets inside the sweep
        first_sweep = False
        # cap memory: drop dedupe keys older than 48h (key part 3 is the fill ts)
        if len(seen) > 50000:
            cut = time.time() - 48 * 3600
            def _ts(k):
                try:
                    return float(k.split("|")[2])
                except (IndexError, ValueError):
                    return 0
            seen = {k for k in seen if _ts(k) >= cut}
        time.sleep(max(0.5, POLL - (time.time() - t_sweep)))


if __name__ == "__main__":
    main()
