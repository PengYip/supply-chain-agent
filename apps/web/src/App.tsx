import { useEffect, useState, useCallback } from 'react';
import { authClient } from './lib/auth';
import { LoginPage } from './components/LoginPage';
import { RealChatView } from './components/RealChatView';

function App() {
  const [session, setSession] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const refetchSession = useCallback(async () => {
    const { data } = await authClient.getSession();
    setSession(data ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    refetchSession();
  }, [refetchSession]);

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

  return <RealChatView onSignOut={refetchSession} />;
}

export default App;
