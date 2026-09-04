// apps/web/src/components/review-workbench/UnitGroupHeader.tsx
// unit 分组分隔行: 单据级信息(标题/页区间/状态徽标/置信度/合计勾稽/失败页)。
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { WorkbenchRow, WorkbenchUnit } from '../../api/reviewWorkbench';
import { checkTotal, type WorkbenchTableDocType } from './workbenchModel';

export function statusBadge(u: WorkbenchUnit): { label: string; className: string } {
  if (u.reviewStatus === 'confirmed') {
    return u.reviewAction === 'auto-release'
      ? { label: '已放行', className: 'bg-success/10 text-success' }
      : { label: '已确认', className: 'bg-success/10 text-success' };
  }
  if (u.reviewStatus === 'corrected') return { label: '已修改待确认', className: 'bg-primary/10 text-primary' };
  return { label: '待复核', className: 'bg-warning/10 text-warning' };
}

export function UnitGroupHeader({
  unit,
  docType,
  currentRows,
  confirmable,
}: {
  unit: WorkbenchUnit;
  docType: WorkbenchTableDocType;
  /** 编辑中的行(与服务端 totals 漂移时客户端重算合计)。 */
  currentRows?: WorkbenchRow[];
  confirmable: boolean;
}) {
  void docType;
  const badge = statusBadge(unit);
  const rows = currentRows ?? unit.rows ?? [];
  const total = checkTotal(rows, unit.totals?.总净重_吨 ?? null);
  const pageRange =
    unit.pageStart != null && unit.pageEnd != null
      ? unit.pageStart === unit.pageEnd
        ? `第 ${unit.pageStart} 页`
        : `第 ${unit.pageStart}-${unit.pageEnd} 页`
      : '';
  return (
    <div className="flex flex-wrap items-center gap-2 border-y border-line/60 bg-surface/60 px-3 py-1.5 text-xs">
      <span className="font-semibold text-ink">{unit.title}</span>
      {pageRange && <span className="text-ink-soft">{pageRange}</span>}
      <span className={clsx('rounded px-1.5 py-px', badge.className)}>{badge.label}</span>
      <span className="text-ink-soft">置信度 {unit.overallConfidence.toFixed(2)}</span>
      {unit.totals?.总净重_吨 != null && (
        <span className={clsx(total.pass ? 'text-ink-soft' : 'font-medium text-danger')}>
          合计 {total.actual} 吨{total.expected != null && !total.pass ? `（存量 ${total.expected} 不符）` : ''}
        </span>
      )}
      {unit.totals?.失败页 && unit.totals.失败页.length > 0 && (
        <span className="inline-flex items-center gap-0.5 rounded bg-warning/10 px-1.5 py-px text-warning">
          <AlertTriangle className="h-3 w-3" aria-hidden />
          失败页 {unit.totals.失败页.join(',')}
        </span>
      )}
      {confirmable && (
        <span className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1.5 py-px text-primary">
          <CheckCircle2 className="h-3 w-3" aria-hidden />
          可确认
        </span>
      )}
    </div>
  );
}