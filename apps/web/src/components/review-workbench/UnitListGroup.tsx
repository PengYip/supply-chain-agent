// apps/web/src/components/review-workbench/UnitListGroup.tsx
// 非 schema 类型组(质检报告/化验报告等): 列表 + 打开既有单据复核卡。
// 工作台是统一入口, 不强改无行结构的类型(设计 2026-09-04 §6)。
import clsx from 'clsx';
import { FileText } from 'lucide-react';
import { requestOpenReview } from '../../lib/reviewModal';
import type { WorkbenchUnit } from '../../api/reviewWorkbench';

export function unitListBadge(u: WorkbenchUnit): { label: string; className: string } {
  if (u.reviewStatus === 'confirmed') {
    return {
      label: u.reviewAction === 'auto-release' ? '已放行' : '已确认',
      className: 'bg-success/10 text-success',
    };
  }
  if (u.reviewStatus === 'corrected') return { label: '已修改', className: 'bg-primary/10 text-primary' };
  return { label: '待复核', className: 'bg-warning/10 text-warning' };
}

export function UnitListGroup({ units }: { units: WorkbenchUnit[] }) {
  return (
    <div className="divide-y divide-line/40">
      {units.map((u) => {
        const badge = unitListBadge(u);
        return (
          <div key={u.docId || u.unitIndex} className="flex items-center gap-3 px-4 py-3 text-sm">
            <FileText className="h-4 w-4 shrink-0 text-ink-soft" aria-hidden />
            <span className="shrink-0 font-medium text-ink">{u.title}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-ink-soft">
              {u.needsReview ? '建议人工复核' : `置信度 ${u.overallConfidence.toFixed(2)}`}
              {u.warnings.length > 0 ? ` · ${u.warnings[0]}` : ''}
            </span>
            <span className={clsx('shrink-0 rounded px-1.5 py-px text-[10px]', badge.className)}>
              {badge.label}
            </span>
            {u.docId && (
              <button
                type="button"
                onClick={() => requestOpenReview(u.docId)}
                className="shrink-0 cursor-pointer rounded px-2 py-px text-xs font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
              >
                复核
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}