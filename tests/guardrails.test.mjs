import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = process.env.AEROSAGE_ANALYZE_PATH || join(here, '..', 'netlify', 'functions', 'analyze.mjs');
let source = readFileSync(sourcePath, 'utf8');
source = source.replace(/export\s+default\s+async\s*\(req\)\s*=>\s*\{/, 'async function __aerosageHandler(req) {');
if (/\bexport\s+default\b/.test(source)) {
  throw new Error('Could not instrument analyze.mjs for guardrail tests. The handler signature changed.');
}
source += `\n;globalThis.__AEROSAGE_TEST_API__ = { deriveEvidenceGuardrails, hypothesisDomain, applyEvidenceGuardrails, deterministicReport, buildEvidenceProvenance, buildEvidenceManifest, buildDeterministicReplayProof, verifyReplay, sha256Hex };`;
const sandbox = { crypto: globalThis.crypto, TextEncoder };
vm.createContext(sandbox);
new vm.Script(source, { filename: sourcePath }).runInContext(sandbox);
const { deriveEvidenceGuardrails, hypothesisDomain, applyEvidenceGuardrails, deterministicReport, buildEvidenceProvenance, buildEvidenceManifest, buildDeterministicReplayProof, verifyReplay, sha256Hex } = sandbox.__AEROSAGE_TEST_API__;

function incidentPacket(values = {}) {
  return {
    incident_rows: [{
      row_index: 42,
      score: 10,
      reasons: ['cutout_episodes=1', 'emergency_state=1'],
      values: {
        cutout_episodes: 1,
        magneto_episodes: 0,
        angle_episodes: 0,
        critical_batt_episodes: 0,
        low_batt_episodes: 0,
        battery_min_pct: 38,
        wifi_weakest_dbm: -67,
        sat_median: 12,
        ...values,
      },
    }],
    metrics: { anomaly_count: 4, numeric_columns: 9, incident_rows: 1 },
  };
}

function checkedReport(packet, causes, risk = 'critical', confidence = 0.9) {
  packet.evidence_guardrails = deriveEvidenceGuardrails(packet);
  const fallback = deterministicReport(packet);
  const report = {
    ...fallback,
    risk_level: risk,
    confidence,
    likely_causes: causes.map(c => ({ ...c })),
  };
  return applyEvidenceGuardrails(report, packet, fallback);
}

test('targets the explicit cut-out row', () => {
  const g = deriveEvidenceGuardrails(incidentPacket());
  assert.deepEqual(Array.from(g.target_rows), [42]);
});

test('blocks magnetic disturbance when magneto_episodes=0', () => {
  const g = deriveEvidenceGuardrails(incidentPacket());
  assert.ok(g.blocked_domains.includes('magnetic'));
});

test('blocks attitude explanation when angle_episodes=0', () => {
  const g = deriveEvidenceGuardrails(incidentPacket());
  assert.ok(g.blocked_domains.includes('attitude'));
});

test('caps unsupported battery depletion at 25%', () => {
  const g = deriveEvidenceGuardrails(incidentPacket());
  assert.equal(g.confidence_caps.battery_depletion, 0.25);
});

test('caps radio-link loss at 30% when Wi-Fi is not severely weak', () => {
  const g = deriveEvidenceGuardrails(incidentPacket());
  assert.equal(g.confidence_caps.radio, 0.30);
});

test('caps GPS loss at 25% when satellite count is healthy', () => {
  const g = deriveEvidenceGuardrails(incidentPacket());
  assert.equal(g.confidence_caps.gps, 0.25);
});

test('removes a high-confidence magnetic hallucination', () => {
  const out = checkedReport(incidentPacket(), [
    { cause: 'Magnetic disturbance', confidence: 0.88, why: 'Compass interference may have caused the event.' },
    { cause: 'Propulsion / motor cut-out event', confidence: 0.72, why: 'Motor telemetry shows a cut-out.' },
  ]);
  assert.equal(out.likely_causes.some(c => hypothesisDomain(`${c.cause} ${c.why}`) === 'magnetic'), false);
  assert.ok(out.guardrail_filtered >= 1);
});

test('removes an unsupported attitude hallucination', () => {
  const out = checkedReport(incidentPacket(), [
    { cause: 'Attitude instability', confidence: 0.82, why: 'A sudden tilt may have caused shutdown.' },
    { cause: 'Propulsion / motor cut-out event', confidence: 0.70, why: 'Explicit motor cut-out.' },
  ]);
  assert.equal(out.likely_causes.some(c => hypothesisDomain(`${c.cause} ${c.why}`) === 'attitude'), false);
});

test('post-validation reduces battery depletion confidence to the telemetry cap', () => {
  const out = checkedReport(incidentPacket(), [
    { cause: 'Battery depletion', confidence: 0.91, why: 'The battery may have been exhausted.' },
    { cause: 'Propulsion / motor cut-out event', confidence: 0.70, why: 'Explicit cut-out.' },
  ]);
  const cause = out.likely_causes.find(c => hypothesisDomain(`${c.cause} ${c.why}`) === 'battery');
  assert.equal(cause.confidence, 0.25);
});

test('post-validation reduces radio-loss confidence to the telemetry cap', () => {
  const out = checkedReport(incidentPacket(), [
    { cause: 'Radio link loss', confidence: 0.89, why: 'Signal loss may have triggered the event.' },
    { cause: 'Propulsion / motor cut-out event', confidence: 0.70, why: 'Explicit cut-out.' },
  ]);
  const cause = out.likely_causes.find(c => hypothesisDomain(`${c.cause} ${c.why}`) === 'radio');
  assert.equal(cause.confidence, 0.30);
});

test('post-validation reduces GPS-loss confidence to the telemetry cap', () => {
  const out = checkedReport(incidentPacket(), [
    { cause: 'GPS loss', confidence: 0.86, why: 'GNSS failure may have caused loss of control.' },
    { cause: 'Propulsion / motor cut-out event', confidence: 0.70, why: 'Explicit cut-out.' },
  ]);
  const cause = out.likely_causes.find(c => hypothesisDomain(`${c.cause} ${c.why}`) === 'gps');
  assert.equal(cause.confidence, 0.25);
});

test('restores propulsion evidence if the AI proposes only unsupported causes', () => {
  const out = checkedReport(incidentPacket(), [
    { cause: 'Magnetic disturbance', confidence: 0.95, why: 'Compass interference.' },
    { cause: 'Attitude instability', confidence: 0.90, why: 'Orientation failure.' },
  ]);
  assert.equal(hypothesisDomain(`${out.likely_causes[0].cause} ${out.likely_causes[0].why}`), 'propulsion');
  assert.equal(out.likely_causes[0].confidence, 0.94);
});

test('does not allow AI output to downgrade a critical deterministic risk', () => {
  const out = checkedReport(incidentPacket(), [
    { cause: 'Propulsion / motor cut-out event', confidence: 0.70, why: 'Explicit cut-out.' },
  ], 'medium', 0.40);
  assert.equal(out.risk_level, 'critical');
  assert.ok(out.confidence >= 0.92);
});

test('allows magnetic hypotheses when telemetry actually reports magnetic episodes', () => {
  const packet = incidentPacket({ magneto_episodes: 2 });
  const g = deriveEvidenceGuardrails(packet);
  assert.equal(g.blocked_domains.includes('magnetic'), false);
});

test('does not cap battery depletion when a low-battery episode is present', () => {
  const packet = incidentPacket({ low_batt_episodes: 1 });
  const g = deriveEvidenceGuardrails(packet);
  assert.equal(g.confidence_caps.battery_depletion, undefined);
});

test('does not cap radio loss when Wi-Fi crosses the severe threshold', () => {
  const packet = incidentPacket({ wifi_weakest_dbm: -85 });
  const g = deriveEvidenceGuardrails(packet);
  assert.equal(g.confidence_caps.radio, undefined);
});

test('does not cap GPS loss when satellite count is poor', () => {
  const packet = incidentPacket({ sat_median: 4 });
  const g = deriveEvidenceGuardrails(packet);
  assert.equal(g.confidence_caps.gps, undefined);
});

test('publishes a reproducible 88% magnetic adversarial probe', () => {
  const g = deriveEvidenceGuardrails(incidentPacket());
  assert.equal(g.validation_probe.hypothesis, 'Magnetic disturbance');
  assert.equal(g.validation_probe.proposed_confidence, 0.88);
  assert.equal(g.validation_probe.verdict, 'REJECTED');
  assert.match(g.validation_probe.telemetry_evidence, /magneto_episodes = 0/);
});

test('records the evidence, rule and verdict for a rejected hypothesis', () => {
  const out = checkedReport(incidentPacket(), [
    { cause: 'Magnetic disturbance', confidence: 0.88, why: 'Compass interference.' },
    { cause: 'Propulsion / motor cut-out event', confidence: 0.72, why: 'Explicit cut-out.' },
  ]);
  const decision = out.investigation_trace.find(item => item.domain === 'magnetic');
  assert.equal(decision.verdict, 'REJECTED');
  assert.equal(decision.proposed_confidence, 0.88);
  assert.match(decision.telemetry_evidence, /magneto_episodes = 0/);
  assert.match(decision.rule, /Block magnetic/);
});

test('records both proposed and final confidence for a capped hypothesis', () => {
  const out = checkedReport(incidentPacket(), [
    { cause: 'Radio link loss', confidence: 0.89, why: 'Signal loss.' },
    { cause: 'Propulsion / motor cut-out event', confidence: 0.72, why: 'Explicit cut-out.' },
  ]);
  const decision = out.investigation_trace.find(item => item.domain === 'radio');
  assert.equal(decision.verdict, 'CAPPED');
  assert.equal(decision.proposed_confidence, 0.89);
  assert.equal(decision.final_confidence, 0.30);
});

test('decision ledger records measured inputs and every rule vote for a rejection', () => {
  const out = checkedReport(incidentPacket(), [
    { cause: 'Magnetic disturbance', confidence: 0.88, why: 'Compass interference.' },
    { cause: 'Propulsion / motor cut-out event', confidence: 0.72, why: 'Explicit cut-out.' },
  ]);
  const entry = out.decision_ledger.entries.find(item => item.domain === 'magnetic');
  assert.equal(out.decision_ledger.schema, 'aerosage-decision-ledger-v1');
  assert.equal(entry.verdict, 'REJECTED');
  assert.equal(entry.telemetry_inputs[0].field, 'magneto_episodes');
  assert.equal(entry.telemetry_inputs[0].samples[0].value, 0);
  assert.ok(entry.rule_votes.some(vote => vote.rule_id === 'CSV_EVIDENCE_AUTHORITY' && vote.vote === 'AUTHORITATIVE'));
  assert.ok(entry.rule_votes.some(vote => vote.rule_id === 'MAGNETIC_ZERO_EVENT_BLOCK' && vote.vote === 'BLOCK'));
  assert.match(entry.resolution, /Suppressed because/);
});

test('decision ledger explains a capped competing hypothesis', () => {
  const out = checkedReport(incidentPacket(), [
    { cause: 'Radio link loss', confidence: 0.89, why: 'Signal loss.' },
    { cause: 'Propulsion / motor cut-out event', confidence: 0.72, why: 'Explicit cut-out.' },
  ]);
  const entry = out.decision_ledger.entries.find(item => item.domain === 'radio');
  assert.equal(entry.verdict, 'CAPPED');
  assert.equal(entry.final_confidence, 0.30);
  assert.ok(entry.rule_votes.some(vote => vote.rule_id === 'RADIO_THRESHOLD_CAP' && vote.vote === 'CAP'));
  assert.ok(out.decision_ledger.suppressed_competitors.some(item => item.hypothesis === 'Radio link loss'));
});

test('decision ledger records deterministic restoration when proposals omit propulsion', () => {
  const out = checkedReport(incidentPacket(), [
    { cause: 'Magnetic disturbance', confidence: 0.95, why: 'Compass interference.' },
    { cause: 'Attitude instability', confidence: 0.90, why: 'Orientation failure.' },
  ]);
  const restored = out.decision_ledger.entries.find(item => item.proposal_source === 'deterministic-baseline' && item.domain === 'propulsion');
  assert.equal(restored.verdict, 'ACCEPTED');
  assert.equal(restored.rule_votes[1].vote, 'RESTORE');
  assert.match(restored.resolution, /Restored from the deterministic baseline/);
});

test('provenance binds authoritative values to uploaded CSV target rows', () => {
  const provenance = buildEvidenceProvenance(incidentPacket());
  const magnetic = provenance.authoritative_signals.find(item => item.field === 'magneto_episodes');
  assert.equal(provenance.authority, 'uploaded telemetry');
  assert.deepEqual(Array.from(provenance.target_rows), [42]);
  assert.deepEqual(Array.from(magnetic.values), [0]);
  assert.equal(magnetic.source, 'uploaded CSV target rows');
});

test('provenance explicitly keeps telemetry outside model authority', () => {
  const provenance = buildEvidenceProvenance(incidentPacket());
  assert.match(provenance.model_boundary, /read-only/);
  assert.match(provenance.adjudication, /Deterministic rules/);
});

test('evidence manifest hashes the exact CSV bytes and identifies the ruleset', async () => {
  const csv = 'signal,value\nmagneto_episodes,0\n';
  const manifest = await buildEvidenceManifest(csv, 'nvidia/test-model', '2026-09-26T20:00:00.000Z');
  assert.equal(manifest.csv_sha256, await sha256Hex(csv));
  assert.equal(manifest.nemotron_model, 'nvidia/test-model');
  assert.equal(manifest.guardrail_ruleset, 'aerosage-guardrails-v1.3.0');
  assert.match(manifest.manifest_sha256, /^[a-f0-9]{64}$/);
});

test('evidence manifest digest changes when any covered field changes', async () => {
  const first = await buildEvidenceManifest('a,b\n1,2\n', 'model-a', '2026-09-26T20:00:00.000Z');
  const second = await buildEvidenceManifest('a,b\n1,3\n', 'model-a', '2026-09-26T20:00:00.000Z');
  assert.notEqual(first.csv_sha256, second.csv_sha256);
  assert.notEqual(first.manifest_sha256, second.manifest_sha256);
});

test('deterministic replay fingerprint is stable for identical evidence and verdict', async () => {
  const packet = incidentPacket();
  const report = checkedReport(packet, deterministicReport(packet).likely_causes);
  const first = await buildDeterministicReplayProof('a'.repeat(64), report);
  const second = await buildDeterministicReplayProof('a'.repeat(64), report);
  assert.equal(first.verdict_sha256, second.verdict_sha256);
  assert.equal(first.execution, 'deterministic-only; Nemotron and Tavily are not invoked');
});

test('deterministic replay fingerprint changes when the CSV identity changes', async () => {
  const packet = incidentPacket();
  const report = checkedReport(packet, deterministicReport(packet).likely_causes);
  const first = await buildDeterministicReplayProof('a'.repeat(64), report);
  const second = await buildDeterministicReplayProof('b'.repeat(64), report);
  assert.notEqual(first.verdict_sha256, second.verdict_sha256);
});

test('replay verification reports exact matches and mismatches', async () => {
  const packet = incidentPacket();
  const report = checkedReport(packet, deterministicReport(packet).likely_causes);
  const proof = await buildDeterministicReplayProof('a'.repeat(64), report);
  const matching = verifyReplay(proof.verdict_sha256, proof);
  const mismatch = verifyReplay('f'.repeat(64), proof);
  assert.equal(matching.status, 'MATCH');
  assert.equal(matching.exact_match, true);
  assert.equal(mismatch.status, 'MISMATCH');
  assert.equal(mismatch.exact_match, false);
});
