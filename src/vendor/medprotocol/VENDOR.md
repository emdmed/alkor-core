# medprotocol v0.7.10, vendored

This directory is a copy of the `medprotocol` CLI — `packages/medprotocol/src` plus the `lib/`
it imports, from the medprotocol-core repository at v0.7.10. It is not a fork. Nothing here is
meant to be edited; see "Re-syncing" below.

## Why it is checked in

The clinical profile delegates every numeric decision to this CLI, for the reason stated at the
top of `src/profiles/clinical/medprotocol.ts`: a 4B model asked whether a systolic is below a
threshold gets the glaring case right and the boundary wrong, and a second hand-rolled
implementation in this repository would let the eval and the consuming product classify the same
blood pressure differently without either of them noticing.

That argument says the decision belongs to the tool. It does not say the tool has to be
something the reader installs. Until this copy existed the reference pack's numbers were a
property of whatever the operator had on `$PATH`: no medprotocol and the clinical profile did
not run; a medprotocol of another version and it refused — correctly, and uselessly, on a
machine with no way to fix it. Since the CLI is a few thousand lines of arithmetic with no
dependencies outside node's standard library, the cheapest way to make the pack reproducible was
to carry it. `git clone && npm test` now measures the same rules everywhere.

The version pin in `packs/clinical/pack.toml` is unchanged and still checked on every run. It
now compares the pack's declaration against the constant in `index.ts`, so the two move together
or the pack refuses to load.

## What was changed in the copy

Three edits, all mechanical, all forced by how this repository runs TypeScript — node's type
stripping, no build step:

1. **Import specifiers carry `.ts` extensions**, and the `../../../../lib/...` imports that
   reached out of the upstream package now point at `lib/` inside this directory.
2. **Two type-only imports were marked `import type`** — `Values`/`ExpectedValues` in
   `lib/acid-base/analyze.ts` and `BloodPressureCategory`/`BloodPressureValue` in
   `lib/vital-signs-validations/blood-pressure-validations.ts`. Without this node throws at
   startup, because a stripped type import leaves a named import of something that does not
   exist at runtime.
3. **`VERSION` in `index.ts` is a literal** rather than a read of the upstream package.json,
   which does not travel with the copy.

No calculation, threshold, category boundary, output shape, or exit code was touched. That was
checked rather than assumed: 29 invocations spanning every command and both halves of the CLI's
error contract were run against the upstream `dist/index.js` and against this copy, and compared
on stdout, stderr and exit code. All 29 matched exactly.

## Re-syncing

Re-copy `packages/medprotocol/src` and `lib/`, redo the three edits above, then:

- `npm run typecheck` — `tsconfig.vendor.json` checks this directory with
  `noUncheckedIndexedAccess` relaxed (upstream does not set it) but `verbatimModuleSyntax` kept,
  which is what catches edit 2's class of error;
- re-run the differential comparison against the new upstream build;
- update `VERSION` here and `[clinical.medprotocol].version` in `packs/clinical/pack.toml`
  together, and re-measure the pack's numbers, because a different build is a different rule.

`MEDPROTOCOL_BIN` still overrides the executable, so an operator who wants their own build — or
a test that wants a fixture — does not have to touch this directory.

## Upstream

medprotocol, from medprotocol-core, which declares `"license": "MIT"` in its package.json and
ships no LICENSE file of its own — so there is no upstream text to retain here and no copyright
line to reproduce, and inventing one would be worse than saying so. If medprotocol-core is ever
published with a LICENSE, copy it into this directory. alkor's own license (MIT) covers the
rest of the repository and does not cover this directory.
