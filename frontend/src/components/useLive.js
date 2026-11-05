import { useEffect, useState } from 'react';
import api from '../services/api';

const EVERY_MS = 5000;

// Re-read an endpoint while its page is open. Earlier data stays on screen if a
// read fails, with `failed` set so the page can say it may be out of date. `fetcher`
// must be stable across renders: define it outside the component.
export default function useLive(path, active, fetcher = api) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!active) return;
    let current = true;
    const read = async () => {
      try {
        const fresh = await fetcher(path);
        if (current) {
          setData(fresh);
          setFailed(false);
        }
      } catch {
        if (current) setFailed(true);
      }
    };
    read();
    const timer = setInterval(read, EVERY_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [path, active, fetcher]);

  return { data, failed };
}
