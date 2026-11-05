import { Fragment, useState, useRef, useEffect } from 'react';
import { motion } from 'motion/react';
import {
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Compass,
  FileText,
  Layers,
  Loader,
  Plus,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import Sphere from './Sphere';
import Stats from './Stats';
import api, { BACKENDS } from '../services/api';
import { useCopy, useTheme } from '../theme';

// The API accepts up to 20 history messages (10 question-answer turns) of up to
// 4,000 characters each.
const MAX_TURNS = 10;
const MAX_CHARS = 4000;
// the API cuts source excerpts at this length
const EXCERPT_CHARS = 200;

// Models answer in Markdown by habit. Render the little they use (paragraphs,
// headings, bulleted and numbered lists, **bold**, *italic*) as React elements,
// never as HTML, so an answer can't inject markup. Code ticks are dropped:
// answers are prose. Citations like [1] or [1, 2] go to `cite`.
const CITATION = /\[\d{1,2}(?:,\s*\d{1,2})*\]/;
const INLINE = new RegExp(`(\\*\\*[^*]+\\*\\*|\\*[^*\\n]+\\*|${CITATION.source})`);

// The sources a citation names, or null if any number matches no source: then
// it isn't one of ours (a reference copied from a document, say) and stays text.
const citedBy = (marker, sources) => {
  const numbers = marker.match(/\d+/g).map(Number);
  return numbers.every((n) => sources?.[n - 1]) ? numbers : null;
};

function inline(text, cite) {
  return text
    .replace(/`/g, '')
    .split(INLINE)
    .map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
        return <strong key={i}>{inline(part.slice(2, -2), cite)}</strong>;
      if (part.startsWith('*') && part.endsWith('*') && part.length > 2)
        return <em key={i}>{inline(part.slice(1, -1), cite)}</em>;
      if (CITATION.test(part)) return <Fragment key={i}>{cite(part)}</Fragment>;
      return part;
    });
}

// what an answer does as it lands: rises once, and isn't replayed on returning to the view
const RISE = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.42, ease: [0.22, 1, 0.36, 1] },
};

const scrollBehavior = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';

// Where pro.css puts the sources beside the answer, so the evidence starts open.
const SIDE_BY_SIDE = '(min-width: 1100px)';

function Prose({ text, cite }) {
  const blocks = [];
  for (const line of text.split('\n')) {
    const heading = line.match(/^\s*#{1,6}\s+(.*)/);
    const bullet = line.match(/^\s*[*-]\s+(.*)/);
    const number = line.match(/^\s*(\d+)[.)]\s+(.*)/);
    const last = blocks[blocks.length - 1];
    if (heading) {
      blocks.push({ type: 'h', lines: [heading[1]] });
    } else if (bullet) {
      if (last?.type === 'ul') last.lines.push(bullet[1]);
      else blocks.push({ type: 'ul', lines: [bullet[1]] });
    } else if (number) {
      // `start` keeps the count when a blank line splits one list in two
      if (last?.type === 'ol') last.lines.push(number[2]);
      else blocks.push({ type: 'ol', start: Number(number[1]), lines: [number[2]] });
    } else if (line.trim()) {
      if (last?.type === 'p') last.lines.push(line.trim());
      else blocks.push({ type: 'p', lines: [line.trim()] });
    } else {
      blocks.push({ type: 'break' });
    }
  }
  return blocks.map((b, i) => {
    const items = b.lines?.map((l, j) => <li key={j}>{inline(l, cite)}</li>);
    if (b.type === 'h') return <h4 key={i}>{inline(b.lines[0], cite)}</h4>;
    if (b.type === 'ul') return <ul key={i}>{items}</ul>;
    if (b.type === 'ol') return <ol key={i} start={b.start}>{items}</ol>;
    return b.type === 'p' ? <p key={i}>{inline(b.lines.join(' '), cite)}</p> : null;
  });
}

// The API names what it redacted or masked by detector label; say it in words.
const LABELS = {
  EMAIL_ADDRESS: 'email address',
  PHONE_NUMBER: 'phone number',
  US_SSN: 'Social Security number',
  CREDIT_CARD: 'card number',
  API_KEY: 'API key',
  PASSWORD: 'password',
  TOKEN: 'token',
  AWS_KEY: 'AWS key',
  PRIVATE_KEY: 'private key',
};
const LABEL_RE = new RegExp(`\\b(${Object.keys(LABELS).join('|')})\\b`, 'g');
const humanize = (warning) =>
  warning.replace(/^PII redacted/, 'Personal details removed').replace(LABEL_RE, (label) => LABELS[label]);

const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// Suggestion cards start a question and leave the topic to the reader. Retrieval
// matches a question against passage content, so questions about the documents
// as a whole ("what are the key takeaways?") score under the relevance floor
// and are always declined; a named topic scores well above it.
const STARTERS = [
  [FileText, 'Find the essentials', 'Name a topic to get its key facts.', 'What does my library say about '],
  [Layers, 'Connect the dots', 'See how your documents describe one topic.', 'How do my documents describe '],
  [Compass, 'Go a little deeper', 'Get the conditions and fine print.', 'What are the rules and exceptions for '],
];

function Turn({ turn }) {
  const pro = useTheme() === 'pro';
  const copy = useCopy();
  const [followed, setFollowed] = useState(null); // the citation last followed: { n, from }
  const [hinted, setHinted] = useState(null); // the citation under the pointer or focus
  const [evidenceOpen] = useState(() => pro && window.matchMedia(SIDE_BY_SIDE).matches);
  const sourcesRef = useRef(null);
  // Beside the answer, 'nearest' moves the sources without pulling the answer away.
  const block = pro ? 'nearest' : 'center';

  const follow = (n, from) => {
    const source = sourcesRef.current.querySelectorAll('details')[n - 1];
    source.open = true;
    source.querySelector('summary').focus({ preventScroll: true });
    source.scrollIntoView({ behavior: scrollBehavior(), block });
    setFollowed({ n, from });
  };

  const goBack = () => {
    followed.from.focus({ preventScroll: true });
    followed.from.scrollIntoView({ behavior: scrollBehavior(), block });
    setFollowed(null);
  };

  // ponytail: a number copied from a document's own text links too if it's in
  // range; only structured citations from the API could tell them apart.
  const cite = (marker) => {
    const numbers = citedBy(marker, turn.sources);
    if (!numbers) return marker;
    return numbers.map((n) => {
      const { document, page } = turn.sources[n - 1];
      return (
        <button
          key={n}
          type="button"
          className={followed?.n === n ? 'cite active' : 'cite'}
          aria-label={`Source ${n}: ${document}, page ${page}`}
          title={`${document}, page ${page}`}
          onClick={(e) => follow(n, e.currentTarget)}
          onPointerEnter={() => setHinted(n)}
          onPointerLeave={() => setHinted(null)}
          onFocus={() => setHinted(n)}
          onBlur={() => setHinted(null)}
        >
          {n}
        </button>
      );
    });
  };

  const cited = new Set(
    (turn.answer?.match(new RegExp(CITATION.source, 'g')) ?? []).flatMap((m) => citedBy(m, turn.sources) ?? []),
  );
  // An answer with no citations at all says nothing about which sources it used.
  const uncited = (n) => cited.size > 0 && !cited.has(n);
  const someUncited = turn.sources?.some((_, i) => uncited(i + 1));

  return (
    <motion.article className="turn" {...RISE}>
      <div className="turn-question">
        <span className="question-label">You asked</span>
        <h3>{turn.question}</h3>
      </div>
      <div className="response-heading">
        <Sphere />
        <span>ATLAS</span>
        <span className="response-line" />
      </div>
      {turn.pending ? (
        <div className="answer-loading">
          <p className="thinking">
            <Sphere className="sphere-turning" strokeWidth={5} />
            {copy.thinking}
          </p>
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : (
        <>
          {turn.error ? (
            <p className="answer error" role="alert">
              {turn.answer}
            </p>
          ) : (
            <motion.div className="answer" {...RISE}>
              <Prose text={turn.answer} cite={cite} />
            </motion.div>
          )}

          {turn.warnings?.length > 0 && (
            <ul className="warnings" aria-label="Security notes">
              {turn.warnings.map((w) => (
                <li key={w}>{humanize(w)}</li>
              ))}
            </ul>
          )}

          {turn.sources?.length > 0 && (
            <div className="sources" ref={sourcesRef}>
              <p className="sources-heading">
                <BookOpen size={14} /> Sources{' '}
                <span>{someUncited ? `${cited.size} of ${turn.sources.length} cited` : turn.sources.length}</span>
              </p>
              <ol>
                {turn.sources.map((s, i) => (
                  <li key={i}>
                    <details
                      className={`source${followed?.n === i + 1 ? ' active' : ''}${hinted === i + 1 ? ' hinted' : ''}${uncited(i + 1) ? ' uncited' : ''}`}
                      open={evidenceOpen && !uncited(i + 1)}
                    >
                      <summary>
                        <b>{i + 1}</b>
                        <span>
                          {s.document}
                          <small>
                            Page {s.page}
                            {uncited(i + 1) && ', not cited'}
                          </small>
                        </span>
                        <Plus size={15} className="source-expand" />
                      </summary>
                      <p>
                        {s.excerpt}
                        {s.excerpt.length >= EXCERPT_CHARS && '…'}
                      </p>
                      {followed?.n === i + 1 && (
                        <button type="button" className="text-button source-back" onClick={goBack}>
                          <ArrowUp size={15} /> Back to the answer
                        </button>
                      )}
                    </details>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {turn.backend && (
            <p className="answered-by">
              {turn.backend === 'cache'
                ? 'Answered from cache'
                : `Answered by ${BACKENDS[turn.backend] ?? turn.backend}`}
            </p>
          )}
        </>
      )}
    </motion.article>
  );
}

function Ask({ documents, readyCount, loading, loaded, onOpenLibrary, onStateChange }) {
  const pro = useTheme() === 'pro';
  const copy = useCopy();
  const [turns, setTurns] = useState([]);
  const [input, setInput] = useState('');
  const threadRef = useRef(null);
  const inputRef = useRef(null);
  const busy = turns.some((t) => t.pending);
  const unfinished = STARTERS.some(([, , , starter]) => input === starter); // a card's starter, no topic yet

  useEffect(() => {
    onStateChange({ busy, hasThread: turns.length > 0 });
  }, [busy, turns.length, onStateChange]);

  // Bring the newest question to the top, so a long answer is read from its start.
  useEffect(() => {
    threadRef.current?.lastElementChild?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  }, [turns]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const question = input.trim();
    if (!question || busy || readyCount === 0) return;

    // earlier turns let a follow-up ("and for contractors?") be understood
    const history = turns
      .filter((t) => !t.error && !t.pending)
      .slice(-MAX_TURNS)
      .flatMap((t) => [
        { role: 'user', content: t.question.slice(0, MAX_CHARS) },
        { role: 'assistant', content: t.answer.slice(0, MAX_CHARS) },
      ]);

    setInput('');
    setTurns((prev) => [...prev, { question, pending: true }]);
    let done;
    try {
      const data = await api('/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, history }),
      });
      done = {
        question,
        answer: data.answer,
        sources: data.sources,
        warnings: data.security_warnings,
        backend: data.forge_backend,
      };
    } catch (error) {
      setInput((typed) => typed || question); // ready to ask again, unless they've moved on
      done = {
        question,
        answer: error.detail
          ? sentence(error.detail)
          : 'The question couldn’t be answered. Try again in a moment.',
        error: true,
      };
    }
    setTurns((prev) => [...prev.slice(0, -1), done]);
  };

  // Focus stays in the composer, so answers are read out from a region that is
  // always mounted. Errors announce themselves with role="alert".
  const last = turns[turns.length - 1];
  const announcement = !last || last.error
    ? ''
    : last.pending
      ? 'Reading your documents…'
      : `Answer ready. ${last.answer.replace(new RegExp(`\\s*${CITATION.source}`, 'g'), '').replace(/[*`#]/g, '')}`;

  const firstDocument = !readyCount && loaded && (
    <div className="first-document">
      <BookOpen size={18} />
      <div>
        <strong>{copy.noDocuments}</strong>
        <span>Add your first PDF, then ask about it.</span>
      </div>
      <button className="text-button" onClick={onOpenLibrary}>
        Open library <ArrowRight size={16} />
      </button>
    </div>
  );

  const hero = (
    <section className="empty">
      <div className="hero-copy">
        <h1>
          {copy.hero[0]}
          {copy.hero[1] && (
            <>
              <br />
              <em>{copy.hero[1]}</em>
            </>
          )}
        </h1>
        <p>{copy.heroText}</p>
        <div className="hero-proof">
          <ShieldCheck size={15} />
          <span>Private to your workspace.</span>
        </div>
      </div>
      {pro && <Stats documents={documents} loaded={loaded} />}
    </section>
  );

  const starters = firstDocument || (
    <section className="discovery" aria-labelledby="discovery-title">
      <div className="discovery-heading">
        <h2 id="discovery-title">Start with a question</h2>
      </div>
      <div className="prompt-grid">
        {STARTERS.map(([Icon, title, description, starter]) => (
          <button
            className="prompt-card"
            key={title}
            disabled={!readyCount || loading}
            onClick={() => {
              setInput(starter);
              // after the input re-renders: focus it with the cursor at the end
              requestAnimationFrame(() => {
                inputRef.current?.focus();
                inputRef.current?.setSelectionRange(starter.length, starter.length);
              });
            }}
          >
            <div className="prompt-card-top">
              <Icon size={19} />
            </div>
            <h3>
              {title}
              <ArrowUpRight size={16} />
            </h3>
            <p>{description}</p>
          </button>
        ))}
      </div>
    </section>
  );

  const thread = (
    <div className="thread" aria-busy={busy} ref={threadRef}>
      <div className="thread-heading">
        <h1>{copy.threadTitle}</h1>
        <span>
          {turns.length} question{turns.length !== 1 ? 's' : ''}
        </span>
      </div>
      {turns.map((t, i) => (
        <Turn key={i} turn={t} />
      ))}
    </div>
  );

  const composer = (
      <div className="composer">
        {turns.length > 0 && firstDocument}
        <form onSubmit={handleSubmit}>
          <Sparkles size={20} className="composer-icon" />
          <input
            ref={inputRef}
            className="field"
            aria-label="Your question"
            maxLength={2000}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              loading
                ? 'Connecting to your library…'
                : !loaded
                  ? 'Your library isn’t available right now'
                  : readyCount
                    ? 'Ask your documents…'
                    : 'Add a PDF to your library first'
            }
            disabled={readyCount === 0 || loading}
          />
          <button
            className="btn ask-submit"
            type="submit"
            disabled={busy || !input.trim() || unfinished || readyCount === 0}
            aria-label={busy ? 'Answer in progress' : 'Ask Atlas'}
          >
            {busy ? <Loader size={19} className="spin" /> : <ArrowUp size={20} />}
          </button>
        </form>
        <div className="composer-meta">
          <span>
            <ShieldCheck size={12} />
            Grounded in your library. Always check the sources.
          </span>
          <span>
            Enter to ask <kbd>↵</kbd>
          </span>
        </div>
      </div>
  );

  const announcer = (
    <p className="sr-only" role="status">
      {announcement}
    </p>
  );

  // Each layout keeps the composer in one slot of the tree whether or not there's
  // a thread, so asking the first question doesn't remount it and lose focus.
  return pro ? (
    <div className="ask">
      {announcer}
      {turns.length === 0 && hero}
      {composer}
      {turns.length === 0 ? starters : thread}
    </div>
  ) : (
    <div className="ask">
      {announcer}
      {turns.length === 0 ? (
        <>
          {hero}
          {starters}
        </>
      ) : (
        thread
      )}
      {composer}
    </div>
  );
}

export default Ask;
