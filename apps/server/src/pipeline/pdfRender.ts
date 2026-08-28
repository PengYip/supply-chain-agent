// PDF 页面渲染: pdf-to-img(纯 JS pdfjs)把每页渲成 PNG Buffer。
// 分类取第 1 页、凭证提取取全部页, 由调用方切片; 本模块只做页->图。
import { statSync } from 'node:fs';
import { pdf } from 'pdf-to-img';

export interface RenderedPage {
  /** 1-indexed */
  page: number;
  mime: 'image/png';
  buffer: Buffer;
}

/** DPI->pdf-to-img scale(基准 72dpi)。默认 150dpi: 分类与票据提取够用, 单页产物远小于 10MB 上限。 */
export function dpiToScale(dpi = 150): number {
  return dpi / 72;
}

export async function renderPdfPages(
  sourcePath: string,
  opts: { dpi?: number; /** 只渲染前 N 页(分类只需第 1 页; 160 页批量件不必全渲)。 */ first?: number } = {},
): Promise<RenderedPage[]> {
  let ok = false;
  try {
    ok = /\.pdf$/i.test(sourcePath) && statSync(sourcePath).isFile();
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`不是有效的 PDF 文件: ${sourcePath}`);
  const doc = await pdf(sourcePath, { scale: dpiToScale(opts.dpi) });
  const out: RenderedPage[] = [];
  let page = 0;
  for await (const img of doc) {
    page += 1;
    out.push({ page, mime: 'image/png', buffer: Buffer.from(img) });
    if (opts.first !== undefined && page >= opts.first) break;
  }
  if (out.length === 0) throw new Error(`PDF 渲染得到 0 页: ${sourcePath}`);
  return out;
}
