// apps/web/src/components/review-workbench/OriginalPane.tsx
// 左栏原文区(行->页锚定, spec 2026-09-04 §6): 上方当前页大图(Task 6 单页
// 裁切端点), 下方缩略图条(该 unit 页区间); 点选行 -> 大图跳到该行 页码。
// 页码取自明细行注入的 页码 字段(pageRecords.ts 聚合), 无选中时显示第
// 一页; 手动点缩略图可临时覆盖(selectedPage 变化时重新跟随)。
import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { FileQuestion } from 'lucide-react';
import { unitPreviewPageUrl, type WorkbenchUnit } from '../../api/reviewWorkbench';

export function OriginalPane({
  unit,
  selectedPage,
}: {
  unit: WorkbenchUnit | null;
  selectedPage: number | null;
}) {
  const pages = useMemo(() => {
    if (!unit || unit.pageStart == null) return [];
    const end = unit.pageEnd ?? unit.pageStart;
    const out: number[] = [];
    for (let p = unit.pageStart; p <= end; p++) out.push(p);
    return out;
  }, [unit]);

  // selectedPage 变化即跟随(点行/方向键都走 selected); 手动点缩略图临时覆盖。
  const [manualPage, setManualPage] = useState<number | null>(null);
  useEffect(() => {
    setManualPage(null);
  }, [selectedPage, unit?.docId]);

  const current = manualPage ?? selectedPage ?? pages[0] ?? null;
  const imgUrl = unit && current != null ? unitPreviewPageUrl(unit.docId, current) : null;

  // 大图加载失败兜底(spec §10 承诺): 失败回退整 unit 纵拼图(无 page 参数);
  // state 记录已回退, 避免 onError 死循环; imgUrl 变化时重置重新尝试单页。
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => {
    setImgFailed(false);
  }, [imgUrl]);
  const displayUrl = imgUrl && imgFailed && unit ? unitPreviewPageUrl(unit.docId) : imgUrl;

  if (!unit || current == null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs text-ink-soft">
        <FileQuestion className="h-8 w-8 text-line" aria-hidden />
        <span>点击表格中的行，这里显示对应原片页</span>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-1.5 text-xs text-ink-soft">
        <span className="truncate font-medium text-ink">{unit.title}</span>
        <span>第 {current} 页{unit.pageEnd != null && unit.pageEnd > (unit.pageStart ?? 1) ? ` / 共 ${unit.pageEnd - (unit.pageStart ?? 1) + 1} 页` : ''}</span>
      </div>
      {/* 大图: object-contain 适配, 加载失败回退整 unit 图 */}
      <div className="min-h-0 flex-1 overflow-auto bg-surface p-3">
        {displayUrl && (
          <img
            key={displayUrl}
            src={displayUrl}
            alt={`${unit.title} 第 ${current} 页原片`}
            loading="lazy"
            onError={() => setImgFailed(true)}
            className="mx-auto max-w-full rounded border border-line bg-white shadow-sm"
          />
        )}
      </div>
      {/* 缩略图条 */}
      {pages.length > 1 && (
        <div className="flex shrink-0 gap-1.5 overflow-x-auto border-t border-line px-3 py-2">
          {pages.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setManualPage(p)}
              title={`查看第 ${p} 页`}
              className={clsx(
                'flex h-14 w-11 shrink-0 cursor-pointer items-center justify-center rounded border text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
                p === current
                  ? 'border-primary bg-primary/10 font-semibold text-primary'
                  : 'border-line bg-surface text-ink-soft hover:border-ink-soft/40',
              )}
            >
              {p}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}