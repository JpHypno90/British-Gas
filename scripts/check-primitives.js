// Guards against primitive drift between packages.
//
// Each package carries its own copy of the primitive layer so that its Token
// Studio sync is self-contained. That is a deliberate trade: the cost is that
// copies can silently diverge. This check makes divergence loud — it is the
// safety net a multi-repo split could not have.
//
// Run:  npm run check:primitives              reports drift, exits 0
//       npm run check:primitives -- --strict   fails the build on drift
//
// Deliberately NOT gated on CI=true: GitHub Actions sets that automatically,
// which would make the check blocking before the team has agreed it should be.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PACKAGES_DIR = path.join(ROOT, 'packages');
const STRICT = process.argv.includes('--strict');

// Primitive sets expected to be identical everywhere they appear.
// Brand-specific palettes belong to their brand and are compared only across
// packages of that same brand.
const BRAND_OF = (pkg) => pkg.split('-')[0];
const SHARED = ['dimensions', 'opacity'];
const BRAND = ['colours', 'typography'];

const readTokens = (file) => {
  if (!fs.existsSync(file)) return null;
  const flat = {};
  const walk = (node, trail = []) => {
    if (!node || typeof node !== 'object') return;
    if ('$value' in node || 'value' in node) {
      flat[trail.join('.')] = JSON.stringify(node.$value ?? node.value);
      return;
    }
    for (const [key, value] of Object.entries(node)) walk(value, [...trail, key]);
  };
  walk(JSON.parse(fs.readFileSync(file, 'utf8')));
  return flat;
};

const packages = fs.readdirSync(PACKAGES_DIR).filter((name) =>
  fs.existsSync(path.join(PACKAGES_DIR, name, 'tokens')));

const compare = (name, pkgs) => {
  const found = pkgs
    .map((pkg) => ({ pkg, tokens: readTokens(path.join(PACKAGES_DIR, pkg, 'tokens/primitives', `${name}.json`)) }))
    .filter((entry) => entry.tokens);
  if (found.length < 2) return [];

  const [base, ...rest] = found;
  const problems = [];
  for (const other of rest) {
    const keys = new Set([...Object.keys(base.tokens), ...Object.keys(other.tokens)]);
    for (const key of keys) {
      const a = base.tokens[key];
      const b = other.tokens[key];
      if (a === b) continue;
      const detail = a === undefined ? `only in ${other.pkg}`
        : b === undefined ? `only in ${base.pkg}`
        : `${base.pkg}=${a} vs ${other.pkg}=${b}`;
      problems.push(`primitives/${name}  ${key}  →  ${detail}`);
    }
  }
  return problems;
};

const problems = [];
for (const name of SHARED) problems.push(...compare(name, packages));
for (const name of BRAND) {
  const byBrand = {};
  for (const pkg of packages) (byBrand[BRAND_OF(pkg)] ??= []).push(pkg);
  for (const pkgs of Object.values(byBrand)) problems.push(...compare(name, pkgs));
}

console.log(`• Comparing primitives across ${packages.length} packages: ${packages.join(', ')}`);
if (!problems.length) {
  console.log('✓ No drift — every shared primitive matches across packages.');
  process.exit(0);
}
console.log(`\n✗ ${problems.length} primitive difference(s):\n`);
for (const line of problems.slice(0, 40)) console.log('   ' + line);
if (problems.length > 40) console.log(`   … and ${problems.length - 40} more`);
console.log(STRICT ? '\nFailing build (--strict).' : '\nReport only. Pass --strict to fail the build.');
process.exit(STRICT ? 1 : 0);
