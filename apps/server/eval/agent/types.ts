// Scenario schema + episode artifact/score types for the LLM-as-judge agent eval.
// Book Ch6 methodology: dataset = persona (user sim) + verifiers (deterministic,
// veto-first) + rubric (LLM judge dimensions with behavior anchors).

import { z } from 'zod';

// ---- scenario schema ----

export const WeightSchema = z.enum(['essential', 'important', 'optional']);
export type Weight = z.infer<typeof WeightSchema>;

export const DimensionSchema = z.object({
  name: z.string().min(1),
  weight: WeightSchema,
  /** Score anchors keyed "4".."1"; each value is a verifiable behavior description. */
  scoring: z.record(z.string()),
});
export type Dimension = z.infer<typeof DimensionSchema>;

export const ApprovalRuleSchema = z.object({
  tool: z.string().min(1),
  ifField: z.string().min(1),
  op: z.enum(['>', '<', '>=', '<=', '==', '!=']),
  value: z.union([z.number(), z.string()]),
  action: z.enum(['approve', 'reject']),
});
export type ApprovalRule = z.infer<typeof ApprovalRuleSchema>;

export const ApprovalPolicySchema = z.object({
  default: z.enum(['approve', 'reject']).default('approve'),
  rules: z.array(ApprovalRuleSchema).default([]),
});
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;

export const PersonaSchema = z.object({
  facts: z.array(z.string()).min(1),
  disclosure: z.string().min(1),
  goal: z.string().min(1),
  patience: z.number().int().min(1).default(3),
});
export type Persona = z.infer<typeof PersonaSchema>;

export const VerifierChecksSchema = z.object({
  /** Contract.linkedDocuments must contain the documentId. */
  contractLinked: z.array(z.object({ contractNo: z.string(), documentId: z.string() })).default([]),
  /** Tool names that MUST appear in the episode (flow-compliance check). */
  mustAppear: z.array(z.string()).default([]),
  /** Tool names that MUST NOT appear. */
  forbidden: z.array(z.string()).default([]),
  /** Substrings that must appear in the final assistant reply (content check). */
  keywordInReply: z.array(z.string()).default([]),
  /** Substrings that must appear in ANY assistant turn across the episode.
   * Use for multi-turn flows where the fact-of-record is stated mid-conversation
   * and the final turn may be a wrap-up/farewell. */
  keywordInTranscript: z.array(z.string()).default([]),
});
export type VerifierChecks = z.infer<typeof VerifierChecksSchema>;

export const RubricSchema = z.object({
  dimensions: z.array(DimensionSchema).min(1),
  veto: z.object({ hallucination: z.string() }).optional(),
});
export type Rubric = z.infer<typeof RubricSchema>;

export const ScenarioSchema = z.object({
  id: z.string().min(1),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  capability: z.array(z.string()).default([]),
  persona: PersonaSchema,
  approvalPolicy: ApprovalPolicySchema.default({ default: 'approve', rules: [] }),
  maxTurns: z.number().int().min(1).max(20).default(8),
  verifiers: VerifierChecksSchema.default({
    contractLinked: [],
    mustAppear: [], forbidden: [], keywordInReply: [], keywordInTranscript: [],
  }),
  rubric: RubricSchema,
});
export type Scenario = z.infer<typeof ScenarioSchema>;

// ---- episode artifact (trajectory + outcome the scorers consume) ----

export interface ToolCallObservation {
  toolName: string;
  args: unknown;
  result: unknown;
  durationMs: number;
}

export interface ApprovalObservation {
  id: string;
  level: 'L2' | 'L3';
  toolName: string;
  input: unknown;
  decision: 'approved' | 'denied';
  reason: string;
  matchedRule?: string;
}

export interface EnvSnapshot {
  contractLinked: Record<string, string[]>;
}

export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'system-note';
  text: string;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface EpisodeArtifact {
  scenarioId: string;
  runIndex: number;
  sessionId: string;
  startedAt: string;
  wallMs: number;
  turnsUsed: number;
  transcript: TranscriptEntry[];
  toolCalls: ToolCallObservation[];
  approvals: ApprovalObservation[];
  envSnapshot: EnvSnapshot;
  finalAssistantText: string;
  totalUsage: UsageSummary;
  simError?: string;
}

// ---- scoring ----

export interface VerifierFailure {
  check: string;
  detail: string;
}

export interface JudgeDimensionScore {
  name: string;
  weight: Weight;
  score: number;
  rationale: string;
}

export interface JudgeOutcome {
  ok: boolean;
  error?: string;
  dimensions: JudgeDimensionScore[];
  vetoTriggered: boolean;
  vetoRationale?: string;
  confidence: number;
}

export type Verdict = 'pass' | 'fail' | 'sim_error' | 'judge_error' | 'needs_human_review';

export interface EpisodeScore {
  scenarioId: string;
  runIndex: number;
  verdict: Verdict;
  verifierFailures: VerifierFailure[];
  judge: JudgeOutcome | null;
  /** Weighted 1-4 mean across rubric dimensions; null when judge failed. */
  rubricScore: number | null;
  vetoTriggered: boolean;
  firstFailure: VerifierFailure | null;
}
