# AeroSage — 60-second judge guide

> **AI proposes. Telemetry decides.**

AeroSage is an evidence-first incident investigator for drone and machine telemetry. It combines deterministic telemetry analysis with **NVIDIA Nemotron 3 Super on Nebius Token Factory**, optional **Tavily** technical grounding, and a final guardrail layer that can reject or confidence-cap unsupported model hypotheses.

## 1. Try the live investigation

Open **https://aerosage-ai.netlify.app**.

1. Load the sanitized real drone incident demo.
2. Run the forensic analysis.
3. Notice that the deterministic baseline is available independently of external AI enrichment.
4. Inspect the live Nemotron hypotheses.
5. Inspect **Decision Ledger** to see the measured fields, rule votes, final rank and suppression reason for every candidate.
6. Click **Replay this incident** and verify that the deterministic verdict SHA-256 returns `MATCH` without invoking Nemotron or Tavily.
7. Inspect **Evidence guardrails** to see which model claims were rejected or confidence-capped by telemetry.
8. Inspect the Tavily technical sources used for grounding.

The demo is intentionally designed so the LLM does **not** get the final word.

## 2. Reproduce the trust layer

The production guardrail implementation is exercised directly by the repository test suite — the tests do not maintain a second copy of the rules.

```bash
node --test tests/guardrails.test.mjs
```

Expected result:

```text
# tests 30
# pass 30
# fail 0
```

See [GUARDRAIL_VALIDATION.md](GUARDRAIL_VALIDATION.md) for the validation matrix.

A representative adversarial case:

```text
AI hypothesis: Magnetic disturbance — 88%
Telemetry: magneto_episodes = 0 in the target cut-out rows
AeroSage verdict: REJECTED
```

Other tests verify that unsupported battery depletion, radio-link loss and GPS-loss claims are confidence-capped, while explicit propulsion cut-out evidence and deterministic risk severity are preserved.

## 3. Why this is different

Many AI incident tools stop after generating a plausible explanation. AeroSage separates three responsibilities:

```text
Measurements  ->  deterministic evidence
Nemotron      ->  competing hypotheses
Guardrails    ->  evidence-based accept / reject / cap
```

That separation is the core product idea: generative reasoning is useful, but measured telemetry remains authoritative.

## 3.5 Action safety and evidence handoff

The live report also exposes a server-generated **Action Policy** in `REVIEW_ONLY` mode with a `No automatic actuation` gate. High/critical cases require qualified human review before return to operation. Operators can export an **Evidence bundle** containing the investigation ID, SHA-256 manifest, provenance, Decision Ledger, investigation trace, replay fingerprint, action policy and grounding sources.

## 4. How AeroSage maps to the judging criteria

### Technological implementation
- Real `nvidia/nemotron-3-super-120b-a12b` inference through Nebius Token Factory.
- Runtime Tavily grounding.
- Deterministic telemetry preprocessing and robust anomaly detection before the LLM call.
- Post-validation of model output against target-event telemetry.
- 30/30 zero-dependency automated guardrail, Decision Ledger, replay and integrity tests passed in CI.
- Reproducible local benchmark: 24 rows and 26 numeric signals, 1.709 ms p50 / 3.366 ms p95 for deterministic base analysis, Decision Ledger and SHA-256 manifest/replay creation (25 runs; network enrichment excluded).
- A deterministic baseline remains usable if an external provider is unavailable.
- Every run emits a SHA-256 evidence manifest covering the exact CSV, model, timestamp and versioned ruleset.
- Every candidate emits a Decision Ledger record with target-row inputs, deterministic rule votes and a suppression/retention explanation.
- The live replay control proves that identical CSV bytes and ruleset reproduce the same deterministic verdict fingerprint without model or search calls.

### Design
- One investigation flow from CSV to ranked causes, evidence, timeline and next actions.
- Guardrail decisions are exposed to the operator instead of being hidden.
- The AI enrichment is additive rather than a single point of failure.

### Potential impact
The current demonstration focuses on sanitized drone telemetry, but the same evidence-first architecture can be extended with rule packs for robotics, vehicles and industrial equipment where operators need traceable incident triage rather than an unconstrained chatbot answer.

### Quality and originality
The central mechanism is not simply prompting a model to diagnose a failure. AeroSage deliberately allows the model to propose hypotheses and then gives deterministic evidence the authority to overrule them.

## 5. Fast links

- **Live app:** https://aerosage-ai.netlify.app
- **Demo video:** https://youtu.be/CR_o_ouLBX4
- **Guardrail validation:** [GUARDRAIL_VALIDATION.md](GUARDRAIL_VALIDATION.md)
- **Production inference + guardrails:** [netlify/functions/analyze.mjs](netlify/functions/analyze.mjs)
- **Automated tests:** [tests/guardrails.test.mjs](tests/guardrails.test.mjs)

## Known scope

AeroSage is an investigation assistant, not a certified accident-analysis or safety-decision system. The current domain-specific guardrails are strongest for the drone demo; broader machine support is a planned extension rather than a claim about the current MVP.
