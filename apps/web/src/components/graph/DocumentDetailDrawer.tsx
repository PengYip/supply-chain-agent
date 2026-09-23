import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchDocumentDetail, type DocumentDetailDTO,
} from '../../api/ontology';

interface Props {
  docId: string;
  onClose: () => void;
}

/** 文件扩展名 -> 预览形态: pdf 内嵌 iframe, 图片内嵌 img, 其余给新开页下载。 */
function previewKind(filename: string): 'pdf' | 'image' | 'other' {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return 'image';
  return 'other';
}

const STATUS_LABELS: Record<string, string> = {
  confirmed: '已确认', proposed: '待确认', pending: '待复核',
  parsed: '已解析', uploaded: '已上传', parsing: '解析中',
  needs_ocr: '待OCR', failed: '解析失败', approved: '已复核',
};

function statusLabel(s: string): string {
  return STATUS_LABELS[s] ?? s;
}

/** 单据详情抽屉(2026-09-23): 面包屑「项目 \ 合同 \ 单据类型 \ 单据名称」+
 *  原文件预览(/api/files/stream 同源流式, 会话鉴权)+ 绑定合同/项目归属。
 *  穿透图谱 Document 节点与台账「关联单据」行共用。 */
export function DocumentDetailDrawer({ docId, onClose }: Props) {
  const [detail, setDetail] = useState<DocumentDetailDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchDocumentDetail(docId);
      if (seq !== seqRef.current) return;
      setDetail(res);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [docId]);

  useEffect(() => { void load(); }, [load]);

  const kind = detail ? previewKind(detail.filename) : 'other';

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" role="dialog" aria-modal="true">
      <div className="flex h-full w-[720px] max-w-[95vw] flex-col bg-white shadow-lg">
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-ink">单据详情</div>
            {/* 面包屑: 项目 \ 合同 \ 单据类型 \ 单据名称 */}
            <div className="mt-1 break-all text-xs leading-5 text-ink">
              {detail?.breadcrumb ?? <span className="text-ink-soft">加载中...</span>}
            </div>
            <div className="mt-0.5 text-xs text-ink-soft">{docId}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {detail?.previewUrl && (
              <a
                href={detail.previewUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded border border-line px-2 py-1 text-xs text-ink-soft transition-colors hover:border-primary/40 hover:text-primary"
              >
                新窗口打开
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="rounded p-1 text-ink-soft transition-colors hover:bg-surface hover:text-ink"
            >
              关闭
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && <div className="px-4 py-6 text-sm text-ink-soft">加载中...</div>}
          {error && <div className="px-4 py-6 text-sm text-danger">{error}</div>}
          {detail && (
            <>
              {/* 元信息 */}
              <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2 text-xs">
                <span className="rounded bg-surface px-1.5 py-0.5 text-ink">{detail.docType}</span>
                <span className="rounded bg-surface px-1.5 py-0.5 text-ink-soft">
                  解析: {statusLabel(detail.parseStatus)}
                </span>
                <span className="rounded bg-surface px-1.5 py-0.5 text-ink-soft">
                  复核: {statusLabel(detail.reviewStatus)}
                </span>
                {detail.batchRole === 'container' && (
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">单据组</span>
                )}
                {detail.createdAt && (
                  <span className="text-ink-soft">录入 {detail.createdAt.slice(0, 10)}</span>
                )}
              </div>

              {/* 绑定合同 + 项目归属 */}
              <div className="grid grid-cols-2 gap-x-4 border-b border-line px-4 py-3 text-xs">
                <div>
                  <div className="mb-1 font-medium text-ink">关联合同</div>
                  {detail.contracts.length === 0 && <div className="text-ink-soft">无绑定</div>}
                  <ul className="space-y-1">
                    {detail.contracts.map((ct) => (
                      <li key={ct.contractNo} className="leading-5">
                        <span className="text-ink">{ct.contractNo}</span>
                        {ct.title && <span className="ml-1 text-ink-soft">{ct.title}</span>}
                        <span className="ml-1 rounded bg-surface px-1 text-ink-soft">
                          {ct.relation} · {statusLabel(ct.status)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="mb-1 font-medium text-ink">项目归属</div>
                  {detail.projects.length === 0 && <div className="text-ink-soft">无归属</div>}
                  <ul className="space-y-1">
                    {detail.projects.map((p) => (
                      <li key={p.code} className="leading-5">
                        <span className="text-ink">{p.name}</span>
                        <span className="ml-1 text-ink-soft">{p.code}</span>
                        <span className="ml-1 rounded bg-surface px-1 text-ink-soft">
                          {statusLabel(p.status)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* 原文件预览 */}
              <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
                <div className="mb-2 text-xs font-medium text-ink">原始文件</div>
                {!detail.previewUrl && (
                  <div className="rounded border border-line bg-surface/40 px-3 py-6 text-center text-xs text-ink-soft">
                    该单据为旧数据（无 MinIO 对象），暂无原文件预览
                  </div>
                )}
                {detail.previewUrl && kind === 'pdf' && (
                  <iframe
                    src={detail.previewUrl}
                    title={detail.filename}
                    className="h-[62vh] w-full rounded border border-line"
                  />
                )}
                {detail.previewUrl && kind === 'image' && (
                  <img
                    src={detail.previewUrl}
                    alt={detail.filename}
                    className="max-h-[62vh] w-full rounded border border-line object-contain"
                  />
                )}
                {detail.previewUrl && kind === 'other' && (
                  <div className="rounded border border-line bg-surface/40 px-3 py-6 text-center text-xs text-ink-soft">
                    {detail.filename}（该格式不支持内嵌预览，
                    <a href={detail.previewUrl} target="_blank" rel="noreferrer" className="text-primary underline">
                      点击下载
                    </a>
                    ）
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
