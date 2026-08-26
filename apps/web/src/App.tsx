import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { authClient } from './lib/auth';
import { LoginPage } from './components/LoginPage';
import { ChatWorkspace } from './components/chat/ChatWorkspace';
import { AppShell } from './components/shell/AppShell';
import { FileDrawer } from './components/shell/FileDrawer';
import { type ViewId } from './components/shell/navigation';
import { useHashRoute } from './hooks/useHashRoute';
import { type FileEntry, type ContextFile, useFiles } from './hooks/useFiles';
import { processDocument, type DocParseState } from './api/process';
import { useSessions } from './hooks/useSessions';
import { EvalWorkbenchView } from './components/eval/EvalWorkbenchView';
import { GraphView } from './components/graph/GraphView';
import { BindingsView } from './components/bindings/BindingsView';
import { FlowsView } from './components/flows/FlowsView';
import { SelfPartyPanel } from './components/parties/SelfPartyPanel';
import { FavoritesView } from './components/favorites/FavoritesView';
import { ProjectsView } from './components/projects/ProjectsView';
import type { GraphFocus, GraphFocusTarget } from './components/graph/focus';

function App() {
  const [session, setSession] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [fileDrawerOpen, setFileDrawerOpen] = useState(false);
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
  // 跨视图定位（同 graphFocus 模式）：文件抽屉「未绑定」徽标 -> 绑定工作台
  // 选中该文档。nonce 保证重复点击同一文件也会重新选中；跳转即关抽屉。
  const [bindingsFocus, setBindingsFocus] = useState<{ docId: string; nonce: number } | null>(null);
  const bindingsFocusNonceRef = useRef(0);
  const openBindingsForDoc = useCallback(
    (docId: string) => {
      bindingsFocusNonceRef.current += 1;
      setBindingsFocus({ docId, nonce: bindingsFocusNonceRef.current });
      setFileDrawerOpen(false);
      navigate('bindings');
    },
    [navigate],
  );
  // 导航入口的统一跳转：手动进入图谱/绑定页时清掉旧的外部定位，避免残留
  // 定位覆盖用户操作（openInGraph/openBindingsForDoc 直接调 navigate，不清
  // 自己刚设置的 focus）。
  const handleNavigate = useCallback((v: ViewId) => {
    if (v === 'graph') setGraphFocus(null);
    if (v === 'bindings') setBindingsFocus(null);
    navigate(v);
  }, [navigate]);
  // 执行流水页 -> 主体名单页的跳转(主体未配置导致流水为空时的引导)。
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
  // Per-docId parse state for files referenced in the conversation, shown on
  // the context chips in RealChatView (解析中 -> 已解析 / 需OCR / 解析失败).
  const [docParseStates, setDocParseStates] = useState<Record<string, DocParseState>>({});

  const refetchSession = useCallback(async () => {
    const { data } = await authClient.getSession();
    setSession(data ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    refetchSession();
  }, [refetchSession]);

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

  const handleSignOut = useCallback(async () => {
    try {
      await authClient.signOut();
    } catch {
      /* best-effort */
    }
    refetchSession();
  }, [refetchSession]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-ink-soft text-sm">
        Loading...
      </div>
    );
  }

  if (!session) {
    return <LoginPage onAuthed={refetchSession} />;
  }

  const user = (session as { user?: { name?: string; email?: string } } | null)?.user ?? null;

  return (
    <AppShell
      currentView={view}
      onNavigate={handleNavigate}
      onOpenFiles={() => setFileDrawerOpen(true)}
      filesOpen={fileDrawerOpen}
      user={user}
      onSignOut={() => void handleSignOut()}
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
            docParseStates,
          }}
        />
      ) : view === 'bindings' ? (
        <BindingsView onOpenInGraph={openInGraph} docFocus={bindingsFocus} />
      ) : view === 'flows' ? (
        <FlowsView onOpenParties={openParties} />
      ) : view === 'parties' ? (
        <SelfPartyPanel />
      ) : view === 'favorites' ? (
        <FavoritesView onOpenSession={(id) => navigate('chat', { session: id })} />
      ) : view === 'graph' ? (
        <GraphView focus={graphFocus} />
      ) : view === 'projects' ? (
        <ProjectsView />
      ) : view === 'eval' ? (
        <EvalWorkbenchView />
      ) : null}
      <FileDrawer
        open={fileDrawerOpen}
        onClose={() => setFileDrawerOpen(false)}
        onAddToConversation={addToConversation}
        contextFileKeys={contextFileKeys}
        filesApi={filesApi}
        onOpenBindings={openBindingsForDoc}
      />
    </AppShell>
  );
}

export default App;
