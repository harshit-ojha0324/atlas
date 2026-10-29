import { useState, useRef, useEffect } from 'react';
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
import Observatory from './Observatory';
import api from '../services/api';

// The API accepts up to 20 history messages (10 question-answer turns) of up to
// 4,000 characters each.
const MAX_TURNS = 10;
const MAX_CHARS = 4000;
// the API cuts source excerpts at this length
const EXCERPT_CHARS = 200;

// Models answer in Markdown by habit. Render the little they use (paragraphs,
// "* " or "- " bullets, **bold**, *italic*) as React elements, never as HTML,
// so an answer can't inject markup. Code ticks are dropped: answers are prose.
function inline(text) {
  return text
    .replace(/`/g, '')
    .split(/(\*\*[^*]+\*\*|\*[^*\n]+\*)/)
    .map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
        return <strong key={i}>{part.slice(2, -2)}</strong>;
      if (part.startsWith('*') && part.endsWith('*') && part.length > 2)
        return <em key={i}>{part.slice(1, -1)}</em>;
      return part;
    });
}

function Prose({ text }) {
  const blocks = [];
  for (const line of text.split('\n')) {
    const bullet = line.match(/^\s*[*-]\s+(.*)/);
    const last = blocks[blocks.length - 1];
    if (bullet) {
      if (last?.type === 'ul') last.lines.push(bullet[1]);
      else blocks.push({ type: 'ul', lines: [bullet[1]] });
    } else if (line.trim()) {
      if (last?.type === 'p') last.lines.push(line.trim());
      else blocks.push({ type: 'p', lines: [line.trim()] });
    } else {
      blocks.push({ type: 'break' });
    }
  }
  return blocks.map((b, i) =>
    b.type === 'ul' ? (
      <ul key={i}>
        {b.lines.map((l, j) => (
          <li key={j}>{inline(l)}</li>
        ))}
      </ul>
    ) : b.type === 'p' ? (
      <p key={i}>{inline(b.lines.join(' '))}</p>
    ) : null,
  );
}

// forge's backend ids, as names
const BACKENDS = { gemini: 'Gemini', vllm: 'vLLM' };

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
  return (
    <article className="turn">
      <div className="turn-question">
        <span className="question-label">YOU ASKED</span>
        <h3>{turn.question}</h3>
      </div>
      <div className="response-heading">
        <Sphere />
        <span>ATLAS</span>
        <span className="response-line" />
      </div>
      {turn.pending ? (
        <div className="answer-loading" role="status">
          <p className="thinking">
            <Loader size={15} className="spin" />
            Reading your documents…
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
            <div className="answer">
              <Prose text={turn.answer} />
            </div>
          )}

          {turn.warnings?.length > 0 && (
            <ul className="warnings" aria-label="Security notes">
              {turn.warnings.map((w) => (
                <li key={w}>{humanize(w)}</li>
              ))}
            </ul>
          )}

          {turn.sources?.length > 0 && (
            <div className="sources">
              <p className="sources-heading">
                <BookOpen size={14} /> SOURCES <span>{turn.sources.length}</span>
              </p>
              <ol>
                {turn.sources.map((s, i) => (
                  <li key={i}>
                    <details className="source">
                      <summary>
                        <b>{String(i + 1).padStart(2, '0')}</b>
                        <span>
                          {s.document}
                          <small>Page {s.page}</small>
                        </span>
                        <Plus size={15} className="source-expand" />
                      </summary>
                      <p>
                        {s.excerpt}
                        {s.excerpt.length >= EXCERPT_CHARS && '…'}
                      </p>
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
    </article>
  );
}

function Ask({ readyCount, loading, onOpenLibrary }) {
  const [turns, setTurns] = useState([]);
  const [input, setInput] = useState('');
  const endRef = useRef(null);
  const inputRef = useRef(null);
  const busy = turns.some((t) => t.pending);
  const unfinished = STARTERS.some(([, , , starter]) => input === starter); // a card's starter, no topic yet

  useEffect(() => {
    if (turns.length)
      endRef.current?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
        block: 'end',
      });
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

  return (
    <div className="ask">
      <div className="section-topline">
        <p className="eyebrow">
          <span /> YOUR KNOWLEDGE, CONNECTED
        </p>
        <span className="section-index">01 / DISCOVER</span>
      </div>
      {turns.length === 0 ? (
        <>
          <section className="empty">
            <div className="hero-copy">
              <div className="hero-kicker">
                <span className="tiny-star">✦</span> A little curiosity goes a long way.
              </div>
              <h1>
                A world of knowledge.
                <br />
                <em>Within reach.</em>
              </h1>
              <p>
                Turn the documents you carry into the answers you need. Ask freely. Explore deeply. Every
                insight has a source.
              </p>
              <div className="hero-proof">
                <ShieldCheck size={15} />
                <span>Your documents. Your workspace. Your answers.</span>
              </div>
            </div>
            <Observatory />
          </section>
          <section className="discovery" aria-labelledby="discovery-title">
            <div className="discovery-heading">
              <h2 id="discovery-title">Where will your curiosity take you?</h2>
              <span>START WITH A QUESTION</span>
            </div>
            <div className="prompt-grid">
              {STARTERS.map(([Icon, title, description, starter], i) => (
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
                    <span>0{i + 1}</span>
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
        </>
      ) : (
        <div className="thread" aria-busy={busy}>
          <div className="thread-heading">
            <h1>Follow your curiosity.</h1>
            <span>
              {turns.length} question{turns.length !== 1 ? 's' : ''}
            </span>
          </div>
          {turns.map((t, i) => (
            <Turn key={i} turn={t} />
          ))}
          <div ref={endRef} />
        </div>
      )}

      <div className="composer">
        {!readyCount && !loading && (
          <div className="first-document">
            <BookOpen size={18} />
            <div>
              <strong>A great answer starts with a source.</strong>
              <span>Add your first PDF to begin exploring.</span>
            </div>
            <button className="text-button" onClick={onOpenLibrary}>
              Open library <ArrowRight size={16} />
            </button>
          </div>
        )}
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
            ENTER TO ASK <kbd>↵</kbd>
          </span>
        </div>
      </div>
    </div>
  );
}

export default Ask;
