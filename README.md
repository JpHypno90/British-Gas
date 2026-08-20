# design-tokens — POC

Proof of concept for a **single repository containing one token package per
brand + platform**, each with its own Tokens Studio sync target.

Currently modelled: **British Gas web** and **British Gas app**. Adding Hive, or
any other brand, means adding a folder — nothing else changes.

## Why

Design tokens are authored in Figma via Tokens Studio, which syncs to a Git
folder. Each Figma library is a separate team with a separate component library
and almost no crossover between them.

Previously all brands and platforms shared one `tokens/` folder. That meant
every library could see every other library's tokens, so designers had to keep
themes and set visibility configured correctly to avoid aliasing the wrong
platform's colours — and nothing enforced it.

Giving each library its own folder makes that structurally impossible. An app
designer cannot alias a web token because web tokens are not in the folder their
Figma file is connected to.

The alternative — four separate repositories — was rejected because the build,
CI and release setup would be duplicated four times and drift apart.

## Layout

```
packages/
  bg-web/
    package.json          → @jphypno90/tokens-bg-web
    tokens/               → Tokens Studio sync target for the BG web library
      $metadata.json        (its own set list)
      $themes.json          (its own themes)
      primitives/ semantics/ components/
  bg-app/
    package.json          → @jphypno90/tokens-bg-app
    tokens/               → Tokens Studio sync target for the BG app library
      …

scripts/                  → ONE build script, shared by every package
  build.js
  transform-tokens.js
  check-primitives.js
```

Each package's `tokens/` folder carries its own `$metadata.json` and
`$themes.json`. That is what makes the sync targets independent.

## Tokens Studio setup

One sync provider per Figma library, all pointing at the same repo and branch,
differing only in the storage path:

| Figma library | Repository | Token storage location |
|---|---|---|
| British Gas — Web | `<owner>/design-tokens` | `packages/bg-web/tokens` |
| British Gas — App | `<owner>/design-tokens` | `packages/bg-app/tokens` |

Because the folders are disjoint, teams pushing at the same time never conflict.

## Commands

```bash
npm ci                              # one lockfile for the whole repo
npm run build                       # build every package
npm run build -w @jphypno90/tokens-bg-app    # build one
npm run check:primitives            # report primitive drift between packages
npm run check:primitives -- --strict # …and fail if any is found
```

`CI=true` makes unresolved token references **fail** the build rather than print
a warning. CI sets it; locally you should too when verifying a change.

## What consumers install

Each package publishes independently, and ships only its `dist/`:

```js
import light from '@jphypno90/tokens-bg-web/themes/color-light.json';
import button from '@jphypno90/tokens-bg-app/components/button.json';
```

An app team installs the app package and gets app tokens only.

## Design notes

**Colour modes are per package.** The build reads each package's
`$metadata.json` and emits only the modes that package actually ships. BG web
has light and dark; BG app is dark-only, so its component tokens contain no
light branch. One script, different output, no per-package configuration.

**Primitives are duplicated on purpose.** Each package needs its primitives
locally so its Tokens Studio sync is self-contained and so unused scales can be
pruned per platform. The cost is that copies can drift, so
`npm run check:primitives` compares them and reports differences. Four separate
repos would have had the same duplication with no way to detect it.

**One build script.** The single largest argument for one repo over four: the
build logic exists once, so a fix lands once.

## Trade-off

Everyone can see every brand's folder, even though they only work in their own.
`CODEOWNERS` can require the right reviewers per folder, but it does not
restrict visibility. If a brand ever needs genuine isolation, that package can
be split into its own repository later — the structure inside it would not
change.
