import { useState, useRef, useEffect } from 'react';
import { Loader } from 'lucide-react';
import Sphere from './Sphere';
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
  return text.replace(/`/g, '').split(/(\*\*[^*]+\*\*|\*[^*\n]+\*)/).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={i}>{part.slice(1, -1)}</em>;
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
    b.type === 'ul' ? <ul key={i}>{b.lines.map((l, j) => <li key={j}>{inline(l)}</li>)}</ul>
    : b.type === 'p' ? <p key={i}>{inline(b.lines.join(' '))}</p>
    : null
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

function Turn({ turn }) {
  return (
    <article className="turn">
      <h3>{turn.question}</h3>
      {turn.pending ? (
        <p className="thinking"><Loader size={15} className="spin" />Reading your documents…</p>
      ) : (
        <>
          {turn.error
            ? <p className="answer error">{turn.answer}</p>
            : <div className="answer"><Prose text={turn.answer} /></div>}

          {turn.warnings?.length > 0 && (
            <ul className="warnings" aria-label="Security notes">
              {turn.warnings.map((w) => <li key={w}>{humanize(w)}</li>)}
            </ul>
          )}

          {turn.sources?.length > 0 && (
            <div className="sources">
              <ol>
                {turn.sources.map((s, i) => (
                  <li key={i}>
                    <details className="source">
                      <summary><b>[{i + 1}]</b>{s.document}, page {s.page}</summary>
                      <p>{s.excerpt}{s.excerpt.length >= EXCERPT_CHARS && '…'}</p>
                    </details>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {turn.backend && (
            <p className="answered-by">
              {turn.backend === 'cache' ? 'Answered from cache' : `Answered by ${BACKENDS[turn.backend] ?? turn.backend}`}
            </p>
          )}
        </>
      )}
    </article>
  );
}

function Ask({ readyCount }) {
  const [turns, setTurns] = useState([]);
  const [input, setInput] = useState('');
  const endRef = useRef(null);
  const busy = turns.some((t) => t.pending);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [turns]);

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
        answer: error.detail ? sentence(error.detail) : 'The question couldn’t be answered. Try again in a moment.',
        error: true,
      };
    }
    setTurns((prev) => [...prev.slice(0, -1), done]);
  };

  return (
    <div className="ask">
      {turns.length === 0 ? (
        <section className="empty">
          <div>
            <Sphere className="sphere" />
            <h2>Ask about your documents</h2>
            <p>Answers come only from the PDFs in your library, and each one names the pages it used.</p>
          </div>
        </section>
      ) : (
        <div className="thread">
          {turns.map((t, i) => <Turn key={i} turn={t} />)}
          <div ref={endRef} />
        </div>
      )}

      <div className="composer">
        <form onSubmit={handleSubmit}>
          <input
            className="field"
            aria-label="Your question"
            maxLength={2000}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={readyCount ? 'How many vacation days do employees get?' : 'Add a PDF to your library first'}
            disabled={readyCount === 0}
          />
          <button className="btn" type="submit" disabled={busy || !input.trim() || readyCount === 0}>Ask</button>
        </form>
        {readyCount === 0 && <p className="hint">Nothing to search yet. Add a PDF in the Library.</p>}
      </div>
    </div>
  );
}

export default Ask;
