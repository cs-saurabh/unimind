# Memory Intelligence Dashboard Help

This page explains what the new dashboard signals mean and how to use them safely.

## Insights

Insights are synthetic memories created from repeated patterns in the memory graph.

- They are summaries, not raw transcripts.
- They link back to source memories through provenance edges.
- You can inspect them from the synthesis audit viewer or open them in the graph.

## Contradictions

Contradictions are flag-only and neutral.

- The dashboard does not pick a winner.
- Both memories stay visible as equal peers.
- The reconciliation note explains why they were flagged.
- If a pair is wrong, use dismiss to clear the flag.

## Knowledge gaps

Knowledge gaps mean the system saw a recurring topic without a durable recorded stance.

- Gaps are regular `CONTEXTUAL` memories with `kind: "knowledge_gap"`.
- They are temporary and can expire naturally.
- Suggested prompts are there to help collect the missing stance.
- Closing a gap marks it resolved.
- Reopening a gap makes it eligible again for future prompting and tracking.

## Monitoring alerts

The monitoring section highlights a few high-signal conditions:

- synthesis overrun: no synthesis row landed by 11:30
- contradiction over-flagging: one run flagged more than 50 contradictions
- validation spike: synthesis started producing malformed or rejected candidates

These alerts are meant to trigger inspection, not to assert user-facing truth automatically.

## Read-path metrics

The dashboard also shows:

- latency percentiles for inject and recall
- hit rate
- budget utilization
- backstop trip rate
- naive fallback rate

High fallback rates or heavy backstop usage usually mean the planner or ranking path needs attention.
