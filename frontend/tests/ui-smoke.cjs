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
    const asks = [];
    let uploads = 0;
    let deletes = 0;
    let pendingReads = 0;
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (!/^\/(documents(?:\/\d+)?|ask|search)$/.test(url.pathname)) return route.continue();
      const reply = (body, status = 200, headers = {}) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers });
      if (request.headers()['x-api-key'] !== fixtureKey) return reply({ detail: 'Invalid API key' }, 401);
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
        return reply(answer);
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
        .locator('.celestial-orbit')
        .first()
        .evaluate((el) => getComputedStyle(el).animationName)) === 'none',
      'reduced motion disables decorative animation',
    );
    await page.getByRole('button', { name: /Find the essentials/ }).click();
    check(
      (await page.getByRole('textbox', { name: 'Your question' }).inputValue()) ===
        'What are the key takeaways from my documents?',
      'prompt card fills the question',
    );
    await page.locator('.composer').getByRole('button', { name: 'Ask Atlas', exact: true }).click();
    await visible(page, 'Reading your documents…');
    await visible(page, 'Answered by Gemini');
    check(asks[0].history.length === 0, 'first question has empty history');
    check(
      (await page.getByText('25 days of paid leave', { exact: true }).evaluate((el) => el.tagName)) ===
        'STRONG',
      'answer formatting remains safe React markup',
    );
    await visible(page, 'Personal details removed: email address');
    await page.locator('summary').focus();
    await page.keyboard.press('Enter');
    await visible(page, answer.sources[0].excerpt);
    check(await page.locator('details').evaluate((el) => el.open), 'source disclosure opens by keyboard');
    await page.screenshot({ path: `${output}/answer-desktop.png`, fullPage: true });
    await page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('button', { name: /Library/ })
      .click();
    await visible(page, 'No readable text found.');
    await page.screenshot({ path: `${output}/library-desktop.png`, fullPage: true });
    await page.getByLabel('Search documents').fill('research');
    check((await page.locator('.doc').count()) === 1, 'document search filters locally');
    await page.getByLabel('Filter by status').selectOption('failed');
    await visible(page, 'No documents found.');
    await page.getByRole('button', { name: 'Clear filters' }).click();
    check((await page.locator('.doc').count()) === 3, 'clear filters restores documents');
    await page.getByLabel('Filter by status').selectOption('failed');
    check((await page.locator('.doc').count()) === 1, 'status filter finds failed document');
    await page.getByLabel('Filter by status').selectOption('all');
    await page.getByRole('navigation').getByRole('button', { name: 'Ask Atlas' }).click();
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
    askError = false;
    await page.getByRole('textbox', { name: 'Your question' }).fill('Please explain the policy.');
    await page.getByRole('textbox', { name: 'Your question' }).press('Enter');
    await page.locator('.answered-by').nth(2).waitFor();
    check(
      asks[3].history.length === 4 && !asks[3].history.some((item) => item.content === 'One more question'),
      'failed turns are excluded from follow-up history',
    );

    await page
      .getByRole('navigation')
      .getByRole('button', { name: /Library/ })
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
    await page.getByRole('navigation').getByRole('button', { name: 'Ask Atlas' }).click();
    await visible(page, 'Atlas isn’t reachable');
    listError = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await visible(page, '2 documents ready');
    check((await page.locator('.connection-notice').count()) === 0, 'retry recovers an unavailable library');
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
    await visible(page, 'A blank page. Endless potential.');
    documents = structuredClone(initialDocuments);
    await page.getByRole('navigation').getByRole('button', { name: 'Ask Atlas' }).click();
    await visible(page, '2 documents ready');

    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
      await noOverflow(page, `${width}px Ask`);
      if (width === 390) await page.screenshot({ path: `${output}/ask-mobile.png`, fullPage: true });
      await page
        .getByRole('navigation')
        .getByRole('button', { name: /Library/ })
        .click();
      await noOverflow(page, `${width}px Library`);
      if (width === 390) await page.screenshot({ path: `${output}/library-mobile.png`, fullPage: true });
      await page.getByRole('navigation').getByRole('button', { name: 'Ask Atlas' }).click();
    }
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
      .getByRole('button', { name: /Library/ })
      .click();
    await visible(page, 'Welcome to Atlas.');
    check(
      (await page.evaluate(() => sessionStorage.getItem('atlas.apiKey'))) === null,
      '401 responses sign out and clear the expired key',
    );
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.reload();
    check(
      (await page.locator('.celestial-orbit').evaluate((el) => getComputedStyle(el).animationDuration)) ===
        '3s',
      'normal-motion illustration has a finite three-second entrance',
    );
    check(errors.length === 0, `no browser runtime errors (${errors.join('; ')})`);
    console.log(`\n${checks} checks passed. Screenshots: ${output}`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
