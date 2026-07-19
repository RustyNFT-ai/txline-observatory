"""Curated public-wallet suggestions shared by the recorder and web server.

These are research-cohort addresses, not endorsements or profitability claims.
Keeping the roster in one module prevents the watchlist UI and recorder from
silently drifting apart.
"""

SUGGESTED_WALLETS = (
    {
        "address": "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
        "name": "RN1",
        "description": "Fast-crowd benchmark from the leaderboard study.",
    },
    {
        "address": "0x204f72f35326db932158cba6adff0b9a1da95e14",
        "name": "swisstony",
        "description": "Tracked sports wallet from the leaderboard study.",
    },
    {
        "address": "0xd218e474776403a330142299f7796e8ba32eb5c9",
        "name": "cigarettes",
        "description": "Recorded demo wallet with archive cross-checks.",
    },
    {
        "address": "0x84cfffc3f16dcc353094de30d4a45226eccd2f63",
        "name": "mooseborzoi",
        "description": "High-activity sports wallet in the research cohort.",
    },
    {
        "address": "0x0346afae2603313d2bbee96b628536c8cbe352a5",
        "name": "GoalLineGhost",
        "description": "Goal-market candidate from the leaderboard study.",
    },
)

# Unlike the public-wallet cohort above, this is a simulated execution source.
# The web app exposes it as an explicit, locally saved watchlist choice so the
# archive never implies that it belongs to the current user.
SUGGESTED_BOTS = (
    {
        "id": "txline-paper-bot",
        "kind": "bot",
        "name": "TxLINE paper bot",
        "description": "Recorded paper-execution ledger; simulated fills, not an on-chain wallet.",
    },
)

WATCH = {wallet["address"]: wallet["name"] for wallet in SUGGESTED_WALLETS}
