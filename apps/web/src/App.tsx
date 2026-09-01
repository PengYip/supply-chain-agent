import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { authClient } from './lib/auth';
import { LoginPage } from './components/LoginPage';
import { ChatWorkspace } from './components/chat/ChatWorkspace';
import { AppShell } from './components/shell/AppShell';
import { DragDropOverlay } from './components/shell/DragDropOverlay';
import { FileDrawer } from './components/shell/FileDrawer';
import { type ViewId } from './components/shell/navigation';
import { useHashRoute } from './hooks/useHashRoute';
import { type FileEntry, type ContextFile, useFiles } from './hooks/useFiles';
import { collectDropItems, useFolderDropUpload } from './hooks/useFolderDropUpload';
import { usePageFileDrop } from './hooks/usePageFileDrop';
import { processDocument, type DocParseState } from './api/process';
import { useSessions } from './hooks/useSessions';
import { EvalWorkbenchView } from './components/eval/EvalWorkbenchView';
import { GraphView } from './components/graph/GraphView';
import { BindingsView } from './components/bindings/BindingsView';
import { SelfPartyPanel } from './components/parties/SelfPartyPanel';
import { FavoritesView } from './components/favorites/FavoritesView';
import { AuditView } from './components/audit/AuditView';
import { ProjectsView } from './components/projects/ProjectsView';
import { ProjectLedgerView } from './components/ledger/ProjectLedgerView';
import { SharePage } from './components/share/SharePage';
import { ReviewModal } from './components/ReviewModal';
import { subscribeContainerRefreshes, subscribeReviewRequests } from './lib/reviewModal';
import type { GraphFocus, GraphFocusTarget } from './components/graph/focus';

/** 免登录分享路由：pathname 匹配 /share/<token> 时在认证网关之前分流，
 *  直接渲染独立只读页（不进 AppShell、不查登录会话）。token 限 URL 安全字符。 */
function matchShareToken(pathname: string): string | null {
  const m = /^\/share\/([A-Za-z0-9_-]{1,128})\/?$/.exec(pathname);
  return m ? m[1] : null;
}

/** 应用根组件：按 pathname 分流 —— /share/<token> 走免登录分享页，其余进
 *  既有认证网关 App。分享页内部没有前端跳转，pathname 只需在启动时判定一次。 */
function AppRoot() {
  const shareToken = useMemo(() => matchShareToken(window.location.pathname), []);
  if (shareToken) return <SharePage token={shareToken} />;
  return <App />;
}

/** 认证网关: 只负责会话解析与账号切换的 epoch 递增。
 *  user id 变化时通过 key 强制重挂载内层 AppSession —— 所有按用户隔离的数据
 *  钩子(useGraph/useFiles/useSessions 等)随重挂载整体重建, 消灭"切号后列表
 *  不更新"一类的过期数据 bug(修复于 2026-08-27 反馈)。 */
function App() {
  const [session, setSession] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  // 已挂载会话的 user id; 用于识别跨账号切换并递增 epoch。
  const activeUidRef = useRef<string | null>(null);
  const [sessionEpoch, setSessionEpoch] = useState(0);

  const refetchSession = useCallback(async () => {
    const { data } = await authClient.getSession();
    setSession(data ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refetchSession();
  }, [refetchSession]);

  const uid =
    (session as { user?: { id?: string } } | null)?.user?.id ?? null;
  useEffect(() => {
    if (!uid || uid === activeUidRef.current) return;
    if (activeUidRef.current !== null) setSessionEpoch((e) => e + 1);
    activeUidRef.current = uid;
  }, [uid]);

  const handleSignOut = useCallback(async () => {
    try {
      await authClient.signOut();
    } catch {
      /* best-effort */
    }
    void refetchSession();
  }, [refetchSession]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-ink-soft text-sm">
        Loading...
      </div>
    );
  }

  if (!session || !uid) {
    return <LoginPage onAuthed={() => void refetchSession()} />;
  }

  const user = (session as { user?: { name?: string; email?: string } }).user ?? null;

  return (
    <AppSession
      key={`${uid}-${sessionEpoch}`}
      user={{ name: user?.name ?? '', email: user?.email ?? '', id: uid }}
      onSignOut={() => void handleSignOut()}
    />
  );
}

interface SessionUser { name: string; email: string; id: string }

function AppSession({ user, onSignOut }: { user: SessionUser; onSignOut: () => void }) {
  // 文件面板常驻右栏，登录后默认展开；顶栏只负责折叠/展开切换。
  const [fileDrawerOpen, setFileDrawerOpen] = useState(true);
  // hash 路由是视图与活动会话的 SSOT：`#/chat?session=<id>`。手动 setState
  // activeSessionId 的旧双源已消除，popstate 时自动从 hash 恢复。
  const { route, navigate } = useHashRoute();
  const view = route.view;
  const activeSessionId = route.params.session ?? null;
  // 跨视图定位：绑定工作台 -> 图谱页，以合同节点为中心展开。
  // nonce 自增保证重复跳转同一合同也会触发图谱页重新查询。URL 表达不了
  // 「重复触发同一目标」，故 nonce 不进路由、保留 App state。
  const [graphFocus, setGraphFocus] = useState<GraphFocus | null>(null);
  const graphFocusNonceRef = useRef(0);
  const openInGraph = useCallback((target: GraphFocusTarget) => {
    graphFocusNonceRef.current += 1;
    setGraphFocus({ ...target, nonce: graphFocusNonceRef.current });
    navigate('graph');
  }, [navigate]);
  // 跨视图定位 -> 绑定工作台：图谱 Inspector「去审核」(spec 2026-08-26 §4.4)
  // 与文件抽屉「未挂合同」徽标两条入口共用同一 focus 状态。nonce 自增保证重复
  // 跳转同一文档也会重新选中。
  const [bindingsFocus, setBindingsFocus] = useState<{ docId: string; nonce: number } | null>(null);
  const bindingsFocusNonceRef = useRef(0);
  const openInBindings = useCallback((docId: string) => {
    bindingsFocusNonceRef.current += 1;
    setBindingsFocus({ docId, nonce: bindingsFocusNonceRef.current });
    navigate('bindings');
  }, [navigate]);
  // 文件抽屉「未挂合同」徽标 -> 绑定工作台（跳转即关抽屉）。
  const openBindingsForDoc = useCallback(
    (docId: string) => {
      bindingsFocusNonceRef.current += 1;
      setBindingsFocus({ docId, nonce: bindingsFocusNonceRef.current });
      setFileDrawerOpen(false);
      navigate('bindings');
    },
    [navigate],
  );
  // 全局复核弹窗（App 层单例）： 文件树子单据行/复核卡拆分清单经
  // lib/reviewModal 通道请求打开；弹窗已开时切换目标（key 化重挂载）。
  const [reviewDocId, setReviewDocId] = useState<string | null>(null);
  // 复核弹窗关闭后递增，驱动文件抽屉重拉已展开单据组的子单据清单。
  const [batchRefreshToken, setBatchRefreshToken] = useState(0);
  useEffect(() => subscribeReviewRequests((docId) => setReviewDocId(docId)), []);
  // 批量拆分修正(重拆/单 unit 重抽/合并)成功后: 递增令牌让文件抽屉重拉
  // 已展开单据组的子单据清单(复核卡自身会就地刷新,不依赖本通道)。
  useEffect(() => subscribeContainerRefreshes(() => setBatchRefreshToken((t) => t + 1)), []);
  const closeReview = useCallback(() => {
    setReviewDocId(null);
    setBatchRefreshToken((t) => t + 1);
  }, []);
  // 导航入口的统一跳转：手动进入图谱/绑定页时清掉旧的外部定位，避免残留
  // 定位覆盖用户操作（openInGraph/openInBindings/openBindingsForDoc 直接调
  // navigate，不清自己刚设置的 focus）。
  const handleNavigate = useCallback((v: ViewId) => {
    if (v === 'graph') setGraphFocus(null);
    if (v === 'bindings') setBindingsFocus(null);
    navigate(v);
  }, [navigate]);
  // 台账执行区块 -> 主体名单页的跳转(主体未配置导致流水为空时的引导)。
  const openParties = useCallback(() => navigate('parties'), [navigate]);
  // 会话切换用 replace：高频操作不灌爆浏览器历史；跨视图跳转用 push。
  const selectSession = useCallback(
    (id: string) => navigate('chat', { session: id }, { replace: true }),
    [navigate],
  );
  const [contextFiles, setContextFiles] = useState<ContextFile[]>([]);
  // Phase 5: sessions live at App so the sidebar (data) and RealChatView
  // (refresh trigger) can share one useSessions instance.
  const sessionsApi = useSessions();
  // Files live at App so RealChatView (upload) and FileDrawer (list) share one
  // useFiles instance; upload success refreshes the list via onFilesChanged.
  const filesApi = useFiles();
  // Stable re-fetch reference (useCallback inside useFiles) for effect deps.
  const refreshFiles = filesApi.refresh;
  // 上传队列提升到 App 层：全页面拖拽上传与文件抽屉共用一个队列，抽屉
  // 关闭不再销毁进行中的上传（汇总条 UI 仍在 FileDrawer 内消费）。
  // ensureDirs/onDone 写法与原 FileDrawer 内实现保持一致。
  const { folders, createFolder } = filesApi;
  const uploadQueue = useFolderDropUpload({
    ensureDirs: useCallback(
      async (dirs: string[]) => {
        const have = new Set(folders.map((f) => f.path));
        for (const d of dirs) {
          if (!have.has(d)) {
            await createFolder(d);
            have.add(d);
          }
        }
      },
      [folders, createFolder],
    ),
    onDone: () => void refreshFiles(),
  });
  // 页面级拖拽：OS 文件拖入窗口任意位置显示提示遮罩；落在无人认领的
  // 区域时收集条目（支持文件夹层级）入队到文件管理根目录。
  const handlePageDrop = useCallback(
    (dt: DataTransfer) => {
      void collectDropItems(dt).then((items) => {
        if (items.length > 0) void uploadQueue.enqueue(items, '');
      });
    },
    [uploadQueue],
  );
  const { dragActive } = usePageFileDrop({ onDropFiles: handlePageDrop });
  // Per-docId parse state for files referenced in the conversation, shown on
  // the context chips in RealChatView (解析中 -> 已解析 / 需OCR / 解析失败).
  const [docParseStates, setDocParseStates] = useState<Record<string, DocParseState>>({});

  const contextFileKeys = useMemo(
    () => new Set(contextFiles.map((f) => f.key)),
    [contextFiles],
  );

  const addToConversation = useCallback((file: FileEntry) => {
    // 添加到对话只在对话视图有意义：从其他视图的文件抽屉发起时先跳回 chat，
    // contextFiles 是 App state，跨视图天然保留。
    if (view !== 'chat') navigate('chat');
    // Upload now always creates a document stub, so docId is guaranteed. The
    // guard only trips for objects stored before that contract existed --
    // they can't be referenced in chat, so skip silently rather than block.
    if (!file.docId) return;
    const docId = file.docId;
    setContextFiles((prev) =>
      prev.some((f) => f.key === file.key)
        ? prev
        : [...prev, { docId, filename: file.name, key: file.key }],
    );
    // Adding to a conversation activates parsing: fire the background process
    // immediately and track the per-doc state for the context chip. Sending
    // mid-parse is fine -- the backend waits for referenced docs before the
    // agent runs.
    setDocParseStates((prev) => ({ ...prev, [docId]: 'parsing' }));
    processDocument(docId)
      .then((res) => {
        setDocParseStates((prev) => ({ ...prev, [docId]: res.parseStatus }));
      })
      .catch(() => {
        setDocParseStates((prev) => ({ ...prev, [docId]: 'failed' }));
      })
      .finally(() => {
        // Sync the file drawer so the row badge reflects the stored status.
        void refreshFiles();
      });
  }, [view, navigate, refreshFiles]);

  return (
    <AppShell
      currentView={view}
      onNavigate={handleNavigate}
      // 顶栏「文件」按钮兼作面板开关。展开时重拉列表：「已挂合同」徽标在
      // 绑定工作台/对话里确认后会过期（useFiles 仅在挂载与上传等少数事件时
      // 刷新），展开即取最新态。
      onOpenFiles={() => {
        if (fileDrawerOpen) {
          setFileDrawerOpen(false);
          return;
        }
        setFileDrawerOpen(true);
        void refreshFiles();
      }}
      filesOpen={fileDrawerOpen}
      user={user}
      onSignOut={onSignOut}
      // 文件面板常驻挂载（open 只控制宽度伸缩）：内部选中/展开状态跨开关
      // 保留；收起时宽度归零，主对话区以 flex-1 延展占满剩余空间。
      filesPanel={
        <FileDrawer
          open={fileDrawerOpen}
          onClose={() => setFileDrawerOpen(false)}
          onAddToConversation={addToConversation}
          contextFileKeys={contextFileKeys}
          filesApi={filesApi}
          uploadQueue={uploadQueue}
          onOpenBindings={openBindingsForDoc}
          batchRefreshToken={batchRefreshToken}
        />
      }
    >
      {view === 'chat' ? (
        <ChatWorkspace
          activeSessionId={activeSessionId}
          onSelectSession={selectSession}
          sessionsApi={sessionsApi}
          chat={{
            contextFiles,
            setContextFiles,
            onSessionChanged: () => { void sessionsApi.refresh(); },
            onSessionCreated: (id) => {
              selectSession(id);
              void sessionsApi.refresh();
            },
            onFilesChanged: () => { void filesApi.refresh(); },
            onOpenBindings: openBindingsForDoc,
            docParseStates,
          }}
        />
      ) : view === 'bindings' ? (
        <BindingsView onOpenInGraph={openInGraph} docFocus={bindingsFocus} onChanged={() => { void filesApi.refresh(); }} />
      ) : view === 'parties' ? (
        <SelfPartyPanel />
      ) : view === 'favorites' ? (
        <FavoritesView onOpenSession={(id) => navigate('chat', { session: id })} />
      ) : view === 'graph' ? (
        <GraphView focus={graphFocus} onOpenInBindings={openInBindings} />
      ) : view === 'projects' ? (
        <ProjectsView />
      ) : view === 'ledger' ? (
        <ProjectLedgerView onOpenProjects={() => navigate('projects')} onOpenParties={openParties} />
      ) : view === 'eval' ? (
        <EvalWorkbenchView />
      ) : view === 'audit' ? (
        <AuditView />
      ) : null}
      {/* 全页面拖拽上传提示遮罩：fixed 定位，z-modal 高于文件抽屉 */}
      <DragDropOverlay visible={dragActive} />
      {/* 全局复核弹窗单例：docId 作 key，切换目标即重挂载重拉快照。
          挂在 AppShell 内容区之后，z-modal 层级高于文件抽屉。 */}
      {reviewDocId && (
        <ReviewModal
          key={reviewDocId}
          docId={reviewDocId}
          onClose={closeReview}
          onOpenBindings={openBindingsForDoc}
        />
      )}
    </AppShell>
  );
}

export default AppRoot;
