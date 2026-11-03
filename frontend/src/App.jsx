import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { ArrowUpRight, BookOpen, ChevronRight, Compass, LogOut, ShieldCheck } from 'lucide-react';
import Ask from './components/Ask';
import Library from './components/Library';
import SignIn from './components/SignIn';
import Sphere from './components/Sphere';
import api, { getKey, clearKey, setUnauthorizedHandler } from './services/api';

// While any document is pending, the library is re-read this often, so
// statuses change on screen as the worker finishes them.
const POLL_MS = 1500;

// Views live in the URL hash: the API serves the UI as static files, so a path
// wouldn't survive a reload. Other hashes (the skip link's) leave the view alone.
const VIEWS = { '': 'ask', '#/ask': 'ask', '#/library': 'library' };
const TITLES = { ask: 'Ask Atlas', library: 'Library | Atlas' };

function App() {
  const [signedIn, setSignedIn] = useState(Boolean(getKey()));
  const [view, setView] = useState(VIEWS[window.location.hash] ?? 'ask');
  const scrollTops = useRef({});
  const [documents, setDocuments] = useState([]);
  const [apiUp, setApiUp] = useState(true);
  const [loading, setLoading] = useState(true);
  // Until a read succeeds the list is unknown, not empty: an outage on load
  // mustn't tell someone their library has nothing in it.
  const [loaded, setLoaded] = useState(false);

  const signOut = useCallback(() => {
    clearKey();
    setSignedIn(false);
    setDocuments([]);
    setLoading(true);
    setLoaded(false);
  }, []);

  useEffect(() => setUnauthorizedHandler(signOut), [signOut]);

  // Each view keeps its own scroll position, on Back as well as from the nav.
  useEffect(() => {
    window.history.scrollRestoration = 'manual';
    const onHashChange = () => {
      const next = VIEWS[window.location.hash];
      if (!next || next === view) return;
      scrollTops.current[view] = window.scrollY;
      setView(next);
      document.getElementById('main-content')?.focus({ preventScroll: true });
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [view]);

  useLayoutEffect(() => {
    window.scrollTo(0, scrollTops.current[view] ?? 0);
  }, [view]);

  useEffect(() => {
    document.title = signedIn ? TITLES[view] : 'Atlas';
  }, [signedIn, view]);

  const loadDocuments = useCallback(async () => {
    try {
      setDocuments(await api('/documents'));
      setApiUp(true);
      setLoaded(true);
    } catch (error) {
      if (error.status !== 401) setApiUp(false);
    } finally {
      setLoading(false);
    }
  }, []);

  // Re-read on opening the library too: documents uploaded elsewhere (the API,
  // an MCP client, another tab) show up without a reload.
  useEffect(() => {
    if (signedIn) loadDocuments();
  }, [signedIn, view, loadDocuments]);

  const pending = documents.filter((d) => d.status === 'pending').length;
  const ready = documents.filter((d) => d.status === 'ready').length;

  useEffect(() => {
    if (!signedIn || !pending) return;
    const timer = setInterval(loadDocuments, POLL_MS);
    return () => clearInterval(timer);
  }, [signedIn, pending, loadDocuments]);

  if (!signedIn) return <SignIn onSignIn={() => setSignedIn(true)} />;

  const tabs = [
    ['ask', 'Ask Atlas', Compass],
    ['library', 'Library', BookOpen],
  ];
  const openLibrary = () => {
    window.location.hash = '/library';
  };

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="brand">
          <Sphere strokeWidth={3} />
          <span>
            atlas<span className="brand-period">.</span>
          </span>
        </div>
        <p className="brand-caption">A WORLD WITHIN YOUR REACH</p>
        <div className="workspace-label">
          <span className="workspace-avatar">A</span>
          <div>
            Your workspace<small>Personal knowledge space</small>
          </div>
        </div>
        <p className="nav-label">EXPLORE</p>
        <nav className="tabs" aria-label="Sections">
          {tabs.map(([id, label, Icon]) => (
            <a key={id} className="tab" href={`#/${id}`} aria-current={view === id ? 'page' : undefined}>
              <Icon size={18} />
              <span>{label}</span>
              {id === 'library' ? (
                loaded && <span className="nav-count">{documents.length}</span>
              ) : (
                <ChevronRight size={15} className="nav-arrow" />
              )}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <Sphere />
            <p>
              Big questions.
              <br />
              <em>Grounded answers.</em>
            </p>
            <span>Build your library. Let curiosity lead.</span>
            <button onClick={openLibrary}>
              Explore your library <ArrowUpRight size={15} />
            </button>
          </div>
          <div className="workspace-privacy">
            <ShieldCheck size={16} />
            <span>Private to your workspace</span>
          </div>
          <button className="signout" onClick={signOut}>
            <LogOut size={16} />
            Sign out
          </button>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={14} />
            <span>{view === 'ask' ? 'Ask Atlas' : 'Library'}</span>
          </div>
          <div className="connection" role="status">
            <span className={`connection-dot ${!apiUp ? 'offline' : ''}`} />
            {loading
              ? 'Connecting…'
              : apiUp
                ? `${ready} document${ready !== 1 ? 's' : ''} ready${pending ? ` · ${pending} processing` : ''}`
                : 'Atlas isn’t reachable'}
          </div>
        </header>
        <main className="page" id="main-content" tabIndex={-1}>
          {!apiUp && (
            <div className="notice error connection-notice" role="alert">
              <span>We couldn’t refresh your library. Check your connection and try again.</span>
              <button className="text-button" onClick={loadDocuments}>
                Retry
              </button>
            </div>
          )}
          <div hidden={view !== 'ask'}>
            <Ask readyCount={ready} loading={loading} loaded={loaded} onOpenLibrary={openLibrary} />
          </div>
          <div hidden={view !== 'library'}>
            <Library documents={documents} onChange={loadDocuments} loading={loading} loaded={loaded} />
          </div>
        </main>
        <footer className="workspace-footer">
          <span>BUILT FOR THE CURIOUS.</span>
          <span>
            Grounded in your documents <span className="footer-star">✦</span>
          </span>
        </footer>
      </div>
    </div>
  );
}

export default App;
