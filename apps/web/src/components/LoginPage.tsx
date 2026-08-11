import { useState } from 'react';
import { authClient } from '../lib/auth';

interface LoginPageProps {
  onAuthed: () => void;
}

type Mode = 'signin' | 'signup';

export const LoginPage: React.FC<LoginPageProps> = ({ onAuthed }) => {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === 'signup' && password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }
    setLoading(true);
    try {
      if (mode === 'signup') {
        const { error: signUpError } = await authClient.signUp.email({
          email,
          password,
          name: name || email,
        });
        if (signUpError) throw new Error(signUpError.message ?? 'Sign up failed');
      } else {
        const { error: signInError } = await authClient.signIn.email({
          email,
          password,
        });
        if (signInError) throw new Error(signInError.message ?? 'Sign in failed');
      }
      onAuthed();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bgGray px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm bg-white rounded-2xl border border-borderGray p-6 space-y-4"
      >
        <div className="text-center">
          <h1 className="text-lg font-semibold text-textDark">
            {mode === 'signin' ? '登录' : '注册'}
          </h1>
          <p className="text-xs text-textGray mt-1">供应链贸易执行助理</p>
        </div>

        {mode === 'signup' && (
          <input
            type="text"
            placeholder="姓名"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-borderGray text-sm focus:outline-none"
          />
        )}

        <input
          type="email"
          required
          placeholder="邮箱"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-borderGray text-sm focus:outline-none"
        />

        <input
          type="password"
          required
          placeholder="密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-borderGray text-sm focus:outline-none"
        />

        {mode === 'signup' && (
          <input
            type="password"
            required
            placeholder="确认密码"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-borderGray text-sm focus:outline-none"
          />
        )}

        {error && (
          <div className="text-xs text-danger bg-danger/10 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2 rounded-lg bg-deepSea text-white text-sm font-medium disabled:opacity-50"
        >
          {loading ? '...' : mode === 'signin' ? '登录' : '注册'}
        </button>

        <button
          type="button"
          onClick={() => {
            setMode(mode === 'signin' ? 'signup' : 'signin');
            setError(null);
          }}
          className="w-full text-xs text-textGray hover:text-textDark"
        >
          {mode === 'signin' ? '没有账号？去注册' : '已有账号？去登录'}
        </button>
      </form>
    </div>
  );
};
