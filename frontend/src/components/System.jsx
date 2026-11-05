import { useEffect, useState } from 'react';
import useLive from './useLive';

const SERVICES = [
  ['postgres', 'Postgres', 'Documents and passages'],
  ['redis', 'Redis', 'Ingest queues and rate limits'],
  ['forge', 'forge', 'Model gateway. Answers need it; uploads and search don’t.'],
];

const SECURITY = [
  ['pii_redacted', 'Personal details removed', 'From questions, before they reach a model.'],
  ['injection_blocked', 'Questions refused', 'They looked like prompt injections.'],
  ['chunk_dropped', 'Passages withheld', 'Planted instructions in a document were kept out of the prompt.'],
  ['history_turn_dropped', 'Earlier questions dropped', 'Injection attempts earlier in a conversation.'],
  ['output_filtered', 'Credentials masked', 'Found in an answer before it was returned.'],
];

const LIMITS = [
  ['Answers don’t stream', 'A question returns all at once when the answer is finished.'],
  ['Detection is pattern-based', 'PII and injection checks use patterns, so ten-digit IDs are redacted as phone numbers.'],
  ['Fairness is per document', 'A very large PDF holds a worker until it finishes.'],
  ['Search is an exact scan', 'There’s no vector index yet, so search time grows with a workspace’s passages.'],
  ['Quotas are fixed', 'Every workspace gets the same forge quota and weight.'],
  ['No workspace deletion', 'There’s no command to remove a tenant.'],
];

// Public and unauthenticated, and a 503 still lists which check failed.
function useReadiness(active) {
  const [health, setHealth] = useState(null); // null until read; false if the API didn't answer
  useEffect(() => {
    if (!active) return;
    let current = true;
    const read = () =>
      fetch('/readyz')
        .then((r) => r.json())
        .catch(() => false)
        .then((checks) => current && setHealth(checks));
    read();
    const timer = setInterval(read, 5000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [active]);
  return health;
}

function System({ active }) {
  const health = useReadiness(active);
  const { data, failed } = useLive('/system', active);
  const count = (n) => (n == null ? '—' : n.toLocaleString());

  return (
    <section className="connect">
      <div className="library-heading">
        <h1>System</h1>
        <p className="lede">The services behind this workspace, its processing queue, and how Atlas has been verified.</p>
      </div>
      {failed && (
        <p className="notice error" role="alert">
          This page couldn’t be refreshed. The numbers below may be out of date.
        </p>
      )}

      <div className="connect-section">
        <h2>Services</h2>
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

      <div className="connect-section">
        <h2>Processing</h2>
        <div className="library-stats system-grid">
          <div data-alert={data?.workers_live === 0 || undefined}>
            <span>Workers alive</span>
            <strong>{count(data?.workers_live)}</strong>
          </div>
          <div>
            <span>Waiting</span>
            <strong>{count(data?.ingest?.waiting)}</strong>
          </div>
          <div>
            <span>Being processed</span>
            <strong>{count(data?.ingest?.in_progress)}</strong>
          </div>
          <div data-alert={data?.documents?.failed > 0 || undefined}>
            <span>Failed documents</span>
            <strong>{count(data?.documents?.failed)}</strong>
          </div>
          <div>
            <span>Pages indexed</span>
            <strong>{count(data?.documents?.pages)}</strong>
          </div>
          <div>
            <span>Passages indexed</span>
            <strong>{count(data?.documents?.passages)}</strong>
          </div>
        </div>
      </div>

      <div className="connect-columns">
        <div className="connect-section">
          <h2>Security, last {data?.security?.window_days ?? 7} days</h2>
          <ul className="plain-list security-list">
            {SECURITY.map(([id, label, description]) => (
              <li key={id}>
                <b>{count(data?.security?.[id])}</b>
                <div>
                  <span>{label}</span>
                  <small>{description}</small>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="connect-section">
          <h2>Last verified</h2>
          <p className="connect-note">
            Recorded runs of the project’s checks, with the date and commit of each. Not live, and refreshed with{' '}
            <code>make verify</code>.
          </p>
          <ul className="plain-list verification-list">
            {(data?.verification ?? []).map((check) => (
              <li key={check.id}>
                <span className={check.passed ? 'check-result' : 'check-result failed'}>
                  {check.passed ? 'Passed' : 'Failed'}
                </span>
                <div>
                  <span>{check.label}</span>
                  <small>{check.detail}</small>
                </div>
                <span className="check-when">
                  {check.date} · {check.commit}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="connect-section">
        <h2>Known limits</h2>
        <ul className="plain-list limit-list">
          {LIMITS.map(([title, text]) => (
            <li key={title}>
              <div>
                <span>{title}</span>
                <small>{text}</small>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export default System;
