import { useState } from 'react';
import { ArrowRight, BookOpen, KeyRound, Loader, ShieldCheck } from 'lucide-react';
import Sphere from './Sphere';
import Observatory from './Observatory';
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
          <Sphere strokeWidth={2} />
          <span>
            atlas<span className="brand-period">.</span>
          </span>
        </div>
        <div className="signin-story-content">
          <p className="eyebrow">
            <span /> KNOWLEDGE HAS NO HORIZON
          </p>
          <h1>
            Carry the knowledge.
            <br />
            <em>Discover the world.</em>
          </h1>
          <p className="signin-description">
            Your documents hold a universe of answers.
            <br />
            Atlas helps you find your way.
          </p>
          <Observatory />
        </div>
        <div className="signin-story-footer">
          <span>INSPIRED BY CURIOSITY.</span>
          <span>GROUNDED IN YOUR SOURCES.</span>
        </div>
      </section>
      <div className="signin-inner">
        <div className="signin-form-content">
          <div className="signin-icon">
            <KeyRound size={23} />
          </div>
          <p className="eyebrow">YOUR NEXT DISCOVERY STARTS HERE</p>
          <h2>Welcome to Atlas.</h2>
          <p className="signin-tagline">
            A little less searching. <br />A lot more understanding.
          </p>
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
            <div>
              <strong>Your documents. Your discoveries.</strong>
              <p>Upload a PDF, ask a question, and follow every answer back to its source.</p>
            </div>
          </div>
        </div>
        <p className="signin-bottom">A private space for a curious mind.</p>
      </div>
    </main>
  );
}

export default SignIn;
