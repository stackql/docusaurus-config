#!/usr/bin/env node
// Compare the Providers menu a site actually serves with the provider
// catalog it should have been built from.
//
//   node scripts/menu-sync/compare.mjs <catalog.json> <html file or https URL>
//
// Prints one JSON object and exits 0 when the menu matches, 1 when it has
// drifted, 2 when the page could not be fetched or parsed. The same function
// is the drift check before a redeploy and the verification after one
// (wait-for-menu.mjs), and check-fleet.mjs runs it over every site.
//
// The menu is server-rendered, so a plain fetch of the homepage is enough.
// Only the first <nav class="navbar ..."> block is inspected: page content
// can link to other provider sites (gemeni's homepage does) and those must
// not count as menu rows. Provider rows are the https://<slug>-provider.
// stackql.io hrefs in that block, category rows the
// https://stackql.io/providers#<id> anchors; both are compared as sets, so
// order is not checked. Zero provider rows is reported as "no-menu" (a site
// not on the shared chrome, or one built from an empty catalog) and counts
// as drift for the redeploy decision.
//
// Node 22 built-ins only: this repo has no package.json by design (README).

import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

export const FETCH_TIMEOUT_MS = 20_000;

const NAV_OPEN = /<nav\b[^>]*\bclass=["']?[^"'>]*\bnavbar\b[^>]*>/i;
const PROVIDER_HREF = /https:\/\/([a-z0-9-]+)-provider\.stackql\.io(?=[/"'\s>])/g;
const CATEGORY_HREF = /https:\/\/stackql\.io\/providers#([A-Za-z0-9_-]+)/g;

// Flat provider list in catalog order (categories, then the providers of
// each). Everything downstream (the site matrix, the canary choice, the
// report) uses this order.
export function catalogProviders(catalog) {
  return catalog.categories.flatMap((category) =>
    category.providers.map((provider) => ({...provider, category: category.id})),
  );
}

export function readCatalog(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

// The first navbar block of a page, or null when there is none.
export function navbarBlock(html) {
  const open = html.match(NAV_OPEN);
  if (!open) return null;
  const start = open.index;
  const end = html.indexOf('</nav>', start + open[0].length);
  return end === -1 ? html.slice(start) : html.slice(start, end + '</nav>'.length);
}

function matches(regex, text) {
  return new Set([...text.matchAll(regex)].map((m) => m[1]));
}

const sortedDiff = (a, b) => [...a].filter((x) => !b.has(x)).sort();

// Pure comparison of a page's HTML against a catalog.
export function compareHtml(catalog, html, site) {
  const expected = new Set(catalogProviders(catalog).map((p) => p.slug));
  const expectedCategories = new Set(catalog.categories.map((c) => c.id));
  const base = {
    ok: false,
    reason: 'drift',
    site,
    missing: [],
    extra: [],
    missingCategories: [],
    extraCategories: [],
    found: 0,
    generated: catalog.generated || null,
  };
  const nav = navbarBlock(html);
  if (!nav) {
    return {...base, reason: 'no-menu', detail: 'no <nav class="navbar"> block in the page', missing: [...expected].sort(), missingCategories: [...expectedCategories].sort()};
  }
  const found = matches(PROVIDER_HREF, nav);
  const foundCategories = matches(CATEGORY_HREF, nav);
  const result = {
    ...base,
    missing: sortedDiff(expected, found),
    extra: sortedDiff(found, expected),
    missingCategories: sortedDiff(expectedCategories, foundCategories),
    extraCategories: sortedDiff(foundCategories, expectedCategories),
    found: found.size,
  };
  if (found.size === 0) {
    return {...result, reason: 'no-menu', detail: 'navbar has no provider rows'};
  }
  const drifted =
    result.missing.length || result.extra.length || result.missingCategories.length || result.extraCategories.length;
  return drifted ? result : {...result, ok: true, reason: 'ok'};
}

// Homepage URL of a provider microsite, cache-busted. Both CDNs honour a
// fresh query string; the no-cache header covers the ones that key on it.
export function siteUrl(slug) {
  return `https://${slug}-provider.stackql.io/?cb=${Date.now()}`;
}

export async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {accept: 'text/html', 'cache-control': 'no-cache', pragma: 'no-cache'},
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.text();
}

// Slug of a microsite URL, or null when the host is not <slug>-provider.stackql.io.
export function slugOfUrl(url) {
  try {
    const m = new URL(url).hostname.match(/^([a-z0-9-]+)-provider\.stackql\.io$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Fetch (or read) a target and compare it. Never throws: fetch and parse
// failures come back as {ok: false, reason: 'fetch-error' | 'parse-error'}.
export async function inspect(catalog, target) {
  const isUrl = /^https?:\/\//i.test(target);
  const site = isUrl ? slugOfUrl(target) || target : target;
  let html;
  try {
    html = isUrl ? await fetchHtml(target) : fs.readFileSync(target, 'utf8');
  } catch (error) {
    return {
      ok: false,
      reason: 'fetch-error',
      site,
      detail: error.message,
      status: error.status,
      missing: [],
      extra: [],
      missingCategories: [],
      extraCategories: [],
      found: 0,
      generated: catalog.generated || null,
    };
  }
  return compareHtml(catalog, html, site);
}

export function exitCode(result) {
  if (result.ok) return 0;
  return result.reason === 'fetch-error' || result.reason === 'parse-error' ? 2 : 1;
}

async function main(argv) {
  const [catalogPath, target] = argv;
  if (!catalogPath || !target) {
    console.error('usage: compare.mjs <catalog.json> <html file or https URL>');
    process.exitCode = 2;
    return;
  }
  let catalog;
  try {
    catalog = readCatalog(catalogPath);
  } catch (error) {
    console.log(JSON.stringify({ok: false, reason: 'parse-error', site: target, detail: `catalog: ${error.message}`}));
    process.exitCode = 2;
    return;
  }
  const result = await inspect(catalog, target);
  console.log(JSON.stringify(result));
  // exitCode rather than exit(): lets the fetch's sockets close cleanly,
  // which process.exit() straight after a fetch does not do on every platform.
  process.exitCode = exitCode(result);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main(process.argv.slice(2));
}
