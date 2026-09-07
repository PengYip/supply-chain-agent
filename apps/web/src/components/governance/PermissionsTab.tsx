// apps/web/src/components/governance/PermissionsTab.tsx
import { useEffect, useState } from 'react';
import { fetchPermissionSnapshot, type PermissionSnapshotDTO } from '../../api/governance';
import { permissionMatrixRows } from './governanceModel';
import { Section, Provenance } from './OntologyTab';

/** 治理 Tab 3 权限矩阵：L1/L2/L3 x 工具（列来自快照 levels，不硬编码）。 */
export function PermissionsTab() {
  const [snap, setSnap] = useState<PermissionSnapshotDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchPermissionSnapshot()
      .then((s) => { if (alive) setSnap(s); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  if (error) return <div className="rounded-lg border border-line bg-white p-4 text-sm text-danger">{error}</div>;
  if (!snap) return <div className="rounded-lg border border-line bg-white p-4 text-sm text-ink-soft">加载中...</div>;

  const { levels, rows } = permissionMatrixRows(snap);

  return (
    <div className="max-w-6xl space-y-4 pb-2">
      <Section title={`权限矩阵（注册声明 ${rows.length} 条）`}>
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-soft">
                <th className="px-3 py-2 font-medium">工具</th>
                {levels.map((l) => <th key={l} className="px-3 py-2 text-center font-medium">{l}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.toolName} className="border-b border-line/60 last:border-b-0">
                  <td className="px-3 py-1.5 font-mono text-xs text-ink">{r.toolName}</td>
                  {levels.map((l) => (
                    <td key={l} className="px-3 py-1.5 text-center text-xs">
                      {r.level === l
                        ? <span className={l === 'L2' ? 'text-amber-600' : 'text-primary'}>{l}</span>
                        : <span className="text-ink-soft/30">-</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-ink-soft">{snap.note}</p>
      </Section>

      <Provenance text={`数据出处：${snap.source}（经 GET /api/tools/permissions）`} />
    </div>
  );
}
