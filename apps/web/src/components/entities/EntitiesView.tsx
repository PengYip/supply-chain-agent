import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { fetchOntologySchema, type OntologyEntitySchemaDTO } from '../../api/ontology';

/** 实体台账(roadmap Item 3)：类型列表由注册表 schema 驱动，空源类型显示空态不报错。 */
export function EntitiesView() {
  const [schema, setSchema] = useState<OntologyEntitySchemaDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchOntologySchema()
      .then((s) => { if (alive) setSchema(s.entities); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  const active = schema?.find((e) => e.name === selected) ?? null;

  return (
    <div className="flex h-full min-w-0 bg-surface/40">
      <aside className="h-full w-64 shrink-0 overflow-y-auto border-r border-line bg-white">
        <div className="px-4 pb-2 pt-4 text-xs font-medium text-ink-soft">实体类型（本体注册表）</div>
        {error && <div className="px-4 py-2 text-sm text-danger">{error}</div>}
        {!error && schema === null && <div className="px-4 py-2 text-sm text-ink-soft">加载中...</div>}
        {schema?.map((e) => (
          <button
            key={e.name}
            type="button"
            onClick={() => setSelected(e.name)}
            className={clsx(
              'block w-full px-4 py-2 text-left text-sm transition-colors',
              selected === e.name
                ? 'bg-surface font-medium text-ink'
                : 'text-ink-soft hover:bg-surface/60 hover:text-ink',
            )}
          >
            {e.label}
          </button>
        ))}
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
        {active ? (
          <div className="rounded-lg border border-line bg-white p-6 text-center text-sm text-ink-soft">
            「{active.label}」列表加载中...（Task 10 接入数据）
          </div>
        ) : (
          <div className="rounded-lg border border-line bg-white p-6 text-center text-sm text-ink-soft">
            从左侧选择实体类型
          </div>
        )}
      </div>
    </div>
  );
}
