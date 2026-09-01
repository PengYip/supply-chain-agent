// 批量拆分器 Phase 2: bbox 裁剪 + 旋回候选(设计 2026-09-01 §5.2)。
// 用 @napi-rs/canvas 构造非对称页图, 断言裁剪尺寸/取色/旋转方向。
import { describe, it, expect } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  candidateRotations,
  renderUnitImages,
  unitRotationPlans,
} from '../../src/pipeline/unitImages.js';
import type { DetectedUnit } from '../../src/pipeline/batchSplit.js';
import type { RenderedPage } from '../../src/pipeline/pdfRender.js';

/** 200x100 页: 左半红, 右半蓝, 左上角 20x20 黑块(旋转方向判别用)。 */
function makePage(page: number): RenderedPage {
  const canvas = createCanvas(200, 100);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 100, 100);
  ctx.fillStyle = '#0000ff';
  ctx.fillRect(100, 0, 100, 100);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 20, 20);
  return { page, mime: 'image/png', buffer: canvas.toBuffer('image/png') };
}

async function pixel(buf: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const img = await loadImage(buf);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(x, y, 1, 1).data;
  return [d[0]!, d[1]!, d[2]!];
}

function unit(regions: DetectedUnit['regions']): DetectedUnit {
  return {
    unitIndex: 1,
    formType: '质检报告',
    confidence: 0.95,
    identifier: null,
    evidence: '',
    pageStart: regions[0]?.page ?? 1,
    pageEnd: regions[regions.length - 1]?.page ?? 1,
    bbox: regions.length === 1 ? regions[0]!.bbox : null,
    rotationDeg: regions[0]?.rotationDeg ?? 0,
    regions,
  };
}

describe('candidateRotations / unitRotationPlans', () => {
  it('0/180 单候选; 90/270 双候选(检测方向 + 反方向)', () => {
    expect(candidateRotations(0)).toEqual([0]);
    expect(candidateRotations(180)).toEqual([180]);
    expect(candidateRotations(90)).toEqual([90, 270]);
    expect(candidateRotations(270)).toEqual([270, 90]);
  });

  it('无歧义 unit 单计划; 含 90/270 region 的 unit 双计划(0/180 区域固定)', () => {
    expect(unitRotationPlans(unit([{ page: 1, bbox: { x: 0, y: 0, w: 1, h: 1 }, rotationDeg: 0 }]))).toEqual([[0]]);
    expect(
      unitRotationPlans(unit([
        { page: 1, bbox: { x: 0, y: 0, w: 1, h: 1 }, rotationDeg: 90 },
        { page: 2, bbox: { x: 0, y: 0, w: 1, h: 1 }, rotationDeg: 0 },
      ])),
    ).toEqual([[90, 0], [270, 0]]);
    expect(
      unitRotationPlans(unit([{ page: 1, bbox: { x: 0, y: 0, w: 1, h: 1 }, rotationDeg: 270 }])),
    ).toEqual([[270], [90]]);
  });
});

describe('renderUnitImages', () => {
  it('按归一化 bbox 裁剪(右半页 -> 蓝)', async () => {
    const images = await renderUnitImages(
      [makePage(1)],
      unit([{ page: 1, bbox: { x: 0.5, y: 0, w: 0.5, h: 1 }, rotationDeg: 0 }]),
      [0],
    );
    expect(images).toHaveLength(1);
    expect(images[0]!.mime).toBe('image/png');
    const img = await loadImage(images[0]!.buffer);
    expect(img.width).toBe(100);
    expect(img.height).toBe(100);
    expect(await pixel(images[0]!.buffer, 50, 50)).toEqual([0, 0, 255]);
  });

  it('顺时针旋转 90 度: 尺寸互换, 左上黑块转到右上', async () => {
    const images = await renderUnitImages(
      [makePage(1)],
      unit([{ page: 1, bbox: { x: 0, y: 0, w: 0.25, h: 1 }, rotationDeg: 90 }]),
      [90],
    );
    const img = await loadImage(images[0]!.buffer);
    expect(img.width).toBe(100); // 裁剪 50x100(竖) -> 旋回后 100x50(横)
    expect(img.height).toBe(50);
    // 左上 20x20 黑块顺时针 90 度后位于右上角。
    expect(await pixel(images[0]!.buffer, img.width - 5, 5)).toEqual([0, 0, 0]);
    expect(await pixel(images[0]!.buffer, 5, 5)).toEqual([255, 0, 0]);
  });

  it('反方向 270 度候选: 黑块转到左下(双候选方向歧义的另一侧)', async () => {
    const images = await renderUnitImages(
      [makePage(1)],
      unit([{ page: 1, bbox: { x: 0, y: 0, w: 0.25, h: 1 }, rotationDeg: 90 }]),
      [270],
    );
    const img = await loadImage(images[0]!.buffer);
    expect(await pixel(images[0]!.buffer, 5, img.height - 5)).toEqual([0, 0, 0]);
  });

  it('region 引用缺失页号时抛错(不静默产空图)', async () => {
    await expect(
      renderUnitImages([makePage(1)], unit([{ page: 2, bbox: { x: 0, y: 0, w: 1, h: 1 }, rotationDeg: 0 }]), [0]),
    ).rejects.toThrow('不在渲染页集');
  });
});
