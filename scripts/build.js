// Shared token build script.
//
// One copy lives at the repo root and is invoked by every package. It reads
// that package's `tokens/$metadata.json`, applies the Token Studio
// transformations, and writes one JSON file per token set into the package's
// own `dist/`:
//
//   dist/foundation/<name>.json   ← primitives/*
//   dist/themes/<name>.json       ← semantics/*   (colour modes scoped to color.light / color.dark)
//   dist/components/<name>.json   ← components/*
//
// Usage, from a package directory:  node ../../scripts/build.js
// Set CI=true to make unresolved references fail the build instead of warning.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import StyleDictionary from 'style-dictionary';
import { transformColorModifiers } from '@tokens-studio/sd-transforms';

import { transformTokenSet, normalizeOnly, DEFAULT_MODES } from './transform-tokens.js';

// This script is shared by every package in the monorepo. Paths resolve from
// the package that invokes it (its own cwd), never from the script's location,
// so a single copy serves all packages.
const ROOT = process.env.TOKENS_PACKAGE_ROOT
  ? path.resolve(process.env.TOKENS_PACKAGE_ROOT)
  : process.cwd();
const PKG_NAME = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name; }
  catch { return path.basename(ROOT); }
})();
const TOKENS_DIR = path.join(ROOT, 'tokens');
const STAGING_DIR = path.join(ROOT, '.tokens-build');
const DIST_DIR = path.join(ROOT, 'dist');
const IS_CI = String(process.env.CI).toLowerCase() === 'true';
const BROKEN_REFS_MODE = IS_CI ? 'throw' : 'console';

const readJSON = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const writeJSON = (filePath, data) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};

const rmrf = (target) => {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
};

/**
 * Split a token set id into its parts.
 *
 * A set id is `<kind>/<scope…>/<name>`, where `scope` is the optional
 * platform/brand path introduced by the restructure:
 *
 *   primitives/dimensions              → kind=primitives  scope=''               name=dimensions
 *   primitives/shared/dimensions       → kind=primitives  scope='shared'         name=dimensions
 *   semantics/web/british-gas/light    → kind=semantics   scope='web/british-gas' name=light
 *   components/web/british-gas/button  → kind=components  scope='web/british-gas' name=button
 *
 * Everything downstream keys off `kind` and `name` so that the flat and
 * nested layouts behave identically.
 */
const MODE_SET_NAMES = new Set([
  'light', 'dark', 'colour-light', 'colour-dark',
  'gradient-light', 'gradient-dark', 'effects-light', 'effects-dark',
]);
const isModeSet = (name) => MODE_SET_NAMES.has(name);

const parseSetId = (setId) => {
  const parts = setId.split('/');
  return {
    kind: parts[0],
    scope: parts.slice(1, -1).join('/'),
    name: parts[parts.length - 1],
  };
};

/**
 * Scopes published at the root of `dist/`. These keep the output paths the
 * package exposed before the restructure, so existing consumers are
 * unaffected. Any other scope publishes under `dist/<scope>/` instead —
 * that is what keeps `app` and `web` component tokens from overwriting each
 * other. Empty the set to move every scope into its own subtree.
 */
const ROOT_SCOPES = new Set(['', 'shared', 'british-gas', 'web/british-gas']);

/**
 * Mapping from `<kind>/<name>` to output destination, independent of scope.
 * Both spellings are listed so the flat layout still builds.
 */
const OUTPUT_BASENAMES = {
  'primitives/bg-colours': 'foundation/color.json',
  'primitives/colours': 'foundation/color.json',
  'primitives/typography': 'foundation/typography.json',
  'primitives/dimensions': 'foundation/dimensions.json',
  'primitives/opacity': 'foundation/opacity.json',
  'semantics/colour-light': 'themes/color-light.json',
  'semantics/light': 'themes/color-light.json',
  'semantics/colour-dark': 'themes/color-dark.json',
  'semantics/dark': 'themes/color-dark.json',
  'semantics/gradient-light': 'themes/gradient-light.json',
  'semantics/gradient-dark': 'themes/gradient-dark.json',
  'semantics/effects-light': 'themes/effects-light.json',
  'semantics/effects-dark': 'themes/effects-dark.json',
  'semantics/dimensions': 'themes/dimensions.json',
  'semantics/planets': 'themes/planets.json',
  'semantics/typography': 'themes/typography.json',
};

/**
 * Convert camelCase to kebab-case (same logic as transform-tokens).
 */
const toKebabCase = (str) =>
  str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

const COLOR_REF_IN_RGBA_PATTERN = /rgba\(\s*\{\s*([^}]+?)\s*\}\s*,/gi;
const HEX_IN_RGBA_PATTERN = /rgba\(\s*(#[\da-fA-F]{3}|#[\da-fA-F]{6})\s*,/gi;
const PRIMITIVE_COLOR_REF_PATTERN = /^color\.(primary|secondary|system)\./;

/**
 * Normalize 3/6-digit hex to lowercase 6-digit hex for stable lookup.
 */
const normalizeHex = (value) => {
  if (typeof value !== 'string') return null;
  const hex = value.trim();
  const shortMatch = /^#([\da-fA-F]{3})$/.exec(hex);
  const longMatch = /^#([\da-fA-F]{6})$/.exec(hex);

  if (!shortMatch && !longMatch) return null;

  if (longMatch) return `#${longMatch[1].toLowerCase()}`;

  const expanded = shortMatch[1]
    .split('')
    .map((char) => `${char}${char}`)
    .join('')
    .toLowerCase();

  return `#${expanded}`;
};

/**
 * Convert a token reference path to normalized form used by transformed tokens.
 * Example: `colour.primary.dark.navy.1` -> `color.primary.dark.navy.1`
 */
const normalizeRefPath = (refPath) => refPath
  .split('.')
  .map((segment, index) => toKebabCase(index === 0 && segment === 'colour' ? 'color' : segment))
  .join('.');

/**
 * Convert hex color to an RGB tuple string used for rgba composition.
 */
const hexToRgb = (value) => {
  if (typeof value !== 'string') return null;
  const hex = value.trim();
  const shortMatch = /^#([\da-fA-F]{3})$/.exec(hex);
  const longMatch = /^#([\da-fA-F]{6})$/.exec(hex);

  if (!shortMatch && !longMatch) return null;

  const normalized = shortMatch
    ? shortMatch[1].split('').map((ch) => `${ch}${ch}`).join('')
    : longMatch[1];

  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
};

/**
 * Collect primitive color refs used as rgba() inputs.
 */
const collectPrimitiveRefsFromRgbaGradients = (node, refs = new Set()) => {
  if (typeof node === 'string') {
    if (node.includes('rgba(')) {
      let match;
      while ((match = COLOR_REF_IN_RGBA_PATTERN.exec(node)) !== null) {
        const normalizedRef = normalizeRefPath(match[1].trim());
        if (PRIMITIVE_COLOR_REF_PATTERN.test(normalizedRef)) {
          refs.add(normalizedRef);
        }
      }

      COLOR_REF_IN_RGBA_PATTERN.lastIndex = 0;
      HEX_IN_RGBA_PATTERN.lastIndex = 0;
    }
    return refs;
  }

  if (Array.isArray(node)) {
    for (const value of node) collectPrimitiveRefsFromRgbaGradients(value, refs);
    return refs;
  }

  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) {
      collectPrimitiveRefsFromRgbaGradients(value, refs);
    }
  }

  return refs;
};

/**
 * Create sibling `-rgb` tokens for primitive color tokens targeted by reference paths.
 * Transforms `color.primary.dark.navy.1` into a new sibling `color.primary.dark.navy.1-rgb`.
 */
const annotatePrimitiveRgbAttributes = (primitivesTree, refPaths) => {
  for (const refPath of refPaths) {
    const parts = refPath.split('.');
    let token = primitivesTree;
    let parent = null;
    let lastKey = null;

    // Navigate to the leaf token, keeping track of parent and key
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!token || typeof token !== 'object') {
        token = null;
        break;
      }
      parent = token;
      lastKey = part;
      token = token[part];
    }

    if (!token || typeof token !== 'object' || typeof token.value !== 'string') continue;

    const rgb = hexToRgb(token.value);
    if (!rgb) continue;

    // Create new sibling token with -rgb suffix
    if (parent && lastKey) {
      parent[`${lastKey}-rgb`] = {
        value: rgb,
        type: 'color'
      };
    }
  }
};

/**
 * Rewrite `rgba({color.foo}, alpha)` to `rgba({color.foo-rgb}, alpha)` for primitive colors.
 */
const rewriteRgbaRefsToRgbAttributes = (value) => {
  if (typeof value !== 'string' || !value.includes('rgba(')) return value;

  const normalizeWholeNumberRgbaAlpha = (input) => input.replace(
    /rgba\(([^)]*?),\s*(-?\d+\.0+)\s*\)/g,
    (match, prefix, alpha) => {
      const whole = Number(alpha);
      if (!Number.isFinite(whole)) return match;
      return `rgba(${prefix}, ${whole})`;
    }
  );

  // Find and replace color refs inside rgba() blocks with -rgb version
  const rewritten = value.replace(/rgba\([^)]*\)/g, (rgbaMatch) => {
    const withRefRewrites = rgbaMatch.replace(/\{\s*([^}]+?)\s*\}/g, (refMatch, refPath) => {
      const normalizedRef = normalizeRefPath(refPath.trim());
      if (!PRIMITIVE_COLOR_REF_PATTERN.test(normalizedRef)) return refMatch;
      if (normalizedRef.endsWith('-rgb')) return refMatch;
      return `{${normalizedRef}-rgb}`;
    });

    return withRefRewrites.replace(
      /rgba\(\s*(#[\da-fA-F]{3}|#[\da-fA-F]{6})\s*,/i,
      (match, hex) => {
        const rgb = hexToRgb(hex);
        return rgb ? `rgba(${rgb},` : match;
      }
    );
  });

  return normalizeWholeNumberRgbaAlpha(rewritten);
};

/**
 * Preserve unresolved token references in nested composite values when
 * `outputReferences` is enabled.
 */
const preserveReferenceValues = (originalValue, resolvedValue) => {
  if (typeof originalValue === 'string') {
    return (originalValue.includes('{') || originalValue.includes('rgba('))
      ? rewriteRgbaRefsToRgbAttributes(originalValue)
      : resolvedValue;
  }

  if (Array.isArray(originalValue)) {
    if (!Array.isArray(resolvedValue)) return resolvedValue;
    return originalValue.map((item, index) =>
      preserveReferenceValues(item, resolvedValue[index])
    );
  }

  if (originalValue && typeof originalValue === 'object') {
    if (!resolvedValue || typeof resolvedValue !== 'object') return resolvedValue;
    const output = {};
    for (const [key, value] of Object.entries(originalValue)) {
      output[key] = preserveReferenceValues(value, resolvedValue[key]);
    }
    for (const [key, value] of Object.entries(resolvedValue)) {
      if (!Object.prototype.hasOwnProperty.call(output, key)) output[key] = value;
    }
    return output;
  }

  return resolvedValue;
};

/**
 * For component sets (e.g. `components/button`), derive output path.
 */
const getOutputPath = (setId) => {
  const { kind, scope, name } = parseSetId(setId);
  const prefix = ROOT_SCOPES.has(scope) ? '' : `${scope}/`;

  const mapped = OUTPUT_BASENAMES[`${kind}/${name}`];
  if (mapped) return `${prefix}${mapped}`;

  if (kind === 'components') {
    const kebab = toKebabCase(name);
    if (kebab) return `${prefix}components/${kebab}.json`;
  }
  return null;
};

/**
 * Load all token sets listed in `$metadata.json`, transform them, and write
 * the transformed copies to the staging directory. Returns a map of
 * `setId → stagedFilePath`.
 *
 * For semantic colour files we also write an "unscoped" version (without the
 * light/dark nesting) so component tokens can resolve their references
 * against the original paths.
 */
const stageTokenSets = () => {
  rmrf(STAGING_DIR);
  fs.mkdirSync(STAGING_DIR, { recursive: true });

  const metadata = readJSON(path.join(TOKENS_DIR, '$metadata.json'));

  // Which colour modes does THIS package actually ship? A package with only a
  // dark semantic set must not emit light component branches — they could never
  // resolve. Derived per package, so one shared script serves all of them.
  const modes = DEFAULT_MODES.filter((mode) => metadata.tokenSetOrder.some((setId) => {
    const { kind, name } = parseSetId(setId);
    return kind === 'semantics' && (name === mode || name === `colour-${mode}`);
  }));
  console.log(`• Colour modes: ${modes.length ? modes.join(', ') : '(none)'}`);
  const setPaths = {};
  const unscopedPaths = {};
  const sourceBySetId = {};

  for (const setId of metadata.tokenSetOrder) {
    const srcPath = path.join(TOKENS_DIR, `${setId}.json`);
    if (!fs.existsSync(srcPath)) continue;
    sourceBySetId[setId] = readJSON(srcPath);
  }

  const primitiveRefsInRgbaGradients = new Set();
  for (const source of Object.values(sourceBySetId)) {
    collectPrimitiveRefsFromRgbaGradients(source, primitiveRefsInRgbaGradients);
  }

  for (const setId of metadata.tokenSetOrder) {
    const src = sourceBySetId[setId];
    if (!src) {
      console.warn(`[warn] token set not found on disk: ${setId}`);
      continue;
    }
    const transformed = transformTokenSet(setId, src, modes);

    const { kind: setKind, name: setName } = parseSetId(setId);
    if (setKind === 'primitives' && (setName === 'bg-colours' || setName === 'colours')) {
      annotatePrimitiveRgbAttributes(transformed, primitiveRefsInRgbaGradients);
    }

    const outPath = path.join(STAGING_DIR, `${setId}.json`);
    writeJSON(outPath, transformed);
    setPaths[setId] = outPath;

    // For semantic light/dark sets, also write an unscoped version for ref resolution.
    if (
      setKind === 'semantics'
      && ['colour-light', 'colour-dark', 'light', 'dark', 'gradient-light', 'gradient-dark', 'effects-light', 'effects-dark'].includes(setName)
    ) {
      const unscoped = normalizeOnly(src);
      const unscopedPath = path.join(STAGING_DIR, `${setId}.unscoped.json`);
      writeJSON(unscopedPath, unscoped);
      unscopedPaths[setId] = unscopedPath;
    }
  }

  return { setPaths, unscopedPaths };
};

/**
 * Determine which token sets should be loaded as `include` (for reference
 * resolution) when building a specific token set.
 */
const resolveIncludes = (setId, allSetIds, setPaths, unscopedPaths) => {
  const target = parseSetId(setId);
  const includes = [];
  for (const id of allSetIds) {
    if (id === setId) continue;
    const candidate = parseSetId(id);
    // Primitives are always needed for reference resolution.
    if (candidate.kind === 'primitives') {
      includes.push(setPaths[id]);
      continue;
    }
    // Semantic sets need other semantics for cross-references (e.g. dimensions
    // referencing primitives is handled above). Colour-light references
    // primitives only.
    // Semantic sets do not see their siblings — light and dark define the same
    // paths and would collide. They do see semantics from a parent scope,
    // e.g. `semantics/app/british-gas/dark` referencing `semantics/app/modifiers`.
    // Semantic sets only need keeping apart when both are colour-mode variants
    // (light vs dark) — those define the same paths. Non-mode semantics such as
    // `modifiers` are shared context and must stay visible.
    if (target.kind === 'semantics' && candidate.kind === 'semantics') {
      const bothModes = isModeSet(target.name) && isModeSet(candidate.name);
      const scopeOk = candidate.scope === target.scope
        || candidate.scope === ''
        || target.scope.startsWith(`${candidate.scope}/`);
      if (bothModes || !scopeOk) continue;
      includes.push(setPaths[id]);
      continue;
    }
    // Component tokens reference scoped semantic colour paths (e.g.
    // `color.light.background.*` and `color.dark.background.*`) because
    // `splitColorModes` rewrites refs with the mode prefix during transform.
    // Include the transformed (scoped) semantic files so those paths resolve —
    // but only those in the component's own scope, or a parent of it. `app`
    // and `web` semantics define the same token paths, so including both
    // would make one silently overwrite the other.
    if (target.kind === 'components' && candidate.kind === 'semantics') {
      const sameScope = candidate.scope === target.scope;
      const parentScope = candidate.scope === '' || target.scope.startsWith(`${candidate.scope}/`);
      if (sameScope || parentScope) {
        includes.push(setPaths[id]);
      }
    }
  }
  return includes.filter(Boolean);
};

/**
 * Build a Style Dictionary config for a single token set file.
 */
const configForSet = (setId, setPaths, allSetIds, unscopedPaths) => {
  const include = resolveIncludes(setId, allSetIds, setPaths, unscopedPaths);
  const source = [setPaths[setId]].filter(Boolean);
  const outputPath = getOutputPath(setId);
  const dir = path.dirname(outputPath);
  const file = path.basename(outputPath);

  // Semantic and component tokens keep references; primitives resolve to values.
  const keepRefs = setId.startsWith('semantics/') || setId.startsWith('components/');

  return {
    log: {
      warnings: 'warn',
      verbosity: 'verbose',
      errors: { brokenReferences: BROKEN_REFS_MODE }
    },
    preprocessors: ['tokens-studio'],
    usesDtcg: false,
    include,
    source,
    platforms: {
      json: {
        transforms: [...StyleDictionary.hooks.transformGroups.js, 'ts/color/modifiers'],
        buildPath: `dist/${dir}/`,
        files: [
          {
            destination: file,
            format: 'json/clean-nested',
            options: { outputReferences: keepRefs }
          }
        ]
      }
    }
  };
};

/**
 * Register the `tokens-studio` preprocessor as a no-op.
 */
const registerColorModifiers = () => {
  StyleDictionary.registerTransform({
    name: 'ts/color/modifiers',
    type: 'value',
    transitive: true,
    filter: (token) => typeof (token.$value ?? token.value) === 'string'
      && (token.$type ?? token.type) === 'color'
      && token.$extensions?.['studio.tokens']?.modify,
    transform: (token) => transformColorModifiers(token, { format: 'hex' }),
  });
};

const ensurePreprocessor = () => {
  StyleDictionary.registerPreprocessor({
    name: 'tokens-studio',
    preprocessor: (dictionary) => dictionary
  });
};

/**
 * Register a custom JSON format that outputs a clean nested token structure
 * with `value`, `type`, and optional `description`/`rgb`.
 * When `options.outputReferences` is true, outputs the original reference
 * string instead of the resolved value.
 */
const registerCleanNestedFormat = () => {
  StyleDictionary.registerFormat({
    name: 'json/clean-nested',
    format: ({ dictionary, options }) => {
      const keepRefs = options?.outputReferences === true;
      const buildNested = (tokens) => {
        const result = {};
        for (const token of tokens) {
          if (!token.isSource) continue;
          const parts = token.path;
          let current = result;
          for (let i = 0; i < parts.length - 1; i++) {
            if (!current[parts[i]]) current[parts[i]] = {};
            current = current[parts[i]];
          }
          const leaf = {};
          // Use original value (reference) if keepRefs and it's a reference.
          const origValue = token.original?.value ?? token.original?.$value;
          // A token carrying a Tokens Studio `modify` extension (alpha, lighten,
          // darken…) resolves to a computed colour that cannot be expressed as a
          // plain reference, so the transformed value has to win over the
          // original reference — otherwise the modifier is silently dropped.
          const hasColorModifier = Boolean(token.$extensions?.['studio.tokens']?.modify);
          leaf.value = keepRefs && !hasColorModifier
            ? preserveReferenceValues(origValue, token.value)
            : token.value;
          if (token.type) leaf.type = token.type;
          if (token.description) leaf.description = token.description;
          const origRgb = token.original?.rgb;
          if (typeof origRgb === 'string' && origRgb.length > 0) leaf.rgb = origRgb;
          current[parts[parts.length - 1]] = leaf;
        }
        return result;
      };
      return JSON.stringify(buildNested(dictionary.allTokens), null, 2) + '\n';
    }
  });
};

const build = async () => {
  console.log(`• Package: ${PKG_NAME}`);
  console.log('• Staging transformed tokens →', path.relative(ROOT, STAGING_DIR));
  console.log(`• Broken reference handling: ${BROKEN_REFS_MODE}${IS_CI ? ' (CI)' : ' (local)'}`);
  const { setPaths, unscopedPaths } = stageTokenSets();
  const allSetIds = Object.keys(setPaths);

  rmrf(DIST_DIR);
  ensurePreprocessor();
  registerCleanNestedFormat();
  registerColorModifiers();

  // Build each token set that has an output mapping.
  for (const setId of allSetIds) {
    const outputPath = getOutputPath(setId);
    if (!outputPath) continue;

    console.log(`• Building: ${setId} → dist/${outputPath}`);
    const sd = new StyleDictionary(configForSet(setId, setPaths, allSetIds, unscopedPaths));
    await sd.hasInitialized;
    await sd.buildAllPlatforms();
  }

  console.log(`✓ Done. Output written to ${path.relative(ROOT, DIST_DIR)}/`);
};

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
