import { useState, useEffect, useCallback } from 'react';
import Ask from './components/Ask';
import Library from './components/Library';
import SignIn from './components/SignIn';
import Sphere from './components/Sphere';
import api, { getKey, clearKey, setUnauthorizedHandler } from './services/api';

// While any document is pending, the library is re-read this often, so
// statuses change on screen as the worker finishes them.
const POLL_MS = 1500;

function App() {
  const [signedIn, setSignedIn] = useState(Boolean(getKey()));
  const [view, setView] = useState('ask');
  const [documents, setDocuments] = useState([]);
  const [apiUp, setApiUp] = useState(true);

  const signOut = useCallback(() => {
    clearKey();
    setSignedIn(false);
    setDocuments([]);
  }, []);

  useEffect(() => setUnauthorizedHandler(signOut), [signOut]);

  const loadDocuments = useCallback(async () => {
    try {
      setDocuments(await api('/documents'));
      setApiUp(true);
    } catch (error) {
      if (error.status !== 401) setApiUp(false);
    }
  }, []);

  // Re-read on opening the library too: documents uploaded elsewhere (the API,
  // an MCP client, another tab) show up without a reload.
  useEffect(() => { if (signedIn) loadDocuments(); }, [signedIn, view, loadDocuments]);

  const pending = documents.filter((d) => d.status === 'pending').length;
  const ready = documents.filter((d) => d.status === 'ready').length;

  useEffect(() => {
    if (!signedIn || !pending) return;
    const timer = setInterval(loadDocuments, POLL_MS);
    return () => clearInterval(timer);
  }, [signedIn, pending, loadDocuments]);

  if (!signedIn) return <SignIn onSignIn={() => setSignedIn(true)} />;

  const tabs = [['ask', 'Ask'], ['library', 'Library']];

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <Sphere strokeWidth={3} />
          <span>Atlas</span>
        </div>
        <nav className="tabs" aria-label="Sections">
          {tabs.map(([id, label]) => (
            <button key={id} className="tab" aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="topbar-end">
          {apiUp ? (
            <span>
              {ready} ready{pending > 0 && `, ${pending} processing`}
            </span>
          ) : (
            <span className="offline" role="status">Atlas isn’t reachable</span>
          )}
          <button className="signout" onClick={signOut}>Sign out</button>
        </div>
      </header>

      <main className="page">
        {view === 'ask' ? <Ask readyCount={ready} /> : <Library documents={documents} onChange={loadDocuments} />}
      </main>
    </div>
  );
}

export default App;
