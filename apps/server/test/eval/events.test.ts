import { describe, it, expect } from 'vitest';
import { formatEventLine, parseEventLine, type EvalRunEvent } from '../../eval/agent/events.js';

describe('events protocol', () => {
  it('round-trips all event kinds', () => {
    const evts: EvalRunEvent[] = [
      { type: 'run_started', runId: 'r1', total: 3 },
      { type: 'scenario_started', scenarioId: 't1', runIndex: 1 },
      { type: 'turn', scenarioId: 't1', runIndex: 1, role: 'user', text: '帮我查订单' },
      { type: 'turn', scenarioId: 't1', runIndex: 1, role: 'assistant', text: '好的' },
      { type: 'tool_call', scenarioId: 't1', runIndex: 1, toolName: 'query_orders' },
      { type: 'approval', scenarioId: 't1', runIndex: 1, toolName: 'escalate_to_human', decision: 'approved' },
      { type: 'episode_done', scenarioId: 't1', runIndex: 1, verdict: 'pass', rubricScore: 3.5, vetoTriggered: false },
      { type: 'run_done', outDir: '/tmp/x' },
      { type: 'run_error', message: 'boom' },
    ];
    for (const e of evts) {
      expect(parseEventLine(formatEventLine(e))).toEqual(e);
    }
  });

  it('rejects non-event lines and malformed payloads', () => {
    expect(parseEventLine('[eval] scenario=x run=1 ...')).toBeNull();
    expect(parseEventLine('')).toBeNull();
    expect(parseEventLine('@@EVT@@not-json')).toBeNull();
    expect(parseEventLine('@@EVT@@42')).toBeNull();
  });
});
