import { describe, it, expect } from 'vitest';
import {
  buildCreateEntityTool,
  buildLinkEntitiesTool,
  buildGraphQueryTool,
  buildGraphFindEntityTool,
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
  it('graph_find_entity requires name; kind enum optional', () => {
    const t = buildGraphFindEntityTool();
    expect((t.inputSchema as any).safeParse({ name: '中石化' }).success).toBe(true);
    expect((t.inputSchema as any).safeParse({ kind: 'Party', name: '中石化', exact: true }).success).toBe(true);
    expect((t.inputSchema as any).safeParse({ kind: 'Bogus', name: 'x' }).success).toBe(false);
    expect((t.inputSchema as any).safeParse({}).success).toBe(false);
  });
});

describe('graph tool contracts are registered', () => {
  it('create_entity / link_entities / graph_query all have context contracts', () => {
    const names = ['create_entity', 'link_entities', 'graph_query', 'graph_find_entity'];
    // assertAllToolsContracted throws if any name in the list lacks a contract
    expect(() => assertAllToolsContracted(names)).not.toThrow();
  });
});
