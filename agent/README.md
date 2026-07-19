# Autonomous goal-lag agent

This is the strategy that produced the paper-execution ledger displayed in TxLINE
Observatory. It runs without manual intervention once started:

1. `goal_latency.py` authenticates to TxLINE and consumes the live odds and score
   SSE feeds, while sampling the executable Polymarket CLOB book.
2. Each normalized observation is appended to `out/goal_latency.jsonl`.
3. `goal_paper_trader.py` tails that stream and evaluates every new TxLINE goal.
4. It enters only when `TxLINE fair - Polymarket ask >= MIN_GAP`, then exits on
   adaptive convergence, reversal, or the hard time limit.
5. Every `ENTRY`, `EXIT`, and `SKIP` is written to an append-only CSV ledger that
   the Observatory normalizer joins back to the recorded event timeline.

TxLINE score events are the primary trigger. ESPN score transitions remain a
fallback for a missing/unmapped score action. The same TxLINE fair-value gate applies
to either trigger, which also rejects many unconfirmed or reversed goal signals.

## Run in paper mode

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r agent/requirements.txt
export TXLINE_API_TOKEN='your TxLINE API token'
mkdir -p agent/out
python3 agent/goal_latency.py 8
```

In a second terminal:

```bash
. .venv/bin/activate
python3 agent/goal_paper_trader.py
```

The trader is paper-only: it observes the live ask/bid and simulates fills but never
requests a wallet signature or posts an order. Defaults are deterministic and can be
overridden with `K`, `MIN_GAP`, `MAX_HOLD`, `SLIP`, and `NOTIONAL`.

## Default strategy parameters

| Parameter | Default | Meaning |
| --- | ---: | --- |
| `MIN_GAP` | `0.03` | Minimum TxLINE-fair minus executable-ask edge |
| `K` | `0.70` | Fraction of the entry gap targeted on convergence |
| `MAX_HOLD` | `180s` | Hard time exit |
| `SLIP` | `0.005` | Simulated per-share slippage on market exits |
| `NOTIONAL` | `$100` | Fixed paper notional per entry |

## TxLINE endpoints

- `POST /auth/guest/start`
- `GET /api/fixtures/snapshot?competitionId=72`
- `GET /api/odds/snapshot/{fixtureId}`
- `GET /api/odds/stream`
- `GET /api/scores/stream`

The token is read from `TXLINE_API_TOKEN` or a local, ignored `.txodds_token` file.
No credential is present in this repository.
