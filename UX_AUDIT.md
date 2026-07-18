# UX Audit — July 17, 2026

## Scope and method

The final build was exercised in Chrome at 1440×900, 820×900, and a true emulated
390×844 viewport. The pass covered direct/deep-linked Full mode, moment focus, goal
detail and AI, Replay, a simulated Live transition, upcoming prematch, Insights, wallet
success/invalid states, manual hash edits, keyboard close, and scroll behavior. Browser
runtime exceptions were monitored during the mode regression.

## Shipped improvements

| Area | Result |
| --- | --- |
| Orientation | Canonical deep links, match-specific page titles, selected goal state, and graceful invalid-hash fallback make the current context shareable. |
| Goal detail | A separate expand affordance preserves card-to-chart zoom while revealing source timing, VAR/feed-gap state, price move, and bot evidence. |
| Explanation | Ask AI stays tied to the selected goal and exposes provider/fallback state instead of presenting an ungrounded global chatbot. |
| Terminology | Hover/focus/tap help was added for unclear metrics. Negative timing is described as “recorded before,” not unsupported front-running. |
| Wallet safety | The modal says public/read-only and World-Cup-only before input; demo, invalid, empty, capped, and public-API failure states are explicit. Wallet notional and internal bot P&L remain separate. |
| Responsive header | At 390 px, the match picker and all seven actions fit a compact three-row grid without document overflow. Long status detail collapses. |
| Chart | Margins, tick density, and endpoint labels adapt to narrow widths. Empty views show a double-click-to-fit hint. |
| Modals | Goal and wallet dialogs fit at 390 px, avoid horizontal overflow, close with Escape/outside click, and restore focus. |
| Sticky navigation | Insights tabs pin directly beneath the upcoming banner; measured seam is 0 px, so scrolled content does not show through. |
| State reset | Switching to a new/upcoming match clears the previous selected event and closes the stale Inspector. |
| Empty state | Loaded matches with no goal moments show a plain-language message instead of an unexplained blank strip. |

The automated mode pass observed no JavaScript runtime exceptions. UI-driven match and
moment changes used `history.replaceState` and did not increase browser-history length;
manual hash edits still work and naturally create normal browser history.

## Known limitations and recommended handling

1. **Insights tables scroll horizontally on narrow phones.** The sticky tabs and page
   itself fit, but dense research tables retain their columns. This is preferable to
   hiding evidence before the submission; a later pass could add card-based mobile rows.
2. **Canvas detail is visual-first.** Controls and dialogs are keyboard-operable, but
   the chart itself is not a full screen-reader data table. Inspector and Insights expose
   much of the same evidence as DOM text.
3. **Wallet lookup can take several seconds.** It may scan up to 20,000 public rows and
   is then cached for five minutes. The UI labels loading, partial, capped, and error
   states; do not promise complete wallet history or realized P&L.
4. **Free deployment cold starts are possible.** Warm the app before recording. The
   recorded-data experience is self-contained after startup.
5. **Live depends on recorder availability.** If no match is currently being recorded,
   Live should remain unavailable. Use the explicitly labeled 60× historical Replay in
   the demo rather than simulating live data for judges.
6. **Tooltips are intentionally sparse on touch.** Persistent explanatory copy is used
   for critical wallet/AI limitations; hover-only help is supplemental.

## Pre-submission recommendation

Do not add another major UI surface before the video. The most valuable remaining work
is operational: add the Anthropic key, complete the durable deployment, execute
[TESTING.md](TESTING.md) against that URL, and record [VIDEO_SCRIPT.md](VIDEO_SCRIPT.md).

