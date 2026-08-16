// apps/server/eval/agent/events.ts
// Event protocol between the eval runner child process and the server.
// stdout lines prefixed @@EVT@@ are machine events; human logs go to stderr
// so stdout stays line-parseable. Server side mirrors these types in
// src/routes/evalRunCore.ts (src cannot import eval/** per tsconfig rootDir).
export const EVT_PREFIX = '@@EVT@@';

export type EvalRunEvent =
  | { type: 'run_started'; runId: string; total: number }
  | { type: 'scenario_started'; scenarioId: string; runIndex: number }
  | { type: 'turn'; scenarioId: string; runIndex: number; role: 'user' | 'assistant' | 'system-note'; text: string }
  | { type: 'tool_call'; scenarioId: string; runIndex: number; toolName: string }
  | { type: 'approval'; scenarioId: string; runIndex: number; toolName: string; decision: 'approved' | 'denied' }
  | { type: 'episode_done'; scenarioId: string; runIndex: number; verdict: string; rubricScore: number | null; vetoTriggered: boolean }
  | { type: 'run_done'; outDir: string }
  | { type: 'run_error'; message: string };

export function formatEventLine(e: EvalRunEvent): string {
  return EVT_PREFIX + JSON.stringify(e);
}

export function parseEventLine(line: string): EvalRunEvent | null {
  const t = line.trim();
  if (!t.startsWith(EVT_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(t.slice(EVT_PREFIX.length));
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (!('type' in parsed) || typeof (parsed as { type: unknown }).type !== 'string') return null;
    return parsed as EvalRunEvent;
  } catch {
    return null;
  }
}
