/**
 * Regenerates the README screenshots from the demo data. Usage: npm run screenshots
 * Builds data/demo.db, serves it on port 4799 (your real server and data are untouched), and saves framed
 * dark-mode PNGs to docs/screenshots/. Uses your installed Google Chrome through playwright-core.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { PROJECT_ROOT } from '../src/core/db.ts';

const PORT = 4799;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(PROJECT_ROOT, 'docs', 'screenshots');
const DB = path.join(PROJECT_ROOT, 'data', 'demo.db');
const env = { ...process.env, PORT: String(PORT), BUDGET_DB: DB };

execFileSync('npx', ['tsx', 'scripts/demo.ts'], { cwd: PROJECT_ROOT, env, stdio: 'inherit' });
execFileSync('npx', ['vite', 'build', '--logLevel', 'warn'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
// Run node directly (not through npx) so killing it stops the server.
const server = spawn(process.execPath, [path.join(PROJECT_ROOT, 'node_modules/tsx/dist/cli.mjs'), 'src/server/index.ts'], { cwd: PROJECT_ROOT, env, stdio: 'inherit' });

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/meta`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Demo server didn't start on ${BASE}`);
}

/** A page's screenshot in a rounded window with a soft shadow, on a transparent background. */
async function framed(page: Page, raw: Buffer, file: string) {
  const border = 'rgba(255,255,255,.12)';
  await page.setContent(`<html><body style="margin:0;background:transparent">
    <div id="f" style="display:inline-block;padding:56px">
      <img src="data:image/png;base64,${raw.toString('base64')}" style="display:block;width:1440px;border-radius:14px;
        border:1px solid ${border};box-shadow:0 2px 6px rgba(15,23,42,.08),0 24px 60px -12px rgba(15,23,42,.28)">
    </div></body></html>`);
  await page.locator('#f').screenshot({ path: file, omitBackground: true });
}

const shots: { name: string; path: string }[] = [
  { name: 'dashboard', path: '/' },
  { name: 'transactions', path: '/transactions' },
  { name: 'budgets', path: '/budgets' },
  { name: 'recurring', path: '/recurring' },
  { name: 'people', path: '/people' },
  { name: 'trends', path: '/trends' },
];

try {
  await waitForServer();
  const { payees } = (await (await fetch(`${BASE}/api/payees?kind=person`)).json()) as { payees: { id: number; name: string }[] };
  const id = payees.find((p) => p.name === 'Sam')?.id;
  if (id) shots.push({ name: 'person', path: `/people/${id}` });

  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const page = await ctx.newPage();
  const frame = await ctx.newPage();
  for (const s of shots) {
    await page.goto(BASE + s.path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800); // let the charts finish animating
    const raw = await page.screenshot();
    const file = path.join(OUT, `${s.name}.png`);
    await framed(frame, raw, file);
    console.error(`saved ${path.relative(PROJECT_ROOT, file)}`);
  }
  await ctx.close();
  await browser.close();
} finally {
  server.kill();
}
