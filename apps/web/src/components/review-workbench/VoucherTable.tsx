// apps/web/src/components/review-workbench/VoucherTable.tsx
// 虚拟滚动可编辑表格: div 网格(行绝对定位, 与 <table> 语义冲突故不用 table),
// 定宽列 + 横向滚动; 单元格双击进入编辑, 失焦提交(明细行是整字段 JSON 替换
// 契约, 由父组件组装数组); 三色(客户端镜像勾稽); 行勾选"已核"。
import { useRef, useState } from 'react';
import clsx from 'clsx';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { WorkbenchRow, WorkbenchUnit } from '../../api/reviewWorkbench';
import { TABLE_COLUMNS, cellTone, checkRow, isUnitConfirmable, type WorkbenchTableDocType } from './workbenchModel';
import { UnitGroupHeader } from './UnitGroupHeader';

const NUMERIC_COLUMNS = new Set(['毛重_吨', '皮重_吨', '净重_吨', '票重_吨', '盈亏_吨']);
const COL_WIDTH: Record<string, number> = {};
for (const c of [...TABLE_COLUMNS['汽运磅单'], ...TABLE_COLUMNS['轨道衡称重单']]) {
  COL_WIDTH[c] = NUMERIC_COLUMNS.has(c) ? 92 : 132;
}
const PAGE_W = 64;
const CHECK_W = 48;
const CHECKS_W = 180;

type Item =
  | { kind: 'group'; unit: WorkbenchUnit }
  | { kind: 'row'; unit: WorkbenchUnit; rowIndex: number };

export function VoucherTable(props: {
  docType: WorkbenchTableDocType;
  units: WorkbenchUnit[];
  checkedRows: Set<string>;
  editedRows: Set<string>;
  editedDocs: Set<string>;
  onToggleRow: (key: string) => void;
  rowEdits: Record<string, WorkbenchRow[]>;
  onCellCommit: (unit: WorkbenchUnit, rowIndex: number, column: string, raw: string) => void;
  selected: { docId: string; rowIndex: number } | null;
  onSelect: (sel: { docId: string; rowIndex: number }) => void;
}) {
  const { docType, units, checkedRows, editedRows, editedDocs, onToggleRow, rowEdits, onCellCommit, selected, onSelect } = props;
  const columns = TABLE_COLUMNS[docType];
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<{ docId: string; rowIndex: number; column: string } | null>(null);

  const rowsOf = (u: WorkbenchUnit): WorkbenchRow[] => rowEdits[u.docId] ?? u.rows ?? [];

  const items: Item[] = [];
  for (const u of units) {
    items.push({ kind: 'group', unit: u });
    rowsOf(u).forEach((_r, i) => items.push({ kind: 'row', unit: u, rowIndex: i }));
  }

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (items[i]!.kind === 'group' ? 40 : 34),
    overscan: 12,
  });

  const gridTemplate = `${CHECK_W}px ${PAGE_W}px ${columns.map((c) => `${COL_WIDTH[c] ?? 120}px`).join(' ')} ${CHECKS_W}px`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 单一共享滚动容器: 表头 sticky top-0 与虚拟表体同轴滚动, 横/纵对齐 */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div className="min-w-max">
          {/* sticky 表头 */}
          <div className="sticky top-0 z-10 border-b border-line bg-panel">
            <div className="grid" style={{ gridTemplateColumns: gridTemplate }}>
              <div className="px-2 py-1.5 text-[11px] font-medium text-ink-soft">已核</div>
              <div className="px-2 py-1.5 text-[11px] font-medium text-ink-soft">页码</div>
              {columns.map((c) => (
                <div key={c} className="px-2 py-1.5 text-[11px] font-medium text-ink-soft">{c}</div>
              ))}
              <div className="px-2 py-1.5 text-[11px] font-medium text-ink-soft">勾稽</div>
            </div>
          </div>
          {/* 虚拟滚动体 */}
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const item = items[vi.index]!;
            if (item.kind === 'group') {
              const u = item.unit;
              const rs = rowsOf(u);
              const confirmable = isUnitConfirmable(
                u,
                rs.filter(
                  (_r, i) =>
                    checkedRows.has(`${u.docId}#${i}`) || editedRows.has(`${u.docId}#${i}`),
                ).length,
                rs.length,
              );
              return (
                <div
                  key={`g-${u.docId}`}
                  style={{ position: 'absolute', top: vi.start, left: 0, right: 0, height: vi.size }}
                >
                  <UnitGroupHeader
                    unit={u}
                    docType={docType}
                    currentRows={rowEdits[u.docId]}
                    confirmable={confirmable}
                  />
                </div>
              );
            }
            const { unit: u, rowIndex } = item;
            const row = rowsOf(u)[rowIndex]!;
            // 客户端镜像勾稽(编辑后即时反馈): 编辑过的 unit 整体忽略服务端
            // rowChecks(客户端镜像是权威, 规则双实现同源, 修好后不再残留旧红);
            // 未编辑时服务端 rowChecks 兜底合并去重。
            const clientIssues = checkRow(row, docType);
            const serverIssues = rowEdits[u.docId] ? [] : (u.rowChecks?.[rowIndex]?.issues ?? []);
            const allIssues = [
              ...clientIssues,
              ...serverIssues.filter((s) => !clientIssues.some((i) => i.rule === s.rule)),
            ];
            const rowKey = `${u.docId}#${rowIndex}`;
            const checked = checkedRows.has(rowKey);
            const isSel = selected?.docId === u.docId && selected?.rowIndex === rowIndex;
            const locked = u.reviewStatus === 'confirmed';
            return (
              <div
                key={`r-${u.docId}-${rowIndex}`}
                style={{
                  position: 'absolute',
                  top: vi.start,
                  left: 0,
                  right: 0,
                  height: vi.size,
                  gridTemplateColumns: gridTemplate,
                }}
                onClick={() => onSelect({ docId: u.docId, rowIndex })}
                className={clsx(
                  'grid cursor-pointer items-stretch border-b border-line/30 text-xs',
                  isSel ? 'bg-primary/5' : 'hover:bg-surface',
                  locked && 'opacity-60',
                )}
                data-row-key={rowKey}
              >
                <div className="flex items-center justify-center">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={locked}
                    onChange={() => onToggleRow(rowKey)}
                    className="h-3.5 w-3.5 cursor-pointer accent-[#35719C]"
                    aria-label={`已核 ${u.title} 第 ${rowIndex + 1} 行`}
                  />
                </div>
                <div className="flex items-center px-2 font-mono text-[11px] text-ink-soft">{row['页码'] ?? '-'}</div>
                {columns.map((col) => {
                  const tone = cellTone(allIssues, col);
                  const isEditing =
                    editing?.docId === u.docId && editing?.rowIndex === rowIndex && editing?.column === col;
                  const value = row[col];
                  return (
                    <div
                      key={col}
                      className={clsx(
                        'flex items-center px-2',
                        tone === 'error' && 'bg-danger/10 text-danger',
                        tone === 'warning' && 'bg-warning/10 text-warning',
                        editedDocs.has(u.docId) && tone === null && 'bg-primary/5',
                      )}
                      onDoubleClick={() => {
                        if (!locked) setEditing({ docId: u.docId, rowIndex, column: col });
                      }}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          defaultValue={value == null ? '' : String(value)}
                          onBlur={(e) => {
                            setEditing(null);
                            if (e.target.value !== (value == null ? '' : String(value))) {
                              onCellCommit(u, rowIndex, col, e.target.value);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              (e.target as HTMLInputElement).blur();
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              setEditing(null);
                            }
                          }}
                          className="w-full rounded border border-primary bg-white px-1 py-px text-xs outline-none"
                        />
                      ) : (
                        <span className="w-full truncate" title={value == null ? '' : String(value)}>
                          {value == null ? '-' : String(value)}
                        </span>
                      )}
                    </div>
                  );
                })}
                <div className="flex items-center px-2 text-[11px]">
                  {allIssues.length === 0 ? (
                    <span className="text-success">通过</span>
                  ) : (
                    <span
                      className={clsx(
                        'truncate',
                        allIssues.some((i) => i.severity === 'error') ? 'text-danger' : 'text-warning',
                      )}
                      title={allIssues.map((i) => i.message).join('; ')}
                    >
                      {allIssues[0]!.message}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        </div>
      </div>
    </div>
  );
}