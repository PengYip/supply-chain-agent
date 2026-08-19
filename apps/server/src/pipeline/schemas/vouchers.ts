// 业务凭证 schema 族 (Phase A: 图片凭证 VLM 解析分支)。
//
// 三类凭证(货转单/付款凭证/化验报告)的 zod schema, 与 schemas/contract.ts 的
// 中文键名惯例一致: 必填字段用非 optional(且字符串必填用 min(1) 拒绝空串),
// 可空字段用 .nullable().optional()(VLM 无法辨认时填 null)。
//
// 本文件是纯 schema + 纯函数, 不 import 任何运行时依赖(除 zod), 供
// vlmAdapter / documentEntry 图片分支 / Phase B 复用。

import { z } from 'zod';

/** 凭证类型。'其他' 为 VLM 无法归入三类时的兜底。 */
export type VoucherType = '货转单' | '化验报告' | '付款凭证' | '其他';

// ---- 货转单 (货权转移单) ----------------------------------------------------

export const 货转单明细Schema = z.object({
  煤种: z.string().nullable().optional(),
  运输方式: z.string().nullable().optional(),
  数量_吨: z.number(),
  低位发热量_千卡: z.number().nullable().optional(),
  全硫: z.string().nullable().optional(),
  暂估价_元每吨: z.number().nullable().optional(),
  含税总价_元: z.number(),
  货款75_元: z.number().nullable().optional(),
});

export const 货转单Schema = z.object({
  编号: z.string().nullable().optional(),
  合同号: z.string().min(1),
  买方: z.string().min(1),
  卖方: z.string().min(1),
  交货日期: z.string().min(1),
  交货地点: z.string().min(1),
  交货总量_吨: z.number(),
  明细行: z.array(货转单明细Schema).min(1),
  合计含税总价_元: z.number(),
  日期: z.string().nullable().optional(),
});

// ---- 付款凭证 (银行回单) ----------------------------------------------------

export const 付款凭证Schema = z.object({
  付款人名称: z.string().min(1),
  收款人名称: z.string().min(1),
  金额: z.number(),
  金额大写: z.string().nullable().optional(),
  入账日期: z.string().min(1),
  回单编号: z.string().nullable().optional(),
  附言: z.string().nullable().optional(),
  付款人账号: z.string().nullable().optional(),
  收款人账号: z.string().nullable().optional(),
});

// ---- 化验报告 (入库化验与到港化验共用, 方向不做区分) ------------------------

export const 化验指标Schema = z.object({
  基准: z.enum(['ar', 'ad', 'd']),
  全水_百分比: z.number().nullable().optional(),
  灰分_百分比: z.number().nullable().optional(),
  挥发分_百分比: z.number().nullable().optional(),
  全硫_百分比: z.number().nullable().optional(),
  水分_百分比: z.number().nullable().optional(),
  低位发热量_MJ每kg: z.number().nullable().optional(),
  低位发热量_千卡每kg: z.number().nullable().optional(),
});

export const 化验报告Schema = z.object({
  出具机构: z.string().min(1),
  报告编号: z.string().nullable().optional(),
  送检单位: z.string().nullable().optional(),
  委托方: z.string().nullable().optional(),
  品名: z.string().nullable().optional(),
  重量_吨: z.number().nullable().optional(),
  采样地点: z.string().nullable().optional(),
  装卸地点: z.string().nullable().optional(),
  检测日期: z.string().min(1),
  指标: z.array(化验指标Schema).nullable().optional(),
});

/** voucherType -> 对应 zod schema 的查找表。'其他' 无 schema(不校验)。 */
export const VOUCHER_SCHEMAS: Record<Exclude<VoucherType, '其他'>, z.ZodTypeAny> = {
  货转单: 货转单Schema,
  付款凭证: 付款凭证Schema,
  化验报告: 化验报告Schema,
};

// ---- 锚点提取 (Phase B 绑定/台账用) -----------------------------------------

export interface VoucherAnchors {
  contractNo?: string;
  buyer?: string;
  seller?: string;
  /** ISO 日期或原文。 */
  date?: string;
  amount?: number;
  quantityTon?: number;
  /** 数量单位(如 '吨'), 与 quantityTon 同源。字段名不带单位语义(如裸 '数量')时缺省, 不猜测。 */
  quantityUnit?: string;
}

function anchorStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function anchorNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * 从凭证字段中提取业务锚点(纯函数)。货转单: buyer=买方 seller=卖方
 * amount=合计含税总价 quantityTon=交货总量; 付款凭证: buyer=付款人 seller=收款人
 * amount=金额 date=入账日期; 化验报告: buyer=送检单位||委托方 quantityTon=重量_吨
 * date=检测日期。供 Phase B(绑定/台账回写)使用。
 */
export function extractAnchors(
  voucherType: VoucherType,
  fields: Record<string, unknown>,
): VoucherAnchors {
  switch (voucherType) {
    case '货转单': {
      const qtyTon = anchorNum(fields['交货总量_吨']);
      return {
        contractNo: anchorStr(fields['合同号']),
        buyer: anchorStr(fields['买方']),
        seller: anchorStr(fields['卖方']),
        date: anchorStr(fields['交货日期']) ?? anchorStr(fields['日期']),
        amount: anchorNum(fields['合计含税总价_元']),
        quantityTon: qtyTon,
        quantityUnit: qtyTon !== undefined ? '吨' : undefined,
      };
    }
    case '付款凭证':
      return {
        buyer: anchorStr(fields['付款人名称']),
        seller: anchorStr(fields['收款人名称']),
        date: anchorStr(fields['入账日期']),
        amount: anchorNum(fields['金额']),
      };
    case '化验报告': {
      const qtyTon = anchorNum(fields['重量_吨']);
      return {
        buyer: anchorStr(fields['送检单位']) ?? anchorStr(fields['委托方']),
        date: anchorStr(fields['检测日期']),
        quantityTon: qtyTon,
        quantityUnit: qtyTon !== undefined ? '吨' : undefined,
      };
    }
    default:
      return {};
  }
}

// ---- 中文大写金额解析 --------------------------------------------------------

const CN_DIGITS: Record<string, number> = {
  零: 0, 壹: 1, 贰: 2, 叁: 3, 肆: 4, 伍: 5, 陆: 6, 柒: 7, 捌: 8, 玖: 9,
};
const CN_SMALL_UNITS: Record<string, number> = { 拾: 10, 佰: 100, 仟: 1000 };
const CN_BIG_UNITS: Record<string, number> = { 万: 10000, 亿: 100000000 };

/**
 * 中文大写金额 -> 元(数字)。支持 零壹贰叁肆伍陆柒捌玖 拾佰仟万亿 元角分 整。
 * 解析失败返回 null(调用方据此跳过校验, 不硬失败)。
 * 例: '贰佰捌拾肆万壹仟陆佰贰拾元零贰角柒分' -> 2841620.27。
 */
export function parseChineseAmount(s: string): number | null {
  const text = s.replace(/整$/u, '').trim();
  if (text.length === 0) return null;

  let total = 0; // 已结算的整数部分(元)
  let section = 0; // 当前 万/亿 段内的累计值(< 10000)
  let current = 0; // 当前位数字(0-9)
  let hasDigit = false; // 段内是否出现过数字(处理 零 与 拾 缺省 1)
  let jiao = 0;
  let fen = 0;

  for (const ch of text) {
    if (ch === '元') {
      total += section + current;
      section = 0;
      current = 0;
      hasDigit = false;
      continue;
    }
    if (ch === '角') {
      jiao = current;
      current = 0;
      hasDigit = false;
      continue;
    }
    if (ch === '分') {
      fen = current;
      current = 0;
      hasDigit = false;
      continue;
    }
    if (ch in CN_DIGITS) {
      current = CN_DIGITS[ch]!;
      hasDigit = true;
      continue;
    }
    if (ch in CN_SMALL_UNITS) {
      const unit = CN_SMALL_UNITS[ch]!;
      // 拾/佰/仟 前的数字缺省为 1(如 '拾万' = 10万)。
      section += (hasDigit ? current : 1) * unit;
      current = 0;
      hasDigit = false;
      continue;
    }
    if (ch in CN_BIG_UNITS) {
      const unit = CN_BIG_UNITS[ch]!;
      // 万/亿 乘的是整个已累计段(含当前位), 不是单个数字:
      // '贰佰捌拾肆万' = (200+80+4) * 10000 = 2840000。
      if (ch === '亿') {
        total = (total + section + current) * unit;
      } else {
        total += (section + current) * unit;
      }
      section = 0;
      current = 0;
      hasDigit = false;
      continue;
    }
    // 未知字符(如 '人民币' 前缀) -> 无法解析。
    return null;
  }

  total += section + current;
  return total + jiao / 10 + fen / 100;
}

// ---- 交叉校验 (返回 warnings, 不是硬失败) ------------------------------------

function sumRows(rows: unknown[], key: string): number {
  return rows.reduce<number>((sum, r) => {
    const v = (r as Record<string, unknown> | null)?.[key];
    return sum + (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  }, 0);
}

/**
 * 凭证字段交叉校验(纯函数)。返回 warnings 列表(空数组 = 无警告); 校验失败
 * 只产生 warning, 不抛错、不拒绝入库 -- 由调用方决定 needs_review。
 */
export function validateVoucher(
  voucherType: VoucherType,
  fields: Record<string, unknown>,
): string[] {
  const warnings: string[] = [];

  if (voucherType === '货转单') {
    const rows = Array.isArray(fields['明细行']) ? fields['明细行'] : [];
    const sumQty = sumRows(rows, '数量_吨');
    const totalQty = fields['交货总量_吨'];
    if (typeof totalQty === 'number' && Math.abs(sumQty - totalQty) > 0.01) {
      warnings.push(`明细行数量合计 ${sumQty} 与交货总量 ${totalQty} 不一致`);
    }
    const sumAmount = sumRows(rows, '含税总价_元');
    const totalAmount = fields['合计含税总价_元'];
    if (typeof totalAmount === 'number' && Math.abs(sumAmount - totalAmount) > 0.01) {
      warnings.push(`明细行含税总价合计 ${sumAmount} 与合计含税总价 ${totalAmount} 不一致`);
    }
  }

  if (voucherType === '付款凭证') {
    const amount = fields['金额'];
    const upper = fields['金额大写'];
    if (typeof amount === 'number' && typeof upper === 'string' && upper.length > 0) {
      const parsed = parseChineseAmount(upper);
      if (parsed !== null && Math.abs(parsed - amount) > 0.01) {
        warnings.push(`金额大写 ${upper} 换算 ${parsed} 与金额 ${amount} 不一致`);
      }
    }
  }

  if (voucherType === '化验报告') {
    const rows = Array.isArray(fields['指标']) ? fields['指标'] : [];
    // 多基准并存时 低位发热量 ar < ad < d(物理关系近似校验)。
    const byBasis = new Map<string, number>();
    for (const r of rows) {
      const row = r as Record<string, unknown> | null;
      const basis = row?.['基准'];
      const v =
        typeof row?.['低位发热量_千卡每kg'] === 'number'
          ? (row['低位发热量_千卡每kg'] as number)
          : typeof row?.['低位发热量_MJ每kg'] === 'number'
            ? (row['低位发热量_MJ每kg'] as number)
            : undefined;
      if (typeof basis === 'string' && v !== undefined) byBasis.set(basis, v);
    }
    const ar = byBasis.get('ar');
    const ad = byBasis.get('ad');
    const d = byBasis.get('d');
    if (ar !== undefined && ad !== undefined && ar >= ad) {
      warnings.push(`低位发热量 ar(${ar}) 应小于 ad(${ad})`);
    }
    if (ad !== undefined && d !== undefined && ad >= d) {
      warnings.push(`低位发热量 ad(${ad}) 应小于 d(${d})`);
    }
    // 全水(ar) <= 水分(ad) 违反 -> warning(物理关系近似校验, 按规格字面规则)。
    const arRow = rows.find((r) => (r as Record<string, unknown> | null)?.['基准'] === 'ar') as
      | Record<string, unknown>
      | undefined;
    const adRow = rows.find((r) => (r as Record<string, unknown> | null)?.['基准'] === 'ad') as
      | Record<string, unknown>
      | undefined;
    const arWater = arRow?.['全水_百分比'];
    const adWater = adRow?.['水分_百分比'];
    if (typeof arWater === 'number' && typeof adWater === 'number' && arWater <= adWater) {
      warnings.push(`全水(ar) ${arWater} 应大于 水分(ad) ${adWater}`);
    }
  }

  return warnings;
}