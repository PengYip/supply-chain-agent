// apps/web/src/components/review-workbench/ReviewWorkbench.tsx
// 全页集中复核工作台(spec 2026-09-04): 左原文页 + 右类型分组可编辑表格。
// Task 7 骨架; Task 8 表格 / Task 9 原文栏 / Task 10 键盘流与批量操作。
import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { RotateCw } from 'lucide-react';
import {
  fetchReviewWorkbench,
  submitReviewBatch,
  submitRowCorrections,
  type WorkbenchData,
  type WorkbenchRow,
  type WorkbenchUnit,
} from '../../api/reviewWorkbench';
import { OriginalPane } from './OriginalPane';
import { UnitListGroup } from './UnitListGroup';
import { useWorkbenchKeyboard } from './useWorkbenchKeyboard';
import { VoucherTable } from './VoucherTable';
import {
  checkRow,
  isUnitConfirmable,
  type WorkbenchTableDocType,
} from './workbenchModel';

export function ReviewWorkbench({ docId }: { docId?: string }) {
  const [data, setData] = useState<WorkbenchData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState(0);
  const [checkedRows, setCheckedRows] = useState<Set<string>>(() => new Set());
  const [editedDocs, setEditedDocs] = useState<Set<string>>(() => new Set());
  const [rowEdits, setRowEdits] = useState<Record<string, WorkbenchRow[]>>({});
  const [selected, setSelected] = useState<{ docId: string; rowIndex: number } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [autoJump, setAutoJump] = useState<boolean>(
    () => localStorage.getItem('sca.reviewAutoJump') === '1',
  );
  const [batchBusy, setBatchBusy] = useState(false);
  const [releaseArmed, setReleaseArmed] = useState(false); // 一键放行两步确认

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const d = await fetchReviewWorkbench(id);
      setData(d);
      // docId 切换: 清空行级客户端状态(已核勾选/编辑中行/选中行/操作错误)
      setCheckedRows(new Set());
      setEditedDocs(new Set());
      setRowEdits({});
      setSelected(null);
      setActionError(null);
      const idx = d.groups.findIndex((g) => g.kind === 'voucher-table');
      setActiveGroup(idx >= 0 ? idx : 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const toggleRow = (key: string) => {
    setCheckedRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // 单元格提交: 更新 working copy -> 整数组 corrections 提交 -> 成功标记已改;
  // 失败回退编辑前值并提示。
  const handleCellCommit = async (
    unit: WorkbenchUnit,
    rowIndex: number,
    column: string,
    raw: string,
  ) => {
    const before = rowEdits[unit.docId] ?? unit.rows ?? [];
    const numeric = ['毛重_吨', '皮重_吨', '净重_吨', '票重_吨', '盈亏_吨'].includes(column);
    const n = Number(raw);
    const parsed: string | number = numeric
      ? raw.trim() === ''
        ? ''
        : Number.isFinite(n)
          ? n
          : raw
      : raw;
    const next = before.map((r, i) => (i === rowIndex ? { ...r, [column]: parsed } : r));
    setRowEdits((prev) => ({ ...prev, [unit.docId]: next }));
    try {
      await submitRowCorrections(unit.docId, next);
      setEditedDocs((prev) => new Set(prev).add(unit.docId));
      setActionError(null);
    } catch (e) {
      setRowEdits((prev) => ({ ...prev, [unit.docId]: before }));
      setActionError(`更正失败(${unit.title} 第 ${rowIndex + 1} 行): ${e instanceof Error ? e.message : String(e)}`);
    }
  };

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

  // 左栏派生值: 选中行所属 unit + 选中行 页码(行->页锚定, Task 9)
  const selectedUnit = useMemo(() => {
    if (!selected || !data) return null;
    for (const g of data.groups) {
      const u = g.units.find((x) => x.docId === selected.docId);
      if (u) return u;
    }
    return null;
  }, [data, selected]);

  const selectedPage = useMemo(() => {
    if (!selectedUnit || !selected) return null;
    const rows = rowEdits[selectedUnit.docId] ?? selectedUnit.rows ?? [];
    const page = rows[selected.rowIndex]?.['页码'];
    return typeof page === 'number' ? page : null;
  }, [selectedUnit, selected, rowEdits]);

  const group = data?.groups[activeGroup] ?? null;

  // 批量操作派生值 + 键盘流(Task 10)。当前行序列/问题行/可确认/可放行/两步确认。
  const flatRows = useMemo(() => {
    // 当前行序列: [docId, rowIndex, row, unit] 用于 Enter/F8 导航
    if (!group || group.kind !== 'voucher-table') return [];
    const out: Array<{
      unit: (typeof group.units)[number];
      rowIndex: number;
      row: Record<string, string | number | null>;
    }> = [];
    for (const u of group.units) {
      const rows = rowEdits[u.docId] ?? u.rows ?? [];
      rows.forEach((r, i) => out.push({ unit: u, rowIndex: i, row: r }));
    }
    return out;
  }, [group, rowEdits]);

  const docTypeOfGroup = (group?.kind === 'voucher-table' ? group.docType : null) as WorkbenchTableDocType | null;

  const isProblemRow = (item: (typeof flatRows)[number]) =>
    checkRow(item.row, docTypeOfGroup ?? '汽运磅单').some((i) => i.severity === 'error') ||
    item.unit.needsReview ||
    item.unit.warnings.length > 0;

  const confirmableUnits = useMemo(() => {
    if (!group) return [];
    return group.units.filter((u) => {
      const rowCount = (rowEdits[u.docId] ?? u.rows ?? []).length;
      const resolved = (rowEdits[u.docId] ?? u.rows ?? []).filter(
        (_r, i) => checkedRows.has(`${u.docId}#${i}`),
      ).length;
      return isUnitConfirmable(u, resolved, rowCount);
    });
  }, [group, checkedRows, rowEdits]);

  const releasableUnits = useMemo(
    () => (data?.groups.flatMap((g) => g.units) ?? []).filter((u) => u.releaseEligible),
    [data],
  );

  const runBatch = async (
    actions: Array<{ docId: string; confirm: true; action: 'manual' | 'auto-release' }>,
  ) => {
    if (actions.length === 0 || !docId) return;
    setBatchBusy(true);
    try {
      const results = await submitReviewBatch(docId, actions);
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        setActionError(`${failed.length} 份单据确认失败: ${failed.map((f) => f.error).join('; ')}`);
      } else {
        setActionError(null);
      }
      await load(docId);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBatchBusy(false);
      setReleaseArmed(false);
    }
  };

  const keyboardHandlers = useMemo(
    () => ({
      onEnter: () => {
        if (!selected || flatRows.length === 0) {
          const first = flatRows[0];
          if (first) setSelected({ docId: first.unit.docId, rowIndex: first.rowIndex });
          return;
        }
        const idx = flatRows.findIndex(
          (r) => r.unit.docId === selected.docId && r.rowIndex === selected.rowIndex,
        );
        if (autoJump && idx >= 0) {
          const key = `${selected.docId}#${selected.rowIndex}`;
          setCheckedRows((prev) => new Set(prev).add(key));
        }
        const next = flatRows[idx + 1] ?? flatRows[0];
        if (next) setSelected({ docId: next.unit.docId, rowIndex: next.rowIndex });
      },
      onF8: (backwards: boolean) => {
        const problems = flatRows.filter((r) => isProblemRow(r));
        if (problems.length === 0) return;
        let idx = 0;
        if (selected) {
          const cur = problems.findIndex(
            (r) => r.unit.docId === selected.docId && r.rowIndex === selected.rowIndex,
          );
          idx = backwards ? (cur <= 0 ? problems.length - 1 : cur - 1) : (cur + 1) % problems.length;
        }
        const target = problems[idx]!;
        setSelected({ docId: target.unit.docId, rowIndex: target.rowIndex });
      },
      onConfirmUnit: () => {
        if (selected) void runBatch([{ docId: selected.docId, confirm: true, action: 'manual' }]);
      },
      onReleaseAll: () => {
        if (releasableUnits.length > 0) setReleaseArmed(true);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, flatRows, autoJump, releasableUnits, docId],
  );
  useWorkbenchKeyboard(!!docId && !batchBusy, keyboardHandlers);

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
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={batchBusy || confirmableUnits.length === 0}
            onClick={() =>
              void runBatch(
                confirmableUnits.map((u) => ({ docId: u.docId, confirm: true, action: 'manual' as const })),
              )
            }
            className="cursor-pointer whitespace-nowrap rounded border border-primary bg-primary px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-primary/90 disabled:cursor-default disabled:opacity-40"
            title="确认所有行都已核对的单据(Ctrl+Enter 确认当前单据)"
          >
            确认已核 ({confirmableUnits.length})
          </button>
          {!releaseArmed ? (
            <button
              type="button"
              disabled={batchBusy || releasableUnits.length === 0}
              onClick={() => setReleaseArmed(true)}
              className="cursor-pointer whitespace-nowrap rounded border border-success bg-success/10 px-2.5 py-1 text-xs font-medium text-success transition-colors hover:bg-success/20 disabled:cursor-default disabled:opacity-40"
              title={`放行 ${releasableUnits.length} 份高置信且勾稽全过的单据(Ctrl+Shift+Enter)`}
            >
              一键放行 ({releasableUnits.length})
            </button>
          ) : (
            <>
              <span className="whitespace-nowrap text-xs text-warning">
                将放行 {releasableUnits.length} 份单据？
              </span>
              <button
                type="button"
                disabled={batchBusy}
                onClick={() =>
                  void runBatch(
                    releasableUnits.map((u) => ({ docId: u.docId, confirm: true, action: 'auto-release' as const })),
                  )
                }
                className="cursor-pointer whitespace-nowrap rounded bg-success px-2 py-1 text-xs font-medium text-white hover:bg-success/90"
              >
                确认放行
              </button>
              <button
                type="button"
                onClick={() => setReleaseArmed(false)}
                className="cursor-pointer whitespace-nowrap rounded border border-line px-2 py-1 text-xs text-ink-soft hover:bg-surface"
              >
                取消
              </button>
            </>
          )}
          <label className="flex cursor-pointer items-center gap-1 whitespace-nowrap text-xs text-ink-soft">
            <input
              type="checkbox"
              checked={autoJump}
              onChange={(e) => {
                setAutoJump(e.target.checked);
                localStorage.setItem('sca.reviewAutoJump', e.target.checked ? '1' : '0');
              }}
              className="h-3.5 w-3.5 accent-[#35719C]"
            />
            Enter 跳行自动已核
          </label>
        </div>
        <span className="ml-auto whitespace-nowrap text-xs text-ink-soft">
          待复核 {progress.pending} / 已放行 {progress.released} / 已确认 {progress.confirmed} / 共 {progress.total}
        </span>
        {actionError && <span className="whitespace-nowrap text-xs text-danger">{actionError}</span>}
      </div>

      {/* 两栏主体: 左原文(Task 9) + 右表格(Task 8) */}
      <div className="flex min-h-0 flex-1">
        <div className="hidden w-[38%] shrink-0 border-r border-line lg:block" data-original-pane>
          <OriginalPane unit={selectedUnit} selectedPage={selectedPage} />
        </div>
        <div className="min-w-0 flex-1" data-voucher-table>
          {group?.kind === 'unit-list' ? (
            <div className="h-full overflow-auto">
              <UnitListGroup units={group.units} />
            </div>
          ) : group ? (
            <VoucherTable
              docType={group.docType as WorkbenchTableDocType}
              units={group.units}
              checkedRows={checkedRows}
              editedDocs={editedDocs}
              onToggleRow={toggleRow}
              rowEdits={rowEdits}
              onCellCommit={(u, i, c, v) => void handleCellCommit(u, i, c, v)}
              selected={selected}
              onSelect={setSelected}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default ReviewWorkbench;