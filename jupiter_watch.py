"""Jupiter Predict book poller: records the Solana-routed venue's quotes for
World Cup match markets, so the observatory can measure router lag vs the
origin Polymarket books after goals.

Honest context: Jupiter's prediction API is a beta aggregator over Polymarket/
Kalshi liquidity (provider "polymarket" on all WC markets). The interesting
measurement is therefore *routing/refresh latency* — does the Solana-side view
of the same book lag the origin after a goal, and by how much — not an
independent venue's opinion.

Run detached:
  cd observatory && setsid python3 -u jupiter_watch.py >> jupiter_watch.log 2>&1 < /dev/null &

Output: research/leaderboard_study/out/jupiter_books.jsonl (override: OBS_JUPITER)
One line per market per poll: {ts, mid, slug, label, bb, ba, bb_sz, ba_sz}
(bb/ba in probability units for the YES side; ba derived as 1 - best NO bid.)
"""
import json
import os
import re
import sys
import time

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_PATH = os.environ.get(
    "OBS_JUPITER",
    os.path.join(ROOT, "research", "leaderboard_study", "out", "jupiter_books.jsonl"))
BASE = "https://api.jup.ag/prediction/v1"
WC_SLUG = re.compile(r"^fifwc-[a-z]{3}-[a-z]{3}-\d{4}-\d{2}-\d{2}$")
DISCOVER_EVERY = 600.0
POLL = 15.0            # per full sweep; 3 markets/match -> ~12 req/min, under the gate
LOOKAHEAD = 24 * 3600  # poll markets closing within this horizon...
LINGER = 4 * 3600      # ...and keep polling this long PAST close: closeTime is
                       # KICKOFF on these markets, and in-play is the whole point

S = requests.Session()
S.headers.update({"User-Agent": "obs-jupiter-watch/1.0"})


def get(url, params=None, tries=2):
    for _ in range(tries):
        try:
            r = S.get(url, params=params, timeout=12)
            if r.status_code == 429:
                time.sleep(30)
                continue
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        time.sleep(2)
    return None


FIXTURES_CACHE = os.path.join(HERE, "data", "fixtures.json")


def discover():
    """WC match markets: [{mid, slug, label, close}]. Jupiter's generic search
    ranks poorly ('World Cup' returns halftime-show props), so drive discovery
    from the TxLINE fixtures cache: one search per upcoming fixture's teams,
    filtered to the canonical fifwc- match slug."""
    try:
        fixtures = json.load(open(FIXTURES_CACHE))
    except Exception:
        fixtures = []
    queries = [f'{fx.get("t1")} {fx.get("t2")}' for fx in fixtures
               if fx.get("t1") and fx.get("t2")] or ["World Cup"]
    out, seen = [], set()
    for q in queries:
        d = get(f"{BASE}/events/search", {"query": q, "includeMarkets": "true"}) or {}
        for e in d.get("data") or []:
            slug = (e.get("metadata") or {}).get("slug") or ""
            if not WC_SLUG.match(slug):
                continue
            for m in e.get("markets") or []:
                if m.get("marketId") in seen:
                    continue
                seen.add(m.get("marketId"))
                out.append({"mid": m.get("marketId"), "slug": slug,
                            "label": m.get("title"), "close": m.get("closeTime") or 0,
                            "status": m.get("status")})
        time.sleep(1.0)
    return out


def best(book):
    """(bb, ba, bb_sz, ba_sz) in YES-probability units from a Jupiter book."""
    yes = book.get("yes_dollars") or []
    no = book.get("no_dollars") or []
    bb, bb_sz = (float(yes[-1][0]), yes[-1][1]) if yes else (None, None)
    if no:
        ba, ba_sz = round(1.0 - float(no[-1][0]), 4), no[-1][1]
    else:
        ba, ba_sz = None, None
    return bb, ba, bb_sz, ba_sz


def main():
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    markets, last_disc = [], 0.0
    print(f"jupiter-watch -> {OUT_PATH}")
    while True:
        now = time.time()
        if now - last_disc > DISCOVER_EVERY or not markets:
            found = discover()
            if found:
                markets = found
                live = [m for m in markets if m["status"] == "open"
                        and -LINGER < m["close"] - now < LOOKAHEAD]
                print(f'{time.strftime("%H:%M:%S")} discovered {len(markets)} WC markets, '
                      f'{len(live)} pollable: {sorted({m["slug"] for m in live})}')
            last_disc = now
        polled = 0
        for m in markets:
            if m["status"] != "open" or not (-LINGER < m["close"] - now < LOOKAHEAD):
                continue
            book = get(f'{BASE}/orderbook/{m["mid"]}', tries=1)
            if not book:
                continue
            bb, ba, bb_sz, ba_sz = best(book)
            with open(OUT_PATH, "a") as f:
                f.write(json.dumps({"ts": round(time.time(), 2), "mid": m["mid"],
                                    "slug": m["slug"], "label": m["label"],
                                    "bb": bb, "ba": ba, "bb_sz": bb_sz, "ba_sz": ba_sz}) + "\n")
            polled += 1
            time.sleep(1.0)
        time.sleep(max(2.0, POLL - (time.time() - now)))


if __name__ == "__main__":
    main()
