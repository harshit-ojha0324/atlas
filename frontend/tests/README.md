# Frontend regression checks

`ui-smoke.cjs` runs a real Chromium browser against the frontend with intercepted,
isolated API fixtures. It never authenticates against the backend or changes a
real workspace. Fixtures live only in this test; the application always uses its
original API service.

Start Vite from `frontend/`:

```sh
npm run dev -- --host 127.0.0.1
```

With Playwright and its matching Chromium installed in your development
environment, run from the repository root:

```sh
node frontend/tests/ui-smoke.cjs
```

If Playwright is provided by an external toolchain, use `NODE_PATH` to point to
that toolchain's `node_modules` directory. No application dependencies were added.

Optional environment variables:

- `ATLAS_UI_URL`: frontend URL (default `http://127.0.0.1:5173`).
- `ATLAS_CHROMIUM_PATH`: path to an existing compatible Chromium executable.
- `ATLAS_UI_SCREENSHOTS`: screenshot directory (default `/tmp/atlas-ui-review`).

Coverage includes sign-in and invalid/expired keys, session storage and sign-out,
question/follow-up payloads, safe answer formatting, keyboard-accessible sources,
security warnings, rate limits, document search/status filters, invalid and
oversized files, multipart upload, processing polls, drag-and-drop concurrency,
delete cancellation/success/failure, connectivity recovery, empty states,
conversation retention between sections, reduced motion, and responsive layouts
at 320, 390, 768, 1024, and 1440 pixels.

These checks verify frontend behavior and API request compatibility. They do not
replace a live backend test of PDF ingestion, retrieval, or model generation.
