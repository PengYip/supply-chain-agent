// 集中复核工作台勾稽校验(spec 2026-09-04 §7.4)。纯函数: workbench 组装与
// releaseEligible 判定共用; 前端 workbenchModel.ts 镜像同规则 —— 改容忍值/
// 规则时两处必须同步(双端无共享包, 以注释互指)。

export type WorkbenchWeighDocType = '汽运磅单' | '轨道衡称重单';

/** 进表格视图(kind='voucher-table')的票据类型。 */
export const WORKBENCH_TABLE_DOCTYPES: ReadonlySet<string> = new Set([
  '汽运磅单',
  '轨道衡称重单',
]);

export interface RowIssue {
  rule: string;
  severity: 'error' | 'warning';
  columns: string[];
  message: string;
}

/** 容忍值(吨)。镜像: apps/web/src/components/review-workbench/workbenchModel.ts */
export const WEIGHT_TOLERANCE_T = 0.02;
export const TOTAL_TOLERANCE_T = 0.05;

const GROSS = '毛重_吨';
const TARE = '皮重_吨';
const NET = '净重_吨';
const TICKET = '票重_吨';
const SURPLUS = '盈亏_吨';

export type WeighCheckRow = Record<string, string | number | null>;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 行级勾稽: 毛-皮=净(±0.02) / 净重>0 / 轨道衡 盈亏=票重-净重(±0.02)。 */
export function checkWeighRow(
  row: WeighCheckRow,
  docType: WorkbenchWeighDocType,
): RowIssue[] {
  const issues: RowIssue[] = [];
  const gross = row[GROSS];
  const tare = row[TARE];
  const net = row[NET];
  if (typeof gross !== 'number' || typeof tare !== 'number' || typeof net !== 'number') {
    issues.push({
      rule: 'required_missing',
      severity: 'warning',
      columns: [GROSS, TARE, NET],
      message: '毛重/皮重/净重存在缺失, 无法勾稽',
    });
    return issues;
  }
  if (Math.abs(gross - tare - net) > WEIGHT_TOLERANCE_T) {
    issues.push({
      rule: 'gross_minus_tare',
      severity: 'error',
      columns: [GROSS, TARE, NET],
      message: `毛重-皮重=${round2(gross - tare)} 与净重=${net} 不符`,
    });
  }
  if (net <= 0) {
    issues.push({ rule: 'net_positive', severity: 'error', columns: [NET], message: '净重必须大于 0' });
  }
  if (docType === '轨道衡称重单') {
    const ticket = row[TICKET];
    const surplus = row[SURPLUS];
    // 盈亏方向暂定 票重-净重=盈亏(spec §13 开放问题); 真实样本核对后如需
    // 反向只改这一处(与前端镜像同步)。
    if (typeof ticket === 'number' && typeof surplus === 'number') {
      if (Math.abs(ticket - net - surplus) > WEIGHT_TOLERANCE_T) {
        issues.push({
          rule: 'surplus_check',
          severity: 'error',
          columns: [TICKET, NET, SURPLUS],
          message: `票重-净重=${round2(ticket - net)} 与盈亏=${surplus} 不符`,
        });
      }
    }
  }
  return issues;
}

export interface TotalCheck {
  expected: number | null;
  actual: number | null;
  tolerance: number;
  pass: boolean;
}

/** 单据级合计勾稽: Σ行净重 vs 存量总净重_吨(行编辑后漂移由此暴露)。 */
export function checkWeighTotal(
  rows: WeighCheckRow[],
  storedTotal: number | null | undefined,
): TotalCheck {
  let sum = 0;
  for (const r of rows) {
    if (typeof r[NET] === 'number') sum += r[NET] as number;
  }
  const expected = typeof storedTotal === 'number' ? storedTotal : null;
  return {
    expected,
    actual: Math.round(sum * 1000) / 1000,
    tolerance: TOTAL_TOLERANCE_T,
    pass: expected === null ? true : Math.abs(expected - sum) <= TOTAL_TOLERANCE_T,
  };
}