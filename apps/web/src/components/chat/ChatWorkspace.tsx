import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Image as ImageIcon,
  ImageDown,
  Images,
  Loader2,
  Share2,
} from 'lucide-react';
import { useSessions } from '../../hooks/useSessions';
import { SessionSidebar } from '../SessionSidebar';
import { RealChatView } from '../RealChatView';
import { PanelRail } from '../shell/PanelRail';
import { createSessionShare } from '../../api/share';
import {
  disposeExportCanvas,
  renderChatExport,
  type ChatExportResult,
  type ExportMode,
} from '../../lib/chatExport';
import { ExportPreviewModal } from './ExportPreviewModal';

/** 右上角轻提示（样式与 BindingsView / SelfPartyPanel 的本地 toast 一致）。 */
interface ToastItem {
  id: number;
  kind: 'success' | 'error';
  text: string;
  detail?: string;
}

/** 复制文本到剪贴板：优先 navigator.clipboard（安全上下文），内网 http 访问
 *  无该 API 时退化用 execCommand。返回是否复制成功。 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }
}

/** 对话工作区：左侧可折叠会话面板 + 右侧消息流。
 *  会话列表从全局布局收进对话视图（原为 App 级常驻 260px，其他视图白占空间）。
 *  App 仍持有唯一 useSessions 实例并经 sessionsApi 透传，保持
 *  「侧栏数据与 RealChatView 刷新触发共享同一实例」的既有契约。
 *  另承担会话级「分享 / 导出图片」入口（见下方覆盖层注释）。 */
export function ChatWorkspace({
  activeSessionId,
  onSelectSession,
  sessionsApi,
  chat,
}: {
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  sessionsApi: ReturnType<typeof useSessions>;
  /** RealChatView 其余 props 原样透传（sessionId 单独传入）。 */
  chat: Omit<React.ComponentProps<typeof RealChatView>, 'sessionId'>;
}) {
  // 面板折叠（默认展开，不持久化），与图谱/绑定面板同一交互语言
  const [collapsed, setCollapsed] = useState(false);
  // 切换会话即刷新列表：离开刚用过的会话后其 messageCount/标题即时更新，
  // 「空会话不展示」的过滤不会误伤已产生消息的会话。
  const { refresh } = sessionsApi;
  useEffect(() => { void refresh(); }, [activeSessionId, refresh]);

  // ── 分享 / 导出 ──
  const chatAreaRef = useRef<HTMLDivElement>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  // 导出预览：生成结果暂存于此并挂载预览模态，用户确认后才落盘/复制；
  // 关闭时释放主画布（超长对话的画布缓冲可观，不等 GC）
  const [exportPreview, setExportPreview] = useState<ChatExportResult | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastIdRef = useRef(0);

  const pushToast = useCallback(
    (kind: ToastItem['kind'], text: string, detail?: string, duration = 3000) => {
      const id = ++toastIdRef.current;
      setToasts((prev) => [...prev.slice(-2), { id, kind, text, detail }]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, duration);
    },
    [],
  );

  // 导出菜单外点关闭（与 AppTopbar 用户菜单同一交互）
  useEffect(() => {
    if (!exportMenuOpen) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [exportMenuOpen]);

  // 切换会话收起导出菜单：渲染期间检测 prop 变化并重置（React 官方的
  // 「props 变化时调整 state」模式），避免 effect 内同步 setState。
  const [prevSessionId, setPrevSessionId] = useState(activeSessionId);
  if (prevSessionId !== activeSessionId) {
    setPrevSessionId(activeSessionId);
    setExportMenuOpen(false);
  }

  // 分享：创建 token -> 拼完整链接 -> 复制到剪贴板并 toast 反馈
  const handleShare = useCallback(async () => {
    if (!activeSessionId || shareBusy) return;
    setShareBusy(true);
    try {
      const { path } = await createSessionShare(activeSessionId);
      const link = `${window.location.origin}${path}`;
      const copied = await copyTextToClipboard(link);
      pushToast(
        'success',
        copied ? '分享链接已复制' : '分享链接已生成（复制未成功，请手动复制）',
        link,
        copied ? 3000 : 8000,
      );
    } catch (err) {
      pushToast('error', '生成分享链接失败', err instanceof Error ? err.message : undefined);
    } finally {
      setShareBusy(false);
    }
  }, [activeSessionId, shareBusy, pushToast]);

  // 导出：先渲染主画布并弹出预览模态（详见 lib/chatExport.ts 与
  // ExportPreviewModal），用户在预览中确认后才真正落盘/复制
  const handleExport = useCallback(
    async (mode: ExportMode) => {
      if (!activeSessionId || exportBusy) return;
      setExportMenuOpen(false);
      setExportBusy(true);
      const title =
        sessionsApi.sessions.find((s) => s.id === activeSessionId)?.title?.trim() || '未命名对话';
      try {
        const result = await renderChatExport(chatAreaRef.current, { title, mode });
        setExportPreview(result);
      } catch (err) {
        // 含空白自检失败（「导出结果为空白」）等场景，明确提示而不是产出空白图
        pushToast('error', '导出失败，请重试', err instanceof Error ? err.message : undefined, 5000);
      } finally {
        setExportBusy(false);
      }
    },
    [activeSessionId, exportBusy, sessionsApi.sessions, pushToast],
  );

  // 关闭预览：卸载模态并立即释放主画布（width 置 0 是幂等操作）
  const closeExportPreview = useCallback(() => {
    setExportPreview((prev) => {
      if (prev) disposeExportCanvas(prev);
      return null;
    });
  }, []);

  return (
    <div className="flex h-full min-w-0">
      <div
        className={clsx(
          'h-full shrink-0 overflow-hidden transition-[width] duration-200',
          collapsed ? 'w-0' : 'w-64',
        )}
      >
        <SessionSidebar
          activeSessionId={activeSessionId}
          onSelect={onSelectSession}
          sessions={sessionsApi.sessions}
          loading={sessionsApi.loading}
          createSession={sessionsApi.createSession}
          deleteSession={sessionsApi.deleteSession}
          refresh={sessionsApi.refresh}
          favoriteSession={sessionsApi.favoriteSession}
          unfavoriteSession={sessionsApi.unfavoriteSession}
        />
      </div>
      <PanelRail
        collapsed={collapsed}
        side="left"
        label="会话"
        onToggle={() => setCollapsed((v) => !v)}
      />
      {/* relative 包裹层：RealChatView 自身状态条的左半是空白带（标题由全局
          AppTopbar 承担），「分享 / 导出图片」操作簇以覆盖层落在该空白带上，
          视觉上成为状态条的一部分，不触碰 RealChatView 内部实现；导出也从
          这里向下查询消息流 DOM。覆盖层本身 pointer-events-none，右侧原有的
          状态徽标与收藏按钮不受遮挡。 */}
      <div className="relative flex min-w-0 flex-1 flex" ref={chatAreaRef}>
        <RealChatView sessionId={activeSessionId} {...chat} />
        {activeSessionId && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex h-12 items-center px-4">
            <div className="pointer-events-auto flex items-center gap-1">
              <button
                type="button"
                title={shareBusy ? '正在生成分享链接...' : '分享对话（复制免登录只读链接）'}
                aria-label="分享对话"
                disabled={shareBusy || exportBusy}
                onClick={() => {
                  void handleShare();
                }}
                className={clsx(
                  'rounded-lg p-1.5 transition-colors',
                  'text-ink-soft hover:bg-surface hover:text-ink',
                  (shareBusy || exportBusy) && 'cursor-not-allowed opacity-50',
                )}
              >
                {shareBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Share2 className="h-4 w-4" aria-hidden />
                )}
              </button>
              <div className="relative" ref={exportMenuRef}>
                <button
                  type="button"
                  title="导出图片"
                  aria-label="导出图片"
                  aria-expanded={exportMenuOpen}
                  disabled={exportBusy || shareBusy}
                  onClick={() => setExportMenuOpen((v) => !v)}
                  className={clsx(
                    'flex items-center gap-0.5 rounded-lg p-1.5 transition-colors',
                    'text-ink-soft hover:bg-surface hover:text-ink',
                    (exportBusy || shareBusy) && 'cursor-not-allowed opacity-50',
                  )}
                >
                  {exportBusy ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <ImageDown className="h-4 w-4" aria-hidden />
                  )}
                  <ChevronDown className="h-3 w-3" aria-hidden />
                </button>
                {exportMenuOpen && (
                  <div className="animate-fade-in absolute left-0 top-full z-30 mt-2 w-60 rounded-lg border border-line bg-white p-1 shadow-lg">
                    <button
                      type="button"
                      onClick={() => {
                        void handleExport('long');
                      }}
                      disabled={exportBusy}
                      className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <ImageIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary-500" aria-hidden />
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium text-ink">保存长图</span>
                        <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-soft">
                          整段对话导出为一张 PNG
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void handleExport('paged');
                      }}
                      disabled={exportBusy}
                      className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Images className="mt-0.5 h-4 w-4 shrink-0 text-primary-500" aria-hidden />
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium text-ink">分页多图</span>
                        <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-soft">
                          切片打包为单个 ZIP 下载
                        </span>
                      </span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      {/* 导出预览模态（长图核验 / 多图翻页，确认后落盘）。置于 toast 容器
          之前：两者同为 z-60 时后写入 DOM 者居上，报错/成功提示不被遮罩盖住 */}
      {exportPreview && (
        <ExportPreviewModal
          result={exportPreview}
          onClose={closeExportPreview}
          onToast={pushToast}
        />
      )}
      {/* 右上角 toast（样式与 BindingsView 一致） */}
      <div className="pointer-events-none fixed right-4 top-4 z-[60] flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={clsx(
              'animate-fade-in rounded-md border border-line border-l-4 bg-white px-3.5 py-2.5 shadow-card',
              t.kind === 'error' ? 'border-l-danger' : 'border-l-success',
            )}
          >
            <div className="flex items-start gap-2">
              {t.kind === 'error' ? (
                <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-danger" aria-hidden />
              ) : (
                <CheckCircle2 className="mt-px h-4 w-4 shrink-0 text-success" aria-hidden />
              )}
              <div className="min-w-0 text-xs leading-relaxed text-ink">
                <span className="break-words">{t.text}</span>
                {t.detail && (
                  <span className="mt-0.5 block break-all text-[11px] text-ink-soft">{t.detail}</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
