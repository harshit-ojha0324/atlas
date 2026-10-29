import { useState } from 'react';
import { Loader } from 'lucide-react';
import Sphere from './Sphere';
import api, { setKey, clearKey } from '../services/api';

// The tenant's API key is the sign-in: it's checked against the API, then kept
// in sessionStorage for this tab only.
function SignIn({ onSignIn }) {
  const [key, setKeyInput] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!key.trim() || checking) return;
    setChecking(true);
    setError(null);
    setKey(key.trim());
    try {
      await api('/documents');
      onSignIn();
    } catch (err) {
      clearKey();
      setError(err.status === 401 ? 'That API key isn’t valid. Check it and try again.' : err.detail || 'Atlas isn’t reachable. Check that the stack is running.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <main className="signin">
      <div className="signin-inner">
        <Sphere className="signin-sphere" />
        <h1>Atlas</h1>
        <p className="signin-tagline">Answers from the documents you carry.</p>

        <form onSubmit={handleSubmit}>
          {error && <p className="notice error" role="alert">{error}</p>}
          <label htmlFor="api-key">API key</label>
          <input
            id="api-key"
            className="field"
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="atlas_…"
          />
          <p className="hint">Your workspace’s key from <code>make tenant</code>. It stays in this browser tab only.</p>
          <button className="btn" type="submit" disabled={!key.trim() || checking}>
            {checking && <Loader size={16} className="spin" />}
            {checking ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}

export default SignIn;
