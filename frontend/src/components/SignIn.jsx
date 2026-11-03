import { useState } from 'react';
import { ArrowRight, BookOpen, Loader, ShieldCheck } from 'lucide-react';
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
      setError(
        err.status === 401
          ? 'That API key isn’t valid. Check it and try again.'
          : err.detail || 'Atlas isn’t reachable. Check that the stack is running.',
      );
    } finally {
      setChecking(false);
    }
  };

  return (
    <main className="signin">
      <section className="signin-story" aria-label="About Atlas">
        <div className="brand">
          <Sphere strokeWidth={3} />
          <span>Atlas</span>
        </div>
        <div className="signin-story-content">
          <h1>
            He holds up the sky.
            <br />
            <em>You ask the questions.</em>
          </h1>
        </div>
      </section>
      <div className="signin-inner">
        <div className="signin-form-content panel">
          <h2>Welcome to Atlas.</h2>
          <form onSubmit={handleSubmit}>
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
            <label htmlFor="api-key">Workspace API key</label>
            <input
              id="api-key"
              className="field"
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-describedby="key-hint"
              aria-invalid={Boolean(error)}
              value={key}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="atlas_…"
            />
            <p className="hint" id="key-hint">
              Use your workspace’s key from <code>make tenant</code>.
            </p>
            <button className="btn" type="submit" disabled={!key.trim() || checking}>
              {checking && <Loader size={16} className="spin" />}
              {checking ? 'Signing in…' : 'Enter your workspace'}
              {!checking && <ArrowRight size={17} />}
            </button>
          </form>
          <p className="signin-security">
            <ShieldCheck size={15} />
            Your key stays in this browser tab only.
          </p>
          <div className="signin-how">
            <BookOpen size={20} />
            <p>Upload a PDF, ask a question, and follow every answer back to its source.</p>
          </div>
        </div>
      </div>
    </main>
  );
}

export default SignIn;
