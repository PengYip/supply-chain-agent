// 业务凭证 schema 族 (Phase A: 图片凭证 VLM 解析分支)。
//
// 三类凭证(货转单/付款凭证/化验报告)的 zod schema, 与 schemas/contract.ts 的
// 中文键名惯例一致: 必填字段用非 optional(且字符串必填用 min(1) 拒绝空串),
// 可空字段用 .nullable().optional()(VLM 无法辨认时填 null)。
//
// 本文件是纯 schema + 纯函数, 不 import 任何运行时依赖(除 zod), 供
// vlmAdapter / documentEntry 图片分支 / Phase B 复用。

import { z } from 'zod';
import type { AnchorQuantity } from '../../domain/units.js';

/** 凭证类型。'其他' 为 VLM 无法归入时的兜底。v2.1 增重量凭证三类型。 */
export type VoucherType =
  | '货转单' | '化验报告' | '付款凭证'
  | '汽运磅单' | '轨道衡称重单' | '水尺计重单'
  | '质检汇总表'
  | '其他';

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
  /** 四基: 空干基 ar / 空气干燥基 ad / 干基 d / 干燥无灰基 daf(挥发分常用,
   *  2026-09-01 华新实测 VLM 正确输出 daf 被旧三基词表拒绝, 补齐)。 */
  基准: z.enum(['ar', 'ad', 'd', 'daf']),
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

// ---- 质检汇总表 (收货质检混合汇总表, B 方案 2026-09-03) ----------------------
// 现实载体: ERP「下游收货数据」导出件等, 逐行同时有重量列(净重或毛/皮/净)
// 与质量列(水分/灰分/硫分/发热量), 常带合计行。行内重量与质量列均可缺
// (混排版式), 硬性要求仅 明细行 min(1) —— 类型正确性由分类器把守, schema
// 保持宽容避免把不完美 VLM 输出打成解析失败。

export const 质检汇总行Schema = z.object({
  车号: z.string().nullable().optional(),
  日期: z.string().nullable().optional(),
  毛重_吨: z.number().nullable().optional(),
  皮重_吨: z.number().nullable().optional(),
  净重_吨: z.number().nullable().optional(),
  水分_百分比: z.number().nullable().optional(),
  灰分_百分比: z.number().nullable().optional(),
  挥发分_百分比: z.number().nullable().optional(),
  全硫_百分比: z.number().nullable().optional(),
  低位发热量_千卡每kg: z.number().nullable().optional(),
  低位发热量_MJ每kg: z.number().nullable().optional(),
});

export const 质检汇总表Schema = z.object({
  编号: z.string().nullable().optional(),
  收货单位: z.string().nullable().optional(),
  供货单位: z.string().nullable().optional(),
  品名: z.string().nullable().optional(),
  明细行: z.array(质检汇总行Schema).min(1),
  合计净重_吨: z.number().nullable().optional(),
  合计水分_百分比: z.number().nullable().optional(),
  合计灰分_百分比: z.number().nullable().optional(),
  合计全硫_百分比: z.number().nullable().optional(),
  合计低位发热量_千卡每kg: z.number().nullable().optional(),
  合计低位发热量_MJ每kg: z.number().nullable().optional(),
  日期: z.string().nullable().optional(),
});

// ---- 汽运磅单 (一页一车, 文档级由聚合器组装) --------------------------------

export const 汽运磅单行Schema = z.object({
  编号: z.string().nullable().optional(),
  卡号: z.string().nullable().optional(),
  车号: z.string().nullable().optional(),
  毛重_吨: z.number(),
  皮重_吨: z.number(),
  净重_吨: z.number(),
  毛重时间: z.string().nullable().optional(),
  皮重时间: z.string().nullable().optional(),
  称号: z.string().nullable().optional(),
});

export const 汽运磅单Schema = z.object({
  明细行: z.array(汽运磅单行Schema).min(1),
  总净重_吨: z.number(),
  页数: z.number().int().positive(),
  失败页: z.array(z.number().int().positive()),
});

// ---- 轨道衡称重单 (逐车厢行, 可跨多页) --------------------------------------

export const 轨道衡行Schema = z.object({
  车型: z.string().nullable().optional(),
  车号: z.string().nullable().optional(),
  毛重_吨: z.number(),
  皮重_吨: z.number(),
  净重_吨: z.number(),
  票重_吨: z.number().nullable().optional(),
  盈亏_吨: z.number().nullable().optional(),
});

export const 轨道衡称重单Schema = z.object({
  编号: z.string().nullable().optional(),
  称量日期: z.string().nullable().optional(),
  明细行: z.array(轨道衡行Schema).min(1),
  总净重_吨: z.number(),
  页数: z.number().int().positive(),
  失败页: z.array(z.number().int().positive()),
});

// ---- 水尺计重单 (单页表单) ---------------------------------------------------

export const 水尺计重单Schema = z.object({
  船名: z.string().min(1),
  航次: z.string().nullable().optional(),
  泊位: z.string().nullable().optional(),
  货名: z.string().nullable().optional(),
  卸货量_吨: z.number(),
  检测日期: z.string().nullable().optional(),
});

/** voucherType -> 对应 zod schema 的查找表。'其他' 无 schema(不校验)。 */
export const VOUCHER_SCHEMAS: Record<Exclude<VoucherType, '其他'>, z.ZodTypeAny> = {
  货转单: 货转单Schema,
  付款凭证: 付款凭证Schema,
  化验报告: 化验报告Schema,
  汽运磅单: 汽运磅单Schema,
  轨道衡称重单: 轨道衡称重单Schema,
  水尺计重单: 水尺计重单Schema,
  质检汇总表: 质检汇总表Schema,
};

/** 重量聚合模式类型(spec 2026-08-28 §5.1): 逐页提取行 + 服务端 Σ净重聚合。 */
export const WEIGHT_AGGREGATE_DOCTYPES: ReadonlySet<VoucherType> = new Set([
  '汽运磅单', '轨道衡称重单', '水尺计重单',
]);

// ---- VLM 提取 prompt 注册表(vlmAdapter 泛化用, spec 2026-08-28 §5) -----------
// 页级 prompt(行/表单级输出, 供逐页聚合); 文档级 prompt(整单 schema, 多图一次调用)。

export const VOUCHER_PAGE_PROMPTS: Partial<Record<Exclude<VoucherType, '其他'>, string>> = {
  汽运磅单: [
    '你是汽车过磅单识别模型。图片是一张汽车来煤过衡单(针打票据), 提取这一张票的单车记录。',
    '输出字段: 编号(字符串或null), 卡号(字符串或null), 车号(字符串或null),',
    '毛重_吨(数字,必填), 皮重_吨(数字,必填), 净重_吨(数字,必填),',
    '毛重时间(字符串或null,如 "2025-09-10 09:25"), 皮重时间(字符串或null), 称号(字符串或null)。',
    '数字去掉千分位逗号与单位; 无法辨认的字段填 null, 严禁编造。',
    '严格以 JSON 输出, 不要包含任何注释或解释文字。',
  ].join('\n'),
  轨道衡称重单: [
    '你是铁路轨道衡计量单识别模型。图片是逐车厢称重记录表(可能带红色印章), 提取表头与全部数据行。',
    '输出字段: 编号(字符串或null), 称量日期(字符串或null),',
    'rows(数组,必填,每行含: 车型(字符串或null), 车号(字符串或null), 毛重_吨(数字,必填),',
    '皮重_吨(数字,必填), 净重_吨(数字,必填), 票重_吨(数字或null), 盈亏_吨(数字或null)))。',
    '一行车厢一行数据, 严禁漏行; 数字去掉千分位逗号; 无法辨认填 null, 严禁编造。',
    '严格以 JSON 输出: {"编号": ..., "称量日期": ..., "rows": [...]}',
  ].join('\n'),
};

export const VOUCHER_DOC_PROMPTS: Partial<Record<Exclude<VoucherType, '其他'>, string>> = {
  水尺计重单: [
    '你是水尺计重单(DRAFT SURVEY REPORT)识别模型。提取核定要素。',
    '输出字段: 船名(字符串,必填,如 "硕隆817"), 航次(字符串或null), 泊位(字符串或null),',
    '货名(字符串或null), 卸货量_吨(数字,必填,取 WEIGHT OF CARGO LOADED/DISCHARGED),',
    '检测日期(字符串或null)。',
    '数字去掉千分位逗号; 无法辨认填 null, 严禁编造。',
    '严格以 JSON 输出, 不要包含任何注释或解释文字。',
  ].join('\n'),
  货转单: [
    '你是货权转移单识别模型。提取结构化字段。',
    '输出: 编号(字符串或null), 合同号(字符串,必填), 买方(字符串,必填), 卖方(字符串,必填),',
    '交货日期(字符串,必填), 交货地点(字符串,必填), 交货总量_吨(数字,必填),',
    '明细行(数组,必填,每项含: 煤种(字符串或null), 运输方式(字符串或null), 数量_吨(数字),',
    '低位发热量_千卡(数字或null), 全硫(字符串或null), 暂估价_元每吨(数字或null),',
    '含税总价_元(数字), 货款75_元(数字或null)),',
    '合计含税总价_元(数字,必填), 日期(字符串或null)。',
    '数字字段输出为数字(去掉千分位逗号与货币符号); 无法辨认填 null, 严禁编造。',
    '严格以 JSON 输出, 不要包含任何注释或解释文字。',
  ].join('\n'),
  付款凭证: [
    '你是银行回单识别模型。提取结构化字段。',
    '输出: 付款人名称(字符串,必填), 收款人名称(字符串,必填), 金额(数字,必填,单位元),',
    '金额大写(字符串或null), 入账日期(字符串,必填), 回单编号(字符串或null),',
    '附言(字符串或null), 付款人账号(字符串或null), 收款人账号(字符串或null)。',
    '金额输出为数字(去掉千分位逗号与货币符号); 无法辨认填 null, 严禁编造。',
    '严格以 JSON 输出, 不要包含任何注释或解释文字。',
  ].join('\n'),
  化验报告: [
    '你是化验报告识别模型。提取结构化字段。',
    '输出: 出具机构(字符串,必填), 报告编号(字符串或null), 送检单位(字符串或null),',
    '委托方(字符串或null), 品名(字符串或null), 重量_吨(数字或null),',
    '采样地点(字符串或null), 装卸地点(字符串或null), 检测日期(字符串,必填),',
    '指标(数组或null,每项含: 基准(枚举 ar/ad/d/daf), 全水_百分比(数字或null),',
    '灰分_百分比(数字或null), 挥发分_百分比(数字或null), 全硫_百分比(数字或null),',
    '水分_百分比(数字或null), 低位发热量_MJ每kg(数字或null), 低位发热量_千卡每kg(数字或null)))。',
    '数字字段输出为数字; 无法辨认填 null, 严禁编造。',
    '严格以 JSON 输出, 不要包含任何注释或解释文字。',
  ].join('\n'),
  质检汇总表: [
    '你是收货质检汇总表识别模型。图片是下游收货数据/收货质检汇总表(逐行同时含重量与质量指标的表格, 可能多页, 常带合计行), 提取表头与全部数据行。',
    '输出: 编号(字符串或null), 收货单位(字符串或null), 供货单位(字符串或null), 品名(字符串或null),',
    '明细行(数组,必填,每行含: 车号(字符串或null), 日期(字符串或null),',
    '毛重_吨(数字或null), 皮重_吨(数字或null), 净重_吨(数字或null),',
    '水分_百分比(数字或null), 灰分_百分比(数字或null), 挥发分_百分比(数字或null), 全硫_百分比(数字或null),',
    '低位发热量_千卡每kg(数字或null), 低位发热量_MJ每kg(数字或null))),',
    '合计净重_吨(数字或null), 合计水分_百分比(数字或null), 合计灰分_百分比(数字或null),',
    '合计全硫_百分比(数字或null), 合计低位发热量_千卡每kg(数字或null), 合计低位发热量_MJ每kg(数字或null),',
    '日期(字符串或null)。',
    '一行数据一条明细, 严禁漏行; 数字去掉千分位逗号与单位; 表格没有的列填 null, 严禁编造。',
    '严格以 JSON 输出, 不要包含任何注释或解释文字。',
  ].join('\n'),
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
  /** 通用物化层数量投影(spec 2026-08-27 §8): 原值+原始单位+量纲+规范值。quantityTon/quantityUnit 由它投影兼容。 */
  quantity?: AnchorQuantity;
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
    case '质检汇总表': {
      const qtyTon = anchorNum(fields['合计净重_吨']);
      return {
        buyer: anchorStr(fields['收货单位']),
        seller: anchorStr(fields['供货单位']),
        date: anchorStr(fields['日期']),
        quantityTon: qtyTon,
        quantityUnit: qtyTon !== undefined ? '吨' : undefined,
      };
    }
    case '汽运磅单':
    case '轨道衡称重单': {
      // quantityTon = 服务端聚合总净重(聚合零幻觉), 不取模型输出。
      const qtyTon = anchorNum(fields['总净重_吨']);
      const rows = Array.isArray(fields['明细行']) ? (fields['明细行'] as unknown[]) : [];
      const first = rows[0] as Record<string, unknown> | null | undefined;
      const date =
        anchorStr(first?.['毛重时间']) ?? anchorStr(fields['称量日期']);
      return { date, quantityTon: qtyTon, quantityUnit: qtyTon !== undefined ? '吨' : undefined };
    }
    case '水尺计重单': {
      const qtyTon = anchorNum(fields['卸货量_吨']);
      return {
        buyer: anchorStr(fields['船名']),
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

// 能量换算(化验报告低位发热量跨基准校验用): 1 MJ/kg = 238.8459 kcal/kg
// (1 cal = 4.1868 J, IT 卡, 煤质检测常规折算)。domain/units.ts 注册表仅含
// 质量/计数两量纲, 能量对为此校验局部声明(spec 2026-09-01 §8.2 跨量纲修复)。
const KCAL_PER_MJ = 238.8459;

interface NormalizedLowHeat {
  /** 归一化 kcal/kg(比较用)。 */
  kcal: number;
  /** 抽取原值 + 单位标签(告警文案忠实于原值)。 */
  raw: number;
  unitLabel: string;
}

/** 低位发热量行 -> 归一 kcal/kg; 两种单位字段均缺/非数值 -> null(跳过该行)。 */
function normalizeLowHeat(row: Record<string, unknown>): NormalizedLowHeat | null {
  const kcal = row['低位发热量_千卡每kg'];
  if (typeof kcal === 'number' && Number.isFinite(kcal)) {
    return { kcal, raw: kcal, unitLabel: '千卡/kg' };
  }
  const mj = row['低位发热量_MJ每kg'];
  if (typeof mj === 'number' && Number.isFinite(mj)) {
    return { kcal: mj * KCAL_PER_MJ, raw: mj, unitLabel: 'MJ/kg' };
  }
  return null;
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
    // 跨量纲修复(spec 2026-09-01 §8.2): 各行单位可不同(ar 行千卡/kg、ad/d 行
    // MJ/kg)—— 先换算到 kcal/kg 再比较, 可互换单位不再误报; 未知单位/字段
    // 缺失的行跳过(与旧行为一致)。
    const byBasis = new Map<string, NormalizedLowHeat>();
    for (const r of rows) {
      const row = r as Record<string, unknown> | null;
      const basis = row?.['基准'];
      const norm = row ? normalizeLowHeat(row) : null;
      if (typeof basis === 'string' && norm !== null) byBasis.set(basis, norm);
    }
    const ar = byBasis.get('ar');
    const ad = byBasis.get('ad');
    const d = byBasis.get('d');
    if (ar !== undefined && ad !== undefined && ar.kcal >= ad.kcal) {
      warnings.push(`低位发热量 ar(${ar.raw}${ar.unitLabel}) 应小于 ad(${ad.raw}${ad.unitLabel})`);
    }
    if (ad !== undefined && d !== undefined && ad.kcal >= d.kcal) {
      warnings.push(`低位发热量 ad(${ad.raw}${ad.unitLabel}) 应小于 d(${d.raw}${d.unitLabel})`);
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

  // v2.1 重量凭证组(spec 2026-08-28 §5.1): 行内自洽 + 合计守恒, warnings 不硬失败。
  if (voucherType === '汽运磅单' || voucherType === '轨道衡称重单') {
    const rows = Array.isArray(fields['明细行']) ? fields['明细行'] : [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] as Record<string, unknown> | null;
      const g = r?.['毛重_吨'];
      const t = r?.['皮重_吨'];
      const n = r?.['净重_吨'];
      if (
        typeof g === 'number' && typeof t === 'number' && typeof n === 'number' &&
        Math.abs(g - t - n) > 0.01
      ) {
        const label = voucherType === '汽运磅单' ? `明细行${i + 1}` : `第${i + 1}行`;
        warnings.push(`${label} 毛重${g} - 皮重${t} != 净重${n}`);
      }
      if (voucherType === '轨道衡称重单') {
        const tp = r?.['票重_吨'];
        const yk = r?.['盈亏_吨'];
        if (
          typeof n === 'number' && typeof tp === 'number' && typeof yk === 'number' &&
          Math.abs(n - tp - yk) > 0.05
        ) {
          warnings.push(`第${i + 1}行 净重${n} - 票重${tp} != 盈亏${yk}`);
        }
      }
    }
    const total = fields['总净重_吨'];
    if (typeof total === 'number' && Math.abs(sumRows(rows, '净重_吨') - total) > 0.01) {
      warnings.push(`明细行净重合计 ${sumRows(rows, '净重_吨')} 与总净重 ${total} 不一致`);
    }
  }

  // B 方案(2026-09-03): 质检汇总表守恒校验。行毛/皮/净三重齐全才做行内自洽
  // (混排版式常缺毛皮列); 合计净重存在时做 Σ明细行守恒。均只产 warning。
  if (voucherType === '质检汇总表') {
    const rows = Array.isArray(fields['明细行']) ? fields['明细行'] : [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] as Record<string, unknown> | null;
      const g = r?.['毛重_吨'];
      const t = r?.['皮重_吨'];
      const n = r?.['净重_吨'];
      if (
        typeof g === 'number' && typeof t === 'number' && typeof n === 'number' &&
        Math.abs(g - t - n) > 0.01
      ) {
        warnings.push(`明细行${i + 1} 毛重${g} - 皮重${t} != 净重${n}`);
      }
    }
    const total = fields['合计净重_吨'];
    if (typeof total === 'number' && Math.abs(sumRows(rows, '净重_吨') - total) > 0.01) {
      warnings.push(`明细行净重合计 ${sumRows(rows, '净重_吨')} 与合计净重 ${total} 不一致`);
    }
  }

  return warnings;
}
