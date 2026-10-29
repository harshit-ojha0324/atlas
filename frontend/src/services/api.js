// Same-origin calls to atlas's API, as the signed-in tenant. The API key lives
// in sessionStorage: it lasts for this tab and is gone when the tab closes.
const KEY = 'atlas.apiKey';

export const getKey = () => sessionStorage.getItem(KEY);
export const setKey = (key) => sessionStorage.setItem(KEY, key);
export const clearKey = () => sessionStorage.removeItem(KEY);

// Set by App: called when the API rejects the key, so the UI signs out.
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

// fetch() that resolves to the parsed JSON body (null for 204) and rejects on
// non-2xx with the API's `detail` message as error.detail. A 429 says when to
// retry; 422 validation errors carry a list in `detail`, which isn't shown.
export default async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...options.headers, 'X-API-Key': getKey() ?? '' },
  });
  if (res.status === 401) onUnauthorized();
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    let detail = typeof data.detail === 'string' ? data.detail : undefined;
    const retry = res.headers.get('Retry-After');
    if (detail && retry) detail += ` Try again in ${retry}s.`;
    throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, detail });
  }
  return data;
}
