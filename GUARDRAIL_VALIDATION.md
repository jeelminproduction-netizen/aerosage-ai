# AeroSage — Evidence Guardrail Validation

> **AI proposes. Telemetry decides.**

AeroSage does not accept model hypotheses at face value. The production backend derives deterministic guardrails from the target incident rows, then post-validates Nemotron output before a cause can be ranked.

This repository includes a zero-dependency Node.js test suite that exercises the **actual guardrail functions in `netlify/functions/analyze.mjs`**. The tests instrument that source file at runtime; they do not maintain a second copy of the guardrail implementation.

## Run the validation

Requirements: Node.js 18+.

```bash
node --test tests/guardrails.test.mjs
```

Expected result:

```text
# tests 17
# pass 17
# fail 0
```

## What is covered

| Scenario | Telemetry evidence | Expected AeroSage behavior |
|---|---|---|
| Magnetic false positive | `magneto_episodes = 0` | Reject magnetic hypothesis |
| Attitude false positive | `angle_episodes = 0` | Reject attitude hypothesis |
| Battery depletion claim | No low/critical battery event, battery still 38% | Cap confidence at 25% |
| Radio-link loss claim | Weakest target-event Wi-Fi is -67 dBm | Cap confidence at 30% |
| GPS-loss claim | Target-event satellite median is 12 | Cap confidence at 25% |
| Unsupported causes dominate AI output | Explicit motor cut-out exists | Restore propulsion evidence to the ranked causes |
| AI lowers severity | Deterministic baseline is `critical` | Preserve the deterministic critical risk |
| Magnetic evidence actually exists | `magneto_episodes > 0` | Do not block magnetic domain |
| Low-battery evidence actually exists | `low_batt_episodes > 0` | Do not apply the depletion cap |
| Severe radio weakness exists | Wi-Fi <= -80 dBm | Do not apply the radio cap |
| Poor GPS evidence exists | Low satellite count | Do not apply the GPS cap |

The remaining tests verify target-event selection, domain classification, confidence-cap application, evidence replacement, and guardrail accounting.

## Why this matters

Generative models can produce technically plausible explanations that conflict with measured data. AeroSage uses Nemotron for hypothesis generation and synthesis, while deterministic telemetry remains the authority for whether a hypothesis can be promoted.

A concrete example from development was a high-confidence magnetic explanation despite zero magnetic episodes in the target cut-out rows. The current guardrail layer rejects that contradiction instead of displaying it as a likely cause.

## CI

`.github/workflows/guardrails.yml` runs the same test suite automatically on pushes and pull requests that affect the guardrails or tests. This keeps the evidence policy reproducible without touching the production inference path.
