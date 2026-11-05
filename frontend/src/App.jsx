import { lazy, Suspense, useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { motion } from 'motion/react';
import { Activity, BookOpen, Compass, LogOut, Network } from 'lucide-react';
import Ask from './components/Ask';
import Gateway from './components/Gateway';
import Library from './components/Library';
import SignIn from './components/SignIn';
import Sphere from './components/Sphere';
import System from './components/System';
import api, { getKey, clearKey, setUnauthorizedHandler } from './services/api';
import { savedTheme, saveTheme, ThemeContext } from './theme';
import proCss from './pro.css?inline';

// Only one stylesheet is ever on the page, so neither theme has to undo the other.
const TitanWorld = lazy(() => import('./components/TitanWorld'));

// While any document is pending, the library is re-read this often, so
// statuses change on screen as the worker finishes them.
const POLL_MS = 1500;

// Views live in the URL hash: the API serves the UI as static files, so a path
// wouldn't survive a reload. Other hashes (the skip link's) leave the view alone.
const VIEWS = { '': 'ask', '#/ask': 'ask', '#/library': 'library', '#/gateway': 'gateway', '#/system': 'system' };
const TITLES = { ask: 'Ask Atlas', library: 'Library | Atlas', gateway: 'Gateway | Atlas', system: 'System | Atlas' };
const TITAN_VIEWS = ['ask', 'library']; // the titan keeps its two original tabs

const TABS = [
  ['ask', 'Ask Atlas', Compass],
  ['library', 'Library', BookOpen],
  ['gateway', 'Gateway', Network],
  ['system', 'System', Activity],
];

function App() {
  const [theme, setTheme] = useState(savedTheme);
  const titan = theme === 'titan';
  const [signedIn, setSignedIn] = useState(Boolean(getKey()));
  const [route, setView] = useState(VIEWS[window.location.hash] ?? 'ask');
  const view = titan && !TITAN_VIEWS.includes(route) ? 'ask' : route;
  const [navigated, setNavigated] = useState(false); // past the opening reveal
  const scrollTops = useRef({});
  const [documents, setDocuments] = useState([]);
  const [apiUp, setApiUp] = useState(true);
  const [loading, setLoading] = useState(true);
  // Until a read succeeds the list is unknown, not empty: an outage on load
  // mustn't tell someone their library has nothing in it.
  const [loaded, setLoaded] = useState(false);
  const [asking, setAsking] = useState({ busy: false, hasThread: false });

  const signOut = useCallback(() => {
    clearKey();
    setSignedIn(false);
    setDocuments([]);
    setLoading(true);
    setLoaded(false);
    setNavigated(false);
    setAsking({ busy: false, hasThread: false });
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
      setNavigated(true);
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

  const openLibrary = () => {
    window.location.hash = '/library';
  };

  const flipTheme = () => {
    const next = titan ? 'pro' : 'titan';
    saveTheme(next);
    setTheme(next);
  };

  // The scene reads the app: what's open, whether Atlas is reading, how much it carries.
  const mode = !signedIn ? 'signin' : view === 'library' ? 'library' : asking.hasThread ? 'thread' : 'ask';
  const skin = titan ? (
    <TitanWorld
      mode={mode}
      charge={signedIn ? Math.min(1, 0.2 + ready * 0.14) : 0.72}
      reading={asking.busy}
      documents={documents}
    />
  ) : (
    <style>{proCss}</style>
  );

  const app = !signedIn ? (
    <SignIn onSignIn={() => setSignedIn(true)} onSecret={flipTheme} />
  ) : (
      <div className={navigated ? 'shell navigated' : 'shell'}>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <header className="skybar">
          <div className="brand">
            <Sphere strokeWidth={3} />
            <span>Atlas</span>
            {!titan && <small>Multi-tenant RAG</small>}
          </div>
          <nav className="tabs" aria-label="Sections">
            {TABS.filter(([id]) => !titan || TITAN_VIEWS.includes(id)).map(([id, label, Icon]) => (
              <a key={id} className="tab" href={`#/${id}`} aria-current={view === id ? 'page' : undefined}>
                <Icon size={17} />
                <span>{label}</span>
                {id === 'library' && loaded && <span className="nav-count">{documents.length}</span>}
                {view === id && (
                  <motion.span
                    layoutId="nav-seam"
                    className="tab-seam"
                    transition={{ type: 'spring', stiffness: 420, damping: 36 }}
                  />
                )}
              </a>
            ))}
          </nav>
          <div className="connection" role="status">
            <i className={`connection-dot${!apiUp ? ' offline' : pending ? ' working' : ''}`} />
            <span>
              {loading
                ? 'Connecting…'
                : apiUp
                  ? `${ready} document${ready !== 1 ? 's' : ''} ready${pending ? ` · ${pending} processing` : ''}`
                  : 'Atlas isn’t reachable'}
            </span>
          </div>
          <button className="signout" onClick={signOut} aria-label="Sign out">
            <LogOut size={16} />
            <span>Sign out</span>
          </button>
        </header>
        <main className="page" id="main-content" tabIndex={-1}>
          {!apiUp && (
            <div className="notice error connection-notice" role="alert">
              <span>Your library couldn’t be refreshed. Check your connection and try again.</span>
              <button className="text-button" onClick={loadDocuments}>
                Retry
              </button>
            </div>
          )}
          <div className="view" hidden={view !== 'ask'}>
            <Ask
              documents={documents}
              readyCount={ready}
              loading={loading}
              loaded={loaded}
              onOpenLibrary={openLibrary}
              onStateChange={setAsking}
            />
          </div>
          <div className="view" hidden={view !== 'library'}>
            <Library documents={documents} onChange={loadDocuments} loading={loading} loaded={loaded} />
          </div>
          {!titan && (
            <>
              <div className="view" hidden={view !== 'gateway'}>
                <Gateway active={view === 'gateway'} />
              </div>
              <div className="view" hidden={view !== 'system'}>
                <System active={view === 'system'} />
              </div>
            </>
          )}
        </main>
      </div>
  );

  return (
    <ThemeContext.Provider value={theme}>
      <Suspense fallback={null}>
        {skin}
        {app}
      </Suspense>
    </ThemeContext.Provider>
  );
}

export default App;
