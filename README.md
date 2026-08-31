# AeroSage — AI Telemetry Incident Investigator

**AeroSage turns machine telemetry into evidence you can act on.** It profiles uploaded CSV telemetry, detects anomalies and incident windows, reconstructs an evidence-first baseline, then uses **NVIDIA Nemotron 3 Super on Nebius Token Factory** to rank competing hypotheses. Optional **Tavily** grounding brings in relevant technical documentation.

**Live demo:** https://aerosage-ai.netlify.app

Built for the **Nebius × NVIDIA Global AI Hackathon 2026**.

## Why AeroSage

Telemetry investigations often start with thousands of numbers and end with an engineer manually trying to answer: *what actually failed?* AeroSage makes that process faster and more traceable.

The key design principle is:

> **AI proposes. Telemetry decides.**

AeroSage never lets the LLM replace the underlying evidence. It produces a deterministic baseline first, then post-validates every AI hypothesis against the target-event telemetry before ranking it.

## What it does

- Accepts telemetry CSV files (up to 4 MB in this MVP)
- Discovers numeric signals without assuming one specific vendor schema
- Uses robust statistics to flag outliers
- Detects safety-relevant events such as motor cut-outs and battery states
- Builds an evidence packet before any external AI call
- Uses `nvidia/nemotron-3-super-120b-a12b` via Nebius Token Factory
- Uses Tavily for optional technical web grounding
- Applies evidence guardrails to remove or cap unsupported AI claims
- Produces a ranked incident report with confidence, evidence, timeline and recommended next actions

## Evidence guardrails

The current drone demo includes explicit post-validation rules. Examples:

- If `magneto_episodes = 0` in the cut-out rows, a magnetic disturbance cannot become the primary cause.
- If `angle_episodes = 0`, an attitude/angle explanation is rejected.
- Battery depletion, radio-link loss and GPS-loss hypotheses are confidence-capped when telemetry does not support them.
- Explicit motor cut-out evidence preserves propulsion-related severity.

These checks are intentionally shown in the UI so judges and operators can see where AI claims were filtered.

## Architecture

```text
CSV telemetry
    │
    ▼
Schema profiler + robust anomaly engine
    │
    ▼
Evidence-first deterministic report
    │
    ├────────────► Tavily technical grounding
    │
    └────────────► NVIDIA Nemotron 3 Super
                         │
                         ▼
                 Evidence guardrails
                         │
                         ▼
                Final ranked report
```

The deterministic baseline is returned before external enrichment. If an external provider is unavailable, the report remains usable instead of disappearing.

## Tech stack

- Static HTML/CSS/JavaScript frontend
- Netlify Functions backend
- Nebius Token Factory (OpenAI-compatible API)
- NVIDIA Nemotron 3 Super 120B A12B
- Tavily Search API
- Netlify deployment

## Run locally

1. Copy the example environment file:

```bash
cp .env.example .env
```

2. Fill in your own keys:

```env
NEBIUS_API_KEY=...
NEBIUS_BASE_URL=https://api.tokenfactory.nebius.com/v1
NEBIUS_MODEL=nvidia/nemotron-3-super-120b-a12b
TAVILY_API_KEY=...
```

3. Run with Netlify CLI:

```bash
npx netlify-cli dev
```

4. Open `http://localhost:8888`.

## Demo data and privacy

`demo/anafi_incidents_sanitized.csv` is an anonymized incident dataset used to demonstrate the investigation flow. Direct identifiers and GPS coordinates are not included in the demo file.

## Security

API keys are server-side environment variables. `.env` files are excluded by `.gitignore` and must never be committed.

## MVP limitations

- CSV schema inference is heuristic and deliberately conservative.
- The current domain guardrails are strongest for drone telemetry; future versions can add configurable rule packs for robotics, industrial equipment and vehicles.
- AeroSage is an investigation assistant, not a certified accident-analysis or safety-decision system.

## License

MIT — see [LICENSE](LICENSE).
