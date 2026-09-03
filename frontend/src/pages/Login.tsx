import { FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { apiErrorMessage } from '../api/client';
import { useFetch } from '../hooks/useFetch';

/**
 * Internal employee login screen.
 * States: idle, loading, error, success.
 */
export default function Login() {
  const { loginFn } = useAuth();
  const navigate = useNavigate();
  // The build manifest is served statically by express (robust across hosts);
  // it exposes which commit + SPA asset this deployment is running.
  const { data: buildInfo } = useFetch<any>('/build-info.json');

  const [identifier, setIdentifier] = useState('');
  const [secret, setSecret] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await loginFn(identifier.trim(), secret);
      navigate('/', { replace: true });
      setLoading(false);
    } catch (err: unknown) {
      setError(apiErrorMessage(err) || 'Login failed.');
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="login-logo">
          <div className="b1">AYROVI</div>
          <div className="b2">Warehouse</div>
        </div>
        <div className="login-sub">Sign in to Warehouse Core</div>

        {error && <div className="error-box">{error}</div>}

        <div className="field">
          <label htmlFor="identifier">Employee Code / User</label>
          <input
            id="identifier"
            type="text"
            autoComplete="username"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="e.g. ADMIN001"
            disabled={loading}
            autoFocus
          />
        </div>

        <div className="field">
          <label htmlFor="secret">Password or PIN</label>
          <input
            id="secret"
            type="password"
            autoComplete="current-password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="••••••••"
            disabled={loading}
          />
        </div>

        <button className="btn" type="submit" disabled={loading || !identifier || !secret}>
          {loading ? <span className="spinner" /> : null}
          {loading ? 'Signing in…' : 'Sign in'}
        </button>

        {buildInfo?.commitShort && buildInfo.commitShort !== 'dev' && (
          <div className="login-build mono">
            BUILD {buildInfo.commitShort}
            {buildInfo.spaAsset ? ` · ${String(buildInfo.spaAsset).replace('index-', '').replace('.js', '')}` : ''}
          </div>
        )}
      </form>
    </div>
  );
}
