/**
 * The package boundary, exercised the way a stranger reaches it.
 *
 * Every import here goes through the package name rather than a relative path, so it
 * resolves through `exports` in package.json exactly as an out-of-tree profile's would.
 * That is the whole point: a profile living in another repository can only import what this
 * map allows, and the first person to find a hole in it should be the author.
 *
 * The list below is a CONTRACT, not an inventory. A symbol removed from it is a breaking
 * change for someone who cannot be asked, which is why the test states the names rather
 * than counting them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as medextract from 'medextract'

/** What a profile is written against. Removing any of these breaks an out-of-tree profile. */
const CONTRACT = [
  // the deployment's wiring
  'loadConfig',
  'requireProfile',
  'findConfig',
  'CONFIG_NAME',
  'ConfigError',
  'envSuffix',
  // the domain, as data
  'loadPack',
  'resolvePackRoot',
  'PackError',
  'MANIFEST_NAME',
  'SPEC_VERSION',
  // what a profile exposes, and how one is found
  'loadProfileModule',
  'resolveProfileModule',
  'chatPrompt',
  'requireDocumentName',
  'ProfileError',
  // the tool contract
  'toolSpecs',
  'dispatchCall',
  // tracing
  'openTrace',
  'stateRoot',
  // activity
  'ACTIVITY_SPEC',
  'createActivity',
  'nullActivity',
  'withActivity',
  'withActivityScope',
  // transport
  'chat',
  'llamaChat',
  'toolChat',
  'streamChat',
  'ChatError',
  'LlamaError',
  'DEFAULT_URL',
  'LLAMA_DEFAULT_URL',
  'serverProps',
  'defaultProvider',
  // what a run cost
  'summarizeBench',
  'formatBench',
  'percentile',
  'median',
  // provenance, and the input side of a contract
  'verifyQuote',
  'verifyDerivation',
  'collapse',
  'assembleDocument',
  'truncateOnCharBoundary',
  // the modes
  'extract',
  'briefing',
  'runAgent',
  'createSession',
  // The redaction hook is part of the contract a profile is written against, and the one
  // place where a host reading the wrong field writes patient data rather than a wrong string.
  'redactor',
] as const

test('the package exports everything a profile is written against', () => {
  for (const name of CONTRACT) {
    assert.ok(name in medextract, `'${name}' is missing from the package entry point`)
  }
})

/**
 * A profile is the CONSUMER of this contract, not part of it. Exporting one would make a
 * particular domain's vocabulary API, which is the arrangement the whole harness exists to
 * avoid.
 */
test('no profile is reachable through the package', () => {
  // Every profile module exports its implementation as `PROFILE`, so that one name is the
  // whole check — a list of known profile names would only catch the profiles that exist
  // today, which is precisely the coupling this test is here to prevent.
  assert.ok(!('PROFILE' in medextract), 'a profile leaked into the API')
})

/**
 * `exports` names the entry point and nothing else, so an internal module can be moved
 * without breaking a stranger. If this ever starts resolving, the boundary has stopped
 * being one.
 */
test('deep imports are refused', async () => {
  await assert.rejects(
    // @ts-expect-error — the specifier is not exported, which is the whole assertion. The
    // suppression is load-bearing in both directions: if `exports` ever starts resolving
    // this path, tsc reports the unused suppression and the boundary's erosion fails the
    // typecheck as well as the test.
    () => import('medextract/src/core/pack.ts'),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, 'ERR_PACKAGE_PATH_NOT_EXPORTED')
      return true
    },
  )
})

/**
 * The entry point must be usable without a config, a pack, a server or a model — an
 * importer that pays a side effect for loading a module has been handed a runtime rather
 * than a library.
 */
test('importing the package costs nothing', () => {
  assert.equal(medextract.SPEC_VERSION, 3)
  // The changelog travels with the version. A consumer that refuses a pack older than the
  // harness needs to be able to say what changed, and re-deriving that from release notes is
  // how two runtimes come to disagree about one format.
  assert.ok(medextract.specGap(1).length > 0)
  assert.equal(typeof medextract.DEFAULT_URL, 'string')
  assert.equal(typeof medextract.LLAMA_DEFAULT_URL, 'string')
  assert.equal(medextract.envSuffix('note-format'), 'NOTE_FORMAT')
})
