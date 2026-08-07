import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/use-auth.js';

export function LoginPage() {
  const navigate = useNavigate();
  const { login, isLoggingIn, loginError } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!email || !password) return;
    try {
      await login(email, password);
      navigate('/', { replace: true });
    } catch {
      // O erro já está exposto por `loginError`; o catch existe só para não
      // deixar uma promise rejeitada sem tratamento.
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4 rounded-lg border p-6"
        style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}>
        <h1 className="text-xl font-semibold">Center Analytics</h1>

        <div className="space-y-1">
          <label htmlFor="email" className="block text-sm" style={{ color: 'var(--text-secondary)' }}>E-mail</label>
          <input id="email" type="email" value={email} autoComplete="username"
            onChange={(event) => setEmail(event.target.value)}
            className="w-full rounded-md border px-3 py-2"
            style={{ borderColor: 'var(--hairline)', backgroundColor: 'var(--page-plane)' }} />
        </div>

        <div className="space-y-1">
          <label htmlFor="password" className="block text-sm" style={{ color: 'var(--text-secondary)' }}>Senha</label>
          <input id="password" type="password" value={password} autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-md border px-3 py-2"
            style={{ borderColor: 'var(--hairline)', backgroundColor: 'var(--page-plane)' }} />
        </div>

        {loginError ? (
          <p role="alert" className="text-sm" style={{ color: 'var(--critical)' }}>{loginError.message}</p>
        ) : null}

        <button type="submit" disabled={isLoggingIn}
          className="w-full rounded-md bg-viz-1 px-3 py-2 text-white disabled:opacity-60">
          {isLoggingIn ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
