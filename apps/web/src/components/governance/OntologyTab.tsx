// apps/web/src/components/governance/OntologyTab.tsx
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { fetchOntologySchema, type OntologySchemaDTO } from '../../api/ontology';
import { clsx } from 'clsx';

/** 治理 Tab 1 本体：类/关系/枚举/meaning 全量渲染。
 *  数据出处：apps/server/src/ontology/index.ts（经 GET /api/ontology/schema）。 */
export function OntologyTab() {
  const [schema, setSchema] = useState<OntologySchemaDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchOntologySchema()
      .then((s) => { if (alive) setSchema(s); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  if (error) return <div className="rounded-lg border border-line bg-white p-4 text-sm text-danger">{error}</div>;
  if (!schema) return <div className="rounded-lg border border-line bg-white p-4 text-sm text-ink-soft">加载中...</div>;

  return (
    <div className="max-w-6xl space-y-4 pb-2">
      <Section title={`实体（${schema.entities.length}）`}>
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-soft">
                <th className="px-3 py-2 font-medium">名称</th>
                <th className="px-3 py-2 font-medium">标签</th>
                <th className="px-3 py-2 font-medium">自有字段</th>
                <th className="px-3 py-2 font-medium">全字段（含 mixin）</th>
                <th className="px-3 py-2 font-medium">meaning</th>
              </tr>
            </thead>
            <tbody>
              {schema.entities.map((e) => (
                <tr key={e.name} className="border-b border-line/60 last:border-b-0">
                  <td className="px-3 py-2 font-mono text-xs text-ink">{e.name}</td>
                  <td className="px-3 py-2 text-ink">{e.label}</td>
                  <td className="px-3 py-2 text-xs text-ink-soft">{e.ownFields.join('、')}</td>
                  <td className="px-3 py-2 text-xs text-ink-soft">{e.fields.length}</td>
                  <td className="px-3 py-2">
                    {e.meaning
                      ? <span className="font-mono text-xs text-primary">{e.meaning}</span>
                      : <span className="text-xs text-ink-soft/60">未挂载</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={`关系（${schema.relations.length}）`}>
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {schema.relations.map((r) => (
            <div key={r.name} className="rounded-lg border border-line bg-white p-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-medium text-ink">{r.name}</span>
                {r.meaning && <span className="font-mono text-xs text-primary">{r.meaning}</span>}
              </div>
              <p className="mt-1 text-xs text-ink-soft">{r.description}</p>
              <div className="mt-2 space-y-0.5 text-xs text-ink-soft">
                {r.pairs.map((p, i) => (
                  <div key={i} className="font-mono">{p.from} -&gt; {p.to}</div>
                ))}
              </div>
              <div className="mt-2 text-xs text-ink-soft">
                params: {r.params.length ? r.params.join('、') : '（无参关系）'}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="枚举与开放词汇">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {Object.entries(schema.enums).map(([name, values]) => (
            <div key={name} className="rounded-lg border border-line bg-white p-3">
              <div className="font-mono text-xs font-medium text-ink">{name}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {values.length === 0
                  ? <span className="text-xs text-ink-soft/60">（空：待业务确认）</span>
                  : values.map((v) => (
                    <span key={v} className="rounded bg-surface px-1.5 py-0.5 text-xs text-ink">{v}</span>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Provenance text={`数据出处：apps/server/src/ontology/index.ts（本体注册表 SSOT）经 GET /api/ontology/schema，version ${schema.version}`} />
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium text-ink">{title}</h3>
      {children}
    </section>
  );
}

export function Provenance({ text }: { text: string }) {
  return (
    <p className={clsx('rounded border border-dashed border-line bg-white/60 px-3 py-2 text-xs text-ink-soft')}>
      {text}
    </p>
  );
}
