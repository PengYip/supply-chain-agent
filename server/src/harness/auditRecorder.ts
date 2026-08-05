// Minimal audit recorder for Phase 2.
// Collects tool-call records into an in-memory array and prints a structured
// single-line JSON log to stdout (so it is observable during dev/tests).
//
// V2 plan: persist each record to a Postgres `audit` table and thread a
// `trace_id` through the whole call chain (request -> step -> tool call) so the
// full agent trajectory can be reconstructed and audited.

export interface ToolCallRecord {
  toolName: string;
  args: unknown;
  result: unknown;
  durationMs: number;
  timestamp: string;
}

export interface RecordToolCallInput {
  toolName: string;
  args: unknown;
  result: unknown;
  durationMs: number;
}

export interface AuditRecorder {
  recordToolCall(input: RecordToolCallInput): void;
  records: ToolCallRecord[];
}

export function createAuditRecorder(): AuditRecorder {
  const records: ToolCallRecord[] = [];
  return {
    records,
    recordToolCall({ toolName, args, result, durationMs }) {
      const record: ToolCallRecord = {
        toolName,
        args,
        result,
        durationMs,
        timestamp: new Date().toISOString(),
      };
      records.push(record);
      // Structured single-line JSON for easy grep/log shipping.
      console.log(JSON.stringify({ event: 'tool_call', ...record }));
    },
  };
}

// Shared MVP instance used by the query tools.
// V2 will construct a per-request recorder bound to a trace_id instead.
export const auditRecorder = createAuditRecorder();
