// apps/web/src/components/review-workbench/ReviewWorkbench.tsx
// 全页集中复核工作台(spec 2026-09-04): 左原文页 + 右类型分组可编辑表格。
// Task 7 骨架; Task 8 表格 / Task 9 原文栏 / Task 10 键盘流与批量操作。
import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { RotateCw } from 'lucide-react';
import { fetchReviewWorkbench, type WorkbenchData } from '../../api/reviewWorkbench';
import { UnitListGroup } from './UnitListGroup';

export function ReviewWorkbench({ docId }: { docId?: string }) {
  const [data, setData] = useState<WorkbenchData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState(0);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const d = await fetchReviewWorkbench(id);
      setData(d);
      const idx = d.groups.findIndex((g) => g.kind === 'voucher-table');
      setActiveGroup(idx >= 0 ? idx : 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (docId) void load(docId);
    else setData(null);
  }, [docId, load]);

  const progress = useMemo(() => {
    const units = data?.groups.flatMap((g) => g.units) ?? [];
    const pending = units.filter(
      (u) => u.reviewStatus === 'pending' || u.reviewStatus === 'corrected',
    ).length;
    const released = units.filter((u) => u.reviewAction === 'auto-release').length;
    const confirmed = units.filter(
      (u) => u.reviewStatus === 'confirmed' && u.reviewAction !== 'auto-release',
    ).length;
    return { total: units.length, pending, released, confirmed };
  }, [data]);

  if (!docId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-sm text-ink-soft">
        <span>请从文件面板选择一个单据组，点击「集中复核」进入</span>
      </div>
    );
  }
  if (loading && !data) {
    return <div className="p-10 text-center text-sm text-ink-soft">加载中...</div>;
  }
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-sm">
        <span className="text-danger">{error}</span>
        <button
          type="button"
          onClick={() => void load(docId)}
          className="inline-flex cursor-pointer items-center gap-1 rounded border border-line px-3 py-1.5 text-xs text-ink transition-colors hover:bg-surface"
        >
          <RotateCw className="h-3.5 w-3.5" aria-hidden />
          重试
        </button>
      </div>
    );
  }
  if (!data) return null;

  const group = data.groups[activeGroup];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏: 标题 + 分组 chips + 进度(批量操作按钮 Task 10 加) */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="max-w-[280px] truncate text-sm font-semibold text-ink" title={data.containerTitle}>
          {data.containerTitle}
        </span>
        <div className="flex flex-wrap items-center gap-1">
          {data.groups.map((g, i) => (
            <button
              key={g.docType}
              type="button"
              onClick={() => setActiveGroup(i)}
              className={clsx(
                'cursor-pointer whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
                i === activeGroup
                  ? 'border-primary bg-primary/10 font-medium text-primary'
                  : 'border-line bg-surface text-ink-soft hover:border-ink-soft/40 hover:text-ink',
              )}
            >
              {g.docType} {g.units.length}
            </button>
          ))}
        </div>
        <span className="ml-auto whitespace-nowrap text-xs text-ink-soft">
          待复核 {progress.pending} / 已放行 {progress.released} / 已确认 {progress.confirmed} / 共 {progress.total}
        </span>
      </div>

      {/* 两栏主体: 左原文(Task 9) + 右表格(Task 8) */}
      <div className="flex min-h-0 flex-1">
        <div className="hidden w-[38%] shrink-0 border-r border-line lg:block" data-original-pane>
          {/* Task 9: OriginalPane */}
        </div>
        <div className="min-w-0 flex-1" data-voucher-table>
          {group?.kind === 'unit-list' ? (
            <div className="h-full overflow-auto">
              <UnitListGroup units={group.units} />
            </div>
          ) : group ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-ink-soft">
              {/* Task 8: VoucherTable */}
              {group.units.reduce((s, u) => s + (u.rows?.length ?? 0), 0)} 行明细，表格组件待接入
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default ReviewWorkbench;