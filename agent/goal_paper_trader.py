"""FORWARD PAPER-TRADER for the in-play goal-lag strategy (adaptive exit).

Tails out/goal_latency.jsonl (written by goal_latency.py) and runs the strategy live in PAPER
mode, logging every action to inplay_paper_events.csv. No real orders are placed — fills are
simulated against the SAME observed Polymarket book the live bot would trade, so this is an
honest forward test that also accumulates out-of-sample results while we travel.

Strategy (matches EXIT_BACKTEST_FINDINGS.md recommendation):
  ENTRY  on a TxLINE score event (ESPN score-change fallback), IF TxLINE odds confirm it:
         buy the scoring team at Polymarket's ask, but only if the TxLINE de-margined fair
         for that team exceeds the ask by >= MIN_GAP
         (this is both the significance gate AND the false-positive-goal veto: a VAR-disallowed
         goal won't move TxODDS, so gap ~0 -> we skip).
  TARGET (adaptive) resting limit SELL at  entry + K*(fair - entry).  Fills when best bid >= target.
  TIMER  if unfilled within MAX_HOLD, market-sell at best bid (minus slippage).
  REVERSAL if TxODDS fair falls back below entry before target/timer, market-sell immediately.

Run live (tails new rows; default):   python3 goal_paper_trader.py
Replay the existing log (validate):    python3 goal_paper_trader.py --replay
Env overrides: K, MIN_GAP, MAX_HOLD, SLIP, NOTIONAL
"""
import csv
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(HERE, "out")
LOG = os.environ.get("GLOG", os.path.join(OUT, "goal_latency.jsonl"))
EVENTS = os.environ.get("GEVENTS", os.path.join(HERE, "inplay_paper_events.csv"))

K = float(os.environ.get("K", 0.7))               # adaptive convergence-capture fraction
MIN_GAP = float(os.environ.get("MIN_GAP", 0.03))  # min (fair - ask) to trade (significance + confirm)
MAX_HOLD = float(os.environ.get("MAX_HOLD", 180)) # seconds before timer market-exit
SLIP = float(os.environ.get("SLIP", 0.005))       # slippage on market exits, per share
NOTIONAL = float(os.environ.get("NOTIONAL", 100)) # $ per paper trade
REPLAY = "--replay" in sys.argv

FIELDS = ["ts", "event", "match", "team", "price", "fair", "target", "shares",
          "notional", "pnl_usd", "pnl_share", "reason", "score", "clock", "hold_s"]


def log_event(row):
    new = not os.path.exists(EVENTS)
    with open(EVENTS, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        if new:
            w.writeheader()
        w.writerow(row)


import re as _re
_FOLD = str.maketrans({"ü": "u", "ç": "c", "ñ": "n", "é": "e", "í": "i", "ó": "o", "ú": "u", "ö": "o", "ä": "a", "å": "a", "ø": "o", "ß": "s"})


def _norm(n):
    s = (n or "").lower().translate(_FOLD)
    return set(w for w in _re.sub(r"[^a-z ]", " ", s).split() if len(w) > 2)


def scoring_label(prev, new, teams, match=""):
    """Team whose goal count went +1, resolved in ESPN's ordering (the 'match'
    string and score string share it), then name-matched to the poly label.
    NEVER positional into the poly dict — its ordering comes from Gamma and is
    independent of ESPN's, so index-matching can pick the team that CONCEDED."""
    espn_teams = match.split(" vs ")
    try:
        pa = [int(x) for x in prev.split("-")]; na = [int(x) for x in new.split("-")]
    except Exception:
        return None
    if len(pa) != 2 or len(na) != 2 or len(espn_teams) != 2:
        return None
    diffs = [na[i] - pa[i] for i in range(2)]
    if diffs.count(1) == 1 and diffs[1 - diffs.index(1)] == 0:
        scorer = _norm(espn_teams[diffs.index(1)])
        return next((t for t in teams if _norm(t) & scorer), None)
    return None


def follow(path):
    """Yield JSON rows from the log. Live: seek to end, then stream new appends. Replay: from start."""
    while not os.path.exists(path):
        time.sleep(1)
    with open(path) as f:
        if not REPLAY:
            f.seek(0, os.SEEK_END)
        while True:
            line = f.readline()
            if not line:
                if REPLAY:
                    return
                time.sleep(1.0)
                continue
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except Exception:
                continue


last_score = {}     # match -> last score string seen
last_tx_goal = {}   # match -> latest TxLINE score-event timestamp already evaluated
pos = {}            # match -> open position dict
stats = {"entries": 0, "skips": 0, "wins": 0, "losses": 0, "pnl": 0.0}
print(f"paper trader started (K={K} MIN_GAP={MIN_GAP} MAX_HOLD={MAX_HOLD}s NOTIONAL=${NOTIONAL}) "
      f"{'REPLAY' if REPLAY else 'LIVE'} -> {EVENTS}")


def close(match, p, price, reason, ts, score, clock):
    proceeds = price if reason == "limit" else price - SLIP
    pnl_share = proceeds - p["entry"]
    pnl_usd = pnl_share * p["shares"]
    stats["pnl"] += pnl_usd
    stats["wins" if pnl_usd > 0 else "losses"] += 1
    log_event({"ts": round(ts, 1), "event": "EXIT", "match": match, "team": p["team"],
               "price": round(proceeds, 4), "fair": p["fair"], "target": p["target"],
               "shares": round(p["shares"], 2), "notional": NOTIONAL,
               "pnl_usd": round(pnl_usd, 2), "pnl_share": round(pnl_share, 4),
               "reason": reason, "score": score, "clock": clock, "hold_s": round(ts - p["entry_ts"])})
    print(f"  EXIT  {match[:22]:22s} {p['team'][:12]:12s} via {reason:7s} "
          f"px={proceeds:.3f} pnl=${pnl_usd:+.2f} hold={ts - p['entry_ts']:.0f}s")
    pos.pop(match, None)


for r in follow(LOG):
    match = r.get("match"); now = r.get("ts")
    poly = r.get("poly") or {}; txbt = r.get("tx_by_team") or {}
    score = r.get("score"); clock = r.get("clock")
    teams = [k for k in poly if k != "draw"]

    # ---- manage an open position for this match ----
    p = pos.get(match)
    if p:
        leg = poly.get(p["team"])
        fair_now = txbt.get(p["team"])
        if fair_now is not None and fair_now < p["entry"]:
            close(match, p, leg[1] if leg else p["entry"], "reversal", now, score, clock)
        elif leg and leg[1] >= p["target"]:
            close(match, p, p["target"], "limit", now, score, clock)
        elif now - p["entry_ts"] >= MAX_HOLD:
            close(match, p, leg[1] if leg else p["entry"], "timer", now, score, clock)

    # ---- entry on TxLINE's score event, with ESPN score-change fallback ----
    tx_goal_ts = r.get("tx_goal_ts")
    tx_trigger = tx_goal_ts is not None and last_tx_goal.get(match) != tx_goal_ts
    espn_trigger = bool(r.get("goal_detected"))
    trigger = "txline" if tx_trigger else "espn" if espn_trigger else None
    if trigger and match not in pos:
        prev = last_score.get(match)
        tx_team = r.get("tx_goal_team") if tx_trigger else None
        lab = next((team for team in teams if tx_team and _norm(team) & _norm(tx_team)), None)
        if not lab:
            lab = scoring_label(prev, score, teams, match) if prev else None
        if lab and lab in poly:
            ask = poly[lab][2]; fair = txbt.get(lab)
            if fair is None:
                stats["skips"] += 1
                log_event({"ts": round(now, 1), "event": "SKIP", "match": match, "team": lab,
                           "price": ask, "fair": "", "target": "", "shares": "", "notional": "",
                           "pnl_usd": "", "pnl_share": "", "reason": f"no-txline-confirm:{trigger}",
                           "score": score, "clock": clock, "hold_s": ""})
                print(f"  SKIP  {match[:22]:22s} {lab[:12]:12s} no TxODDS confirm (goal unconfirmed)")
            elif fair - ask < MIN_GAP:
                stats["skips"] += 1
                log_event({"ts": round(now, 1), "event": "SKIP", "match": match, "team": lab,
                           "price": ask, "fair": round(fair, 3), "target": "", "shares": "",
                           "notional": "", "pnl_usd": "", "pnl_share": "", "reason": f"gap<min:{trigger}",
                           "score": score, "clock": clock, "hold_s": ""})
                print(f"  SKIP  {match[:22]:22s} {lab[:12]:12s} gap {fair-ask:+.3f} < {MIN_GAP}")
            elif 0 < ask < 0.97:
                target = min(ask + K * (fair - ask), 0.99)
                shares = NOTIONAL / ask
                pos[match] = {"team": lab, "entry": ask, "fair": round(fair, 3),
                              "target": round(target, 3), "shares": shares, "entry_ts": now}
                stats["entries"] += 1
                log_event({"ts": round(now, 1), "event": "ENTRY", "match": match, "team": lab,
                           "price": ask, "fair": round(fair, 3), "target": round(target, 3),
                           "shares": round(shares, 2), "notional": NOTIONAL, "pnl_usd": "",
                           "pnl_share": "", "reason": f"adaptive:{trigger}", "score": score,
                           "clock": clock, "hold_s": ""})
                print(f"  ENTRY {match[:22]:22s} {lab[:12]:12s} ask={ask:.3f} fair={fair:.3f} "
                      f"-> target={target:.3f} ({score})")

    if tx_goal_ts is not None:
        last_tx_goal[match] = tx_goal_ts
    last_score[match] = score

print(f"\npaper trader done. entries={stats['entries']} skips={stats['skips']} "
      f"wins={stats['wins']} losses={stats['losses']} net=${stats['pnl']:+.2f}")
