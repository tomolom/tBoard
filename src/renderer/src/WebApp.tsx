import { useCallback, useEffect, useState, type JSX } from 'react';

import App from './App';
import { createRemoteApi, type RemoteClient } from './remoteApi';

type Phase = 'checking' | 'login' | 'ready';

/**
 * Web-mode bootstrap. Runs when the renderer is served in a browser (no Electron
 * preload). Checks the server session; shows a login gate until authenticated;
 * then injects the HTTP client as `window.tBoard` and renders the normal App
 * unchanged. A mid-session 401 (expiry/logout) drops back to the login gate.
 */
export function WebApp(): JSX.Element {
  const [phase, setPhase] = useState<Phase>('checking');
  const [client, setClient] = useState<RemoteClient | null>(null);

  const toLogin = useCallback(() => {
    setPhase('login');
    // Drop the injected API so App can't keep calling a dead session.
    delete (window as { tBoard?: unknown }).tBoard;
  }, []);

  // Build the client once, wired to bounce to login on unauthorized.
  useEffect(() => {
    const remote = createRemoteApi('', toLogin);
    setClient(remote);
    remote.auth
      .checkSession()
      .then((authed) => {
        if (authed) {
          (window as unknown as { tBoard: RemoteClient }).tBoard = remote;
          setPhase('ready');
        } else {
          setPhase('login');
        }
      })
      .catch(() => setPhase('login'));
  }, [toLogin]);

  const handleLoggedIn = useCallback(() => {
    if (client) {
      (window as unknown as { tBoard: RemoteClient }).tBoard = client;
      setPhase('ready');
    }
  }, [client]);

  if (phase === 'checking' || !client) {
    return <p className="empty">Connecting&hellip;</p>;
  }
  if (phase === 'login') {
    return <LoginGate client={client} onLoggedIn={handleLoggedIn} />;
  }
  return <App />;
}

function LoginGate({ client, onLoggedIn }: { client: RemoteClient; onLoggedIn: () => void }): JSX.Element {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy || password.length === 0) {
      return;
    }
    setBusy(true);
    setError(null);
    const result = await client.auth.login(password);
    setBusy(false);
    if (result.ok) {
      setPassword('');
      onLoggedIn();
    } else {
      setError(result.error ?? 'Login failed');
      setPassword('');
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <h1>tBoard</h1>
        <p className="login-sub">Enter the board password to continue.</p>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Password"
          aria-label="Password"
          autoFocus
          disabled={busy}
        />
        <button type="submit" className="primary" disabled={busy || password.length === 0}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error ? <p className="error login-error">{error}</p> : null}
      </form>
    </div>
  );
}
