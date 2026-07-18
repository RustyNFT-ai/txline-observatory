# AI event analyst

Open a goal's `⧉` detail and click **Ask AI insight**. The first answer is a focused
explanation of that selected goal; suggested follow-ups and a short input support
questions such as:

- “Was this still tradable when TxLINE arrived?”
- “Why is this classified as low attention?”
- “Compare this goal with similar opportunities.”
- “What did the bot do, and why?”
- “Why did Edge Finder classify this as a quiet-book opportunity?”

The control is available on every recorded goal, including negative replays,
disallowed goals, feed gaps, and goals where no screened edge exists.

The browser sends one finite `POST /api/ai-insight` request with `match_id`,
`moment_index`, `question`, and—only after the wallet lens loads successfully—an optional
validated `wallet_address`. The browser never supplies timing, price, fill, or bot facts.
The server resolves the selection into trusted local context: the goal record, all
available market history before it (including prematch observations), nearby
feed/fill/bot evidence, screened opportunities, bot events, archive benchmarks, exact
methodology, and bounded server-cached fills for that address. It then makes one finite
Anthropic Messages API call. No API key or raw model call exists in `web/`.

Suggested context payload:

```json
{
  "selection": {"type": "goal|opportunity|review", "match": "...", "t": 0},
  "question": "...",
  "facts": {
    "score_before": "0-0",
    "score_after": "0-1",
    "source_seconds": {"txline": 0, "market": -7.1, "espn": 63.2},
    "prices": {},
    "opportunity": {},
    "bot": {}
  },
  "methodology": {}
}
```

The system instruction requires the response to distinguish recorded facts from
interpretation, express latency in seconds, cite the selected match/event, and say
when the archive cannot support causation. It also limits the answer to this event
and forbids betting instructions.

For a replay candidate, the AI must call the result a **quoted historical replay**, not bot profit. Include the pre-signal quote-change rate, displayed ask depth, recorded ask and exit bid, convergence rule, and the exclusions for fees, latency, slippage, and fill uncertainty.

## Configuration and safety

```bash
cd observatory
cp .env.example .env
# edit .env and set ANTHROPIC_API_KEY=sk-ant-...
python3 server.py
```

`.env` is ignored by Git. Hosted deployments set `ANTHROPIC_API_KEY` as a secret
environment variable. The default model is `claude-sonnet-5` and can be changed with
`ANTHROPIC_MODEL`.

The endpoint enforces an 8–240 character question, a 4 KB request ceiling, 12 calls
per client per ten minutes, 120 calls globally per hour, a 32-second provider timeout,
and a 128-answer in-memory cache. If the key is absent or Anthropic is unavailable,
the same UI returns a clearly labelled deterministic recorded-facts summary so a
judge is never left with a dead button.
