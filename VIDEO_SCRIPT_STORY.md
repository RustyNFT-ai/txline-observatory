# Demo Video Script — Personal Narrative Cut, Target 4:00, Hard Limit 5:00

> This is an alternate narrative draft. Use [VIDEO_SCRIPT.md](VIDEO_SCRIPT.md) for the
> final Trading Tools and Agents submission; it matches the current user-agnostic UI
> and foregrounds the published autonomous agent source.

This is an alternate cut of [VIDEO_SCRIPT.md](VIDEO_SCRIPT.md): same product, same tested
demo beats (reuse [TESTING.md](TESTING.md) preflight and exact numbers below), but told as
your own build story instead of a feature tour. Practice out loud once with a timer before
recording — spoken word count below is tuned for ~150 wpm including on-screen pauses.

## Preflight (same as the other script)

1. Confirm `/api/health`: 47 matches, `ai_enabled: true`.
2. Have three tabs ready: (1) England vs Argentina full timeline, deep-linked to the
   84' Argentina goal — `#m=england-vs-argentina-2026-07-15&t=1784148363.12`; (2) Insights →
   Edge Finder tab; (3) Watchlist with RN1 addable.
3. Test the goal modal + Ask AI once so the response is warm/cached.

## 0:00–0:30 — The problem (personal)

**Screen:** talking head or a quiet terminal/blank tab — no app yet.

"I've built a few Polymarket trading bots. The first ones arbitraged 5-minute crypto
up/down markets — they'd win for a while, then the market would quietly change underneath
them and start bleeding, with no organized way to tell why. Debugging a strategy against a
market that keeps shifting is hard when your data is scattered across logs and one-off
API calls."

## 0:30–1:05 — Pivoting to speed, with TxLINE

**Screen:** brief look at `inplay-bot` code or its architecture, then cut to the app.

"So I pivoted to a cleaner signal: live soccer. Polymarket's in-play markets lag a real goal
by two to three minutes before repricing. TxLINE gave me a fast, de-margined odds and score
stream, so I built `inplay-bot` — it detects the goal, fades that lag, and exits on
convergence instead of holding to the final result. Paper-tested, now live-tested through
this World Cup."

## 1:05–1:25 — It worked... inconsistently

**Screen:** cut to a match with mixed results, e.g. Norway vs England.

"And it worked — some matches were clean wins, others weren't, and a win/loss ledger alone
couldn't tell me which conditions were which. I needed the goal, the odds feed, the market,
and my bot's decision on one timeline across every match. That's why I built this: TxLINE
Observatory."

## 1:25–2:10 — Observatory tour

**Screen:** England vs Argentina, the 84' Argentina goal already expanded.

"Every goal here is anchored to TxLINE's recorded goal message. This one: Polymarket had
already moved 9.2 seconds *before* TxLINE confirmed it, ESPN followed almost a minute later,
and the market moved another 6.3 cents over the next two minutes. My bot entered for
$45.16 on this exact event."

Click **Ask AI insight**. "I can also ask a context-bounded AI analyst about just this
moment — it only sees the evidence packet built for this goal, so it can't invent facts."

## 2:10–2:35 — Comparing my bot against the feeds and other traders

**Screen:** close the modal, open **Watchlist**, add RN1.

"I can also drop in any public Polymarket wallet — read-only, no keys — and see how a known
fast trader reacted to the same goal on the same feeds. RN1 bought Argentina 4.1 seconds
before TxLINE's own message. My internal bot ledger sits right next to that, separately
labeled — 33 entries, 33 exits, plus $22.04 — so I'm judging my execution against both the
raw feeds and real traders, not just against myself."

## 2:35–3:25 — The finding: where the edge actually lives

**Screen:** Insights → Edge Finder.

"Once every match was on one timeline, I could finally ask: does this edge hold everywhere,
or only sometimes? I split all 39 screened matches by how active the order book runs — a
proxy for market attention. In quiet, low-attention group-stage matches, dislocation
windows were profitable **85% of the time**, a median 9 cents a share. In the loudest
matches — France-Spain, Mexico-England, England-Argentina — that flips: only **36%**
profitable, and those three highest-attention matches had **zero** positive windows.

The honest read: on games everyone's watching, Polymarket prices as well as the sharp feed.
The edge lives specifically where attention is thin — a real, discriminative split, though
still a backtested replay, before fees."

## 3:25–3:50 — What I'd do with more data

**Screen:** back to the match picker, maybe scroll past MLS-adjacent context if visible.

"World Cup group-stage matches are naturally low-attention, but a one-off tournament. If
this effect is real, it should show up in low-profile league games year-round — MLS is my
best guess. I don't have TxLINE league coverage to prove that yet; give me a month of API
access and I'll build the same case study for a market you'd want a standing edge in."

## 3:50–4:10 — Next steps and close

**Screen:** Observatory home.

"Next: more real user testing, and a UI that's a little more fun and readable, not just
correct — right now it rewards someone who already knows what they're looking at. But the
core finding held up under scrutiny: TxLINE gave me the speed and the confirmed-goal ground
truth to find out *where* the edge lives, not just that it might. This is TxLINE
Observatory."

Stop recording.

## Numbers used in this script (verified this session, reuse exactly)

- Argentina 84' goal: Polymarket −9.2s, Jupiter +3.6s, ESPN +58.8s, +6.3¢ over 120s, bot
  ENTER +$45.16 (from [TESTING.md](TESTING.md), already regression-tested).
- RN1 wallet: BUY Argentina at −4.1s vs TxLINE.
- Internal bot ledger: 33 entries / 33 exits / +$22.04 (label as internal ledger, not wallet PnL).
- Attention split (computed this session from `/api/insights` + each match's `attention_rate`,
  threshold 1.0 tick-changes/min): low-attention 28 matches / 99 windows / 85% positive /
  median +$0.09 gross-per-share; high-attention 11 matches / 55 windows / 36% positive /
  median −$0.017 gross-per-share. France-Spain, Mexico-England, England-Argentina (the three
  highest attention_rate matches, 5.1–7.0) each have 0 positive windows.
- **Do not claim a pregame TxLINE-vs-Polymarket edge.** Checked this session: only 1 of 11
  spot-checked matches has a real pre-kickoff recorded window (Mexico-England, 42 min), and
  its median fair-minus-ask gap is −$0.003 — essentially zero, consistent with the earlier
  killed pre-match cross-venue finding (Polymarket ≈ Pinnacle pre-match). Cut this claim.
