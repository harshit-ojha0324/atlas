// Browser regression checks against isolated API fixtures, never a live tenant.
// Start Vite first, then run with Playwright available on Node's module path:
// NODE_PATH=/path/to/node_modules node frontend/tests/ui-smoke.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium } = require('playwright');

const origin = process.env.ATLAS_UI_URL || 'http://127.0.0.1:5173';
const output = process.env.ATLAS_UI_SCREENSHOTS || '/tmp/atlas-ui-review';
const fixtureKey = 'atlas_ui_fixture_only';
const initialDocuments = [
  { id: 1, name: 'Company handbook.pdf', status: 'ready', pages: 10, chunk_count: 32 },
  { id: 2, name: 'Research notes.pdf', status: 'ready', pages: 8, chunk_count: 24 },
  { id: 3, name: 'Unreadable scan.pdf', status: 'failed', error: 'No readable text found.' },
];
const answer = {
  answer:
    'Employees receive **25 days of paid leave** each year [1].\n\n- Leave can be requested through your manager.\n- Unused days follow the carry-over policy.',
  sources: [
    {
      document: 'Company handbook.pdf',
      page: 4,
      excerpt: 'Full-time employees receive 25 days of paid annual leave. Submit requests to your manager.',
    },
  ],
  security_warnings: ['PII redacted: EMAIL_ADDRESS'],
  forge_backend: 'gemini',
};
let checks = 0;
function check(value, message) {
  assert.ok(value, message);
  checks++;
  console.log(`PASS ${message}`);
}
async function visible(page, text) {
  await page.getByText(text, { exact: true }).waitFor({ state: 'visible' });
}
// rows leave with a short exit animation, so a filtered list settles rather than snaps
async function docCount(page, n) {
  return page
    .waitForFunction((n) => document.querySelectorAll('.doc').length === n, n, { timeout: 3000 })
    .then(() => true, () => false);
}
async function noOverflow(page, label) {
  check(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    `${label}: no horizontal overflow`,
  );
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ATLAS_CHROMIUM_PATH || undefined,
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let documents = structuredClone(initialDocuments);
    let listError = false;
    let askError = false;
    let deleteError = false;
    let uploadError = false;
    let nextAnswer = null;
    let forgeDown = false;
    let gatewayStatus = {
      quota: { used_tokens: 1234, daily_token_quota: 200000, remaining_tokens: 198766 },
      breaker: 'closed',
      rate_limits: {
        query: { capacity: 30, refill_per_s: 1, available: 27.4 },
        upload: { capacity: 10, refill_per_s: 0.2, available: 10 },
      },
      answers: { window_days: 7, by_backend: { gemini: 3, cache: 1 }, declined: 2, failed: 0 },
      latency: { samples: 4, p50_ms: 812, p95_ms: 2150 },
    };
    const systemStatus = {
      workers_live: 2,
      ingest: { waiting: 1, in_progress: 0 },
      documents: { ready: 2, pending: 0, failed: 1, pages: 18, passages: 56 },
      security: { window_days: 7, pii_redacted: 3, injection_blocked: 1, history_turn_dropped: 0, chunk_dropped: 2, output_filtered: 0 },
      verification: [
        { id: 'drill', label: 'Worker killed mid-document', passed: true, detail: '7/7 checks passed', date: '2026-11-05', commit: 'abc1234' },
        { id: 'eval', label: 'Retrieval evaluation', passed: false, detail: 'below threshold', date: '2026-11-04', commit: 'def5678' },
      ],
    };
    let titanLoaded = false;
    page.on('request', (request) => {
      if (request.url().includes('TitanWorld')) titanLoaded = true;
    });
    const filterBy = (name) =>
      page.getByRole('group', { name: 'Filter by status' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
    const knock = async (times) => {
      for (let i = 0; i < times; i++) await page.locator('.signin .brand-name').click();
    };
    const asks = [];
    let uploads = 0;
    let deletes = 0;
    let pendingReads = 0;
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (!/^\/(documents(?:\/\d+)?|ask|search|readyz|gateway|system)$/.test(url.pathname)) return route.continue();
      const reply = (body, status = 200, headers = {}) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers });
      if (url.pathname === '/readyz') return reply({ redis: 'ok', postgres: 'ok', forge: forgeDown ? 'down' : 'ok' });
      if (request.headers()['x-api-key'] !== fixtureKey) return reply({ detail: 'Invalid API key' }, 401);
      if (url.pathname === '/gateway') return reply(gatewayStatus);
      if (url.pathname === '/system') return reply(systemStatus);
      if (url.pathname === '/documents' && request.method() === 'GET') {
        if (listError) return reply({ detail: 'Temporarily unavailable' }, 503);
        if (documents.some((d) => d.status === 'pending') && ++pendingReads >= 2)
          documents = documents.map((d) =>
            d.status === 'pending' ? { ...d, status: 'ready', pages: 2, chunk_count: 5 } : d,
          );
        return reply(documents);
      }
      if (url.pathname === '/ask') {
        const body = request.postDataJSON();
        check(
          Object.keys(body).sort().join(',') === 'history,question',
          'ask preserves the request contract',
        );
        asks.push(body);
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (askError) return reply({ detail: 'Query rate limit exceeded.' }, 429, { 'Retry-After': '3' });
        return reply(nextAnswer ?? answer);
      }
      if (request.method() === 'POST' && url.pathname === '/documents') {
        uploads++;
        check(
          request.headers()['content-type'].startsWith('multipart/form-data; boundary='),
          'upload keeps multipart encoding',
        );
        check(
          request.postDataBuffer().includes(Buffer.from('name="file"')),
          'upload keeps the file field name',
        );
        if (uploadError) return reply({ detail: 'Upload service unavailable.' }, 503);
        const doc = { id: 4, name: 'New research.pdf', status: 'pending', pages: null, chunk_count: 0 };
        documents.push(doc);
        pendingReads = 0;
        return reply(doc, 202);
      }
      if (request.method() === 'DELETE') {
        deletes++;
        if (deleteError) return reply({ detail: 'Document could not be removed.' }, 503);
        documents = documents.filter((d) => String(d.id) !== url.pathname.split('/').pop());
        return route.fulfill({ status: 204 });
      }
      throw new Error(`Unexpected API request: ${request.method()} ${url.pathname}`);
    });

    await page.goto(origin);
    await visible(page, 'Welcome to Atlas.');
    check((await page.locator('.stage').count()) === 0 && !titanLoaded, 'the professional theme is the default, with no titan loaded');
    check(
      await page.getByRole('button', { name: 'Enter your workspace' }).isDisabled(),
      'blank API key cannot submit',
    );
    await page.screenshot({ path: `${output}/signin-desktop.png`, fullPage: true });
    await page.getByLabel('Workspace API key').fill('invalid_fixture_key');
    await page.getByRole('button', { name: 'Enter your workspace' }).click();
    await visible(page, 'That API key isn’t valid. Check it and try again.');
    check(
      (await page.evaluate(() => sessionStorage.getItem('atlas.apiKey'))) === null,
      'invalid key is cleared',
    );
    await page.getByLabel('Workspace API key').fill(fixtureKey);
    await page.keyboard.press('Tab');
    check(
      await page
        .getByRole('button', { name: 'Enter your workspace' })
        .evaluate((el) => el === document.activeElement),
      'sign-in is reachable by keyboard',
    );
    await page.getByRole('button', { name: 'Enter your workspace' }).click();
    await visible(page, '2 documents ready');
    check(
      (await page.evaluate(() => sessionStorage.getItem('atlas.apiKey'))) === fixtureKey,
      'valid key retains session-only storage',
    );
    await noOverflow(page, 'desktop Ask');
    await page.screenshot({ path: `${output}/ask-desktop.png`, fullPage: true });
    check(
      (await page
        .locator('.connection-dot')
        .evaluate((el) => getComputedStyle(el).animationName)) === 'none',
      'reduced motion disables decorative animation',
    );
    await page.getByRole('button', { name: /Find the essentials/ }).click();
    const questionBox = page.getByRole('textbox', { name: 'Your question' });
    const starter = 'What does my library say about ';
    check((await questionBox.inputValue()) === starter, 'prompt card starts the question');
    check(
      await page.locator('.composer').getByRole('button', { name: 'Ask Atlas', exact: true }).isDisabled(),
      'a starter without a topic cannot be asked',
    );
    // the card focuses the field on the next frame, after the value renders
    check(
      await page
        .waitForFunction(
          () => {
            const el = document.activeElement;
            return el?.getAttribute('aria-label') === 'Your question' && el.selectionStart === el.value.length;
          },
          null,
          { timeout: 2000 },
        )
        .then(() => true, () => false),
      'prompt card leaves the cursor after the starter',
    );
    await page.keyboard.type('annual leave');
    const statusRegion = await page.locator('.ask > [role="status"]').elementHandle();
    await page.locator('.composer').getByRole('button', { name: 'Ask Atlas', exact: true }).click();
    await page.locator('.thinking').waitFor();
    await visible(page, 'Answered by Gemini');
    check(
      await page.locator('.ask > [role="status"]').evaluate(
        (el, region) => el === region && el.textContent.startsWith('Answer ready. Employees receive 25 days'),
        statusRegion,
      ),
      'the answer is announced from a region that stayed mounted',
    );
    check(asks[0].history.length === 0, 'first question has empty history');
    check(asks[0].question === 'What does my library say about annual leave', 'the completed question is sent');
    check(
      (await page.getByText('25 days of paid leave', { exact: true }).evaluate((el) => el.tagName)) ===
        'STRONG',
      'answer formatting remains safe React markup',
    );
    await visible(page, 'Personal details removed: email address');
    await visible(page, answer.sources[0].excerpt);
    check(await page.locator('details').evaluate((el) => el.open), 'a cited source starts open beside its answer');
    await page.locator('summary').focus();
    await page.keyboard.press('Enter');
    check(await page.locator('details').evaluate((el) => !el.open), 'source disclosure closes by keyboard');
    await page.keyboard.press('Enter');
    check(await page.locator('details').evaluate((el) => el.open), 'source disclosure opens by keyboard');
    await page.screenshot({ path: `${output}/answer-desktop.png`, fullPage: true });
    await page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('link', { name: /Library/ })
      .click();
    await visible(page, 'No readable text found.');
    await page.screenshot({ path: `${output}/library-desktop.png`, fullPage: true });
    await page.getByLabel('Search documents').fill('research');
    check(await docCount(page, 1), 'document search filters locally');
    await filterBy('Failed');
    await visible(page, 'No documents found.');
    await page.getByRole('button', { name: 'Clear filters' }).click();
    check(await docCount(page, 3), 'clear filters restores documents');
    await filterBy('Failed');
    check(await docCount(page, 1), 'status filter finds failed document');
    await filterBy('All');
    await page.getByRole('navigation').getByRole('link', { name: 'Ask Atlas' }).click();
    await visible(page, 'Answered by Gemini');
    check((await page.locator('.turn').count()) === 1, 'conversation survives switching sections');
    await page.getByRole('textbox', { name: 'Your question' }).fill('And for contractors?');
    await page.getByRole('textbox', { name: 'Your question' }).press('Enter');
    await page.locator('.answered-by').nth(1).waitFor();
    check(
      asks[1].history.length === 2 &&
        asks[1].history[0].role === 'user' &&
        asks[1].history[1].content === answer.answer,
      'follow-up sends original conversation history',
    );
    askError = true;
    await page.getByRole('textbox', { name: 'Your question' }).fill('One more question');
    await page.getByRole('textbox', { name: 'Your question' }).press('Enter');
    await visible(page, 'Query rate limit exceeded. Try again in 3s.');
    check(
      (await page.getByRole('textbox', { name: 'Your question' }).inputValue()) === 'One more question',
      'a failed question stays in the box to ask again',
    );
    askError = false;
    await page.getByRole('textbox', { name: 'Your question' }).fill('Please explain the policy.');
    await page.getByRole('textbox', { name: 'Your question' }).press('Enter');
    await page.locator('.answered-by').nth(2).waitFor();
    check(
      asks[3].history.length === 4 && !asks[3].history.some((item) => item.content === 'One more question'),
      'failed turns are excluded from follow-up history',
    );
    nextAnswer = { ...answer, answer: Array(14).fill('A long paragraph of the answer, repeated so it runs well past one screen of reading.').join('\n\n') };
    await page.getByRole('textbox', { name: 'Your question' }).fill('Give me the long version.');
    await page.getByRole('textbox', { name: 'Your question' }).press('Enter');
    await page.locator('.answered-by').nth(3).waitFor();
    nextAnswer = null;
    check(
      await page
        .waitForFunction(() => {
          const top = [...document.querySelectorAll('.turn')].pop().getBoundingClientRect().top;
          const composer = document.querySelector('.composer form').getBoundingClientRect().bottom;
          return top >= composer - 4 && top < composer + 100;
        }, null, { timeout: 2000 })
        .then(() => true, () => false),
      'a long answer opens at its question, not its end',
    );
    nextAnswer = { ...answer, answer: '## Leave policy\n\n1. First step\n2. Second step\n\n3. Third step\n\n<b>Not markup</b>' };
    await page.getByRole('textbox', { name: 'Your question' }).fill('Give me the steps.');
    await page.getByRole('textbox', { name: 'Your question' }).press('Enter');
    await page.locator('.answered-by').nth(4).waitFor();
    nextAnswer = null;
    const formatted = page.locator('.answer').last();
    check((await formatted.locator('h4').textContent()) === 'Leave policy', 'a Markdown heading renders as a heading');
    check(
      (await formatted.locator('ol').first().locator('li').count()) === 2 &&
        (await formatted.locator('ol').nth(1).getAttribute('start')) === '3',
      'a numbered list renders as a list and keeps its count across a blank line',
    );
    check(
      (await formatted.locator('b').count()) === 0 && (await formatted.innerText()).includes('<b>Not markup</b>'),
      'HTML in an answer stays plain text',
    );

    nextAnswer = {
      ...answer,
      answer: 'Leave is **25 days [1]**. Both sources agree [1, 2]. Not citations: 2026 [2026] and [9].',
      sources: [
        answer.sources[0],
        { document: 'Research notes.pdf', page: 2, excerpt: 'The carry-over policy applies after one year.' },
        { document: 'Benefits overview.pdf', page: 1, excerpt: 'An overview of employee benefits.' },
      ],
    };
    await page.getByRole('textbox', { name: 'Your question' }).fill('How much leave?');
    await page.getByRole('textbox', { name: 'Your question' }).press('Enter');
    await page.locator('.answered-by').nth(5).waitFor();
    nextAnswer = null;
    const cited = page.locator('.turn').last();
    check(
      (await cited.locator('.cite').count()) === 3 &&
        (await cited.locator('.answer').innerText()).includes('[2026] and [9]'),
      'citations become links, and numbers that match no source stay text',
    );
    check(
      await page.locator('.ask > [role="status"]').evaluate((el) => !/\[\d/.test(el.textContent.replace('[2026]', ''))),
      'citation markers are not read out with the answer',
    );
    check(
      (await cited.locator('.sources-heading').innerText()).includes('2 of 3 cited') &&
        (await cited.locator('.source.uncited').count()) === 1 &&
        (await cited.locator('.source').nth(2).innerText()).includes('Page 1, not cited'),
      'a source the answer never cited is dimmed and says so',
    );
    check(
      (await page.locator('.turn').nth(-2).locator('.source.uncited').count()) === 0,
      'an answer with no citations leaves its sources undimmed',
    );
    const toSource2 = cited.getByRole('button', { name: 'Source 2: Research notes.pdf, page 2' });
    const source2 = cited.locator('details').nth(1);
    await source2.locator('summary').click();
    check(await source2.evaluate((el) => !el.open), 'a source can be closed');
    await toSource2.hover();
    check(await source2.evaluate((el) => el.classList.contains('hinted')), 'pointing at a citation lights its source');
    await toSource2.click();
    check(await source2.evaluate((el) => el.open), 'a citation opens its source');
    check(await cited.locator('details').nth(2).evaluate((el) => !el.open), 'a citation opens only its source');
    check(
      await source2.locator('summary').evaluate((el) => el === document.activeElement),
      'a citation moves focus to its source',
    );
    check(
      await source2.evaluate((el) => {
        const { top, bottom } = el.getBoundingClientRect();
        const form = document.querySelector('.composer form').getBoundingClientRect();
        return top >= form.bottom && bottom <= innerHeight;
      }),
      'the opened source is on screen, clear of the composer',
    );
    await visible(page, 'The carry-over policy applies after one year.');
    await cited.getByRole('button', { name: 'Back to the answer' }).click();
    check(
      await toSource2.evaluate((el) => el === document.activeElement),
      'Back to the answer returns to the citation',
    );
    check((await cited.getByRole('button', { name: 'Back to the answer' }).count()) === 0, 'the way back goes once used');

    await page
      .getByRole('navigation')
      .getByRole('link', { name: /Library/ })
      .click();
    const file = page.locator('input[type="file"]');
    await file.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a PDF') });
    await page.getByRole('alert').filter({ hasText: 'isn’t a PDF' }).waitFor();
    check(uploads === 0, 'invalid file rejected before network request');
    await file.setInputFiles({
      name: 'large.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
    });
    await page.getByRole('alert').filter({ hasText: 'over 10 MB' }).waitFor();
    check(uploads === 0, 'oversized file rejected before network request');
    uploadError = true;
    const pdf = {
      name: 'New research.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 fixture'),
    };
    await file.setInputFiles(pdf);
    await visible(page, 'Upload service unavailable.');
    uploadError = false;
    await file.setInputFiles(pdf);
    await visible(page, 'Uploaded “New research.pdf”. It will be ready to ask about in a moment.');
    await page
      .locator('.doc')
      .filter({ hasText: 'New research.pdf' })
      .getByText('Ready', { exact: true })
      .waitFor();
    check(pendingReads >= 2, 'pending upload polls until ready');
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.getByRole('button', { name: 'Delete New research.pdf', exact: true }).click();
    check(deletes === 0, 'cancel deletion makes no request');
    deleteError = true;
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Delete New research.pdf', exact: true }).click();
    await visible(page, 'Document could not be removed.');
    deleteError = false;
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Delete New research.pdf', exact: true }).click();
    await visible(page, 'Deleted “New research.pdf”.');
    await page.getByText('New research.pdf', { exact: true }).waitFor({ state: 'hidden' });
    check(documents.length === 3, 'confirmed deletion removes only selected document');
    const beforeDrop = uploads;
    await page.locator('.dropzone').evaluate((el) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['%PDF-1.4 fixture'], 'New research.pdf', { type: 'application/pdf' }));
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    });
    await page
      .locator('.doc')
      .filter({ hasText: 'New research.pdf' })
      .getByText('Ready', { exact: true })
      .waitFor();
    check(uploads === beforeDrop + 1, 'drag-and-drop uploads once and ignores overlapping drops');
    documents = structuredClone(initialDocuments);

    listError = true;
    await page.getByRole('navigation').getByRole('link', { name: 'Ask Atlas' }).click();
    await visible(page, 'Atlas isn’t reachable');
    listError = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await visible(page, '2 documents ready');
    check((await page.locator('.connection-notice').count()) === 0, 'retry recovers an unavailable library');
    listError = true;
    await page.reload();
    await visible(page, 'Atlas isn’t reachable');
    check((await page.locator('.first-document').count()) === 0, 'an outage on load does not ask for a first PDF');
    check(await page.getByRole('textbox', { name: 'Your question' }).isDisabled(), 'an outage on load disables asking');
    check(
      (await page.locator('.prompt-card').first().evaluate((el) => el.disabled && +getComputedStyle(el).opacity < 1)),
      'disabled starter cards look disabled',
    );
    await page.getByRole('navigation').getByRole('link', { name: /Library/ }).click();
    await visible(page, 'Your documents couldn’t be loaded.');
    check(
      (await page.getByText('No documents yet.').count()) === 0 &&
        (await page.locator('.library-stats strong').first().textContent()) === '—',
      'an outage on load does not claim the library is empty',
    );
    listError = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await visible(page, '2 documents ready');
    check(await docCount(page, 3), 'retry after an outage on load lists the documents');
    await page.getByRole('navigation').getByRole('link', { name: 'Ask Atlas' }).click();

    const currentView = () => page.locator('.tab[aria-current="page"]').textContent();
    const onView = (name) => page.locator('.tab[aria-current="page"]', { hasText: name }).waitFor();
    const scrollY = () => page.evaluate(() => window.scrollY);
    await page.setViewportSize({ width: 1000, height: 500 });
    await page.getByRole('navigation').getByRole('link', { name: /Library/ }).click();
    await page.waitForURL('**/#/library');
    await onView('Library');
    check(
      await page.waitForFunction(() => document.title === 'Library | Atlas', null, { timeout: 2000 }).then(() => true, () => false),
      'the title names the current view',
    );
    check(
      await page.evaluate(() => document.activeElement.id === 'main-content'),
      'changing view moves focus to the content',
    );
    await page.evaluate(() => window.scrollTo(0, 150));
    await page.goBack();
    await page.waitForURL('**/#/ask');
    await onView('Ask Atlas');
    check((await currentView()) === 'Ask Atlas', 'Back returns to the previous view');
    check((await scrollY()) === 0, 'a view does not inherit the scroll of the last one');
    await page.goForward();
    await page.waitForURL('**/#/library');
    await onView('Library');
    check((await scrollY()) === 150, 'a view keeps its own scroll position');
    await page.evaluate(() => {
      window.location.hash = '#main-content';
    });
    await page.waitForTimeout(100); // long enough for hashchange to fire
    check((await currentView()).startsWith('Library'), 'the skip link does not change the view');
    await page.goBack();
    await page.waitForURL('**/#/library');
    await page.reload();
    await visible(page, '2 documents ready');
    check((await currentView()).startsWith('Library'), 'a reload stays on the current view');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('navigation').getByRole('link', { name: 'Ask Atlas' }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    check(
      (await page.evaluate(() => sessionStorage.getItem('atlas.apiKey'))) === null,
      'sign-out clears API key',
    );
    documents = [];
    await page.getByLabel('Workspace API key').fill(fixtureKey);
    await page.getByRole('button', { name: 'Enter your workspace' }).click();
    await visible(page, '0 documents ready');
    check(
      await page.getByRole('textbox', { name: 'Your question' }).isDisabled(),
      'empty library disables asking',
    );
    check((await page.locator('.turn').count()) === 0, 'sign-out clears conversation');
    await page.getByRole('button', { name: 'Open library', exact: true }).click();
    await visible(page, 'No documents yet.');
    documents = structuredClone(initialDocuments);
    await page.getByRole('navigation').getByRole('link', { name: 'Ask Atlas' }).click();
    await visible(page, '2 documents ready');

    for (const [width, height] of [[1920, 1080], [1440, 900], [1366, 768], [1280, 720], [1000, 700], [1280, 600]]) {
      await page.setViewportSize({ width, height });
      check(
        await page.evaluate(() => {
          const cards = document.querySelector('.prompt-grid').getBoundingClientRect();
          const composer = document.querySelector('.composer form').getBoundingClientRect();
          return cards.bottom <= composer.top || cards.top >= composer.bottom;
        }),
        `${width}x${height}: the composer does not cover the starters`,
      );
    }
    const typeAt = async (width) => {
      await page.setViewportSize({ width, height: 1000 });
      return page.evaluate(() =>
        ['body', '.hero-copy > p', '.prompt-card h3', '.prompt-card p'].map((s) => getComputedStyle(document.querySelector(s)).fontSize).join(),
      );
    };
    check((await typeAt(1440)) === (await typeAt(1920)), 'text does not change size on wider screens');
    check((await typeAt(1440)).startsWith('16px'), 'body text is 16px at the browser default');
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '20px';
    });
    check((await typeAt(1440)).startsWith('20px'), 'text follows the browser font size');
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '';
    });

    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
      await noOverflow(page, `${width}px Ask`);
      if (width === 390) await page.screenshot({ path: `${output}/ask-mobile.png`, fullPage: true });
      await page
        .getByRole('navigation')
        .getByRole('link', { name: /Library/ })
        .click();
      await noOverflow(page, `${width}px Library`);
      if (width === 390) await page.screenshot({ path: `${output}/library-mobile.png`, fullPage: true });
      await page.getByRole('navigation').getByRole('link', { name: 'Gateway' }).click();
      await noOverflow(page, `${width}px Gateway`);
      await page.getByRole('navigation').getByRole('link', { name: 'System' }).click();
      await noOverflow(page, `${width}px System`);
      await page.getByRole('navigation').getByRole('link', { name: 'Ask Atlas' }).click();
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('navigation').getByRole('link', { name: 'Gateway' }).click();
    await page.waitForURL('**/#/gateway');
    const gatewayPage = page.locator('.view:not([hidden]) .connect');
    await gatewayPage.getByText('Tokens used today').waitFor();
    check((await gatewayPage.innerText()).includes('1,234'), 'Gateway shows the tokens this workspace used');
    check((await gatewayPage.innerText()).includes('27'), 'Gateway shows the questions available, rounded down');
    check((await gatewayPage.innerText()).includes('In use'), 'Gateway says the primary model is in use');
    check((await gatewayPage.innerText()).includes('25%'), 'Gateway works out the share of cached answers');
    check((await gatewayPage.innerText()).includes('2,150 ms'), 'Gateway shows the slowest 5% of answers');
    check((await gatewayPage.locator('.backend-list li').count()) === 2, 'Gateway lists answers by model');
    check(!(await gatewayPage.innerText()).includes(fixtureKey), 'Gateway never prints the workspace key');
    gatewayStatus = {
      ...gatewayStatus,
      quota: null,
      breaker: 'open',
      answers: { ...gatewayStatus.answers, failed: 4 },
    };
    await page.reload();
    await gatewayPage.getByText('forge didn’t answer, so this is unknown.').waitFor();
    check((await gatewayPage.innerText()).includes('Skipped'), 'an open breaker says the primary model is skipped');
    check((await gatewayPage.locator('[data-alert]').count()) === 1, 'failed answers stand out');
    check(
      !(await gatewayPage.locator('.meter-card').first().innerText()).includes('0'),
      'an unknown quota is shown as unknown, not zero',
    );
    forgeDown = true;
    await page.getByRole('navigation').getByRole('link', { name: 'System' }).click();
    await page.waitForURL('**/#/system');
    const systemPage = page.locator('.view:not([hidden]) .connect');
    await systemPage.locator('.service[data-state="down"]').waitFor();
    check(
      (await systemPage.locator('.service[data-state="ok"]').count()) === 2 &&
        (await systemPage.locator('.service[data-state="down"]').innerText()).includes('forge'),
      'System shows live readiness, service by service',
    );
    forgeDown = false;
    await systemPage.getByText('Workers alive').waitFor();
    check(
      (await systemPage.locator('.system-grid').innerText()).replace(/\s+/g, ' ').includes('Workers alive 2'),
      'System shows the workers alive',
    );
    check((await systemPage.locator('[data-alert]').count()) === 1, 'failed documents stand out');
    check(
      (await systemPage.locator('.security-list li').first().innerText()).startsWith('3'),
      'System shows this workspace’s security events',
    );
    const recorded = await systemPage.locator('.verification-list').innerText();
    check(
      recorded.includes('2026-11-05') && recorded.includes('abc1234'),
      'each verification result shows when and at which commit it ran',
    );
    check((await systemPage.locator('.check-result.failed').count()) === 1, 'a failed check is shown as failed');
    check((await page.locator('.tab').count()) === 4, 'the professional theme has four tabs');
    documents.push({ id: 9, name: 'Still processing.pdf', status: 'pending', pages: null, chunk_count: 0 });
    pendingReads = -1000; // stays pending for these checks
    await page.reload();
    await visible(page, '2 documents ready · 1 processing');
    for (const width of [1400, 1341, 1340, 1280, 1181, 1180, 1024, 941, 940, 800]) {
      await page.setViewportSize({ width, height: 800 });
      await noOverflow(page, `${width}px, with the longest status`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    documents = documents.filter((d) => d.id !== 9);
    await page.getByRole('navigation').getByRole('link', { name: 'Ask Atlas' }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await noOverflow(page, `${width}px Sign-in`);
      if (width === 390) await page.screenshot({ path: `${output}/signin-mobile.png`, fullPage: true });
    }
    await page.getByLabel('Workspace API key').fill(fixtureKey);
    await page.getByRole('button', { name: 'Enter your workspace' }).click();
    await visible(page, '2 documents ready');
    await page.evaluate(() => sessionStorage.setItem('atlas.apiKey', 'expired_fixture_key'));
    await page
      .getByRole('navigation')
      .getByRole('link', { name: /Library/ })
      .click();
    await visible(page, 'Welcome to Atlas.');
    check(
      (await page.evaluate(() => sessionStorage.getItem('atlas.apiKey'))) === null,
      '401 responses sign out and clear the expired key',
    );
    await page.setViewportSize({ width: 1440, height: 1000 });

    // The easter egg: seven clicks on the name.
    await knock(6);
    check((await page.locator('.stage').count()) === 0 && !titanLoaded, 'six clicks on the name do nothing');
    await page.waitForTimeout(2100);
    await knock(6);
    check((await page.locator('.stage').count()) === 0, 'a pause starts the count again');
    await knock(1);
    await page.locator('.stage').waitFor({ state: 'attached' });
    check(titanLoaded, 'the seventh click brings the titan, loaded only then');
    check(
      (await page.locator('.titan-heat').first().evaluate((el) => getComputedStyle(el).animationName)) === 'none',
      'reduced motion stills the titan too',
    );
    await page.locator('h1', { hasText: 'He holds up the sky.' }).waitFor();
    await page.getByLabel('Workspace API key').fill(fixtureKey);
    await page.getByRole('button', { name: 'Enter your workspace' }).click();
    await visible(page, '2 documents ready');
    check(
      (await page.getByRole('navigation', { name: 'Sections' }).getByRole('link').count()) === 2,
      'the titan keeps its two original tabs',
    );
    await page.getByRole('navigation').getByRole('link', { name: 'Ask Atlas' }).click();
    await page.locator('h1', { hasText: 'The weight of knowledge.' }).waitFor();
    await page.getByRole('navigation').getByRole('link', { name: /Library/ }).click();
    await page.getByLabel('Filter by status').selectOption('failed');
    check(await docCount(page, 1), 'the titan keeps its status filter');
    await page.getByLabel('Filter by status').selectOption('all');
    await docCount(page, 3);
    await page.reload();
    await visible(page, '2 documents ready');
    check((await page.locator('.stage').count()) === 1, 'a reload stays with the titan');
    for (const width of [768, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await noOverflow(page, `titan ${width}px Library`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('navigation').getByRole('link', { name: 'Ask Atlas' }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.reload();
    await visible(page, 'Welcome to Atlas.');
    check(
      await page.locator('.titan-heat').evaluate((el) => getComputedStyle(el).animationName.includes('breathe')),
      'with normal motion the heat in the scene breathes',
    );
    const painted = () =>
      page.locator('.embers').evaluate((canvas) => {
        const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        for (let i = 3; i < data.length; i += 4) if (data[i]) return true;
        return false;
      });
    check(
      await page.waitForFunction(() => document.querySelector('.embers').width > 0).then(painted),
      'embers are rising over the scene',
    );
    const stage = page.locator('.stage');
    check((await stage.getAttribute('data-mode')) === 'signin', 'the scene starts at the sign-in view');
    await page.getByLabel('Workspace API key').fill(fixtureKey);
    await page.getByRole('button', { name: 'Enter your workspace' }).click();
    await visible(page, '2 documents ready');
    await page.getByRole('navigation').getByRole('link', { name: 'Ask Atlas' }).click();
    check(
      await page.locator('.stage[data-mode="ask"]').waitFor({ state: 'attached', timeout: 2000 }).then(() => true, () => false),
      'the scene follows the open view once signed in',
    );
    check((await page.locator('.star').count()) === 2, 'each ready document is a star; failed ones are not');
    check(
      Number(await stage.evaluate((el) => el.style.getPropertyValue('--charge'))) > 0.2,
      'a library with documents charges the titan',
    );
    await page.getByRole('textbox', { name: 'Your question' }).fill('How much leave?');
    await page.getByRole('textbox', { name: 'Your question' }).press('Enter');
    await page.locator('.stage[data-reading]').waitFor({ state: 'attached' });
    await visible(page, 'Answered by Gemini');
    check((await stage.getAttribute('data-reading')) === null, 'the scene stops reading when the answer lands');
    check((await stage.getAttribute('data-mode')) === 'thread', 'a conversation moves the scene behind the text');
    await page.getByRole('navigation').getByRole('link', { name: /Library/ }).click();
    await page.locator('.stage[data-mode="library"]').waitFor({ state: 'attached' });
    check((await page.locator('.tab-seam').count()) === 1, 'one seam marks the open section');
    await page.getByLabel('Search documents').fill('research');
    check(await docCount(page, 1), 'with normal motion, filtered rows still leave');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await knock(7);
    await page.locator('h1', { hasText: 'Answers you can check.' }).waitFor();
    check((await page.locator('.stage').count()) === 0, 'seven more clicks go back to the professional theme');
    await page.getByLabel('Workspace API key').fill(fixtureKey);
    await page.getByRole('button', { name: 'Enter your workspace' }).click();
    await visible(page, '2 documents ready');
    await page.getByRole('navigation').getByRole('link', { name: 'Ask Atlas' }).click();
    const box = page.getByRole('textbox', { name: 'Your question' });
    await box.fill('How much leave?');
    await box.press('Enter');
    await visible(page, 'Answered by Gemini');
    check(
      await box.evaluate((el) => el === document.activeElement),
      'asking the first question leaves focus in the composer',
    );
    const fresh = await context.newPage();
    await fresh.goto(origin);
    await fresh.getByText('Welcome to Atlas.', { exact: true }).waitFor();
    check((await fresh.locator('.stage').count()) === 0, 'a new tab starts on the professional theme');
    await fresh.close();
    check(errors.length === 0, `no browser runtime errors (${errors.join('; ')})`);
    console.log(`\n${checks} checks passed. Screenshots: ${output}`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
