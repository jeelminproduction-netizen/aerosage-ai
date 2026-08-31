# AeroSage — Devpost submission draft

## Inspiration

Machine failures leave evidence in telemetry, but turning raw logs into a defensible explanation is slow. AeroSage was built to shorten that gap while keeping AI accountable to the underlying measurements.

## What it does

AeroSage ingests telemetry CSVs, profiles signals, detects statistical anomalies and safety events, reconstructs the incident sequence, and builds an evidence-first baseline. NVIDIA Nemotron 3 Super then ranks competing hypotheses through Nebius Token Factory, while Tavily can ground the investigation in technical documentation.

The differentiator is an evidence-guardrail layer: LLM hypotheses are post-validated against the target-event telemetry before they can be ranked. Unsupported explanations are removed or confidence-capped. The UI exposes those decisions with the message: **AI proposes · telemetry decides.**

## How we built it

- Static JS/HTML/CSS frontend for a lightweight, reliable demo
- Netlify Function for deterministic preprocessing and secure API calls
- Robust median/MAD anomaly profiling
- Domain incident rules for motor cut-outs and battery states
- NVIDIA Nemotron 3 Super 120B A12B hosted through Nebius Token Factory
- Tavily Search for technical grounding
- Evidence guardrails that reconcile model hypotheses with measured incident rows

## Challenges

The biggest challenge was making generative reasoning reliable in a forensic workflow. A model can produce a plausible explanation that conflicts with telemetry. We therefore changed the architecture so the deterministic evidence packet is created first, the AI only proposes hypotheses, and a final guardrail pass decides what can be promoted.

We also made external enrichment best-effort: the baseline report remains available if an API response is slow or malformed.

## Accomplishments

- Real Nebius/Nemotron inference integrated end-to-end
- Tavily grounding integrated end-to-end
- Evidence guardrails visibly filter unsupported AI claims
- Deployed public application
- Demo based on real, sanitized drone telemetry rather than fabricated rows

## What we learned

For safety-adjacent AI, better prompting is not enough. The application needs deterministic preprocessing, explicit uncertainty, post-validation and a usable fallback path.

## What's next

- Configurable telemetry adapters for PX4, ArduPilot, ROS/ROS2 and industrial systems
- Time-series plots and synchronized incident playback
- Manufacturer-specific evidence rule packs
- Multi-agent review for independent hypothesis generation and adjudication
- Exportable forensic PDF reports

## Built with

Nebius Token Factory, NVIDIA Nemotron 3 Super, Tavily, Netlify, JavaScript.

## Links

Live demo: https://aerosage-ai.netlify.app
Repository: https://github.com/jeelminproduction-netizen/aerosage-ai
