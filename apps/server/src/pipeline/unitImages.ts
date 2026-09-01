// 批量拆分器 Phase 2(抽取层): 按 manifest regions 的归一化 bbox 从渲染页图
// 裁出每个 unit 的图, 并生成旋回候选(设计文档 2026-09-01 §5.2)。
//
//  - rotationDeg 语义 = "该区域内容需顺时针旋转多少度才正立";
//  - 90 与 270 方向不可分辨(原型实测: 同标注下部分照片旋回后 180 度颠倒,
//    宣威第 6 页 4 张全旋反)——对歧义区域生成 [检测方向, 反方向] 两个候选,
//    由抽取层按置信度 + 两遍读数共识择优;
//  - 0/180 只有一个候选(180 无歧义)。
//
// 依赖 @napi-rs/canvas(pdf-to-img 的传递依赖, 此处显式声明为零新原生依赖):
// loadImage + canvas 变换 + toBuffer('image/png')。裁剪/旋回是本地 CPU
// 操作, 页图仍由 pdfRender 统一渲染, 不新增解码路径。

import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { DetectedUnit } from './batchSplit.js';
import type { RenderedPage } from './pdfRender.js';

/** 单个 unit 区域裁出的图(与 RenderedPage 同构, page 保留来源页号)。 */
export type UnitRegionImage = RenderedPage;

/** 90/270 方向歧义: 两个候选 = 检测方向 + 反方向; 0/180 单候选。 */
export function candidateRotations(rotationDeg: number): number[] {
  if (rotationDeg === 90) return [90, 270];
  if (rotationDeg === 270) return [270, 90];
  return [rotationDeg];
}

/**
 * 一个 unit 的旋回候选计划: 每项是"每个 region 各顺时针旋转多少度"。
 * 无歧义区域(0/180)单计划; 任一 region 歧义(90/270)时给两个计划
 * (计划 0 = 全部按检测方向, 计划 1 = 歧义区域全部取反方向)。
 */
export function unitRotationPlans(unit: DetectedUnit): number[][] {
  if (unit.regions.length === 0) return [[]];
  const ambiguous = unit.regions.some((r) => r.rotationDeg === 90 || r.rotationDeg === 270);
  if (!ambiguous) return [unit.regions.map((r) => r.rotationDeg)];
  return [0, 1].map((flip) =>
    unit.regions.map((r) => {
      if (r.rotationDeg !== 90 && r.rotationDeg !== 270) return r.rotationDeg;
      const [detected, opposite] = candidateRotations(r.rotationDeg);
      return flip === 0 ? detected! : opposite!;
    }),
  );
}

/**
 * 裁出并旋回一个 unit 的全部区域图。bbox 为归一化(原点左上, 检测层已加
 * padding); rotations 与 regions 一一对应, 每项为该 region 的顺时针旋回度数。
 * 输出 PNG(与凭证抽取管线的 RenderedPage 同构, page 保留来源页号供审计)。
 */
export async function renderUnitImages(
  pages: RenderedPage[],
  unit: DetectedUnit,
  rotations: number[],
): Promise<UnitRegionImage[]> {
  if (unit.regions.length === 0) throw new Error('unit 无 region, 无法裁剪');
  if (rotations.length !== unit.regions.length) {
    throw new Error(`旋回候选数(${rotations.length})与 region 数(${unit.regions.length})不一致`);
  }
  const byPage = new Map(pages.map((p) => [p.page, p]));
  const out: UnitRegionImage[] = [];
  for (let i = 0; i < unit.regions.length; i++) {
    const region = unit.regions[i]!;
    const page = byPage.get(region.page);
    if (!page) {
      throw new Error(`region 页 ${region.page} 不在渲染页集(${pages.map((p) => p.page).join(',')})`);
    }
    const deg = rotations[i]!;
    const image = await loadImage(page.buffer);
    const sx = Math.max(0, Math.min(image.width - 1, Math.round(region.bbox.x * image.width)));
    const sy = Math.max(0, Math.min(image.height - 1, Math.round(region.bbox.y * image.height)));
    const sw = Math.max(1, Math.min(image.width - sx, Math.round(region.bbox.w * image.width)));
    const sh = Math.max(1, Math.min(image.height - sy, Math.round(region.bbox.h * image.height)));
    const swap = deg === 90 || deg === 270;
    const canvas = createCanvas(swap ? sh : sw, swap ? sw : sh);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // 画布中心平移 + 顺时针旋转, 再把裁剪区绘制到以自身中心为锚的坐标系。
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.translate(-sw / 2, -sh / 2);
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
    out.push({ page: region.page, mime: 'image/png', buffer: canvas.toBuffer('image/png') });
  }
  return out;
}
