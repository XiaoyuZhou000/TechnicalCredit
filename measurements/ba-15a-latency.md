# BA-15A · Live background analysis latency and timing

Card BA-15A (Sprint 2). This report measures how long a live background analysis takes, and
uses that evidence, together with edit patterns and call cost, to judge the quiet period
(debounce, 3 s) and the cooldown (30 s).

Raw evidence, metadata only:

- `ba-15a-live-runs.json`: the live sample;
- `ba-15a-replay.json`: the offline replay.

Both can be regenerated, with `npm run measure:live` (billed, approval required) and
`UPDATE_REPLAY=1 npx jest src/test/measurement/replay.test.ts`. No prompts, source text,
findings or keys are recorded.

## Environment

| Item          | Value                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| Date          | 2026-11-28 (UTC 09:40)                                                                                         |
| OS            | Windows_NT 10.0.19045 x64                                                                                      |
| Node          | v20.14.0                                                                                                       |
| Model         | `claude-sonnet-4-6`, max tokens 4096, 30 s per-call timeout                                                    |
| Detector      | `claude@fp-fd1967ca81397adc`, the real background detector (card 14)                                           |
| Path measured | the real `Scheduler` with quiet 0, cooldown 0 and 1 slot, then `RealDetector` and the shared detection service |
| ADRs          | none, so each type makes exactly 8 heuristic requests                                                          |

## Budget

|                 | Declared | Used                                                  |
| --------------- | -------- | ----------------------------------------------------- |
| Analyses        | 4        | 4                                                     |
| Claude requests | 56       | 56                                                    |
| Early stop      | (none)   | none: no rate limit, no unexpected count, no failures |

Approved in chat before the run, and enforced as a hard cap in the harness client.

## Live runs

The fixtures are in `src/test/measurement/fixtures/`. Every run was a distinct content hash
and a cache miss.

| Run | Fixture                         | Chars | Types | Requests | Outcome | Findings | Detector time | Input tokens | Output tokens |
| --- | ------------------------------- | ----: | ----: | -------: | ------- | -------: | ------------: | -----------: | ------------: |
| 1   | `OneA.java` (class)             |   528 |     1 |      8/8 | done    |        4 |        9.07 s |        9 103 |         2 005 |
| 2   | `OneB.java` (interface)         |   400 |     1 |      8/8 | done    |        5 |        8.57 s |        7 215 |         2 043 |
| 3   | `Two.java` (interface + class)  |   741 |     2 |    16/16 | done    |        9 |       16.03 s |       15 710 |         3 736 |
| 4   | `Three.java` (enum + 2 classes) |   766 |     3 |    24/24 | done    |        3 |       22.54 s |       23 373 |         4 355 |

- **Waiting:** in every run the quiet, cooldown and in-flight waits were 0, and the slot wait was
  under 1 ms. The figures above are pure detector service time, from detector start to settle.
- **Cache hits:** none in the sample.

### Summary

| Measure                        | Value                     | Basis                                                   |
| ------------------------------ | ------------------------- | ------------------------------------------------------- |
| Detector time per file: median | 12.55 s                   | 4 runs                                                  |
| Detector time per file: range  | 8.57–22.54 s              | 4 runs                                                  |
| Detector time per type         | 7.5–9.1 s (median 8.3 s)  | 9.07, 8.57, 16.03/2, 22.54/3                            |
| One-type files                 | 8.57 s and 9.07 s         | 2 runs                                                  |
| Requests per type              | 8                         | every run                                               |
| Tokens per type (mean)         | 7 914 input, 1 734 output | 55 401 / 7 and 12 139 / 7                               |
| Tokens per request (mean)      | 989 input, 217 output     | 56 requests                                             |
| Cost                           | unavailable               | no prices were supplied (`TC_PRICE_IN`, `TC_PRICE_OUT`) |

Detector time grows almost linearly with the number of types, because types run one after
another (card 14). Within a type, the 8 heuristic requests run in parallel, so a type costs
about one slow request: roughly 8 s.

## Offline replay

The replay runs the real scheduler on a simulated clock (`src/measurement/replay.ts`).

- **Patterns:** five edit patterns, four synthetic (`burst-pause`, `slow-typing`, `undo-back`,
  `save-heavy`) and one with the edit timings of a real F5 session (`recorded-f5`, 2026-11-28).
- **Grid:** quiet ∈ {1, 2, 3, 5} s × cooldown ∈ {0, 10, 30, 60} s.
- **Detector time:** at the measured low end, median and high end (8.6, 12.6 and 22.5 s).
- **Measures:** detector calls, stale results (finished after the file had moved on), and the
  time from the last edit until a current result exists.

### Quiet period, with no cooldown, summed over the 5 patterns

|   Quiet | Calls (8.6 / 12.6 / 22.5 s) |         Stale | Time to current, summed (s) |
| ------: | --------------------------: | ------------: | --------------------------: |
|     1 s |                20 / 17 / 13 |   12 / 10 / 7 |         57.1 / 83.2 / 139.5 |
|     2 s |                15 / 14 / 11 |     8 / 8 / 5 |         54.4 / 78.7 / 129.5 |
| **3 s** |            **14 / 12 / 11** | **7 / 6 / 5** |     **52.8 / 67.9 / 139.4** |
|     5 s |                14 / 12 / 11 |     7 / 5 / 5 |         62.8 / 74.5 / 149.4 |

- **At the low and median detector times:** 3 s has the fewest calls (tied with 5 s) and the
  shortest time to a current result.
- **Below 3 s:** quiet periods start calls in the middle of typing bursts (`slow-typing` with
  1.5 s gaps, `burst-pause`). Those results are stale by the time they finish.
- **Above 3 s:** 5 s saves nothing more and only delays the result.
- **At the high detector time:** 2 s is marginally faster (129.5 s against 139.4 s, with the
  same number of calls).

### Cooldown, with a 3 s quiet period, summed over the 5 patterns

| Cooldown | Calls (8.6 / 12.6 / 22.5 s) |         Stale | Time to current, summed (s) |
| -------: | --------------------------: | ------------: | --------------------------: |
|      0 s |                14 / 12 / 11 |     7 / 6 / 5 |         52.8 / 67.9 / 139.4 |
|     10 s |                11 / 11 / 10 |     4 / 5 / 5 |         59.0 / 92.9 / 154.1 |
| **30 s** |             **10 / 10 / 8** | **3 / 5 / 3** |   **120.7 / 157.6 / 151.8** |
|     60 s |                   8 / 8 / 8 |     2 / 3 / 3 |       132.2 / 160.1 / 236.5 |

- **At today's 30 s:** 17–29 % fewer calls than no cooldown, but the time to a current
  result is 2.3× (median detector time) longer.
  - **Example,** median detector time: `burst-pause` goes from 15.7 s to 45.7 s, and
    `save-heavy` from 18.1 s to 48.1 s.
- **At 10 s:** most of the call saving at the low detector time (11 calls against 10), and less
  than half the delay of 30 s at the low and median times. At the high detector time it gives
  no freshness gain over 30 s and costs 2 more calls.
- **At 60 s:** the fewest calls, and the longest delays.

**Per call,** a saved call is worth about 8 requests per type: about 7.9 k input and 1.7 k
output tokens per type.

## Recommendation

**Keep both defaults for now: a 3 s quiet period and a 30 s cooldown.** Revisit the cooldown
once card 15 is in place.

- **Quiet period, 3 s:** supported by the evidence, so it is kept.
  - The replay favours it at the low and median detector times. Shorter values start calls in
    the middle of a typing burst, and those results are stale before they finish.
  - It doesn't follow from network latency. Detector time (8–23 s) is far longer than any
    candidate, so the quiet period is set by edit gaps, not by the API.
- **Cooldown, 30 s:** kept, but the evidence points to a possible reduction to about 10 s. It
  isn't strong enough yet (constitution IV, spec FR-017).
  - **For 10 s:** it more than halves the time to a current result at the median detector
    time (157.6 s → 92.9 s summed), for about one more call per five patterns.
  - **Against changing now:**
    - at the slow end (3 types, 22.5 s), 10 s brings no freshness and costs 25 % more calls;
    - live background calls are still disabled, and card 15's usage limits don't exist, so a
      shorter cooldown would raise call volume with no global bound in place;
    - the sample is small (one or two runs per size).
- **No default changed.** `DEFAULT_QUIET_MS` (3000) and `DEFAULT_COOLDOWN_MS` (30 000) stay as
  they are.

## Uncertainty and data still needed

- **Small sample:**
  - one run each for 2 and 3 types, and two runs for 1 type;
  - one model, one machine, one time of day, so API latency may vary;
  - no ADR matching, which adds up to one request per candidate in a second phase and would
    lengthen each type.
- **Mostly synthetic patterns:**
  - only `recorded-f5` comes from real editing (one short session);
  - the call and stale counts depend on the mix of patterns chosen.
- **Not measured here:** result delivery (card 17, `delivery=n/a`), and concurrency with more
  than one file at once (the global limit of 2).
- **Before changing the cooldown:**
  - card 15's usage limits in place;
  - at least 5 live runs per type count, including ADR matching;
  - edit timings from several real sessions;
  - prices, so the extra calls can be costed.
