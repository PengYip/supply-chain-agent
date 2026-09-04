// apps/web/src/components/review-workbench/workbenchModel.ts
// 集中复核客户端纯逻辑: 勾稽镜像(行编辑后即时反馈) + 可确认判定。
// 镜像声明: 规则与容忍值同 apps/server/src/pipeline/reviewChecks.ts,
// 改一处必须同步另一处(双端无共享包)。
import type { WorkbenchRow, WorkbenchRowIssue, WorkbenchUnit } from '../../api/reviewWorkbench';

export type WorkbenchTableDocType = '汽运磅单' | '轨道衡称重单';

export const TABLE_COLUMNS: Record<WorkbenchTableDocType, string[]> = {
  汽运磅单: ['编号', '卡号', '车号', '毛重_吨', '皮重_吨', '净重_吨', '毛重时间', '皮重时间', '称号'],
  轨道衡称重单: ['车型', '车号', '毛重_吨', '皮重_吨', '净重_吨', '票重_吨', '盈亏_吨'],
};

const WEIGHT_TOLERANCE_T = 0.02; // 镜像 reviewChecks.WEIGHT_TOLERANCE_T
const TOTAL_TOLERANCE_T = 0.05; // 镜像 reviewChecks.TOTAL_TOLERANCE_T

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 行勾稽(服务端 checkWeighRow 镜像)。 */
export function checkRow(row: WorkbenchRow, docType: WorkbenchTableDocType): WorkbenchRowIssue[] {
  const issues: WorkbenchRowIssue[] = [];
  const gross = row['毛重_吨'];
  const tare = row['皮重_吨'];
  const net = row['净重_吨'];
  if (typeof gross !== 'number' || typeof tare !== 'number' || typeof net !== 'number') {
    issues.push({
      rule: 'required_missing',
      severity: 'warning',
      columns: ['毛重_吨', '皮重_吨', '净重_吨'],
      message: '毛重/皮重/净重存在缺失, 无法勾稽',
    });
    return issues;
  }
  if (Math.abs(gross - tare - net) > WEIGHT_TOLERANCE_T) {
    issues.push({
      rule: 'gross_minus_tare',
      severity: 'error',
      columns: ['毛重_吨', '皮重_吨', '净重_吨'],
      message: `毛重-皮重=${round2(gross - tare)} 与净重=${net} 不符`,
    });
  }
  if (net <= 0) {
    issues.push({ rule: 'net_positive', severity: 'error', columns: ['净重_吨'], message: '净重必须大于 0' });
  }
  if (docType === '轨道衡称重单') {
    const ticket = row['票重_吨'];
    const surplus = row['盈亏_吨'];
    if (typeof ticket === 'number' && typeof surplus === 'number') {
      if (Math.abs(ticket - net - surplus) > WEIGHT_TOLERANCE_T) {
        issues.push({
          rule: 'surplus_check',
          severity: 'error',
          columns: ['票重_吨', '净重_吨', '盈亏_吨'],
          message: `票重-净重=${round2(ticket - net)} 与盈亏=${surplus} 不符`,
        });
      }
    }
  }
  return issues;
}

/** 合计勾稽(服务端 checkWeighTotal 镜像)。 */
export function checkTotal(
  rows: WorkbenchRow[],
  storedTotal: number | null | undefined,
): { pass: boolean; expected: number | null; actual: number | null } {
  let sum = 0;
  for (const r of rows) {
    if (typeof r['净重_吨'] === 'number') sum += r['净重_吨'] as number;
  }
  const expected = typeof storedTotal === 'number' ? storedTotal : null;
  return {
    expected,
    actual: Math.round(sum * 1000) / 1000,
    pass: expected === null ? true : Math.abs(expected - sum) <= TOTAL_TOLERANCE_T,
  };
}

/** 单元格三色: error=红(勾稽失败), warning=黄(缺失), null=正常。 */
export function cellTone(issues: WorkbenchRowIssue[], column: string): 'error' | 'warning' | null {
  if (issues.some((i) => i.severity === 'error' && i.columns.includes(column))) return 'error';
  if (issues.some((i) => i.severity === 'warning' && i.columns.includes(column))) return 'warning';
  return null;
}

/** 可确认判定: pending/corrected 且行数>0 且全部行已核(checked/edited)。 */
export function isUnitConfirmable(
  unit: Pick<WorkbenchUnit, 'reviewStatus'> & { rows?: WorkbenchRow[] },
  resolvedCount: number,
  rowCount: number,
): boolean {
  if (unit.reviewStatus !== 'pending' && unit.reviewStatus !== 'corrected') return false;
  if (rowCount === 0) return false;
  return resolvedCount >= rowCount;
}