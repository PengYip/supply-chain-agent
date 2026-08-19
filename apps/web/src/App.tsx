import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { authClient } from './lib/auth';
import { LoginPage } from './components/LoginPage';
import { RealChatView } from './components/RealChatView';
import { SessionSidebar } from './components/SessionSidebar';
import { FilePanel } from './components/FilePanel';
import { type FileEntry, type ContextFile, useFiles } from './hooks/useFiles';
import { processDocument, type DocParseState } from './api/process';
import { useSessions } from './hooks/useSessions';
import { EvalWorkbenchView } from './components/eval/EvalWorkbenchView';
import { GraphView } from './components/graph/GraphView';
import { BindingsView } from './components/bindings/BindingsView';
import { FlowsView } from './components/flows/FlowsView';
import { SelfPartyPanel } from './components/parties/SelfPartyPanel';
import type { GraphFocus, GraphFocusTarget } from './components/graph/focus';
import { ArrowLeftRight, Building2, FlaskConical, Link2, MessageSquare, Network } from 'lucide-react';
import clsx from 'clsx';

function App() {
  const [session, setSession] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [filePanelVisible, setFilePanelVisible] = useState(false);
  const [view, setView] = useState<'chat' | 'eval' | 'graph' | 'bindings' | 'flows' | 'parties'>('chat');
  // 跨视图定位：绑定工作台 -> 图谱页，以合同节点为中心展开。
  // nonce 自增保证重复跳转同一合同也会触发图谱页重新查询。
  const [graphFocus, setGraphFocus] = useState<GraphFocus | null>(null);
  const graphFocusNonceRef = useRef(0);
  const openInGraph = useCallback((target: GraphFocusTarget) => {
    graphFocusNonceRef.current += 1;
    setGraphFocus({ ...target, nonce: graphFocusNonceRef.current });
    setView('graph');
  }, []);
  // 执行流水页 -> 主体名单页的跳转(主体未配置导致流水为空时的引导)。
  const openParties = useCallback(() => setView('parties'), []);
  const [contextFiles, setContextFiles] = useState<ContextFile[]>([]);
  // Phase 5: sessions live at App so the sidebar (data) and RealChatView
  // (refresh trigger) can share one useSessions instance.
  const { sessions, loading: sessionsLoading, refresh: refreshSessions, createSession, deleteSession } = useSessions();
  // Files live at App so RealChatView (upload) and FilePanel (list) share one
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
        // Sync the file panel so the row badge reflects the stored status.
        void refreshFiles();
      });
  }, [refreshFiles]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-textGray text-sm">
        Loading...
      </div>
    );
  }

  if (!session) {
    return <LoginPage onAuthed={refetchSession} />;
  }

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <SessionSidebar
        activeSessionId={activeSessionId}
        onSelect={setActiveSessionId}
        sessions={sessions}
        loading={sessionsLoading}
        createSession={createSession}
        deleteSession={deleteSession}
      />
      <div className="w-12 shrink-0 border-r border-borderGray bg-white flex flex-col items-center py-3 gap-2">
        <button type="button" title="对话" aria-label="对话" onClick={() => setView('chat')}
          className={clsx('w-9 h-9 rounded-lg flex items-center justify-center', view === 'chat' ? 'bg-deepSea text-white' : 'text-textGray hover:bg-bgGray')}>
          <MessageSquare className="h-5 w-5" aria-hidden />
        </button>
        <button type="button" title="评估" aria-label="评估" onClick={() => setView('eval')}
          className={clsx('w-9 h-9 rounded-lg flex items-center justify-center', view === 'eval' ? 'bg-deepSea text-white' : 'text-textGray hover:bg-bgGray')}>
          <FlaskConical className="h-5 w-5" aria-hidden />
        </button>
        <button
          type="button"
          title="图谱"
          aria-label="图谱"
          // 手动进入图谱页时清掉旧的外部定位，避免残留合同中心覆盖用户操作
          onClick={() => {
            setGraphFocus(null);
            setView('graph');
          }}
          className={clsx('w-9 h-9 rounded-lg flex items-center justify-center', view === 'graph' ? 'bg-deepSea text-white' : 'text-textGray hover:bg-bgGray')}
        >
          <Network className="h-5 w-5" aria-hidden />
        </button>
        <button type="button" title="绑定" aria-label="绑定" onClick={() => setView('bindings')}
          className={clsx('w-9 h-9 rounded-lg flex items-center justify-center', view === 'bindings' ? 'bg-deepSea text-white' : 'text-textGray hover:bg-bgGray')}>
          <Link2 className="h-5 w-5" aria-hidden />
        </button>
        <button type="button" title="执行流水" aria-label="执行流水" onClick={() => setView('flows')}
          className={clsx('w-9 h-9 rounded-lg flex items-center justify-center', view === 'flows' ? 'bg-deepSea text-white' : 'text-textGray hover:bg-bgGray')}>
          <ArrowLeftRight className="h-5 w-5" aria-hidden />
        </button>
        <button type="button" title="主体名单" aria-label="主体名单" onClick={() => setView('parties')}
          className={clsx('w-9 h-9 rounded-lg flex items-center justify-center', view === 'parties' ? 'bg-deepSea text-white' : 'text-textGray hover:bg-bgGray')}>
          <Building2 className="h-5 w-5" aria-hidden />
        </button>
      </div>
      {view === 'bindings' ? (
        <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
          <BindingsView onOpenInGraph={openInGraph} />
        </div>
      ) : view === 'flows' ? (
        <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
          <FlowsView onOpenParties={openParties} />
        </div>
      ) : view === 'parties' ? (
        <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
          <SelfPartyPanel />
        </div>
      ) : view === 'graph' ? (
        <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
          <GraphView focus={graphFocus} />
        </div>
      ) : view === 'eval' ? (
        <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
          <EvalWorkbenchView />
        </div>
      ) : (
        <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
        <RealChatView
          sessionId={activeSessionId}
          onSignOut={refetchSession}
          contextFiles={contextFiles}
          setContextFiles={setContextFiles}
          onSessionChanged={() => { void refreshSessions(); }}
          onSessionCreated={(id) => { setActiveSessionId(id); void refreshSessions(); }}
          onFilesChanged={() => { void filesApi.refresh(); }}
          docParseStates={docParseStates}
        />
        <button
          type="button"
          onClick={() => setFilePanelVisible(!filePanelVisible)}
          style={{
            position: 'absolute',
            top: 12,
            right: 56,
            zIndex: 20,
            padding: '4px 10px',
            fontSize: 13,
            color: filePanelVisible ? '#2563eb' : '#555',
            background: filePanelVisible ? '#f0f4ff' : 'white',
            border: '1px solid #e0e0e0',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          文件
        </button>
      </div>
      )}
      <FilePanel
        visible={filePanelVisible}
        onClose={() => setFilePanelVisible(false)}
        onAddToConversation={addToConversation}
        contextFileKeys={contextFileKeys}
        filesApi={filesApi}
      />
    </div>
  );
}

export default App;
