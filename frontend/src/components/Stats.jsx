import { useEffect } from 'react';
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react';
import { useTheme } from '../theme';

// A count that runs to its new value instead of swapping.
function Count({ value, format }) {
  const current = useMotionValue(value);
  const text = useTransform(current, (v) => format(Math.round(v)));
  const reduced = useReducedMotion();
  useEffect(() => {
    const run = animate(current, value, { duration: reduced ? 0 : 0.6, ease: 'easeOut' });
    return () => run.stop();
  }, [value, current, reduced]);
  return <motion.strong>{text}</motion.strong>;
}

function Stats({ documents, loaded }) {
  const pro = useTheme() === 'pro';
  const format = pro ? (n) => n.toLocaleString() : (n) => String(n).padStart(2, '0');
  const value = (n) => (loaded ? <Count value={n} format={format} /> : <strong>—</strong>);
  const count = (status) => documents.filter((doc) => doc.status === status).length;
  return (
    <div className="library-stats">
      <div>
        <span>Documents</span>
        {value(documents.length)}
      </div>
      <div>
        <span>
          <i className="stat-dot ready" />
          Ready to ask
        </span>
        {value(count('ready'))}
      </div>
      <div>
        <span>
          <i className="stat-dot pending" />
          Processing
        </span>
        {value(count('pending'))}
      </div>
      {pro && (
        <div>
          <span>Passages indexed</span>
          {value(documents.reduce((sum, doc) => sum + (doc.chunk_count ?? 0), 0))}
        </div>
      )}
    </div>
  );
}

export default Stats;
