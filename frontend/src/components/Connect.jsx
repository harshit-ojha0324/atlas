import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';

// /readyz is the only live system data the API exposes, and it needs no key.
const SERVICES = [
  ['postgres', 'Postgres', 'Documents and passages'],
  ['redis', 'Redis', 'Ingest queues and rate limits'],
  ['forge', 'forge', 'Model gateway. Answers need it; uploads and search don’t.'],
];

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

function Connect({ active }) {
  const [health, setHealth] = useState(null); // null until read; false if the API didn't answer

  useEffect(() => {
    if (!active) return;
    let current = true;
    fetch('/readyz')
      .then((r) => r.json()) // a 503 still lists which check failed
      .catch(() => false)
      .then((checks) => current && setHealth(checks));
    return () => {
      current = false;
    };
  }, [active]);

  const askExample = `curl ${window.location.origin}/ask \\
  -H "X-API-Key: $ATLAS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"question": "How many vacation days do employees get?"}'`;

  return (
    <section className="connect">
      <div className="library-heading">
        <h1>Connect</h1>
        <p className="lede">
          Use this workspace from your own code or an AI agent. Every route goes through the same isolation, rate
          limits and security checks as this interface.
        </p>
      </div>

      <div className="connect-section">
        <h2>System status</h2>
        <ul className="service-grid" aria-busy={health === null}>
          {SERVICES.map(([id, name, role]) => {
            const state = health === null ? 'checking' : health === false ? 'unknown' : health[id];
            return (
              <li key={id} className="service" data-state={state}>
                <span className="service-state">
                  <i />
                  {state === 'ok' ? 'Reachable' : state === 'down' ? 'Down' : state === 'checking' ? 'Checking…' : 'Unknown'}
                </span>
                <strong>{name}</strong>
                <small>{role}</small>
              </li>
            );
          })}
        </ul>
        {health === false && <p className="doc-detail failed">The API didn’t answer, so these can’t be checked.</p>}
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

export default Connect;
