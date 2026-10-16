#!/usr/bin/env node
// Poll a live provider microsite until its Providers menu matches the
// catalog, after a redeploy has been triggered.
//
//   node scripts/menu-sync/wait-for-menu.mjs <catalog.json> <slug>
//        [--timeout <sec>] [--interval <sec>] [--out <file>]
//
// Every --interval seconds (60) the homepage is fetched with a cache-busting
// query string and Cache-Control: no-cache and run through compare.mjs.
// Exits 0 as soon as the comparison is ok; on timeout prints the last
// comparison and exits 1. Fetch errors while polling are transient (the
// site may be mid-deploy) and do not end the wait.
//
// Default timeout by hosting: GitHub Pages 25 minutes (the build the
// redeploy already watched to completion is done; this covers the Pages
// deployment plus the 10 minute CDN TTL), Netlify 45 minutes (nothing is
// watched on Netlify, so this spans the build too; the main azure site alone
// takes about 25 minutes). --out writes the final comparison as JSON for
// the per-site result record.

import fs from 'node:fs';
import {catalogProviders, inspect, readCatalog, siteUrl} from './compare.mjs';

export const DEFAULT_TIMEOUT_SEC = {github: 25 * 60, netlify: 45 * 60};

function parseArgs(argv) {
  const args = {catalog: null, slug: null, timeout: null, interval: 60, out: null};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--timeout') args.timeout = Number(argv[++i]);
    else if (a === '--interval') args.interval = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (!args.catalog) args.catalog = a;
    else if (!args.slug) args.slug = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!args.catalog || !args.slug) {
    throw new Error('usage: wait-for-menu.mjs <catalog.json> <slug> [--timeout sec] [--interval sec] [--out file]');
  }
  if (!(args.interval > 0)) throw new Error('--interval must be a positive number of seconds');
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function brief(result) {
  if (result.ok) return `ok (${result.found} providers)`;
  if (result.reason === 'drift') {
    const parts = [];
    if (result.missing.length) parts.push(`missing ${result.missing.join(', ')}`);
    if (result.extra.length) parts.push(`extra ${result.extra.join(', ')}`);
    if (result.missingCategories.length) parts.push(`missing categories ${result.missingCategories.join(', ')}`);
    if (result.extraCategories.length) parts.push(`extra categories ${result.extraCategories.join(', ')}`);
    return `drift: ${parts.join('; ')}`;
  }
  return `${result.reason}${result.detail ? `: ${result.detail}` : ''}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalog = readCatalog(args.catalog);
  const entry = catalogProviders(catalog).find((p) => p.slug === args.slug);
  if (!entry) throw new Error(`slug ${args.slug} is not in the catalog`);
  const timeout = args.timeout ?? DEFAULT_TIMEOUT_SEC[entry.deployedBy] ?? DEFAULT_TIMEOUT_SEC.github;
  const deadline = Date.now() + timeout * 1000;
  const human = (sec) => (sec >= 120 ? `${Math.round(sec / 60)} min` : `${sec}s`);
  console.log(`wait-for-menu: ${args.slug} (${entry.deployedBy}), polling every ${args.interval}s for up to ${human(timeout)}`);
  let last = null;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    last = await inspect(catalog, siteUrl(args.slug));
    last.attempt = attempt;
    last.at = new Date().toISOString();
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    console.log(`  [${last.at}] attempt ${attempt}: ${brief(last)}${last.ok ? '' : ` (${left}s left)`}`);
    if (last.ok || Date.now() + args.interval * 1000 > deadline) break;
    await sleep(args.interval * 1000);
  }
  if (args.out) fs.writeFileSync(args.out, `${JSON.stringify(last, null, 2)}\n`);
  console.log(JSON.stringify(last));
  if (!last.ok) {
    console.error(`wait-for-menu: ${args.slug} did not match the catalog within ${human(timeout)}: ${brief(last)}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`wait-for-menu: ${error.message}`);
  process.exitCode = 2;
});
