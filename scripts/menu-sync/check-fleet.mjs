#!/usr/bin/env node
// Drift check over the whole fleet: compare.mjs against the live homepage of
// every provider in the catalog, with bounded concurrency, writing one
// result file per site for the report.
//
//   node scripts/menu-sync/check-fleet.mjs <catalog.json> --out <dir>
//        [--only slug,slug] [--force] [--concurrency 8] [--dry-run]
//
// Result files (<dir>/<slug>.json) carry status "ok", "drifted" or "error"
// plus the comparison. --force marks every selected site drifted (reason
// "forced") so a sync redeploys it whether or not its menu matches. --only
// restricts the run to the listed slugs and fails on one the catalog does not
// know; --dry-run only lists the selected sites (the catalog job uses it to
// reject a bad --only before the preflight build is paid for).
//
// Outputs for the workflow (appended to $GITHUB_OUTPUT when set):
//   drifted  JSON array of drifted slugs in catalog order
//   canary   the first drifted GitHub Pages site in catalog order, else the
//            first drifted site of any kind, else ""
//   fanout   JSON array: drifted minus the canary
//   errors   number of sites that could not be inspected
//
// Exit code is 0 unless the arguments or the catalog are unusable (2): a
// drifted or unreachable site is a result, not a failure of the check. The
// finish job decides what the run's colour is.

import fs from 'node:fs';
import path from 'node:path';
import {catalogProviders, inspect, readCatalog, siteUrl} from './compare.mjs';

function parseArgs(argv) {
  const args = {catalog: null, out: null, only: [], force: false, concurrency: 8, dryRun: false};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--only') args.only = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--concurrency') args.concurrency = Math.max(1, Number(argv[++i]) || 8);
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (!args.catalog) args.catalog = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!args.catalog) throw new Error('usage: check-fleet.mjs <catalog.json> --out <dir> [--only a,b] [--force] [--concurrency N] [--dry-run]');
  if (!args.out && !args.dryRun) throw new Error('--out <dir> is required');
  return args;
}

// The sites a run covers, in catalog order, after the --only filter.
export function selectSites(catalog, only) {
  const all = catalogProviders(catalog);
  if (!only.length) return all;
  const known = new Set(all.map((p) => p.slug));
  const unknown = only.filter((slug) => !known.has(slug));
  if (unknown.length) {
    throw new Error(`--only names slug(s) the catalog does not have: ${unknown.join(', ')}`);
  }
  const wanted = new Set(only);
  return all.filter((p) => wanted.has(p.slug));
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  return results;
}

function toResult(provider, comparison, force) {
  const base = {
    site: provider.slug,
    deployedBy: provider.deployedBy,
    repo: provider.repo,
    branch: provider.branch,
    category: provider.category,
    phase: 'check',
    at: new Date().toISOString(),
  };
  const fields = (({missing, extra, missingCategories, extraCategories, found, generated, detail}) => ({
    missing, extra, missingCategories, extraCategories, found, generated, detail,
  }))(comparison);
  if (comparison.reason === 'fetch-error' || comparison.reason === 'parse-error') {
    return {...base, status: 'error', reason: comparison.reason, ...fields};
  }
  if (force) {
    return {...base, status: 'drifted', reason: 'forced', menuMatches: comparison.ok, ...fields};
  }
  return {...base, status: comparison.ok ? 'ok' : 'drifted', reason: comparison.reason, ...fields};
}

function describe(result) {
  switch (result.reason) {
    case 'ok': return 'menu matches';
    case 'forced': return `forced (menu ${result.menuMatches ? 'matches' : 'differs'})`;
    case 'no-menu': return `no menu: ${result.detail}`;
    case 'fetch-error': return `fetch failed: ${result.detail}`;
    case 'drift': {
      const parts = [];
      if (result.missing.length) parts.push(`missing ${result.missing.join(', ')}`);
      if (result.extra.length) parts.push(`extra ${result.extra.join(', ')}`);
      if (result.missingCategories.length) parts.push(`missing categories ${result.missingCategories.join(', ')}`);
      if (result.extraCategories.length) parts.push(`extra categories ${result.extraCategories.join(', ')}`);
      return parts.join('; ');
    }
    default: return result.detail || result.reason;
  }
}

function output(name, value) {
  const line = `${name}=${typeof value === 'string' ? value : JSON.stringify(value)}`;
  console.log(`output ${line}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalog = readCatalog(args.catalog);
  const sites = selectSites(catalog, args.only);
  console.log(`check-fleet: ${sites.length} site(s) selected from catalog generated ${catalog.generated || 'n/a'}${args.force ? ', force on' : ''}`);
  if (args.dryRun) {
    for (const p of sites) console.log(`  ${p.slug} (${p.deployedBy}, ${p.repo}@${p.branch})`);
    output('sites', sites.map((p) => p.slug));
    return;
  }
  fs.mkdirSync(args.out, {recursive: true});
  const results = await mapLimit(sites, args.concurrency, async (provider) => {
    const comparison = await inspect(catalog, siteUrl(provider.slug));
    const result = toResult(provider, comparison, args.force);
    fs.writeFileSync(path.join(args.out, `${provider.slug}.json`), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`  ${result.status.padEnd(7)} ${provider.slug.padEnd(22)} ${describe(result)}`);
    return result;
  });
  const drifted = results.filter((r) => r.status === 'drifted');
  const errors = results.filter((r) => r.status === 'error');
  const canary = drifted.find((r) => r.deployedBy === 'github') || drifted[0] || null;
  console.log(`check-fleet: ${results.length - drifted.length - errors.length} ok, ${drifted.length} drifted, ${errors.length} error(s)`);
  output('drifted', drifted.map((r) => r.site));
  output('canary', canary ? canary.site : '');
  output('fanout', drifted.filter((r) => r !== canary).map((r) => r.site));
  output('errors', String(errors.length));
}

main().catch((error) => {
  console.error(`check-fleet: ${error.message}`);
  process.exitCode = 2;
});
