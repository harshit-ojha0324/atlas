import { useEffect, useState } from 'react';
import { ArrowRight, BookOpen, Loader, ShieldCheck } from 'lucide-react';
import Sphere from './Sphere';
import api, { setKey, clearKey } from '../services/api';
import { useCopy, useTheme } from '../theme';

const KNOCKS = 7; // clicks on the name that swap the theme
const KNOCK_WINDOW_MS = 2000; // a pause this long starts the count again

const POINTS = [
  ['Cited answers', 'Each answer links to the passages it used, down to the page.'],
  ['Private by workspace', 'Queries, rate limits, quotas and cached answers are scoped to your tenant.'],
  ['Open to your tools', 'The same documents are available over REST and MCP.'],
];

// The tenant's API key is the sign-in: it's checked against the API, then kept
// in sessionStorage for this tab only.
function SignIn({ onSignIn, onSecret }) {
  const [key, setKeyInput] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);
  const [knocks, setKnocks] = useState(0);
  const copy = useCopy();
  const pro = useTheme() === 'pro';

  useEffect(() => {
    if (!knocks) return;
    const timer = setTimeout(() => setKnocks(0), KNOCK_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [knocks]);

  const knock = () => {
    if (knocks + 1 < KNOCKS) return setKnocks(knocks + 1);
    setKnocks(0);
    onSecret();
  };

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
        {/* A plain span on purpose: the egg is a secret, so it isn't a stop in the tab order. */}
        <div className="brand" style={{ '--knocks': knocks }}>
          <Sphere strokeWidth={3} />
          <span className="brand-name" style={{ userSelect: 'none' }} onClick={knock}>
            Atlas
          </span>
        </div>
        {pro && <Sphere className="signin-orbit" strokeWidth={0.35} />}
        <div className="signin-story-content">
          <h1>
            {copy.signinTitle[0]}
            <br />
            <em>{copy.signinTitle[1]}</em>
          </h1>
          {pro && (
            <ul className="signin-points">
              {POINTS.map(([title, text]) => (
                <li key={title}>
                  <strong>{title}</strong>
                  <span>{text}</span>
                </li>
              ))}
            </ul>
          )}
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
