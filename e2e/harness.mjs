// Shared by the end-to-end run and the evidence script: our own server on a free port with its own temporary folder,
// and a headless Chrome with a profile of its own. Nothing here opens a window, takes focus or touches Omid's Chrome.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

/** A program on PATH (the command names of Chrome and Chromium on Linux). */
const onPath = (name) =>
  (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, name))
    .find((path) => existsSync(path));

// DIVAN_CHROME first, then the usual places: Windows, macOS, and the Linux command names
const CHROME = [
  process.env.DIVAN_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ...['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map(onPath),
].find((path) => path && existsSync(path));

/** A headless Chrome with a profile of its own, and one page that records its errors. */
export async function openBrowser({
  viewport = { width: 1440, height: 900 },
  theme = 'light',
  lang = 'en',
} = {}) {
  if (!CHROME)
    throw new Error('no Chrome, Chromium or Edge found: set DIVAN_CHROME to the browser program');
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio'],
  });
  const context = await browser.newContext({
    viewport,
    locale: 'fa-IR',
    colorScheme: theme,
    deviceScaleFactor: 1,
  });
  await context.addInitScript((value) => localStorage.setItem('divan-theme', value), theme);
  // the interface language of the run (the browser itself is Persian); a choice made in the page is kept across reloads
  await context.addInitScript((value) => {
    if (!localStorage.getItem('divan-lang')) localStorage.setItem('divan-lang', value);
  }, lang);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    // "ResizeObserver loop" is a harmless browser notice that React Flow's node measuring can trigger.
    if (message.type() === 'error' && !message.text().includes('ResizeObserver loop')) {
      errors.push(`console: ${message.text()}`);
    }
  });
  return { browser, context, page, errors, close: () => browser.close().catch(() => undefined) };
}

/** Starts our own server in this process (fake harnesses unless `real`) and a headless browser pointing at it. */
export async function launch({ real = false, viewport, theme, home, lang } = {}) {
  if (!real) process.env.DIVAN_FAKE = '1';
  process.env.DIVAN_NO_OPEN = '1';
  const ownHome = home ?? mkdtempSync(join(tmpdir(), 'divan-e2e-'));
  const { startServer } = await import(
    pathToFileURL(join(import.meta.dirname, '..', 'src', 'server', 'server.ts')).href
  );
  const server = await startServer({ port: 0, home: ownHome });
  const opened = await openBrowser({ viewport, theme, lang });
  await opened.page.goto(server.url);
  return {
    ...opened,
    server,
    home: ownHome,
    async close() {
      await opened.close();
      await server.close().catch(() => undefined);
      if (!home) rmSync(ownHome, { recursive: true, force: true });
    },
  };
}
