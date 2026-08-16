// apps/server/eval/agent/scoring.ts
// Verdict aggregation (book Ch6 aggregation skeleton): deterministic verifier
// failures and judge vetoes are applied FIRST; only then do rubric scores and
// the essential-gate / low-confidence rules decide the final verdict.
import type { EpisodeArtifact, EpisodeScore, JudgeOutcome, Weight } from './types.js';
import type { VerifierResult } from './verifiers.js';

const WEIGHT_FACTOR: Record<Weight, number> = { essential: 1, important: 0.75, optional: 0.5 };
const LOW_CONFIDENCE_THRESHOLD = 0.6;
const ESSENTIAL_FLOOR = 2;

export function aggregateScore(
  artifact: EpisodeArtifact,
  verifier: VerifierResult,
  judge: JudgeOutcome | null,
): EpisodeScore {
  const base = {
    scenarioId: artifact.scenarioId,
    runIndex: artifact.runIndex,
    verifierFailures: verifier.failures,
    judge,
    firstFailure: verifier.failures[0] ?? null,
  };

  // 1. Simulator failure -> sim_error (verifier failures still recorded).
  if (artifact.simError) {
    return { ...base, verdict: 'sim_error', rubricScore: null, vetoTriggered: false };
  }
  // 2. Deterministic veto first (environment ground truth).
  if (!verifier.passed) {
    return { ...base, verdict: 'fail', rubricScore: null, vetoTriggered: false };
  }
  // 3. Judge unavailable -> judge_error (never auto-pass).
  if (!judge || !judge.ok) {
    return { ...base, verdict: 'judge_error', rubricScore: null, vetoTriggered: false };
  }
  // 4. Hallucination veto -> fail regardless of dimension scores.
  if (judge.vetoTriggered) {
    return { ...base, verdict: 'fail', rubricScore: 0, vetoTriggered: true };
  }
  // 5. Essential gate: any essential dimension below floor -> fail.
  const essentialFailed = judge.dimensions.some(
    (d) => d.weight === 'essential' && d.score < ESSENTIAL_FLOOR,
  );
  if (essentialFailed) {
    return { ...base, verdict: 'fail', rubricScore: null, vetoTriggered: false };
  }
  // 6. Weighted rubric mean.
  const totalWeight = judge.dimensions.reduce((s, d) => s + WEIGHT_FACTOR[d.weight], 0);
  const rubricScore =
    totalWeight === 0
      ? null
      : Number(
          (
            judge.dimensions.reduce((s, d) => s + d.score * WEIGHT_FACTOR[d.weight], 0) /
            totalWeight
          ).toFixed(3),
        );
  // 7. Low judge confidence -> human review, not auto-pass.
  if (judge.confidence < LOW_CONFIDENCE_THRESHOLD) {
    return { ...base, verdict: 'needs_human_review', rubricScore, vetoTriggered: false };
  }
  return { ...base, verdict: 'pass', rubricScore, vetoTriggered: false };
}
