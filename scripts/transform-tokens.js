// Token transformation utilities.
//
// Responsibilities:
//   1. Normalize Token Studio's legacy `{ type, value }` shape to the DTCG
//      `{ $type, $value }` shape that Style Dictionary v4 expects natively.
//   2. Rename every occurrence of the word `colour` to `color` — this covers
//      both object keys and reference strings (e.g. `{colour.text.primary}`).
//   3. For component token files, pivot the structure so the component name
//      becomes the root and `color` is nested under it. For example:
//         colour.button.primary.background.default
//      becomes:
//         button.color.primary.background.default
//
// The transformations are purely functional and operate on already-parsed JSON.

import path from 'node:path';

const COLOUR_KEY = 'colour';
const COLOR_KEY = 'color';
const COLOUR_REF = /\{colour\./g;
const NEGATIVE_NUMERIC_KEY = /^-(\d+)$/;
const TOKEN_REF = /\{\s*([^}]+?)\s*\}/g;

/**
 * Convert a camelCase or PascalCase string to kebab-case.
 * E.g. `borderRadius` → `border-radius`, `navBar` → `nav-bar`.
 * Leaves already-kebab or lowercase strings unchanged.
 */
const toKebabCase = (str) =>
  str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/**
 * Convert a token path segment. Negative numeric keys are represented as a
 * nested path segment pair (e.g. `-16` -> `negative.16`).
 */
const normalizeSegment = (segment) => {
  const negativeMatch = NEGATIVE_NUMERIC_KEY.exec(segment);
  if (negativeMatch) return ['negative', negativeMatch[1]];
  return [toKebabCase(segment)];
};

/**
 * Convert each dot-separated segment in a reference path to kebab-case.
 * E.g. `{borderRadius.xs}` → `{border-radius.xs}`,
 *      `{fontFamily.interTight}` → `{font-family.inter-tight}`.
 */
const kebabRef = /\{([^}]+)\}/g;
const kebabCaseRef = (str) =>
  str.replace(kebabRef, (_, refPath) => {
    const converted = refPath.split('.').flatMap(normalizeSegment).join('.');
    return `{${converted}}`;
  });

/**
 * Rename `colour` → `color` and convert reference paths to kebab-case.
 */
const renameInString = (value) => {
  if (typeof value !== 'string') return value;
  let result = value.replace(COLOUR_REF, '{color.');
  result = kebabCaseRef(result);
  return result;
};

/**
 * Deep-normalize token values so nested references inside arrays/objects
 * (e.g. boxShadow color refs) are also renamed and kebab-cased.
 */
const normalizeTokenValue = (value) => {
  if (typeof value === 'string') return renameInString(value);
  if (Array.isArray(value)) return value.map((item) => normalizeTokenValue(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      out[toKebabCase(key)] = normalizeTokenValue(nested);
    }
    return out;
  }
  return value;
};

/**
 * Determine whether the given node is a leaf token (has `$value` or `value`).
 */
const isToken = (node) =>
  node && typeof node === 'object' && !Array.isArray(node)
    && (Object.prototype.hasOwnProperty.call(node, '$value')
      || Object.prototype.hasOwnProperty.call(node, 'value'));

/**
 * Normalize a single leaf token: strip `$` prefix from DTCG keys
 * (`$value` → `value`, `$type` → `type`, `$description` → `description`),
 * and rename `colour` references inside string/array values.
 */
const normalizeToken = (token) => {
  const out = {};
  for (const [key, raw] of Object.entries(token)) {
    let k = key;
    let v = raw;
    if (k === '$value' || k === 'value') k = 'value';
    else if (k === '$type' || k === 'type') k = 'type';
    else if (k === '$description' || k === 'description') k = 'description';

    if (k === 'type' && typeof v === 'string') {
      // Retain original camelCase type value (e.g. `borderRadius`, `fontWeight`).
      v = v;
    } else {
      v = normalizeTokenValue(v);
    }

    out[k] = v;
  }
  return out;
};

/**
 * Recursively normalize an entire token tree, renaming `colour` keys to
 * `color` and converting camelCase keys to kebab-case.
 */
const normalizeTree = (node) => {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  if (isToken(node)) return normalizeToken(node);

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    const normalizedValue = normalizeTree(value);
    const negativeMatch = NEGATIVE_NUMERIC_KEY.exec(key);

    if (negativeMatch) {
      if (!out.negative || typeof out.negative !== 'object' || Array.isArray(out.negative)) {
        out.negative = {};
      }
      out.negative[negativeMatch[1]] = normalizedValue;
      continue;
    }

    const renamedKey = toKebabCase(key === COLOUR_KEY ? COLOR_KEY : key);
    out[renamedKey] = normalizedValue;
  }
  return out;
};

// Matches any color token reference so semantic refs are mode-prefixed when
// component color tokens are split into light/dark variants.
const COLOR_REF_PATTERN = /\{color\./g;
const PRIMITIVE_COLOR_REF_PATTERN = /\{color\.(primary|secondary|system)\./;
const MODE_SCOPED_COLOR_REF_PATTERN = /^color\.(light|dark)\./;

/** Modes assumed when a caller does not supply the package's own set. */
export const DEFAULT_MODES = ['light', 'dark'];

/**
 * Prefix semantic color refs with mode, while keeping primitive
 * refs unscoped (e.g. `{color.effect.fill.default}` -> `{color.light.effect.fill.default}`).
 */
const rewriteSemanticColorRefsInString = (value, mode) => {
  if (typeof value !== 'string' || !value.includes('{color.')) return value;

  return value.replace(TOKEN_REF, (fullMatch, refPathRaw) => {
    const refPath = refPathRaw.trim();
    if (!refPath.startsWith('color.')) return fullMatch;
    if (MODE_SCOPED_COLOR_REF_PATTERN.test(refPath)) return fullMatch;
    if (refPath.startsWith('color.primary.') || refPath.startsWith('color.secondary.') || refPath.startsWith('color.system.')) {
      return fullMatch;
    }
    return `{color.${mode}.${refPath.slice('color.'.length)}}`;
  });
};

const rewriteSemanticColorRefsForMode = (node, mode) => {
  if (typeof node === 'string') return rewriteSemanticColorRefsInString(node, mode);
  if (Array.isArray(node)) return node.map((item) => rewriteSemanticColorRefsForMode(item, mode));
  if (!node || typeof node !== 'object') return node;

  if (isToken(node)) {
    const out = { ...node };
    out.value = rewriteSemanticColorRefsForMode(out.value, mode);
    return out;
  }

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = rewriteSemanticColorRefsForMode(value, mode);
  }
  return out;
};

/**
 * Deep-clone a token subtree, rewriting every `{color.X}` reference to
 * `{color.<mode>.X}` (e.g. `{color.background.foo}` → `{color.light.background.foo}`).
 */
const rewriteColorRefs = (node, mode) => {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((item) => rewriteColorRefs(item, mode));

  if (isToken(node)) {
    const out = { ...node };
    if (typeof out.value === 'string') {
      out.value = out.value.replace(COLOR_REF_PATTERN, `{color.${mode}.`);
    }
    return out;
  }

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = rewriteColorRefs(value, mode);
  }
  return out;
};

/**
 * Returns true when every own-value of a plain object is a leaf token.
 */
const isAllLeaves = (node) =>
  node && typeof node === 'object' && !Array.isArray(node) &&
  Object.values(node).every((v) => isToken(v));

/**
 * Returns true when a leaf token is mode-agnostic and should not receive a
 * light/dark split. This includes:
 *   1) direct CSS gradients (`linear-gradient(...)`)
 *   2) references to primitive color namespaces (`{color.primary.*}`, etc.)
 */
const isModeAgnosticToken = (token) =>
  isToken(token) &&
  typeof token.value === 'string' &&
  (
    token.value.includes('linear-gradient') ||
    PRIMITIVE_COLOR_REF_PATTERN.test(token.value)
  );

/**
 * Recursively walk a color subtree and, at each node whose children are all
 * leaf tokens, replace that level with `{ light: <rewritten>, dark: <rewritten> }`.
 *
 * This moves the mode key from the top of the subtree to just above leaf
 * tokens, giving paths like:
 *   color.primary.background.light.default  (was: color.light.primary.background.default)
 *
 * Leaf tokens that are mode-agnostic (e.g. `{color.gradient.*}` references or
 * direct `linear-gradient(...)` values) are kept as-is without a light/dark
 * wrapper.
 *
 * Mixed-depth nodes (where some children are leaves and others are not) treat
 * each leaf child as its own leaf-parent by wrapping it individually.
 */
const wrapModes = (value, modes) =>
  Object.fromEntries(modes.map((mode) => [mode, rewriteColorRefs(value, mode)]));

const insertModesAtLeafParent = (node, modes) => {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;

  if (isAllLeaves(node)) {
    // All leaves are gradient refs — no mode split needed.
    if (Object.values(node).every(isModeAgnosticToken)) return node;

    // All leaves are non-gradient — wrap the whole group under light/dark.
    if (Object.values(node).every((v) => !isModeAgnosticToken(v))) {
      return wrapModes(node, modes);
    }

    // Mixed: some gradient, some not — handle each leaf individually.
    const result = {};
    for (const [key, value] of Object.entries(node)) {
      result[key] = isModeAgnosticToken(value) ? value : wrapModes(value, modes);
    }
    return result;
  }

  const result = {};
  for (const [key, value] of Object.entries(node)) {
    if (isToken(value)) {
      // Leaf token at a mixed-depth level.
      result[key] = isModeAgnosticToken(value) ? value : wrapModes(value, modes);
    } else {
      result[key] = insertModesAtLeafParent(value, modes);
    }
  }
  return result;
};

/**
 * Wrap a component's color subtree so the mode key appears just above leaf
 * tokens rather than at the top of the subtree.
 *
 * `modes` comes from the package's own `$metadata.json` — a package that ships
 * only a dark semantic set produces only dark component tokens, rather than
 * light branches that can never resolve.
 */
const splitColorModes = (colorNode, modes) => insertModesAtLeafParent(colorNode, modes);

/**
 * Renames applied to the component key (second-level token set keys) before
 * they become root keys in the pivoted output.
 * Keys are the original token names (post-normalization/kebab-case), values are the desired output names.
 *
 * Example: `navDot` → normalized `nav-dot` → output key `control`.
 */
const COMPONENT_KEY_RENAMES = {
  'nav-dot': 'control',
  'trustpilot': 'testimonial'
};

/**
 * Component-specific overrides for how a category key maps into the output path.
 * Each entry is `{ [componentName]: { [category]: [...pathSegments] } }`.
 * Keys here should use the *renamed* component key if a rename applies.
 *
 * Example: `card.color` is placed at `card.type.color` instead of `card.color`.
 */
const COMPONENT_CATEGORY_PATH_OVERRIDES = {
  card: {
    [COLOR_KEY]: ['type', COLOR_KEY]
  }
};

/**
 * For a component token set, pivot every `<category>.<component>.<rest>`
 * path so the component name becomes the root: `<component>.<category>.<rest>`.
 *
 * All top-level category keys (e.g. `color`, `spacing`, `border-radius`) are
 * processed, and all second-level keys are treated as component names.
 * For the `color` category the subtree is additionally split into `light` and
 * `dark` sub-trees with semantic references rewritten accordingly.
 * Non-object category values pass through unchanged.
 *
 * Component-specific path overrides in `COMPONENT_CATEGORY_PATH_OVERRIDES` can
 * redirect a category to a deeper nested path (e.g. `card.color` → `card.type.color`).
 */
const pivotComponentTree = (tree, modes) => {
  if (!tree || typeof tree !== 'object') return tree;

  const pivoted = {};

  for (const [category, categoryNode] of Object.entries(tree)) {
    if (!categoryNode || typeof categoryNode !== 'object') {
      pivoted[category] = categoryNode;
      continue;
    }

    for (const [compKey, compValue] of Object.entries(categoryNode)) {
      const renamedKey = COMPONENT_KEY_RENAMES[compKey] ?? compKey;
      if (!pivoted[renamedKey]) pivoted[renamedKey] = {};
      const value = category === COLOR_KEY
        ? splitColorModes(compValue, modes)
        : compValue;

      const pathOverride = COMPONENT_CATEGORY_PATH_OVERRIDES[renamedKey]?.[category];
      if (pathOverride) {
        let target = pivoted[renamedKey];
        for (let i = 0; i < pathOverride.length - 1; i++) {
          if (!target[pathOverride[i]]) target[pathOverride[i]] = {};
          target = target[pathOverride[i]];
        }
        target[pathOverride[pathOverride.length - 1]] = value;
      } else {
        pivoted[renamedKey][category] = value;
      }
    }
  }

  return pivoted;
};

/**
 * For semantic colour token sets (colour-light / colour-dark), wrap the
 * `color` node under a mode key so the output path becomes
 * `color.light.*` or `color.dark.*`.
 */
const scopeColourMode = (tree, mode) => {
  if (!tree || typeof tree !== 'object') return tree;
  const colorNode = tree[COLOR_KEY];
  if (!colorNode || typeof colorNode !== 'object') return tree;

  return {
    ...tree,
    [COLOR_KEY]: { [mode]: colorNode }
  };
};

/**
 * Derive a component name from a token-set id like `components/button`.
 * Returns `null` for non-component sets.
 */
export const componentNameFromSetId = (setId) => {
  const parts = setId.split('/');
  if (parts[0] !== 'components' || parts.length < 2) return null;
  return path.basename(parts.slice(1).join('/'));
};

/**
 * Apply the full transformation pipeline to a single token set.
 *
 * @param {string} setId  e.g. `components/button`, `semantics/colour-light`
 * @param {object} raw    parsed JSON from disk
 */
export const transformTokenSet = (setId, raw, modes = DEFAULT_MODES) => {
  const normalized = normalizeTree(raw);
  const componentName = componentNameFromSetId(setId);
  if (componentName) {
    return pivotComponentTree(normalized, modes);
  }
  // Scope semantic colour tokens under color.light / color.dark.
  //
  // Matched on the trailing segment of the set id rather than the whole id, so
  // that both the flat layout (`semantics/colour-light`) and the
  // platform/brand layout (`semantics/web/british-gas/light`) resolve the same
  // way. Matching the whole id silently skips the scoping for nested sets,
  // which leaves every component reference to `color.light.*` unresolved.
  if (setId.startsWith('semantics/')) {
    const name = path.basename(setId);
    if (name === 'colour-light' || name === 'light') {
      return scopeColourMode(normalized, 'light');
    }
    if (name === 'colour-dark' || name === 'dark') {
      return scopeColourMode(normalized, 'dark');
    }
    if (name === 'gradient-light') {
      return scopeColourMode(normalized, 'light');
    }
    if (name === 'gradient-dark') {
      return scopeColourMode(normalized, 'dark');
    }
    if (name === 'effects-light') {
      return rewriteSemanticColorRefsForMode(scopeColourMode(normalized, 'light'), 'light');
    }
    if (name === 'effects-dark') {
      return rewriteSemanticColorRefsForMode(scopeColourMode(normalized, 'dark'), 'dark');
    }
  }
  return normalized;
};

/**
 * Apply only the normalization (colour→color, $value→value) without any
 * mode scoping or component pivoting. Used for reference resolution.
 */
export const normalizeOnly = (raw) => normalizeTree(raw);
