/**
 * Capture real pages into `fixtures/corpus/` for the token-budget suite.
 *
 *   tsx scripts/capture-corpus.mts [outDir]
 *
 * The committed corpus was five hand-written fixtures whose largest page was
 * 111 tokens against a 1,500-token gate — eleven times the headroom, so no
 * plausible regression could trip it (issue #22). Real pages are one to two
 * orders of magnitude larger, and the point of a budget suite is to notice when
 * the view grows.
 *
 * Captures are committed, so the tests stay offline and deterministic. Re-run
 * this only when the corpus is deliberately refreshed; a page changing upstream
 * should not silently change what CI measures.
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { getAXSnapshot } from '../engine/index.js';
import { serialize } from '../serializer/index.js';

/** Public, stable, structurally varied: lists, articles, forms, docs, apps. */
const PAGES: Array<{ name: string; url: string }> = [
  { name: 'example-minimal', url: 'https://example.com' },
  { name: 'hn-front', url: 'https://news.ycombinator.com' },
  { name: 'hn-newest', url: 'https://news.ycombinator.com/newest' },
  { name: 'hn-ask', url: 'https://news.ycombinator.com/ask' },
  { name: 'wikipedia-portal', url: 'https://www.wikipedia.org/' },
  { name: 'wikipedia-article', url: 'https://en.wikipedia.org/wiki/Web_accessibility' },
  { name: 'wikipedia-axtree', url: 'https://en.wikipedia.org/wiki/Accessibility' },
  { name: 'httpbin-form', url: 'https://httpbin.org/forms/post' },
  { name: 'httpbin-index', url: 'https://httpbin.org/' },
  { name: 'aria-patterns', url: 'https://www.w3.org/WAI/ARIA/apg/patterns/' },
  { name: 'aria-combobox', url: 'https://www.w3.org/WAI/ARIA/apg/patterns/combobox/' },
  { name: 'w3c-wai', url: 'https://www.w3.org/WAI/' },
  { name: 'github-repo', url: 'https://github.com/mohnishbasha/sepia' },
  { name: 'github-issues', url: 'https://github.com/mohnishbasha/sepia/issues' },
  { name: 'iana-reserved', url: 'https://www.iana.org/domains/reserved' },
  { name: 'iana-root', url: 'https://www.iana.org/' },
  { name: 'rfc-editor', url: 'https://www.rfc-editor.org/rfc/rfc9110.html' },
  { name: 'mdn-accessibility', url: 'https://developer.mozilla.org/en-US/docs/Web/Accessibility' },
  { name: 'example-org', url: 'https://example.org' },
  { name: 'nodejs-docs', url: 'https://nodejs.org/en/docs' },
];

const outDir = process.argv[2] ?? new URL('../fixtures/corpus', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const results: Array<{ name: string; nodes: number; tokens: number; kb: number }> = [];
const failures: Array<{ name: string; reason: string }> = [];

for (const { name, url } of PAGES) {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

    const client = await page.context().newCDPSession(page);
    const axSnapshot = await getAXSnapshot(client, {
      frames: page.frames(),
      register: () => {},
    });
    if (axSnapshot === null) throw new Error('no accessibility tree');

    const title = await page.title();
    const view = serialize(axSnapshot, null, { url, title });

    // `baselineTokens` is what the budget suite compares against. The fixture is
    // a frozen snapshot, so this number can only move when the serializer
    // changes — which is exactly the regression the suite exists to catch.
    const fixture = {
      title,
      url,
      capturedAt: new Date().toISOString().slice(0, 10),
      baselineTokens: view.tokenCount,
      axSnapshot,
    };

    // Gzipped: the twenty pages are 18 MB of JSON and 0.7 MB compressed, and a
    // committed corpus should not cost every clone 18 MB.
    const json = `${JSON.stringify(fixture, null, 2)}\n`;
    writeFileSync(`${outDir}/${name}.json.gz`, gzipSync(Buffer.from(json, 'utf8'), { level: 9 }));
    results.push({
      name,
      nodes: view.nodes.length,
      tokens: view.tokenCount,
      kb: Math.round(gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).length / 1024),
    });
    console.log(
      `ok   ${name.padEnd(22)} ${String(view.nodes.length).padStart(5)} nodes ${String(view.tokenCount).padStart(6)} tokens ${String(Math.round(gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).length / 1024)).padStart(4)} KB`,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message.split('\n')[0]! : String(err);
    failures.push({ name, reason });
    console.log(`FAIL ${name.padEnd(22)} ${reason.slice(0, 70)}`);
  } finally {
    await page.close();
  }
}

await browser.close();

const tokens = results.map((r) => r.tokens).sort((a, b) => a - b);
const median = tokens.length === 0 ? 0 : (tokens[Math.floor((tokens.length - 1) / 2)] ?? 0);
console.log(
  `\ncaptured ${String(results.length)}/${String(PAGES.length)} pages` +
    `  median=${String(median)} tokens  max=${String(tokens[tokens.length - 1] ?? 0)} tokens` +
    `  total=${String(results.reduce((s, r) => s + r.kb, 0))} KB`,
);
if (failures.length > 0) {
  console.log(`failed: ${failures.map((f) => f.name).join(', ')}`);
}
