"""Observatory normalizer: fuse all recorded feeds into one per-match timeline.

Sources (all already produced by the running monitors — this module only reads):
  research/leaderboard_study/out/goal_latency.jsonl   ESPN+wc26 score/clock, Polymarket
                                                      books per outcome, TxLINE demargined
                                                      probs (4-5s samples)
  research/leaderboard_study/out/tx_scores_raw.jsonl  TxLINE /api/scores/stream actions
                                                      (goal/var/card/... with server Ts ms)
  research/leaderboard_study/out/tx_odds_raw.jsonl    TxLINE /api/odds/stream raw log
                                                      (demargined lines + sharp-book shocks)
  research/leaderboard_study/out/burst_events.jsonl   Polymarket WS real-time ticks + bursts
  research/leaderboard_study/inplay_live_events.csv   live bot trades/decisions
  inplay-bot/inplay_events.csv                        paper bot trades

Unified event: one JSON object per line, sorted by t (unix seconds float):
  {"t", "src": poly|txline|espn|wc26|polyws|bot, "kind": book|odds|action|shock|score|
   tick|burst|trade|decision, ...kind-specific fields}
Outcome labels are canonicalized to the Polymarket market labels (e.g. "Norway",
"France", "draw") so every lane keys the same way.

Usage:
  python3 normalize.py index            # scan sources -> data/index.json (match list)
  python3 normalize.py build <id|all>   # -> data/<id>.jsonl + data/<id>.json (meta+moments)
"""
import csv
import json
import os
import re
import statistics
import sys
import time
import urllib.parse
import urllib.request

OBS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(OBS)
STUDY = os.path.join(ROOT, "research", "leaderboard_study")
OUT = os.path.join(STUDY, "out")
DATA = os.path.join(OBS, "data")
# source paths overridable via env (testing, alternate deployments)
GL = os.environ.get("OBS_GL", os.path.join(OUT, "goal_latency.jsonl"))
TX_SCORES = os.environ.get("OBS_TX_SCORES", os.path.join(OUT, "tx_scores_raw.jsonl"))
TX_ODDS = os.environ.get("OBS_TX_ODDS", os.path.join(OUT, "tx_odds_raw.jsonl"))
BURSTS = os.environ.get("OBS_BURSTS", os.path.join(OUT, "burst_events.jsonl"))
BOT_LIVE = os.environ.get("OBS_BOT_LIVE", os.path.join(STUDY, "inplay_live_events.csv"))
BOT_PAPER = os.environ.get("OBS_BOT_PAPER", os.path.join(ROOT, "inplay-bot", "inplay_events.csv"))
WALLETS = os.environ.get("OBS_WALLETS", os.path.join(OUT, "wallet_fills.jsonl"))
JUPITER = os.environ.get("OBS_JUPITER", os.path.join(OUT, "jupiter_books.jsonl"))
FIXTURES_CACHE = os.path.join(DATA, "fixtures.json")
TXODDS_BASE = "https://txline.txodds.com"

# ── team-name matching (same rules as the recorder) ─────────────────────────
ASCII_FOLD = str.maketrans({
    "ü": "u", "Ü": "u", "ç": "c", "Ç": "c", "ñ": "n", "Ñ": "n",
    "á": "a", "à": "a", "â": "a", "ä": "a", "ã": "a",
    "é": "e", "è": "e", "ê": "e", "ë": "e",
    "í": "i", "ì": "i", "î": "i", "ï": "i",
    "ó": "o", "ò": "o", "ô": "o", "ö": "o", "õ": "o",
    "ú": "u", "ù": "u", "û": "u", "ý": "y", "ÿ": "y",
    "ß": "s", "ø": "o", "å": "a", "æ": "a",
})
NAME_ALIASES = {"united states": "usa", "turkiye": "turkey", "cote d ivoire": "ivory coast"}


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


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")


def iter_jsonl(path):
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except Exception:
                continue


# ── TxLINE fixtures (fid -> team names), fetched once and cached ────────────
def fetch_fixtures():
    try:
        tok = os.environ.get("TXLINE_API_TOKEN", "").strip()
        if not tok:
            tok = open(os.path.join(STUDY, ".txodds_token")).read().strip()
        auth = urllib.request.Request(TXODDS_BASE + "/auth/guest/start", data=b"",
                                      headers={"User-Agent": "txline-observatory/1.0"}, method="POST")
        with urllib.request.urlopen(auth, timeout=12) as response:
            jwt = json.load(response).get("token")
        h = {"Authorization": f"Bearer {jwt}", "X-Api-Token": tok}
        url = TXODDS_BASE + "/api/fixtures/snapshot?" + urllib.parse.urlencode({"competitionId": 72})
        req = urllib.request.Request(url, headers={**h, "User-Agent": "txline-observatory/1.0"})
        with urllib.request.urlopen(req, timeout=20) as response:
            rows = json.load(response)
        fx = [{"fid": f.get("FixtureId"), "t1": f.get("Participant1"), "t2": f.get("Participant2"),
               "home1": bool(f.get("Participant1IsHome")), "start": (f.get("StartTime") or 0) / 1000.0}
              for f in rows if f.get("FixtureId")]
        if fx:
            os.makedirs(DATA, exist_ok=True)
            with open(FIXTURES_CACHE, "w") as f:
                json.dump(fx, f)
        return fx
    except Exception as e:
        print(f"fixtures fetch failed ({e}); using cache", file=sys.stderr)
        try:
            return json.load(open(FIXTURES_CACHE))
        except Exception:
            return []


def find_fixture(fixtures, teams, t0):
    """fid whose participants word-match both teams and whose kickoff is near t0.
    Only works for fixtures still in the snapshot (upcoming); historical fids are
    inferred from the scores stream by scan_tx_fixtures/assign_fids below."""
    best = None
    for fx in fixtures:
        if not (fx["t1"] and fx["t2"]):
            continue
        names = [fx["t1"], fx["t2"]]
        if all(any(tmatch(t, n) for n in names) for t in teams):
            gap = abs((fx.get("start") or 0) - t0)
            if gap < 6 * 3600 and (best is None or gap < best[0]):
                best = (gap, fx)
    return best[1] if best else None


GOAL_ACTIONS = ("goal", "own_goal", "penalty_goal")


def scan_tx_fixtures():
    """One pass over tx_scores_raw: fid -> {start, p1id, p2id, home1, goals:[(ts, part)]}.
    Goals deduped per participant within 120s (the stream repeats/amends actions)."""
    fids = {}
    for d in iter_jsonl(TX_SCORES):
        fid = d.get("FixtureId")
        if fid is None or d.get("CompetitionId") not in (None, 72):
            continue
        fx = fids.setdefault(fid, {"start": (d.get("StartTime") or 0) / 1000.0,
                                   "p1id": d.get("Participant1Id"), "p2id": d.get("Participant2Id"),
                                   "home1": bool(d.get("Participant1IsHome")), "goals": []})
        if str(d.get("Action") or "").lower() in GOAL_ACTIONS:
            ts, part = (d.get("Ts") or 0) / 1000.0, d.get("Participant")
            if not any(p == part and abs(ts - t) < 120 for t, p in fx["goals"]):
                fx["goals"].append((ts, part))
    return fids


def assign_fids(index, fids):
    """Attach fid/tx_teams to each indexed match. Primary evidence: kickoff-time
    proximity; discriminator for simultaneous games: TxLINE goal timestamps landing
    near that segment's ESPN score-change times. Participant->team-name resolution:
    each matched (goal, score-change) pair votes for participant==the team whose
    score incremented; PID->name propagates to goal-less fixtures."""
    for m in index:
        cands = [(fid, fx) for fid, fx in fids.items()
                 if fx["start"] and abs(fx["start"] - m["t0"]) < 3 * 3600]
        best, best_score = None, -1
        for fid, fx in cands:
            hits = sum(1 for gts, _ in fx["goals"]
                       for ct, _ in m["score_changes"] if abs(gts - ct) < 300)
            score = hits * 10 + (1 if len(fx["goals"]) == len(m["score_changes"]) else 0) \
                - abs(fx["start"] - m["t0"]) / 3600.0
            if score > best_score:
                best, best_score = (fid, fx), score
        if not best:
            continue
        fid, fx = best
        # participant -> team-name votes from matched goal/score-change pairs
        votes = {1: {}, 2: {}}
        for gts, part in fx["goals"]:
            if part not in (1, 2):
                continue
            hit = min((c for c in m["score_changes"] if abs(gts - c[0]) < 300),
                      key=lambda c: abs(gts - c[0]), default=None)
            if hit and hit[1] in (0, 1):
                nm = m["teams"][hit[1]]
                votes[part][nm] = votes[part].get(nm, 0) + 1
        def top(p):
            return max(votes[p], key=votes[p].get) if votes[p] else None
        t1, t2 = top(1), top(2)
        if t1 and not t2:
            t2 = next((t for t in m["teams"] if t != t1), None)
        if t2 and not t1:
            t1 = next((t for t in m["teams"] if t != t2), None)
        m["fid"] = fid
        m["home1"] = fx["home1"]
        m["tx_teams"] = [t1, t2] if (t1 and t2) else None
        m["_pids"] = (fx["p1id"], fx["p2id"])
    # PID->name propagation for fixtures resolved elsewhere (covers 0-0 games)
    pid_name = {}
    for m in index:
        if m.get("tx_teams") and m.get("_pids"):
            for pid, nm in zip(m["_pids"], m["tx_teams"]):
                if pid and nm:
                    pid_name[pid] = nm
    for m in index:
        if m.get("fid") and not m.get("tx_teams") and m.get("_pids"):
            t1, t2 = (pid_name.get(p) for p in m["_pids"])
            if t1 and not t2:
                t2 = next((t for t in m["teams"] if not tmatch(t, t1)), None)
            if t2 and not t1:
                t1 = next((t for t in m["teams"] if not tmatch(t, t2)), None)
            if t1 and t2:
                m["tx_teams"] = [t1, t2]
    for m in index:
        m.pop("_pids", None)


# ── index: segment goal_latency.jsonl into matches ───────────────────────────
def _score_inc(prev, cur):
    """Which side (0/1) incremented between 'a-b' score strings; None if unclear."""
    try:
        pa = [int(x) for x in (prev or "").split("-")]
        ca = [int(x) for x in (cur or "").split("-")]
    except ValueError:
        return None
    if len(pa) != 2 or len(ca) != 2:
        return None
    d = [ca[0] - pa[0], ca[1] - pa[1]]
    return d.index(1) if sorted(d) == [0, 1] else None


def build_index():
    segs = {}   # (match, seg#) -> {t0,t1,labels,tids,n,score_changes,last_score}
    seg_no = {}
    last_t = {}
    for r in iter_jsonl(GL):
        m, t = r.get("match"), r.get("ts")
        if not m or not t:
            continue
        if m in last_t and t - last_t[m] > 6 * 3600:
            seg_no[m] = seg_no.get(m, 0) + 1
        last_t[m] = t
        key = (m, seg_no.get(m, 0))
        s = segs.setdefault(key, {"t0": t, "t1": t, "labels": set(), "tids": set(),
                                  "n": 0, "score_changes": [], "last_score": None,
                                  "slug": None})
        s["t1"] = t
        s["n"] += 1
        if r.get("slug"):
            s["slug"] = r["slug"]
        sc = r.get("score")
        if sc and s["last_score"] is not None and sc != s["last_score"]:
            j = _score_inc(s["last_score"], sc)
            if j is not None:
                s["score_changes"].append((round(t, 1), j))
        s["last_score"] = sc or s["last_score"]
        for lab, rec in (r.get("poly") or {}).items():
            s["labels"].add(lab)
            if len(rec) > 5 and rec[5]:
                s["tids"].add(str(rec[5]))
    fixtures = fetch_fixtures()
    index = []
    for (m, i), s in sorted(segs.items(), key=lambda kv: kv[1]["t0"]):
        if s["n"] < 20:      # skip fragments (pre-match blips)
            continue
        teams = [t.strip() for t in m.split(" vs ")]
        fx = find_fixture(fixtures, teams, s["t0"])
        day = time.strftime("%Y-%m-%d", time.localtime(s["t0"]))
        mid = f"{slugify(m)}-{day}" + (f"-{i}" if i else "")
        index.append({
            "id": mid, "match": m, "teams": teams, "date": day, "slug": s["slug"],
            "labels": sorted(s["labels"]), "t0": round(s["t0"], 1), "t1": round(s["t1"], 1),
            "rows": s["n"], "fid": fx["fid"] if fx else None,
            "home1": fx.get("home1") if fx else None,
            "tx_teams": [fx["t1"], fx["t2"]] if fx else None,
            "score_changes": s["score_changes"],
            "tids": sorted(s["tids"]),
        })
    assign_fids([m for m in index if not m["fid"]], scan_tx_fixtures())
    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, "index.json"), "w") as f:
        json.dump(index, f, indent=1)
    n_fid = sum(1 for m in index if m.get("fid"))
    print(f"indexed {len(index)} matches ({n_fid} with TxLINE fid) -> data/index.json")
    return index


def load_index():
    p = os.path.join(DATA, "index.json")
    return json.load(open(p)) if os.path.exists(p) else build_index()


# ── adapters: each yields unified events for one match ──────────────────────
def participant_label(part, meta):
    """TxLINE Participant 1/2 -> canonical poly label (or None)."""
    if part not in (1, 2) or not meta.get("tx_teams"):
        return None
    name = meta["tx_teams"][part - 1]
    return next((l for l in meta["labels"] if l != "draw" and tmatch(l, name)), None)


def gl_events(meta):
    m, t0, t1 = meta["match"], meta["t0"] - 1, meta["t1"] + 1
    prev_score, prev_wc26, prev_probs = None, None, None
    for r in iter_jsonl(GL):
        if r.get("match") != m or not (t0 <= (r.get("ts") or 0) <= t1):
            continue
        t = r["ts"]
        poly = r.get("poly") or {}
        if poly:
            yield {"t": t, "src": "poly", "kind": "book", "clock": r.get("clock"),
                   "score": r.get("score"),
                   "o": {k: v[:5] for k, v in poly.items()}}
        probs = r.get("tx_by_team")
        if not probs and r.get("txodds") and meta.get("home1") is not None:
            tx = r["txodds"]
            nb = {l: None for l in meta["labels"]}
            nb["draw"] = tx.get("draw")
            probs = nb
        if probs and probs != prev_probs:
            yield {"t": t, "src": "txline", "kind": "odds",
                   "probs": {k: v for k, v in probs.items() if v is not None}}
            prev_probs = probs
        sc = r.get("score")
        if sc and prev_score is not None and sc != prev_score:
            yield {"t": t, "src": "espn", "kind": "score", "score": sc, "clock": r.get("clock")}
        prev_score = sc or prev_score
        scw = r.get("score_wc26")
        if scw and "null" not in str(scw):
            if prev_wc26 is not None and scw != prev_wc26:
                yield {"t": t, "src": "wc26", "kind": "score", "score": scw}
            prev_wc26 = scw


def tx_score_events(meta):
    fid, t0, t1 = meta.get("fid"), meta["t0"] - 300, meta["t1"] + 600
    if not fid:
        return
    totals = {}          # participant -> running Total.Goals
    for d in iter_jsonl(TX_SCORES):
        if d.get("FixtureId") != fid:
            continue
        ts = (d.get("Ts") or 0) / 1000.0
        if not (t0 <= ts <= t1):
            continue
        action = str(d.get("Action") or "").lower()
        if action in ("connected", "disconnected", "venue", "jersey", "weather", "lineups"):
            continue
        cs = (d.get("Clock") or {}).get("Seconds")
        team = participant_label(d.get("Participant"), meta)
        goals = {}
        for pi in (1, 2):
            g = (((d.get("Score") or {}).get(f"Participant{pi}") or {}).get("Total") or {}).get("Goals")
            if g is not None:
                lab = participant_label(pi, meta)
                if lab:
                    goals[lab] = g
                # disallowed-goal detection: a Total.Goals decrease vs running max
                if g < totals.get(pi, 0):
                    yield {"t": ts, "src": "txline", "kind": "action", "action": "goal_disallowed",
                           "team": participant_label(pi, meta), "cs": cs, "confirmed": True}
                totals[pi] = max(totals.get(pi, 0), g) if g >= totals.get(pi, 0) else g
        ev = {"t": ts, "src": "txline", "kind": "action", "action": action,
              "team": team, "cs": cs, "confirmed": bool(d.get("Confirmed")),
              "seq": d.get("Seq"), "part": d.get("Participant")}
        if goals:
            ev["goals"] = goals
        yield ev


def tx_odds_events(meta):
    fid, t0, t1 = meta.get("fid"), meta["t0"] - 300, meta["t1"] + 600
    if not fid:
        return
    l1, l2 = participant_label(1, meta), participant_label(2, meta)
    for d in iter_jsonl(TX_ODDS):
        if d.get("fid") != fid or not (t0 <= (d.get("ts") or 0) <= t1):
            continue
        if d.get("t") == "shock":
            yield {"t": d["ts"], "src": "txline", "kind": "shock",
                   "team": l1 if d.get("side") == 1 else l2,
                   "jump": round(max(d.get("p1", 0) - d.get("prev_p1", 0),
                                     d.get("p2", 0) - d.get("prev_p2", 0)), 3)}
        elif d.get("t") == "demargined":
            probs = {}
            if l1:
                probs[l1] = d.get("p1")
            if l2:
                probs[l2] = d.get("p2")
            probs["draw"] = d.get("draw")
            yield {"t": d["ts"], "src": "txline", "kind": "odds", "probs": probs, "stream": True}


def burst_tick_events(meta):
    tids = {}
    # tid -> label, from the index (tids) + gl rows already carry the mapping order
    for lab_tid in meta.get("tid_map", {}).items():
        tids[lab_tid[0]] = lab_tid[1]
    tid2lab = meta.get("tid_map") or {}
    if not tid2lab:
        return
    t0, t1 = meta["t0"] - 60, meta["t1"] + 600
    for d in iter_jsonl(BURSTS):
        tid = str(d.get("tid") or "")
        if tid not in tid2lab or not (t0 <= (d.get("ts") or 0) <= t1):
            continue
        if d.get("t") == "tick":
            yield {"t": d["ts"], "src": "polyws", "kind": "tick", "team": tid2lab[tid],
                   "bb": d.get("bb"), "ba": d.get("ba")}
        elif d.get("t") == "burst":
            yield {"t": d["ts"], "src": "polyws", "kind": "burst", "team": tid2lab[tid],
                   "from": d.get("from"), "to": d.get("to"), "secs": d.get("secs")}


def bot_events(meta):
    m, t0, t1 = meta["match"], meta["t0"] - 60, meta["t1"] + 600
    for path, tag in ((BOT_LIVE, "live"), (BOT_PAPER, "paper")):
        if not os.path.exists(path):
            continue
        with open(path) as f:
            for row in csv.DictReader(f):
                try:
                    ts = float(row.get("ts") or 0)
                except ValueError:
                    continue
                if not (t0 <= ts <= t1) or (row.get("match") or "") != m:
                    continue
                act = (row.get("event") or "").upper()
                team = row.get("team") or row.get("label")
                fair = row.get("fair") or row.get("sharp_fair")
                size = row.get("notional") or row.get("size_usd")
                pnl = row.get("pnl_usd") or row.get("pnl")
                ev = {"t": ts, "src": "bot", "kind": "decision" if act == "SKIP" else "trade",
                      "action": act, "team": team, "mode": tag,
                      "price": _f(row.get("price")), "fair": _f(fair), "size": _f(size),
                      "pnl": _f(pnl), "reason": row.get("reason"), "clock": row.get("clock")}
                yield ev


def _f(x):
    try:
        return float(x) if x not in (None, "") else None
    except ValueError:
        return None


def jupiter_events(meta):
    """Jupiter Predict (Solana-routed) quotes for this match, joined by slug."""
    slug = meta.get("slug")
    if not slug:
        return
    t0, t1 = meta["t0"] - 300, meta["t1"] + 600
    for d in iter_jsonl(JUPITER):
        if d.get("slug") != slug or not (t0 <= (d.get("ts") or 0) <= t1):
            continue
        lab = d.get("label") or ""
        team = "draw" if lab.lower() == "draw" else \
            next((l for l in meta["labels"] if l != "draw" and tmatch(l, lab)), None)
        if not team:
            continue
        yield {"t": d["ts"], "src": "jupiter", "kind": "jbook", "team": team,
               "bb": d.get("bb"), "ba": d.get("ba")}


def whale_events(meta):
    """Named-wallet fills on this match's tokens (recorded by wallet_watch.py).
    Joined by clob token id -> outcome label; t is the on-chain fill timestamp."""
    tid_map = meta.get("tid_map") or {}
    if not tid_map:
        return
    t0, t1 = meta["t0"] - 300, meta["t1"] + 600
    for d in iter_jsonl(WALLETS):
        tid = str(d.get("asset") or "")
        ts = d.get("timestamp") or 0
        if tid not in tid_map or not (t0 <= ts <= t1):
            continue
        yield {"t": float(ts), "src": "whale", "kind": "fill", "who": d.get("who"),
               "team": tid_map[tid], "side": d.get("side"),
               "price": d.get("price"), "size": d.get("size")}


# ── moments: per goal, when did each feed know / when did the market move ───
def _bid(rec):
    """Best bid from a book record [mid,bid,ask,askUsd,bidUsd]; falls back to mid.
    Bids, not mids: late-game asks get pulled and the mid collapses while the
    market hasn't repriced (seen live: Norway 0.985 -> 'mid 0.665' on a hollow book)."""
    return rec[1] if rec[1] not in (None, 0) else rec[0]


def _score_from_goals(goals, meta):
    if not goals or len(meta.get("teams") or []) != 2:
        return None
    values = []
    for team in meta["teams"]:
        label = next((x for x in meta.get("labels") or [] if x != "draw" and tmatch(x, team)), team)
        values.append(goals.get(label, goals.get(team, 0)))
    return f"{values[0]}-{values[1]}"


def _score_before(score, benefit, meta):
    try:
        values = [int(x) for x in score.split("-")]
    except (AttributeError, ValueError):
        return None
    team = next((i for i, name in enumerate(meta.get("teams") or []) if tmatch(name, benefit)), None)
    if team is None or values[team] < 1:
        return None
    values[team] -= 1
    return f"{values[0]}-{values[1]}"


def _book_snapshot(books, target, max_gap=12):
    hit = min(books, key=lambda x: abs(x["t"] - target), default=None)
    if not hit or abs(hit["t"] - target) > max_gap:
        return None
    return {"dt": round(hit["t"] - target, 1),
            "outcomes": {label: {"bid": _bid(rec), "ask": rec[2] if len(rec) > 2 else None}
                         for label, rec in (hit.get("o") or {}).items() if rec}}


def compute_opportunities(events, meta):
    """Executable TxLINE-fair minus Polymarket-ask dislocation episodes.

    Both rows originate in the common recorder snapshot, so this deliberately
    ignores higher-frequency WS coverage that is absent from older matches.
    """
    books = {x["t"]: x for x in events if x["kind"] == "book"}
    odds = {x["t"]: x for x in events if x["kind"] == "odds" and not x.get("stream")}
    book_times = sorted(books)
    times = sorted(set(books) & set(odds))
    if len(times) < 20:
        return [], None

    changes, previous = 0, None
    for t in book_times:
        state = tuple((k, tuple((v or [])[:3])) for k, v in sorted((books[t].get("o") or {}).items()))
        if previous is not None and state != previous:
            changes += 1
        previous = state
    minutes = max((book_times[-1] - book_times[0]) / 60, 1)
    activity = round(changes / minutes, 3)

    open_episodes, out = {}, []
    for time_index, t in enumerate(times):
        book, probs = books[t], odds[t].get("probs") or {}
        for label, fair in probs.items():
            rec = (book.get("o") or {}).get(label)
            ask = rec[2] if rec and len(rec) > 2 else None
            if fair is None or ask is None or not (0.01 <= fair <= 0.99 and 0.01 <= ask <= 0.99):
                continue
            gap = fair - ask
            if label not in open_episodes and gap >= 0.05:
                prior_times = [pt for pt in book_times if t - 600 <= pt < t]
                prior_changes, prior_state = 0, None
                for pt in prior_times:
                    state = tuple((k, tuple((v or [])[:3]))
                                  for k, v in sorted((books[pt].get("o") or {}).items()))
                    if prior_state is not None and state != prior_state:
                        prior_changes += 1
                    prior_state = state
                prior_minutes = max((prior_times[-1] - prior_times[0]) / 60, 1) if prior_times else 1
                open_episodes[label] = {"t": t, "label": label, "tx_fair": fair,
                                        "poly_ask": ask, "initial_gap": gap, "max_gap": gap,
                                        "ask_depth": rec[3] if len(rec) > 3 else None,
                                        "pre_activity": round(prior_changes / prior_minutes, 3),
                                        "clock": book.get("clock"), "score": book.get("score"),
                                        "_time_index": time_index}
            elif label in open_episodes:
                ep = open_episodes[label]
                ep["max_gap"] = max(ep["max_gap"], gap)
                if gap < 0.02:
                    duration = t - ep["t"]
                    if duration >= 5:
                        entry_5s = next((pt for pt in book_times if pt >= ep["t"] + 5), None)
                        delayed_rec = (books[entry_5s].get("o") or {}).get(label) if entry_5s else None
                        delayed_ask = delayed_rec[2] if delayed_rec and len(delayed_rec) > 2 else None
                        exit_bid = _bid(rec)
                        clean = {k: v for k, v in ep.items() if not k.startswith("_")}
                        out.append({**clean, "duration": round(duration, 1),
                                    "initial_gap": round(ep["initial_gap"], 3),
                                    "max_gap": round(ep["max_gap"], 3),
                                    "exit_bid": exit_bid,
                                    "gross_per_share": round(exit_bid - ep["poly_ask"], 3),
                                    "entry_5s_ask": delayed_ask,
                                    "gross_5s_per_share": round(exit_bid - delayed_ask, 3)
                                    if delayed_ask is not None else None})
                    del open_episodes[label]
    return out, activity


def compute_event_insights(events):
    actions = [x for x in events if x["kind"] == "action"]
    unique = {}
    for ev in actions:
        key = (ev.get("action"), ev.get("team"), ev.get("cs"))
        if key not in unique or ev.get("confirmed"):
            unique[key] = ev
    rows = sorted(unique.values(), key=lambda x: x["t"])

    starts = [x for x in rows if x.get("action") == "var"]
    ends = [x for x in rows if x.get("action") == "var_end"]
    used = set()
    reviews = []
    for start in starts:
        end = next((x for x in ends if id(x) not in used and start["t"] <= x["t"] < start["t"] + 600), None)
        if end:
            used.add(id(end))
        disallowed = any(x.get("action") == "goal_disallowed" and start["t"] - 30 <= x["t"] <= (end or start)["t"] + 60 for x in rows)
        reviews.append({"t": start["t"], "cs": start.get("cs"),
                        "duration": round(end["t"] - start["t"], 1) if end else None,
                        "decision": "goal disallowed" if disallowed else ("completed" if end else "no end recorded")})

    def event_rows(pattern):
        return [{"t": x["t"], "action": x.get("action"), "team": x.get("team"), "cs": x.get("cs")}
                for x in rows if pattern(x.get("action") or "")]

    shots = event_rows(lambda x: x in ("shot", "possible"))
    shot_teams = {}
    for x in shots:
        team = x.get("team") or "Unassigned"
        shot_teams[team] = shot_teams.get(team, 0) + 1
    return {"reviews": reviews,
            "corrections": len(event_rows(lambda x: x in ("action_discarded", "action_amend"))),
            "penalties": event_rows(lambda x: "penalty" in x and x != "penalty_goal"),
            "cards": event_rows(lambda x: x.endswith("_card")),
            "shots": {"total": len(shots), "teams": shot_teams}}


def compute_moments(events, meta):
    labels = [l for l in meta["labels"] if l != "draw"]
    moments = []
    books = [e for e in events if e["kind"] == "book"]
    ticks = [e for e in events if e["kind"] == "tick"]
    last_goal = {}
    last_score = {}
    for e in events:
        if e["kind"] != "action" or e["action"] not in GOAL_ACTIONS:
            continue
        t0, scorer = e["t"], e.get("team")
        score_after = _score_from_goals(e.get("goals"), meta)
        if (score_after and t0 - last_score.get(score_after, 0) < 300) or \
                (not score_after and scorer and t0 - last_goal.get(scorer, 0) < 120):
            continue
        if score_after:
            last_score[score_after] = t0
        last_goal[scorer or "?"] = t0
        benefit = scorer
        if e["action"] == "own_goal" and scorer:
            benefit = next((l for l in labels if l != scorer), scorer)
        mo = _measure_moment(events, books, ticks, t0, benefit, "txline", score_after)
        # anchor against the CONFIRMED goal message: the validated stat tree only
        # includes the goal once confirmed (unconfirmed seqs prove value 0)
        conf = next((x for x in events if x["kind"] == "action"
                     and x["action"] in GOAL_ACTIONS and x.get("team") == scorer
                     and x.get("confirmed") and t0 <= x["t"] < t0 + 300), None)
        mo.update({"action": e["action"], "scorer": scorer,
                   "cs": e.get("cs"), "confirmed": e.get("confirmed"),
                   "score_before": _score_before(score_after, benefit, meta),
                   "score_after": score_after, "seq": (conf or e).get("seq"),
                   "part": (conf or e).get("part")})
        moments.append(mo)
    # goals TxLINE's stream missed (feed gap): synthesize from ESPN score changes,
    # clearly marked — t0 is ESPN's lagged detection, so feed deltas are omitted.
    for ct, j in meta.get("score_changes") or []:
        team = meta["teams"][j] if j in (0, 1) and len(meta["teams"]) == 2 else None
        benefit = next((l for l in labels if team and tmatch(l, team)), None)
        score_event = next((x for x in events if x["kind"] == "score" and x["src"] == "espn"
                            and abs(x["t"] - ct) < 0.2), None)
        score_after = score_event.get("score") if score_event else None
        if (score_after and any(m.get("score_after") == score_after and abs(m["t0"] - ct) < 120
                                for m in moments)) or \
                (not score_after and any(abs(m["t0"] - ct) < 300 for m in moments)):
            continue
        mo = _measure_moment(events, books, ticks, ct, benefit, "espn", score_after)
        mo.update({"action": "goal", "scorer": benefit,
                   "score_before": _score_before(score_after, benefit, meta),
                   "score_after": score_after,
                   "note": "t0 is ESPN detection; TxLINE goal-action recording unavailable"})
        moments.append(mo)
    moments.sort(key=lambda m: m["t0"])
    # attribute each rollback to the LAST prior goal for that team, not every
    # goal in a 600s window (an earlier legit goal must not inherit the flag)
    for x in events:
        if x["kind"] == "action" and x["action"] == "goal_disallowed":
            prior = [m for m in moments if m.get("benefit") == x.get("team") and m["t0"] < x["t"]]
            if prior:
                prior[-1]["disallowed"] = True
    tx_moments = [m for m in moments if m.get("t0_src") == "txline"]
    for i, mo in enumerate(tx_moments):
        limit = min(mo["t0"] + 180, tx_moments[i + 1]["t0"] if i + 1 < len(tx_moments) else float("inf"))
        bot = next((x for x in events if x.get("src") == "bot" and mo["t0"] - 1 <= x["t"] < limit
                    and (not x.get("team") or not mo.get("benefit") or tmatch(x["team"], mo["benefit"]))), None)
        if bot:
            mo.update({"bot_action": bot.get("action"), "bot_dt": round(bot["t"] - mo["t0"], 1),
                       "bot_price": bot.get("price"), "bot_fair": bot.get("fair"),
                       "bot_reason": bot.get("reason"),
                       "bot_entries": 1 if bot.get("action") in ("ENTRY", "ENTER") else 0})
            if bot.get("action") in ("ENTRY", "ENTER"):
                exit_event = next((x for x in events if x.get("src") == "bot" and x.get("kind") == "trade"
                                   and x.get("action") == "EXIT" and bot["t"] < x["t"] < bot["t"] + 600
                                   and (not x.get("team") or not bot.get("team") or tmatch(x["team"], bot["team"]))), None)
                if exit_event:
                    mo["bot_pnl"] = round(exit_event.get("pnl") or 0, 2)
    return moments


def _measure_moment(events, books, ticks, t0, benefit, t0_src, score_after=None):
    mo = {"t0": round(t0, 2), "t0_src": t0_src, "benefit": benefit}
    base = None
    if benefit:
        prior = [_bid(b["o"][benefit]) for b in books
                 if t0 - 60 <= b["t"] <= t0 - 15 and benefit in b.get("o", {})]
        if prior:
            base = statistics.median(prior)
            mo["baseline"] = round(base, 3)
    if base is not None:
        observations = [(x["t"], x.get("bb")) for x in ticks if x.get("team") == benefit]
        observations += [(b["t"], _bid(b["o"][benefit])) for b in books if benefit in b.get("o", {})]
        observations.sort()
        move = None
        threshold = base + 0.03
        for i, (t, value) in enumerate(observations):
            if not (t0 - 15 <= t < t0 + 300 and value is not None and value >= threshold):
                continue
            sustained = next((later for later in observations[i + 1:]
                              if 0 < later[0] - t <= 8 and later[1] is not None), None)
            if sustained and sustained[1] >= threshold:
                move = t
                break
        if move is not None and t0_src == "txline":
            mo["poly_dt"] = round(move - t0, 1)
        after = [b for b in books if t0 + 100 <= b["t"] <= t0 + 160 and benefit in b.get("o", {})]
        if after:
            mo["delta_120s"] = round(_bid(after[0]["o"][benefit]) - base, 3)
    mo["prices"] = {key: value for key, value in (
        ("before", _book_snapshot(books, t0 - 10)),
        ("txline", _book_snapshot(books, t0)),
        ("5s", _book_snapshot(books, t0 + 5)),
        ("10s", _book_snapshot(books, t0 + 10))) if value}
    if t0_src == "txline":
        for src_key, dt_key in (("espn", "espn_dt"), ("wc26", "wc26_dt")):
            hit = next((x for x in events if x["kind"] == "score" and x["src"] == src_key
                        and x.get("score") == score_after and t0 - 30 < x["t"] < t0 + 360), None)
            if hit:
                mo[dt_key] = round(hit["t"] - t0, 1)
        shock = next((x for x in events if x["kind"] == "shock" and t0 - 60 < x["t"] < t0 + 180), None)
        if shock:
            mo["shock_dt"] = round(shock["t"] - t0, 1)
    wf = next((x for x in events if x["kind"] == "fill" and x.get("side") == "BUY"
               and x.get("team") == benefit and t0 - 5 < x["t"] < t0 + 180), None)
    if wf:
        mo["whale_dt"] = round(wf["t"] - t0, 1)
        mo["whale_who"] = wf.get("who")
    if benefit:
        jb = [x for x in events if x["kind"] == "jbook" and x.get("team") == benefit]
        prior_j = [x for x in jb if x["t"] <= t0 and x.get("bb") is not None]
        if prior_j:
            base_j = prior_j[-1]["bb"]
            hit_j = next((x for x in jb if x["t"] > t0 and x["t"] - t0 < 300
                          and (x.get("bb") or 0) >= base_j + 0.03), None)
            if hit_j and t0_src == "txline":
                mo["jup_dt"] = round(hit_j["t"] - t0, 1)
    mo["var"] = any(x for x in events if x["kind"] == "action" and x["action"] == "var"
                    and t0 - 30 < x["t"] < t0 + 300)
    return mo


def build_match(meta):
    # tid -> label map for the WS tick adapter
    meta = dict(meta)
    tid_map = {}
    for r in iter_jsonl(GL):
        if r.get("match") != meta["match"]:
            continue
        for lab, rec in (r.get("poly") or {}).items():
            if len(rec) > 5 and rec[5]:
                tid_map[str(rec[5])] = lab
        if tid_map and r.get("ts", 0) > meta["t0"] + 600:
            break
    meta["tid_map"] = tid_map

    events = []
    for gen in (gl_events, tx_score_events, tx_odds_events, burst_tick_events, bot_events,
                whale_events, jupiter_events):
        events.extend(gen(meta))
    events.sort(key=lambda e: e["t"])
    moments = compute_moments(events, meta)
    opportunities, attention = compute_opportunities(events, meta)
    event_insights = compute_event_insights(events)

    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, meta["id"] + ".jsonl"), "w") as f:
        for e in events:
            f.write(json.dumps(e) + "\n")
    counts = {}
    for e in events:
        counts[f'{e["src"]}:{e["kind"]}'] = counts.get(f'{e["src"]}:{e["kind"]}', 0) + 1
    out_meta = {k: v for k, v in meta.items() if k != "tid_map"}
    out_meta["counts"] = counts
    out_meta["moments"] = moments
    out_meta["opportunities"] = opportunities
    out_meta["attention_rate"] = attention
    out_meta["event_insights"] = event_insights
    with open(os.path.join(DATA, meta["id"] + ".json"), "w") as f:
        json.dump(out_meta, f, indent=1)
    print(f'{meta["id"]}: {len(events)} events, {len(moments)} goal-moments '
          f'({sum(1 for m in moments if m.get("var"))} VAR-flagged)')
    return out_meta


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "index"
    if cmd == "index":
        build_index()
    elif cmd == "build":
        which = sys.argv[2] if len(sys.argv) > 2 else "all"
        idx = load_index()
        for meta in idx:
            if which in ("all", meta["id"]):
                build_match(meta)
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
