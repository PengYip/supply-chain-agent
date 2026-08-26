import { describe, expect, it } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';

describe('template tables DDL', () => {
  it('migrate 后三张模板表存在', () => {
    const ctx = createDb();
    migrate(ctx.sqlite);
    const rows = ctx.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'template_%' ORDER BY name",
    ).all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual([
      'template_edge_rules', 'template_types', 'template_versions',
    ]);
  });

  it('template_types kind+name 唯一约束生效', () => {
    const ctx = createDb();
    migrate(ctx.sqlite);
    ctx.sqlite.prepare(
      "INSERT INTO template_types (id, kind, name) VALUES ('dt-x', 'doc_type', 'X单')",
    ).run();
    expect(() =>
      ctx.sqlite.prepare(
        "INSERT INTO template_types (id, kind, name) VALUES ('dt-x2', 'doc_type', 'X单')",
      ).run(),
    ).toThrow();
  });
});
