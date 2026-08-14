import { useEffect, useState, useCallback, useMemo } from 'react';
import { authClient } from './lib/auth';
import { LoginPage } from './components/LoginPage';
import { RealChatView } from './components/RealChatView';
import { SessionSidebar } from './components/SessionSidebar';
import { FilePanel } from './components/FilePanel';
import { type FileEntry, type ContextFile, useFiles } from './hooks/useFiles';
import { processDocument, type DocParseState } from './api/process';
import { useSessions } from './hooks/useSessions';

function App() {
  const [session, setSession] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [filePanelVisible, setFilePanelVisible] = useState(false);
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
      <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
        <RealChatView
          sessionId={activeSessionId}
          onSignOut={refetchSession}
          contextFiles={contextFiles}
          setContextFiles={setContextFiles}
          onSessionChanged={() => { void refreshSessions(); }}
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
