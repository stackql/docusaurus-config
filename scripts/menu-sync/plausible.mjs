#!/usr/bin/env node
// Plausibility guard for a candidate provider catalog, run before anything
// is built or dispatched.
//
//   node scripts/menu-sync/plausible.mjs <candidate.json> <last-known-good.json> [--force]
//
// Fails (exit 1, message on stderr) unless:
//   - the candidate is a version 1 catalog whose every provider carries what
//     redeploy.sh needs (slug, href, deployedBy github|netlify, repo as
//     owner/name, branch);
//   - every slug in last-known-good is still present (the superset rule:
//     a catalog that lost a provider is more likely a bad publish than a
//     deliberate removal);
//   - the category count has not dropped.
// --force skips the superset rule and nothing else, for the day a provider
// really is retired. last-known-good.json is the catalog the fleet was last
// verified against (catalog/ in this repo, updated by the workflow after a
// fully green run), so the comparison is always against a state that was
// known to render correctly.

import fs from 'node:fs';
import {catalogProviders, readCatalog} from './compare.mjs';

const text1 = (value) => typeof value === 'string' && value.length > 0;

// Shape checks beyond what the shared plugin enforces at build time: the
// plugin only needs name and href to render, the sync also needs the
// deployment coordinates.
export function validateCatalog(catalog, label = 'candidate') {
  const problems = [];
  if (!catalog || typeof catalog !== 'object') return [`${label} is not an object`];
  if (catalog.version !== 1) problems.push(`${label} is not a version 1 catalog (version=${JSON.stringify(catalog.version)})`);
  if (!Array.isArray(catalog.categories)) return [...problems, `${label} has no categories array`];
  const slugs = new Set();
  catalog.categories.forEach((category, ci) => {
    const where = `${label} category #${ci}`;
    if (!text1(category.id)) problems.push(`${where} has no id`);
    if (!text1(category.name)) problems.push(`${where} has no name`);
    if (!text1(category.url)) problems.push(`${where} has no url`);
    if (!Array.isArray(category.providers)) {
      problems.push(`${where} has no providers array`);
      return;
    }
    category.providers.forEach((provider, pi) => {
      const which = `${where} provider #${pi} (${provider && provider.slug ? provider.slug : 'no slug'})`;
      if (!text1(provider.name)) problems.push(`${which} has no name`);
      if (!text1(provider.slug)) problems.push(`${which} has no slug`);
      else if (slugs.has(provider.slug)) problems.push(`${which} duplicates slug ${provider.slug}`);
      else slugs.add(provider.slug);
      if (!text1(provider.href)) problems.push(`${which} has no href`);
      if (provider.deployedBy !== 'github' && provider.deployedBy !== 'netlify') {
        problems.push(`${which} has deployedBy=${JSON.stringify(provider.deployedBy)}, expected github or netlify`);
      }
      if (!text1(provider.repo) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(provider.repo)) {
        problems.push(`${which} has no owner/name repo`);
      }
      if (!text1(provider.branch)) problems.push(`${which} has no branch`);
    });
  });
  if (slugs.size === 0) problems.push(`${label} lists no providers`);
  return problems;
}

export function plausible(candidate, lastKnownGood, {force = false} = {}) {
  const problems = validateCatalog(candidate, 'candidate');
  if (problems.length) return {ok: false, problems};
  const have = new Set(catalogProviders(candidate).map((p) => p.slug));
  if (!lastKnownGood) {
    return force
      ? {ok: true, problems: [], providers: have.size, categories: candidate.categories.length, note: 'no last-known-good catalog; superset rule skipped by --force'}
      : {ok: false, problems: ['no last-known-good catalog to compare against (catalog/last-known-good.json); pass --force to accept the candidate as the new baseline']};
  }
  const had = catalogProviders(lastKnownGood).map((p) => p.slug);
  const lost = had.filter((slug) => !have.has(slug));
  const added = [...have].filter((slug) => !had.includes(slug));
  if (lost.length && !force) {
    problems.push(
      `candidate dropped ${lost.length} provider(s) present in last-known-good: ${lost.join(', ')}. ` +
        'A catalog that lost providers is not rolled out; if the removal is deliberate, run with force=true.',
    );
  }
  const before = lastKnownGood.categories.length;
  const after = candidate.categories.length;
  if (after < before) {
    problems.push(`candidate has ${after} categories, last-known-good had ${before}; a catalog that lost categories is not rolled out.`);
  }
  return {ok: problems.length === 0, problems, added, lost, providers: have.size, categories: after};
}

function main(argv) {
  const force = argv.includes('--force');
  const [candidatePath, lkgPath] = argv.filter((a) => !a.startsWith('--'));
  if (!candidatePath || !lkgPath) {
    console.error('usage: plausible.mjs <candidate.json> <last-known-good.json> [--force]');
    process.exit(1);
  }
  let candidate;
  try {
    candidate = readCatalog(candidatePath);
  } catch (error) {
    console.error(`plausible: candidate ${candidatePath} is not JSON: ${error.message}`);
    process.exit(1);
  }
  let lastKnownGood = null;
  if (fs.existsSync(lkgPath)) {
    try {
      lastKnownGood = readCatalog(lkgPath);
    } catch (error) {
      console.error(`plausible: last-known-good ${lkgPath} is not JSON: ${error.message}`);
      process.exit(1);
    }
  }
  const result = plausible(candidate, lastKnownGood, {force});
  if (!result.ok) {
    console.error('plausible: the candidate catalog is not plausible:');
    for (const problem of result.problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  const added = result.added && result.added.length ? ` added: ${result.added.join(', ')}.` : '';
  const lost = result.lost && result.lost.length ? ` removed (force): ${result.lost.join(', ')}.` : '';
  console.log(
    `plausible: candidate ok (version 1, ${result.categories} categories, ${result.providers} providers, generated ${candidate.generated || 'n/a'}).${added}${lost}${result.note ? ` ${result.note}` : ''}`,
  );
}

main(process.argv.slice(2));
