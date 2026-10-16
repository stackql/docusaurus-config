#!/usr/bin/env node
// Turn the per-site result files of a run into the job summary table, the
// issue body and the run's verdict. Runs in the finish job.
//
//   node scripts/menu-sync/report.mjs <catalog.json> <results-dir>
//        --mode <check|sync> [--jobs <json>] [--md <file>] [--run-url <url>]
//
// Result files come from check-fleet.mjs (phase "check") and sync-site.sh
// (phases "canary" and "fanout"); a sync result for a site replaces its
// check result. Sites in the catalog with no result at all (the check never
// ran, or the --only filter left them out) are listed as "not checked".
// --jobs is a JSON object of job name -> result (success, failure,
// cancelled, skipped) from the workflow's needs context; a failed or
// cancelled job makes the run red whatever the sites say.
//
// Verdict (output "green"):
//   check mode: green unless a job failed, a site could not be inspected,
//               or nothing was checked at all. Drift is reported, not red.
//   sync mode:  green only when every site that has a result is ok or synced.
// Output "fleet_verified" is true when every site in the catalog is ok or
// synced: the condition for promoting the candidate to last-known-good and
// for closing the menu-sync issue. The workflow additionally requires no
// --only filter and no catalog_url override for the promotion.

import fs from 'node:fs';
import path from 'node:path';
import {catalogProviders, readCatalog} from './compare.mjs';

const PHASE_RANK = {check: 0, canary: 1, fanout: 1};

function parseArgs(argv) {
  const args = {catalog: null, dir: null, mode: null, jobs: {}, md: null, runUrl: ''};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--mode') args.mode = argv[++i];
    else if (a === '--jobs') args.jobs = JSON.parse(argv[++i] || '{}');
    else if (a === '--md') args.md = argv[++i];
    else if (a === '--run-url') args.runUrl = argv[++i] || '';
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (!args.catalog) args.catalog = a;
    else if (!args.dir) args.dir = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!args.catalog || !args.dir || !['check', 'sync'].includes(args.mode)) {
    throw new Error('usage: report.mjs <catalog.json> <results-dir> --mode check|sync [--jobs json] [--md file] [--run-url url]');
  }
  return args;
}

// Latest result per site: a sync phase beats the check phase.
export function loadResults(dir) {
  const bySite = new Map();
  if (!fs.existsSync(dir)) return bySite;
  const files = fs
    .readdirSync(dir, {recursive: true})
    .map(String)
    .filter((f) => f.endsWith('.json') && !/\.(dispatch|verify)\.json$/.test(f));
  for (const file of files) {
    let result;
    try {
      result = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    if (!result || !result.site) continue;
    const current = bySite.get(result.site);
    if (!current || (PHASE_RANK[result.phase] ?? 0) >= (PHASE_RANK[current.phase] ?? 0)) {
      bySite.set(result.site, result);
    }
  }
  return bySite;
}

function detailOf(r) {
  if (r.status === 'ok') return '';
  const parts = [];
  if (r.status === 'failed' || r.status === 'error' || r.reason === 'no-menu') {
    if (r.detail) parts.push(r.detail);
  }
  if (r.reason === 'forced') parts.push(`forced${r.menuMatches ? ' (menu already matched)' : ''}`);
  if (r.missing && r.missing.length) parts.push(`missing ${r.missing.join(', ')}`);
  if (r.extra && r.extra.length) parts.push(`extra ${r.extra.join(', ')}`);
  if (r.missingCategories && r.missingCategories.length) parts.push(`missing categories ${r.missingCategories.join(', ')}`);
  if (r.extraCategories && r.extraCategories.length) parts.push(`extra categories ${r.extraCategories.join(', ')}`);
  if (r.runUrl) parts.push(`[deploy run](${r.runUrl})`);
  return parts.join('; ').replace(/\|/g, '\\|');
}

// How a status reads in the table, given the mode. In sync mode a site that
// is still "drifted" after the run was never redeployed (the canary failed
// or fail-fast stopped the fan-out).
function label(r, mode) {
  switch (r.status) {
    case 'ok': return 'ok';
    case 'synced': return 'synced';
    case 'error': return 'error';
    case 'failed': return 'FAILED';
    case 'drifted':
      if (mode === 'sync') return 'drifted, not synced';
      return r.reason === 'no-menu' ? 'no menu' : 'drifted';
    default: return r.status;
  }
}

export function summarise(catalog, results, {mode, jobs, runUrl}) {
  const sites = catalogProviders(catalog);
  const rows = sites.map((p) => {
    const r = results.get(p.slug);
    return r
      ? {site: p.slug, hosting: p.deployedBy, phase: r.phase, status: r.status, text: label(r, mode), detail: detailOf(r)}
      : {site: p.slug, hosting: p.deployedBy, phase: '', status: 'none', text: 'not checked', detail: ''};
  });
  const count = (status) => rows.filter((r) => r.status === status).length;
  const counts = {
    sites: rows.length,
    ok: count('ok'),
    synced: count('synced'),
    drifted: count('drifted'),
    failed: count('failed'),
    error: count('error'),
    unchecked: count('none'),
  };
  const badJobs = Object.entries(jobs).filter(([, v]) => v === 'failure' || v === 'cancelled');
  const checked = rows.filter((r) => r.status !== 'none');
  const green =
    badJobs.length === 0 &&
    checked.length > 0 &&
    counts.error === 0 &&
    counts.failed === 0 &&
    (mode === 'check' || counts.drifted === 0);
  const fleetVerified = rows.every((r) => r.status === 'ok' || r.status === 'synced');

  const headline = (() => {
    if (badJobs.length) return `Run failed: ${badJobs.map(([k, v]) => `${k} ${v}`).join(', ')}.`;
    if (checked.length === 0) return 'No site was checked.';
    if (mode === 'check') {
      if (counts.error) return `${counts.error} site(s) could not be inspected.`;
      if (counts.drifted) return `${counts.drifted} of ${checked.length} checked site(s) serve a Providers menu out of step with the catalog (check only, nothing redeployed).`;
      return `All ${checked.length} checked site(s) match the catalog.`;
    }
    if (counts.failed) return `${counts.failed} site(s) failed to redeploy or verify; ${counts.drifted} drifted site(s) were not redeployed.`;
    if (counts.error) return `${counts.error} site(s) could not be inspected.`;
    if (counts.drifted) return `${counts.drifted} drifted site(s) were not redeployed.`;
    if (counts.synced) return `${counts.synced} site(s) redeployed and verified; ${counts.ok} already matched.`;
    return `All ${checked.length} checked site(s) already matched the catalog; nothing redeployed.`;
  })();

  const lines = [];
  lines.push(`**${headline}**`, '');
  lines.push(`Mode: ${mode}. Catalog generated ${catalog.generated || 'n/a'}.${runUrl ? ` [Run](${runUrl}).` : ''}`, '');
  if (Object.keys(jobs).length) {
    lines.push(`Jobs: ${Object.entries(jobs).map(([k, v]) => `${k} ${v}`).join(', ')}.`, '');
  }
  lines.push('| Site | Hosting | Phase | Status | Detail |', '| --- | --- | --- | --- | --- |');
  for (const r of rows) lines.push(`| ${r.site} | ${r.hosting} | ${r.phase} | ${r.text} | ${r.detail} |`);
  lines.push('');
  return {green, fleetVerified, counts, headline, markdown: lines.join('\n')};
}

function output(name, value) {
  const line = `${name}=${typeof value === 'string' ? value : JSON.stringify(value)}`;
  console.log(`output ${line}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalog = readCatalog(args.catalog);
  const results = loadResults(args.dir);
  const summary = summarise(catalog, results, args);
  if (args.md) fs.writeFileSync(args.md, `${summary.markdown}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## menu-sync\n\n${summary.markdown}\n`);
  }
  console.log(summary.markdown);
  output('green', String(summary.green));
  output('fleet_verified', String(summary.fleetVerified));
  output('headline', summary.headline);
  output('counts', summary.counts);
}

try {
  main();
} catch (error) {
  console.error(`report: ${error.message}`);
  process.exitCode = 2;
}
