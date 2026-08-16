// apps/web/src/api/evalRunTypes.ts
export type RunEvent =
  | { type: 'run_started'; runId: string; total: number }
  | { type: 'scenario_started'; scenarioId: string; runIndex: number }
  | { type: 'turn'; scenarioId: string; runIndex: number; role: 'user' | 'assistant' | 'system-note'; text: string }
  | { type: 'tool_call'; scenarioId: string; runIndex: number; toolName: string }
  | { type: 'approval'; scenarioId: string; runIndex: number; toolName: string; decision: 'approved' | 'denied' }
  | { type: 'episode_done'; scenarioId: string; runIndex: number; verdict: string; rubricScore: number | null; vetoTriggered: boolean }
  | { type: 'run_done'; outDir: string }
  | { type: 'run_error'; message: string };

export interface LiveInfo {
  runId: string;
  state: 'running' | 'done' | 'error';
  events: RunEvent[];
  error: string | null;
}
