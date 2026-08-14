import { useEffect, useState, useCallback, useMemo } from 'react';
import { authClient } from './lib/auth';
import { LoginPage } from './components/LoginPage';
import { RealChatView } from './components/RealChatView';
import { SessionSidebar } from './components/SessionSidebar';
import { FilePanel } from './components/FilePanel';
import { type FileEntry, type ContextFile } from './hooks/useFiles';
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
    if (!file.docId) {
      // The file exists in MinIO but has no document record (docId), so it
      // can't be recalled in chat. Surface the reason instead of failing
      // silently -- this happens when an upload's ingest step failed but the
      // object was already stored (upload route doesn't roll back MinIO).
      window.alert('该文件尚未完成解析（缺少文档 ID），暂时无法添加到对话。请稍后重试或重新上传该文件。');
      return;
    }
    const docId = file.docId;
    setContextFiles((prev) =>
      prev.some((f) => f.key === file.key)
        ? prev
        : [...prev, { docId, filename: file.name, key: file.key }],
    );
  }, []);

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
          onSessionCreated={(id) => { setActiveSessionId(id); void refreshSessions(); }}
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
      />
    </div>
  );
}

export default App;
