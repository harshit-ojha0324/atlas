import { useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import useLive from './useLive';

const ENDPOINTS = [
  ['POST', '/documents', 'Upload a PDF, up to 10 MB. Returns 202 while it’s processed.'],
  ['GET', '/documents', 'All of this workspace’s documents.'],
  ['GET', '/documents/{id}', 'One document’s status: pending, ready, or failed with an error.'],
  ['DELETE', '/documents/{id}', 'Delete a document and its passages.'],
  ['POST', '/search', 'The k nearest passages, with document, page and similarity score.'],
  ['POST', '/ask', 'An answer with cited sources, security warnings and the model that answered.'],
];

const TOOLS = [
  ['list_documents()', 'The workspace’s documents and their status.'],
  ['search_documents(query, k=4)', 'The nearest passages, to read directly.'],
  ['ask(question)', 'An answer with sources. Pass a standalone question.'],
];

const MCP_COMMANDS = `make mcp KEY=atlas_...
claude mcp add --transport http atlas http://localhost:8090/mcp`;

function Code({ label, text }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <div className="code">
      <pre tabIndex={0} aria-label={label}>
        <code>{text}</code>
      </pre>
      <button type="button" className="icon-button" onClick={copy} aria-label={`Copy ${label}`}>
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </button>
    </div>
  );
}

const BREAKER = {
  closed: ['ok', 'In use', 'Answers go to the primary model first.'],
  half_open: ['warn', 'Being retried', 'The primary model failed, and forge is testing it again.'],
  open: ['down', 'Skipped', 'The primary model is failing, so answers go straight to the fallback.'],
};

const BACKENDS = { gemini: 'Gemini', vllm: 'vLLM', cache: 'Cache' };

const perMinute = (perSecond) => {
  const n = perSecond * 60;
  return `Refills ${Number.isInteger(n) ? n : n.toFixed(1)} a minute`;
};

function Meter({ label, value, max, children }) {
  return (
    <div className="meter-card">
      <span>{label}</span>
      <strong>
        {value.toLocaleString()} <small>/ {max.toLocaleString()}</small>
      </strong>
      <progress value={value} max={max} aria-label={label} />
      <small>{children}</small>
    </div>
  );
}

function Unavailable({ label, children }) {
  return (
    <div className="meter-card">
      <span>{label}</span>
      <strong>—</strong>
      <small>{children}</small>
    </div>
  );
}

function Gateway({ active }) {
  const { data, failed } = useLive('/gateway', active);
  const breaker = data && BREAKER[data.breaker];
  const backends = Object.entries(data?.answers?.by_backend ?? {}).sort((a, b) => b[1] - a[1]);
  const answered = backends.reduce((sum, [, n]) => sum + n, 0);
  const cached = data?.answers?.by_backend.cache ?? 0;
  const count = (n) => (n == null ? '—' : n.toLocaleString());
  const query = data?.rate_limits?.query;
  const upload = data?.rate_limits?.upload;

  const askExample = `curl ${window.location.origin}/ask \\
  -H "X-API-Key: $ATLAS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"question": "How many vacation days do employees get?"}'`;

  return (
    <section className="connect">
      <div className="library-heading">
        <h1>Gateway</h1>
        <p className="lede">
          How this workspace’s questions reach a model through forge, what they’ve used, and how to connect your own
          code or agents.
        </p>
      </div>
      {failed && (
        <p className="notice error" role="alert">
          This page couldn’t be refreshed. The numbers below may be out of date.
        </p>
      )}

      <div className="connect-section" aria-busy={!data && !failed}>
        <h2>Right now</h2>
        <div className="meter-grid">
          {data?.quota ? (
            <Meter label="Tokens used today" value={data.quota.used_tokens} max={data.quota.daily_token_quota}>
              Resets at midnight UTC. Cached answers use none.
            </Meter>
          ) : (
            <Unavailable label="Tokens used today">{data ? 'forge didn’t answer, so this is unknown.' : 'Loading…'}</Unavailable>
          )}
          {query ? (
            <Meter label="Questions available" value={Math.floor(query.available)} max={query.capacity}>
              {perMinute(query.refill_per_s)}. Also covers search.
            </Meter>
          ) : (
            <Unavailable label="Questions available">{data ? 'Redis didn’t answer, so this is unknown.' : 'Loading…'}</Unavailable>
          )}
          {upload ? (
            <Meter label="Uploads available" value={Math.floor(upload.available)} max={upload.capacity}>
              {perMinute(upload.refill_per_s)}.
            </Meter>
          ) : (
            <Unavailable label="Uploads available">{data ? 'Redis didn’t answer, so this is unknown.' : 'Loading…'}</Unavailable>
          )}
          <div className="meter-card" data-state={breaker?.[0] ?? 'unknown'}>
            <span>Primary model</span>
            <strong className="breaker">
              <i />
              {breaker?.[1] ?? '—'}
            </strong>
            <small>{breaker?.[2] ?? (data ? 'forge didn’t answer, so this is unknown.' : 'Loading…')}</small>
          </div>
        </div>
      </div>

      <div className="connect-section">
        <h2>Answers, last {data?.answers?.window_days ?? 7} days</h2>
        <div className="library-stats answer-stats">
          <div>
            <span>Answered</span>
            <strong>{data?.answers ? answered.toLocaleString() : '—'}</strong>
          </div>
          <div>
            <span>From cache</span>
            <strong>{data?.answers && answered ? `${Math.round((cached / answered) * 100)}%` : '—'}</strong>
          </div>
          <div>
            <span>Declined, nothing relevant</span>
            <strong>{count(data?.answers?.declined)}</strong>
          </div>
          <div data-alert={data?.answers?.failed > 0 || undefined}>
            <span>Failed</span>
            <strong>{count(data?.answers?.failed)}</strong>
          </div>
          <div>
            <span>Median time</span>
            <strong>{data?.latency ? `${count(data.latency.p50_ms)} ms` : '—'}</strong>
          </div>
          <div>
            <span>95th percentile</span>
            <strong>{data?.latency ? `${count(data.latency.p95_ms)} ms` : '—'}</strong>
          </div>
        </div>
        {answered > 0 && (
          <ul className="backend-list" aria-label="Answers by model">
            {backends.map(([name, n]) => (
              <li key={name}>
                <span>{BACKENDS[name] ?? name}</span>
                <progress value={n} max={answered} aria-label={`${BACKENDS[name] ?? name}, ${n} of ${answered}`} />
                <small>{n.toLocaleString()}</small>
              </li>
            ))}
          </ul>
        )}
        {data?.latency && (
          <p className="connect-note">Times cover this workspace’s last {data.latency.samples} answers.</p>
        )}
      </div>

      <div className="connect-columns">
        <div className="connect-section">
          <h2>REST API</h2>
          <p className="connect-note">
            Send your workspace key as <code>X-API-Key</code>. Rate-limited responses return 429 with Retry-After.
          </p>
          <ul className="endpoints">
            {ENDPOINTS.map(([method, path, description]) => (
              <li key={`${method} ${path}`}>
                <span className={`method ${method.toLowerCase()}`}>{method}</span>
                <code>{path}</code>
                <small>{description}</small>
              </li>
            ))}
          </ul>
          <Code label="ask example" text={askExample} />
          <a className="text-button" href="/docs" target="_blank" rel="noreferrer">
            Interactive API docs <ExternalLink size={15} />
          </a>
        </div>

        <div className="connect-section">
          <h2>MCP server</h2>
          <p className="connect-note">
            Gives agents one workspace’s documents as tools. It runs on your machine with no authentication of its
            own, so anyone who can reach it acts as that workspace. Keep it on localhost.
          </p>
          <ul className="endpoints">
            {TOOLS.map(([name, description]) => (
              <li key={name}>
                <code>{name}</code>
                <small>{description}</small>
              </li>
            ))}
          </ul>
          <Code label="MCP commands" text={MCP_COMMANDS} />
        </div>
      </div>
    </section>
  );
}

export default Gateway;
