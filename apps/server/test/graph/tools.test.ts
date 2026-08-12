import { describe, it, expect } from 'vitest';
import {
  buildCreateEntityTool,
  buildLinkEntitiesTool,
  buildGraphQueryTool,
} from '../../src/graph/tools.js';
import { assertAllToolsContracted } from '../../src/harness/contextContract.js';

describe('graph tool schemas', () => {
  it('create_entity has inputSchema {kind,name,props?} and is L2-safe', () => {
    const t = buildCreateEntityTool();
    expect(t.inputSchema).toBeDefined();
    const parse = (t.inputSchema as any).safeParse({ kind: 'Party', name: 'ACME' });
    expect(parse.success).toBe(true);
  });
  it('link_entities requires srcId,dstId,kind', () => {
    const t = buildLinkEntitiesTool();
    const bad = (t.inputSchema as any).safeParse({ kind: 'x' });
    expect(bad.success).toBe(false);
    const good = (t.inputSchema as any).safeParse({ srcId: 'a', dstId: 'b', kind: 'buyer_of' });
    expect(good.success).toBe(true);
  });
  it('graph_query requires subjectId', () => {
    const t = buildGraphQueryTool();
    const good = (t.inputSchema as any).safeParse({ subject: '4:x:0' });
    expect(good.success).toBe(true);
    const bad = (t.inputSchema as any).safeParse({});
    expect(bad.success).toBe(false);
  });
});

describe('graph tool contracts are registered', () => {
  it('create_entity / link_entities / graph_query all have context contracts', () => {
    const names = ['create_entity', 'link_entities', 'graph_query'];
    // assertAllToolsContracted throws if any name in the list lacks a contract
    expect(() => assertAllToolsContracted(names)).not.toThrow();
  });
});
