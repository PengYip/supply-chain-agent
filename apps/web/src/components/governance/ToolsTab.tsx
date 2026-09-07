// apps/web/src/components/governance/ToolsTab.tsx
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { fetchToolInventory, type ToolInventoryDTO } from '../../api/governance';
import { toolRowFlags } from './governanceModel';
import { Section, Provenance } from './OntologyTab';

/** 治理 Tab 2 工具面：tool-inventory SSOT 视图化 x 注册表实测对比。
 *  deprecated 且仍挂载的工具如实红标呈现（含 removalPlan），不掩饰漂移。 */
export function ToolsTab() {
  const [inv, setInv] = useState<ToolInventoryDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchToolInventory()
      .then((d) => { if (alive) setInv(d); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  if (error) return <div className="rounded-lg border border-line bg-white p-4 text-sm text-danger">{error}</div>;
  if (!inv) return <div className="rounded-lg border border-line bg-white p-4 text-sm text-ink-soft">加载中...</div>;

  return (
    <div className="max-w-6xl space-y-4 pb-2">
      <div className="flex flex-wrap items-center gap-3 text-xs text-ink-soft">
        <span>inventory version {inv.version}</span>
        <span>注册表实测挂载（trader）：{inv.mountedCount} 个</span>
        {(inv.diff.mountedNotInInventory.length > 0 || inv.diff.inventoryNotMounted.length > 0) && (
          <span className="rounded bg-danger/10 px-1.5 py-0.5 text-danger">
            漂移：挂载多出 {inv.diff.mountedNotInInventory.join('、') || '无'}；inventory 缺挂载 {inv.diff.inventoryNotMounted.join('、') || '无'}
          </span>
        )}
      </div>

      <Section title={`工具清单（${inv.tools.length}）`}>
        <div className="space-y-2">
          {inv.tools.map((t) => {
            const flags = toolRowFlags(t);
            return (
              <div key={t.name} className={clsx('rounded-lg border bg-white p-3',
                flags.deprecatedMounted ? 'border-danger/40' : 'border-line')}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-medium text-ink">{t.name}</span>
                  <Badge>{t.layer}</Badge>
                  <Badge accent={t.level === 'L2'}>{t.level}</Badge>
                  <Badge accent={t.status === 'deprecated'}>{t.status}</Badge>
                  <Badge>mount: {t.mount}</Badge>
                  <Badge accent={flags.deprecatedMounted}>
                    {t.registry.mounted ? '注册表：已挂载' : '注册表：未挂载'}
                  </Badge>
                  {t.registry.mounted && (
                    <Badge accent={t.registry.needsApproval}>
                      {t.registry.needsApproval ? 'needsApproval（L2 软门控）' : '自动执行'}
                    </Badge>
                  )}
                  {flags.envGated && t.requiresEnv && <Badge>{t.requiresEnv}</Badge>}
                </div>
                <dl className="mt-2 space-y-1 text-xs text-ink-soft">
                  <div><dt className="inline font-medium text-ink">何时用：</dt><dd className="inline"> {t.whenToUse}</dd></div>
                  <div><dt className="inline font-medium text-ink">边界：</dt><dd className="inline"> {t.boundary}</dd></div>
                  <div><dt className="inline font-medium text-ink">存留理由：</dt><dd className="inline"> {t.rationale}</dd></div>
                  {t.removalPlan && (
                    <div className={clsx(flags.deprecatedMounted && 'text-danger')}>
                      <dt className="inline font-medium">移除计划：</dt><dd className="inline"> {t.removalPlan}</dd>
                    </div>
                  )}
                </dl>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title={`removed 黑名单（${inv.removed.length}，防回潮）`}>
        <div className="rounded-lg border border-line bg-white p-3 text-xs text-ink-soft">
          {inv.removed.map((r) => (
            <div key={r.name} className="py-0.5">
              <span className="font-mono text-ink">{r.name}</span>
              {r.mergedInto && <span className="font-mono"> -&gt; {r.mergedInto}</span>}
              <span>：{r.reason}</span>
            </div>
          ))}
        </div>
      </Section>

      <Provenance text={`数据出处：docs/tool-inventory.json（工具面 SSOT, version ${inv.version}）x 角色工具注册表实测挂载（apps/server/src/harness/roleToolRegistry.ts，经 GET /api/tools/inventory）`} />
    </div>
  );
}

function Badge({ children, accent = false }: { children: ReactNode; accent?: boolean }) {
  return (
    <span className={clsx('rounded px-1.5 py-0.5 text-xs',
      accent ? 'bg-amber-100 text-amber-700' : 'bg-surface text-ink-soft')}>
      {children}
    </span>
  );
}
