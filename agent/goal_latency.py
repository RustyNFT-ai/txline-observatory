"""LIVE TXLINE-TO-POLYMARKET GOAL-LAG MONITOR.
Consumes TxLINE odds and score streams, with ESPN/worldcup26 score fallbacks, and samples
the executable Polymarket moneyline book every POLL seconds. It writes the normalized
observations tailed by the autonomous paper trader and the Observatory recorder.

Run: python3 goal_latency.py <hours>   (default 4)   -> out/goal_latency.jsonl
"""
import json
import os
import re
import sys
import threading
import time

import requests

HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard"
GAMMA = "https://gamma-api.polymarket.com/events"; DATA = "https://data-api.polymarket.com/trades"; CLOB = "https://clob.polymarket.com"
WC26 = "https://worldcup26.ir/get/games"  # second goal source: free, no key, exposes goal minutes
TXODDS_BASE = "https://txline.txodds.com"  # legacy hostname for the TxLINE API
TXODDS_TOKEN = os.environ.get("TXLINE_API_TOKEN", "").strip()
if not TXODDS_TOKEN:
    try:
        TXODDS_TOKEN = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".txodds_token")).read().strip()
    except Exception:
        TXODDS_TOKEN = ""
S = requests.Session(); S.headers.update({"User-Agent": "goal-lat/1.0"})
LOG = os.path.join(OUT, "goal_latency.jsonl")
POLL = 4.0
hours = float(sys.argv[1]) if len(sys.argv) > 1 else 4.0


def get(u, p=None):
    for _ in range(2):
        try:
            r = S.get(u, params=p, timeout=12)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
    return None


# Name aliases bridge ESPN <-> TxODDS spelling for WC teams. Diacritics are stripped
# first by ASCII_FOLD; aliases handle abbreviations (USA/United States) that fold to
# disjoint word-sets. Keep this table tight: only add entries verified against the
# TxODDS /api/fixtures/snapshot competitionId=72 list.
ASCII_FOLD = str.maketrans({
    "ü": "u", "Ü": "u", "ç": "c", "Ç": "c", "ñ": "n", "Ñ": "n",
    "á": "a", "à": "a", "â": "a", "ä": "a", "ã": "a",
    "é": "e", "è": "e", "ê": "e", "ë": "e",
    "í": "i", "ì": "i", "î": "i", "ï": "i",
    "ó": "o", "ò": "o", "ô": "o", "ö": "o", "õ": "o",
    "ú": "u", "ù": "u", "û": "u",
    "ý": "y", "ÿ": "y",
    "ß": "s", "ø": "o", "å": "a", "æ": "a",
})
NAME_ALIASES = {
    "united states": "usa",
    "turkiye": "turkey",
    "cote d ivoire": "ivory coast",
}


def norm(n):
    s = (n or "").lower().translate(ASCII_FOLD)
    s = re.sub(r"[^a-z ]", " ", s)
    s = " ".join(s.split())
    for k, v in NAME_ALIASES.items():
        if k in s:
            s = s.replace(k, v)
    return set(w for w in s.split() if len(w) > 2)


def tmatch(a, b):
    return bool(norm(a) & norm(b))


def book_depth(tid):
    """Returns (buyable$, sellable$, best_bid, best_ask) from the live CLOB book.
    The book endpoint is NOT CDN-cached, unlike gamma bestBid/bestAsk which Cloudflare
    serves with max-age=300 (frozen prices cost us the first live entries, 2026-07-05).
    Bulletproof: (0,0,None,None) on any error so it can never crash the monitor loop."""
    try:
        b = get(f"{CLOB}/book", {"token_id": tid})
        if not b:
            return (0.0, 0.0, None, None)
        bids = [(float(x["price"]), float(x["size"])) for x in b.get("bids", [])]
        asks = [(float(x["price"]), float(x["size"])) for x in b.get("asks", [])]
        bb = max((p for p, _ in bids), default=None)
        ba = min((p for p, _ in asks), default=None)
        ask_usd = sum(p * s for p, s in asks if ba is not None and p <= ba + 0.02)
        bid_usd = sum(p * s for p, s in bids if bb is not None and p >= bb - 0.02)
        return (round(ask_usd), round(bid_usd), bb, ba)
    except Exception:
        return (0.0, 0.0, None, None)


def poly_mids(slug):
    e = get(GAMMA, {"slug": slug})
    if not e:
        return None
    e = e[0] if isinstance(e, list) else e
    outs = {}
    for m in e.get("markets", []):
        q = m.get("question") or ""; ql = q.lower()
        try:
            bb, ba = float(m.get("bestBid")), float(m.get("bestAsk"))
        except (TypeError, ValueError):
            continue
        mid = (bb + ba) / 2 if (bb > 0 and ba > 0) else (bb or ba)
        try:
            tid = json.loads(m.get("clobTokenIds"))[0]
        except Exception:
            tid = None
        ask_usd, bid_usd, live_bb, live_ba = book_depth(tid) if tid else (0.0, 0.0, None, None)
        # prefer the live CLOB book's bid/ask; gamma's copy can be a 5-min CDN cache.
        if live_bb is not None and live_ba is not None:
            bb, ba = live_bb, live_ba
            mid = (bb + ba) / 2
        # record = [mid, bid, ask, $-buyable-near-ask, $-sellable-near-bid, clob_token_id]
        # tid appended LAST so all existing consumers (analyzers, paper trader) keep working.
        rec = [round(mid, 3), bb, ba, ask_usd, bid_usd, tid]
        if "end in a draw" in ql:
            outs["draw"] = rec
        elif ql.startswith("will ") and " win" in ql:
            outs[q.split("Will ", 1)[1].split(" win")[0].strip()] = rec
    return outs or None


slug_teams = {}
def refresh_slugs():
    feed = get(DATA, {"limit": 1000}) or []
    for t in feed:
        base = re.sub(r"-more-markets$", "", (t.get("eventSlug") or t.get("slug") or ""))
        mm = re.match(r"(fifwc-[a-z]{3}-[a-z]{3}-\d{4}-\d{2}-\d{2})", base)
        if mm and mm.group(1) not in slug_teams:
            outs = poly_mids(mm.group(1))
            if outs:
                teams = [k for k in outs if k != "draw"]
                if len(teams) >= 2:
                    slug_teams[mm.group(1)] = teams


def fetch_wc26():
    """Second goal source: worldcup26.ir (free, no key). Returns [{home, away, score, live}].
    Bulletproof: [] on any error, so it can never crash the monitor loop."""
    try:
        d = get(WC26)
        games = d if isinstance(d, list) else ((d.get("data") or d.get("games") or []) if isinstance(d, dict) else [])
        out = []
        for g in games:
            h, a = g.get("home_team_name_en"), g.get("away_team_name_en")
            if not h or not a:
                continue
            out.append({"home": h, "away": a,
                        "score": f'{g.get("home_score")}-{g.get("away_score")}',
                        "live": g.get("time_elapsed") == "live"})
        return out
    except Exception:
        return []


_txj = {"jwt": None, "ts": 0}
_txfix = {"v": [], "ts": 0}


def _txodds_headers():
    if not TXODDS_TOKEN:
        return None
    if (not _txj["jwt"]) or (time.time() - _txj["ts"] > 1800):
        try:
            r = S.post(TXODDS_BASE + "/auth/guest/start", timeout=12)
            if r.status_code == 200:
                _txj["jwt"] = r.json().get("token"); _txj["ts"] = time.time()
        except Exception:
            return None
    return {"Authorization": f"Bearer {_txj['jwt']}", "X-Api-Token": TXODDS_TOKEN} if _txj["jwt"] else None


def txodds_fixtures():
    """Cached WC fixtures [{fid,t1,t2,home1}], refresh every 10 min. Bulletproof."""
    if _txfix["v"] and time.time() - _txfix["ts"] < 600:
        return _txfix["v"]
    h = _txodds_headers()
    if not h:
        return _txfix["v"]
    try:
        r = S.get(TXODDS_BASE + "/api/fixtures/snapshot", headers=h, params={"competitionId": 72}, timeout=20)
        if r.status_code == 200 and isinstance(r.json(), list):
            out = [{"fid": f.get("FixtureId"), "t1": f.get("Participant1"), "t2": f.get("Participant2"),
                    "home1": bool(f.get("Participant1IsHome"))} for f in r.json()]
            if out:
                _txfix["v"] = out; _txfix["ts"] = time.time()
    except Exception:
        pass
    return _txfix["v"]


# ── POLYMARKET WS BURST WATCHER (trigger #2, default log-only) ──────────────
# Spawns poly-ws-watch (Rust) for the live matches' tokens; it emits real-time
# book ticks and "burst" events (best bid +>=0.04 within 4s = stampede).
# Everything is logged to out/burst_events.jsonl for calibration. Bursts feed
# the trigger dict ONLY when BURST_TRIGGER=1 (off until discussed/calibrated).
WS_WATCH_BIN = os.path.join(os.path.dirname(os.path.dirname(HERE)), "target", "release", "poly-ws-watch")
BURST_LOG = os.path.join(OUT, "burst_events.jsonl")
BURST_TRIGGER = os.environ.get("BURST_TRIGGER", "0") == "1"
_tid2team = {}          # token_id(str) -> (fid, poly_label); refreshed by the main loop
_ws_state = {"proc": None, "tids": frozenset()}


def _ws_reader(proc):
    try:
        for raw in proc.stdout:
            line = raw.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            try:
                with open(BURST_LOG, "a") as f:
                    f.write(line + "\n")
            except Exception:
                pass
            if d.get("t") == "burst":
                info = _tid2team.get(str(d.get("tid")))
                print(f"*** BURST [poly-ws] {time.strftime('%H:%M:%S')} "
                      f"{info[1] if info else d.get('tid','?')[-8:]} {d.get('from')}->{d.get('to')} "
                      f"in {d.get('secs', 0):.1f}s (trigger={'ON' if BURST_TRIGGER else 'log-only'})")
                if BURST_TRIGGER and info and info[1] != "draw":
                    fid, team = info
                    with _txgoal_lock:
                        prev = _txgoal.get(fid)
                        if not (prev and d["ts"] - prev["ts"] < 120):
                            _txgoal[fid] = {"ts": d["ts"], "team": team, "src": "burst"}
    except Exception:
        pass


def _ws_manager():
    """Keeps one poly-ws-watch subprocess running on the CURRENT live tokens."""
    import subprocess
    while True:
        time.sleep(5)
        want = frozenset(_tid2team.keys())
        if want == _ws_state["tids"] and _ws_state["proc"] and _ws_state["proc"].poll() is None:
            continue
        if _ws_state["proc"] and _ws_state["proc"].poll() is None:
            _ws_state["proc"].kill()
        if not want or not os.path.exists(WS_WATCH_BIN):
            _ws_state.update(proc=None, tids=frozenset())
            continue
        try:
            p = subprocess.Popen([WS_WATCH_BIN, *sorted(want)], stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, text=True)
            _ws_state.update(proc=p, tids=want)
            threading.Thread(target=_ws_reader, args=(p,), daemon=True).start()
            print(f"poly-ws-watch spawned on {len(want)} tokens")
        except Exception:
            _ws_state.update(proc=None, tids=frozenset())


def txodds_probs(fid, home1):
    """Real-time de-margined 1X2 implied probs {home,draw,away}. Bulletproof: None on error."""
    h = _txodds_headers()
    if not h or not fid:
        return None
    try:
        r = S.get(f"{TXODDS_BASE}/api/odds/snapshot/{fid}", headers=h, timeout=15)
        if r.status_code != 200:
            return None
        for e in (r.json() or []):
            if e.get("SuperOddsType") == "1X2_PARTICIPANT_RESULT" and "Demargined" in (e.get("Bookmaker") or ""):
                names, pr = e.get("PriceNames") or [], e.get("Prices") or []
                m = {names[i]: (1000.0 / pr[i]) for i in range(min(len(names), len(pr))) if pr[i]}
                p1, dr, p2 = m.get("part1"), m.get("draw"), m.get("part2")
                if p1 is None or p2 is None:
                    return None
                home, away = (p1, p2) if home1 else (p2, p1)
                return {"home": round(home, 3), "draw": round(dr or 0, 3), "away": round(away, 3), "src": "snap"}
    except Exception:
        return None
    return None


# ── TxODDS REAL-TIME SSE STREAM ──────────────────────────────────────────────
# The snapshot endpoint above is a 5-min cache and is often empty, so it misses
# the instant goal-jump. This background thread consumes the SSE odds stream and
# keeps an in-memory {FixtureId -> freshest de-margined full-match 1X2 probs}.
# The main loop reads the streamed value first and only falls back to the
# snapshot when the stream has nothing fresh. Bulletproof: a stream drop just
# triggers a reconnect; it can never crash the monitor loop.
TXSTREAM_STALE = 150.0          # streamed value older than this -> treat as missing
_txstream = {}                  # fid(int) -> {"p1","draw","p2","ts","inrunning"}
_txstream_lock = threading.Lock()
_txstream_status = {"connected": False, "last_msg": 0.0, "msgs": 0}

# Raw-log the TxLINE odds stream for WC fixtures (demargined lines + shock events)
# so the observatory can replay a dense odds lane; _txstream only keeps the latest
# value in memory and goal_latency.jsonl samples it at POLL cadence.
TX_ODDS_RAW = os.path.join(OUT, "tx_odds_raw.jsonl")


def _odds_log(rec):
    try:
        with open(TX_ODDS_RAW, "a") as f:
            f.write(json.dumps(rec) + "\n")
    except Exception:
        pass



def _sse_lines(resp):
    """Real-time SSE line iterator. iter_lines() buffers sparse streams for minutes
    (512-byte chunks) and chunk_size=1 is too slow for high-volume streams (per-byte
    decode). iter_content(None) is socket-paced; we assemble lines ourselves."""
    buf = b""
    for chunk in resp.iter_content(chunk_size=None):
        if not chunk:
            continue
        buf += chunk
        while b"\n" in buf:
            raw, buf = buf.split(b"\n", 1)
            yield raw.decode("utf-8", "replace").rstrip("\r")


_rawlast = {}   # (fid, bookmaker_id) -> {"p1": implied, "p2": implied}
_SHOCK_JUMP = 0.10          # implied-prob jump on one side that flags a goal-grade shock
_SHOCK_DEBOUNCE = 120.0     # at most one shock trigger per fixture per this many secs


def _raw_shock_update(fid, bookmaker_id, names, prices, ts_server):
    """Raw (non-demargined) 1X2 line moved: if either side jumped >= _SHOCK_JUMP
    implied, register a goal-grade trigger in _txgoal with the side that ROSE.
    Books reprice within seconds of a goal (suspension -> re-open), well before
    the stabilized line. Returns the side (1/2) on shock, else None."""
    m = {names[i]: (1000.0 / prices[i]) for i in range(min(len(names), len(prices))) if prices[i]}
    p1, p2 = m.get("part1"), m.get("part2")
    if p1 is None or p2 is None:
        return None
    key = (fid, bookmaker_id)
    last = _rawlast.get(key)
    _rawlast[key] = {"p1": p1, "p2": p2}
    if not last:
        return None
    side = None
    if p1 - last["p1"] >= _SHOCK_JUMP:
        side = 1
    elif p2 - last["p2"] >= _SHOCK_JUMP:
        side = 2
    if side is None:
        return None
    with _txgoal_lock:
        prev = _txgoal.get(fid)
        if prev and ts_server - prev["ts"] < _SHOCK_DEBOUNCE:
            return None
        _txgoal[fid] = {"ts": ts_server, "part": side, "src": "shock"}
    print(f"*** SHOCK [raw-book] {time.strftime('%H:%M:%S')} fid={fid} side={side} "
          f"bk={bookmaker_id} jump p1 {last['p1']:.2f}->{p1:.2f} p2 {last['p2']:.2f}->{p2:.2f}")
    _odds_log({"t": "shock", "ts": ts_server, "fid": fid, "side": side, "bk": bookmaker_id,
               "p1": p1, "p2": p2, "prev_p1": last["p1"], "prev_p2": last["p2"]})
    return side


def _txodds_stream_consumer():
    """Long-lived SSE consumer. Reconnects forever; updates _txstream under lock.
    Filters to full-match (MarketPeriod is None) de-margined 1X2 messages."""
    backoff = 3.0
    while True:
        h = _txodds_headers()
        if not h:
            time.sleep(10)
            continue
        h = dict(h); h.update({"Accept": "text/event-stream", "Cache-Control": "no-cache"})
        try:
            r = S.get(TXODDS_BASE + "/api/odds/stream", headers=h, stream=True, timeout=(10, 90))
            if r.status_code != 200:
                _txstream_status["connected"] = False
                time.sleep(backoff); backoff = min(backoff * 2, 60); continue
            _txstream_status["connected"] = True; backoff = 3.0
            for line in _sse_lines(r):
                if not line or not line.startswith("data:"):
                    continue
                try:
                    d = json.loads(line[5:].strip())
                except Exception:
                    continue
                if (d.get("SuperOddsType") != "1X2_PARTICIPANT_RESULT"
                        or d.get("MarketPeriod") is not None):   # full-match 1X2 only
                    continue
                if "Demargined" not in (d.get("Bookmaker") or ""):
                    # raw bookmaker line: goal-grade shock detection (fast trigger #1)
                    fid_raw = d.get("FixtureId")
                    wc = {x["fid"] for x in _txfix["v"]}
                    if fid_raw is not None and (not wc or fid_raw in wc):
                        try:
                            ts_srv = (d.get("Ts") or 0) / 1000.0
                            _raw_shock_update(fid_raw, d.get("BookmakerId"),
                                              d.get("PriceNames") or [], d.get("Prices") or [],
                                              ts_srv if ts_srv > 1e9 else time.time())
                        except Exception:
                            pass
                    continue
                names, pr = d.get("PriceNames") or [], d.get("Prices") or []
                m = {names[i]: (1000.0 / pr[i]) for i in range(min(len(names), len(pr))) if pr[i]}
                p1, dr, p2 = m.get("part1"), m.get("draw"), m.get("part2")
                if p1 is None or p2 is None:
                    continue
                fid = d.get("FixtureId")
                with _txstream_lock:
                    _txstream[fid] = {"p1": p1, "draw": dr or 0.0, "p2": p2,
                                      "ts": time.time(), "inrunning": bool(d.get("InRunning"))}
                _txstream_status["last_msg"] = time.time(); _txstream_status["msgs"] += 1
                wc = {x["fid"] for x in _txfix["v"]}
                if not wc or fid in wc:
                    ts_srv = (d.get("Ts") or 0) / 1000.0
                    _odds_log({"t": "demargined", "ts": ts_srv if ts_srv > 1e9 else time.time(),
                               "fid": fid, "p1": round(p1, 4), "draw": round(dr or 0.0, 4),
                               "p2": round(p2, 4), "inrunning": bool(d.get("InRunning"))})
            # iterator ended cleanly -> server closed; reconnect
            _txstream_status["connected"] = False
        except Exception:
            _txstream_status["connected"] = False
            time.sleep(backoff); backoff = min(backoff * 2, 60)


# ── TxODDS SCORES SSE STREAM (third, fastest goal trigger) ──────────────────
# /api/scores/stream pushes per-fixture action records (goal/red card/etc) in
# real time — earlier than ESPN's score feed and than the stabilized odds line.
# Until we've captured live goal messages the exact schema is uncertain, so we
# raw-log every WC-fixture message to out/tx_scores_raw.jsonl and flag any
# action containing "goal". Bulletproof: reconnects forever, never crashes.
TX_SCORES_RAW = os.path.join(OUT, "tx_scores_raw.jsonl")
_txgoal = {}            # fid(int) -> ts (unix secs) of latest goal-type action
_txgoal_lock = threading.Lock()


def _txodds_scores_consumer():
    backoff = 3.0
    while True:
        h = _txodds_headers()
        if not h:
            time.sleep(10)
            continue
        h = dict(h); h.update({"Accept": "text/event-stream", "Cache-Control": "no-cache"})
        try:
            r = S.get(TXODDS_BASE + "/api/scores/stream", headers=h, stream=True, timeout=(10, 90))
            if r.status_code != 200:
                time.sleep(backoff); backoff = min(backoff * 2, 60); continue
            backoff = 3.0
            for line in _sse_lines(r):
                if not line or not line.startswith("data:"):
                    continue
                try:
                    d = json.loads(line[5:].strip())
                except Exception:
                    continue
                fid = d.get("FixtureId")
                if fid is None:
                    continue  # heartbeat {"Ts": ...}
                wc_fids = {x["fid"] for x in _txfix["v"]}
                if wc_fids and fid not in wc_fids:
                    continue
                try:
                    with open(TX_SCORES_RAW, "a") as f:
                        f.write(json.dumps(d) + "\n")
                except Exception:
                    pass
                action = str(d.get("Action") or "").lower()
                # exact match: substring matching caught "goal_kick" (live 2026-07-05).
                # Unconfirmed goals (Confirmed:false / VAR) still trigger deliberately —
                # the trader's fair-gap gate handles false ones (proven on the disallowed
                # Norway goal); requiring Confirmed would add TxODDS's review latency.
                if action in ("goal", "own_goal", "penalty_goal"):
                    # store the action's SERVER timestamp, not arrival time: fresh SSE
                    # connections replay recent events, and a replayed 4-min-old goal
                    # triggered a stale entry on 2026-07-05. Server time lets the
                    # trader ignore anything that isn't genuinely fresh.
                    ts_server = (d.get("Ts") or 0) / 1000.0
                    with _txgoal_lock:
                        _txgoal[fid] = {"ts": ts_server if ts_server > 1e9 else time.time(),
                                        "part": d.get("Participant")}
                    print(f"*** GOAL [txodds-scores] {time.strftime('%H:%M:%S')} fid={fid} action={action}")
        except Exception:
            time.sleep(backoff); backoff = min(backoff * 2, 60)


def tx_goal_info(fid):
    """{'ts', 'part'} of the latest TxODDS goal-type action for fid, or None."""
    if not fid:
        return None
    with _txgoal_lock:
        return _txgoal.get(fid)


def txodds_stream_probs(fid, home1):
    """Freshest streamed de-margined 1X2 probs {home,draw,away,src} for fid, or
    None if the stream has no fresh value (caller then falls back to snapshot)."""
    if not fid:
        return None
    with _txstream_lock:
        v = _txstream.get(fid)
    if not v or (time.time() - v["ts"] > TXSTREAM_STALE):
        return None
    p1, p2 = v["p1"], v["p2"]
    home, away = (p1, p2) if home1 else (p2, p1)
    return {"home": round(home, 3), "draw": round(v["draw"], 3), "away": round(away, 3), "src": "stream"}


last_score = {}
last_score_wc26 = {}
last_slug_refresh = 0.0
deadline = time.time() + hours * 3600
if TXODDS_TOKEN:
    threading.Thread(target=_txodds_stream_consumer, daemon=True).start()
    threading.Thread(target=_txodds_scores_consumer, daemon=True).start()
    threading.Thread(target=_ws_manager, daemon=True).start()
    print("TxLINE SSE odds + scores stream consumers started (background threads)")
print(f"goal-latency monitor started (TxLINE + ESPN + worldcup26.ir), poll={POLL}s, {hours}h -> {LOG}")
while time.time() < deadline:
    now = time.time()
    if now - last_slug_refresh > 30:
        refresh_slugs(); last_slug_refresh = now
    sb = get(ESPN) or {}
    wc26_games = fetch_wc26()
    tx_fixtures = txodds_fixtures()
    for e in sb.get("events", []):
        if (e.get("status") or {}).get("type", {}).get("state") != "in":
            continue
        comp = (e.get("competitions") or [{}])[0]
        teams = [c.get("team", {}).get("displayName") for c in comp.get("competitors", [])]
        score = {c.get("team", {}).get("displayName"): c.get("score") for c in comp.get("competitors", [])}
        clock = (e.get("status") or {}).get("displayClock")
        name = " vs ".join(teams)
        # find poly slug for this match
        slug = next((s for s, ts in slug_teams.items()
                     if all(any(tmatch(t, p) for p in teams) for t in ts)), None)
        mids = poly_mids(slug) if slug else None
        sc_str = "-".join(str(score.get(t, "?")) for t in teams)
        wc = next((w for w in wc26_games
                   if any(tmatch(t, w["home"]) for t in teams) and any(tmatch(t, w["away"]) for t in teams)), None)
        sc_wc26 = wc["score"] if wc else None
        txf = next((x for x in tx_fixtures
                    if any(tmatch(t, x["t1"]) for t in teams) and any(tmatch(t, x["t2"]) for t in teams)), None)
        tx = None
        if txf:
            tx = txodds_stream_probs(txf["fid"], txf["home1"])  # real-time SSE (preferred)
            if tx is None:
                tx = txodds_probs(txf["fid"], txf["home1"])     # snapshot fallback
        goal = last_score.get(name) is not None and last_score.get(name) != sc_str
        goal_wc26 = (last_score_wc26.get(name) is not None and sc_wc26 is not None
                     and last_score_wc26.get(name) != sc_wc26)
        # map each poly outcome -> its txodds prob, so the paper trader needs no home/away logic
        tx_by_team = None
        if tx and mids:
            try:
                ha = {c.get("team", {}).get("displayName"): c.get("homeAway") for c in comp.get("competitors", [])}
                tx_by_team = {}
                for k in mids:
                    if k == "draw":
                        tx_by_team["draw"] = tx.get("draw"); continue
                    espn_name = next((nm for nm in ha if nm and tmatch(nm, k)), None)
                    side = ha.get(espn_name)
                    if side in ("home", "away"):
                        tx_by_team[k] = tx.get(side)
            except Exception:
                tx_by_team = None
        rec = {"ts": round(now, 1), "match": name, "clock": clock, "score": sc_str,
               "score_wc26": sc_wc26, "txodds": tx, "tx_by_team": tx_by_team, "poly": mids,
               "slug": slug, "goal_detected": goal, "goal_detected_wc26": goal_wc26,
               "tx_goal_ts": None, "tx_goal_team": None}
        if txf and mids:
            for k, v in mids.items():
                if len(v) > 5 and v[5]:
                    _tid2team[str(v[5])] = (txf["fid"], k)
        tg = tx_goal_info(txf["fid"]) if txf else None
        if tg:
            rec["tx_goal_ts"] = tg["ts"]
            # map TxODDS participant (1/2) to that participant's name so the
            # trader can fast-path with the scorer already known.
            if tg.get("team"):
                rec["tx_goal_team"] = tg["team"]
            elif tg.get("part") in (1, 2):
                rec["tx_goal_team"] = txf["t1"] if tg["part"] == 1 else txf["t2"]
        with open(LOG, "a") as f:
            f.write(json.dumps(rec) + "\n")
        if goal:
            print(f"*** GOAL [ESPN] {time.strftime('%H:%M:%S')} {name} -> {sc_str} clock={clock}")
        if goal_wc26:
            print(f"*** GOAL [wc26] {time.strftime('%H:%M:%S')} {name} -> {sc_wc26}")
        last_score[name] = sc_str
        last_score_wc26[name] = sc_wc26
    time.sleep(POLL)
print("goal-latency monitor done")
