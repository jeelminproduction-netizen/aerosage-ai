# AeroSage — Reproducible performance snapshot

This benchmark measures the deterministic path that parses the CSV, profiles numeric signals, detects incidents, derives evidence guardrails, builds provenance, creates the Decision Ledger, computes the SHA-256 evidence manifest and stable replay proof, and returns the baseline report. It deliberately excludes Nemotron and Tavily network calls so the result can be reproduced without API keys or provider variability.

## Run it

Requirements: Node.js 18+.

```bash
node scripts/benchmark.mjs 25
```

The optional argument is the number of measured runs. One warm-up run is performed first and excluded.

## Recorded snapshot

Measured on 2026-09-27 with Node.js v24.19.0:

| Dataset | Runs | Rows | Numeric signals | Incident rows | p50 | p95 |
|---|---:|---:|---:|---:|---:|---:|
| `demo/anafi_incidents_sanitized.csv` | 25 | 24 | 26 | 12 | 1.709 ms | 3.366 ms |

## Interpretation

- These values measure local deterministic preprocessing and baseline-report generation.
- They do **not** measure end-to-end browser latency or external Nemotron/Tavily requests.
- Hardware, Node.js version, cold starts and runtime load can change the result.
- The benchmark prints its runtime, timestamp, dataset dimensions, p50 and p95 so future results remain attributable.
