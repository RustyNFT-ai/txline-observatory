"""TxLINE on-chain anchor verification — pure stdlib (no solana/anchor deps).

Given a score record (fixtureId, seq, statKey), this module:
  1. fetches the Merkle proof from TxLINE /api/scores/stat-validation
  2. recomputes the proof chain locally with SHA-256:
       leaf = sha256(key u32le || value u32le || period u32le)
       leaf --statProof--> eventStatRoot --subTreeProof--> summary.eventStatsSubTreeRoot
     (hash function + leaf encoding verified empirically against live proofs,
      2026-07-13: sha256, sibling order per isRightSibling, u32le triple)
  3. derives the program's daily_scores_roots PDA for the record's epoch day
     (seeds: ["daily_scores_roots", epochDay u16le], mainnet program
      9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA) — find_program_address
     implemented from scratch, incl. the ed25519 on-curve rejection test
  4. reads that account over public RPC and reports its latest update
     transaction + slot, plus whether any candidate main-tree root computed
     from the summary appears verbatim in the account data.

Result: a JSON "receipt" the UI renders — the Verifiable Resolution UI the
track brief asks for.

CLI check:  python3 solana_anchor.py <fixtureId> <seq> <statKey>
"""
import hashlib
import json
import os
import struct
import sys
import time
import urllib.request

TXODDS_BASE = "https://txline.txodds.com"
PROGRAM_ID_B58 = "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA"
RPC = os.environ.get("OBS_SOLANA_RPC", "https://api.mainnet-beta.solana.com")
STUDY = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "research", "leaderboard_study")

# ── base58 ───────────────────────────────────────────────────────────────────
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(b):
    n = int.from_bytes(b, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + (out or "")


def b58decode(s):
    n = 0
    for c in s:
        n = n * 58 + B58.index(c)
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return b"\0" * (len(s) - len(s.lstrip("1"))) + b


# ── ed25519 on-curve test (for PDA derivation) ───────────────────────────────
P = 2**255 - 19
D = (-121665 * pow(121666, P - 2, P)) % P


def on_curve(b32):
    """True if the 32 bytes decompress to a valid ed25519 point."""
    y = int.from_bytes(b32, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    if y >= P:
        return False
    y2 = y * y % P
    u, v = (y2 - 1) % P, (D * y2 + 1) % P
    # x = sqrt(u/v) via x = u*v^3 * (u*v^7)^((p-5)/8)
    x = (u * pow(v, 3, P)) % P * pow((u * pow(v, 7, P)) % P, (P - 5) // 8, P) % P
    vx2 = v * x * x % P
    if vx2 == u % P:
        pass
    elif vx2 == (-u) % P:
        x = x * pow(2, (P - 1) // 4, P) % P
    else:
        return False
    if x == 0 and sign:
        return False
    return True


def find_pda(seeds, program_id):
    """(address_b58, bump) — Solana find_program_address, from scratch."""
    for bump in range(255, -1, -1):
        h = hashlib.sha256(b"".join(seeds) + bytes([bump]) + program_id
                           + b"ProgramDerivedAddress").digest()
        if not on_curve(h):
            return b58encode(h), bump
    raise ValueError("no PDA found")


# ── TxLINE proof fetch ───────────────────────────────────────────────────────
def _http_json(url, data=None, headers=None, timeout=15):
    req = urllib.request.Request(url, data=data, headers=headers or {},
                                 method="POST" if data is not None else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


_auth = {"jwt": None, "ts": 0}


def tx_headers():
    tok = os.environ.get("TXLINE_API_TOKEN", "").strip()
    if not tok:
        try:
            tok = open(os.path.join(STUDY, ".txodds_token")).read().strip()
        except OSError as exc:
            raise RuntimeError("TXLINE_API_TOKEN is not configured") from exc
    if not _auth["jwt"] or time.time() - _auth["ts"] > 1800:
        j = _http_json(TXODDS_BASE + "/auth/guest/start", data=b"")
        _auth["jwt"], _auth["ts"] = j.get("token"), time.time()
    return {"Authorization": f"Bearer {_auth['jwt']}", "X-Api-Token": tok}


def fetch_proof(fixture_id, seq, stat_key):
    url = (f"{TXODDS_BASE}/api/scores/stat-validation?fixtureId={fixture_id}"
           f"&seq={seq}&statKey={stat_key}")
    return _http_json(url, headers=tx_headers())


# ── local Merkle verification ────────────────────────────────────────────────
def _walk(node, path):
    for p in path:
        sib = bytes(p["hash"])
        node = hashlib.sha256(node + sib if p["isRightSibling"] else sib + node).digest()
    return node


def verify_local(proof):
    """Recompute leaf -> eventStatRoot -> eventStatsSubTreeRoot. Returns dict."""
    st = proof["statToProve"]
    leaf = hashlib.sha256(struct.pack("<III", st["key"], st["value"], st["period"])).digest()
    ev_root = _walk(leaf, proof["statProof"])
    stat_ok = ev_root == bytes(proof["eventStatRoot"])
    sub_root = _walk(bytes(proof["eventStatRoot"]), proof["subTreeProof"])
    sub_ok = sub_root == bytes(proof["summary"]["eventStatsSubTreeRoot"])
    return {"stat_path_ok": stat_ok, "subtree_path_ok": sub_ok,
            "event_stat_root": bytes(proof["eventStatRoot"]).hex(),
            "subtree_root": sub_root.hex()}


def candidate_main_roots(proof):
    """Main-tree roots under a few plausible summary-leaf encodings; the
    on-chain account is scanned for any of them (layout-agnostic)."""
    s = proof["summary"]
    u = s["updateStats"]
    sub = bytes(s["eventStatsSubTreeRoot"])
    cands = []
    for enc in (
        struct.pack("<IIQQ", s["fixtureId"], u["updateCount"], u["minTimestamp"], u["maxTimestamp"]) + sub,
        struct.pack("<QIQQ", s["fixtureId"], u["updateCount"], u["minTimestamp"], u["maxTimestamp"]) + sub,
        struct.pack("<IQQ", s["fixtureId"], u["minTimestamp"], u["maxTimestamp"]) + sub,
    ):
        leaf = hashlib.sha256(enc).digest()
        cands.append(_walk(leaf, proof["mainTreeProof"]))
        cands.append(_walk(hashlib.sha256(leaf).digest(), proof["mainTreeProof"]))
    return cands


# ── Solana RPC ───────────────────────────────────────────────────────────────
def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method,
                       "params": params}).encode()
    return _http_json(RPC, data=body,
                      headers={"Content-Type": "application/json"}).get("result")


def anchor_receipt(fixture_id, seq, stat_key):
    """Full receipt: proof + local verification + on-chain account evidence."""
    proof = fetch_proof(fixture_id, seq, stat_key)
    if not isinstance(proof, dict) or "summary" not in proof:
        return {"ok": False, "error": f"no proof returned: {str(proof)[:200]}"}
    local = verify_local(proof)
    epoch_day = proof["summary"]["updateStats"]["minTimestamp"] // 86400000
    pda, bump = find_pda([b"daily_scores_roots", struct.pack("<H", epoch_day)],
                         b58decode(PROGRAM_ID_B58))
    out = {"ok": True, "fixtureId": fixture_id, "seq": seq,
           "stat": proof["statToProve"], "local": local,
           "epoch_day": epoch_day, "pda": pda, "bump": bump,
           "program": PROGRAM_ID_B58,
           "proof_sizes": {k: len(proof.get(k) or []) for k in
                           ("statProof", "subTreeProof", "mainTreeProof")}}
    try:
        import base64
        acct = rpc("getAccountInfo", [pda, {"encoding": "base64"}])
        info = (acct or {}).get("value")
        if info:
            data = base64.b64decode(info["data"][0])
            out["account"] = {"exists": True, "owner": info.get("owner"),
                              "lamports": info.get("lamports"), "bytes": len(data)}
            roots = candidate_main_roots(proof)
            hit = next((r for r in roots if r in data), None)
            out["root_match"] = bool(hit)
            if hit:
                out["matched_root"] = hit.hex()
            sigs = rpc("getSignaturesForAddress", [pda, {"limit": 1}]) or []
            if sigs:
                out["last_update"] = {"signature": sigs[0].get("signature"),
                                      "slot": sigs[0].get("slot"),
                                      "block_time": sigs[0].get("blockTime")}
                out["explorer"] = f'https://solscan.io/tx/{sigs[0].get("signature")}'
        else:
            out["account"] = {"exists": False}
    except Exception as e:
        out["rpc_error"] = str(e)
    return out


if __name__ == "__main__":
    fid = int(sys.argv[1]) if len(sys.argv) > 1 else 18213979
    seq = int(sys.argv[2]) if len(sys.argv) > 2 else 314
    key = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    print(json.dumps(anchor_receipt(fid, seq, key), indent=1))
