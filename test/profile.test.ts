/**
 * Profile resolution: where a profile's module comes from, and what happens when it is
 * somewhere else.
 *
 * The out-of-tree path is what lets a proprietary domain keep its scorer beside its pack
 * instead of in this repository, so it is checked the same way pack resolution is: the
 * precedence, the two different base directories, and the error a wrong path produces.
 * Everything here runs on temporary files — no consuming project, no server, no model.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadProfileModule, resolveProfileModule, ProfileError } from '../src/core/profile.ts'
import { envSuffix } from '../src/core/config.ts'

const withEnv = (key: string, value: string | undefined, fn: () => void) => {
  const before = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try {
    fn()
  } finally {
    if (before === undefined) delete process.env[key]
    else process.env[key] = before
  }
}

const tmp = (): string => mkdtempSync(join(tmpdir(), 'profile-seam-'))

test('a profile with no module resolves to the built-in directory', () => {
  assert.equal(resolveProfileModule('coding', { base: '/anywhere' }), undefined)
})

test('a configured module resolves against the config file, not the cwd', () => {
  const opts = { configured: 'harness/oncology/profile.ts', base: '/opt/other-project' }
  assert.equal(resolveProfileModule('oncology', opts), resolve('/opt/other-project/harness/oncology/profile.ts'))
})

test('an absolute configured module is taken as it is', () => {
  const got = resolveProfileModule('oncology', { configured: '/srv/p.ts', base: '/opt/other-project' })
  assert.equal(got, '/srv/p.ts')
})

test('the env override wins, and resolves against the cwd because it came from a shell', () => {
  withEnv('PROFILE_MODULE_ONCOLOGY', 'elsewhere/profile.ts', () => {
    const opts = { configured: 'harness/oncology/profile.ts', base: '/opt/other-project' }
    assert.equal(resolveProfileModule('oncology', opts), resolve(process.cwd(), 'elsewhere/profile.ts'))
  })
})

test('a hyphenated profile name is settable from a shell', () => {
  assert.equal(envSuffix('note-format'), 'NOTE_FORMAT')
  withEnv('PROFILE_MODULE_NOTE_FORMAT', '/srv/nf.ts', () => {
    assert.equal(resolveProfileModule('note-format', { base: '/opt' }), '/srv/nf.ts')
  })
})

test('an out-of-tree module is loaded and its PROFILE returned', async () => {
  const dir = tmp()
  try {
    mkdirSync(join(dir, 'harness'))
    const file = join(dir, 'harness', 'profile.ts')
    writeFileSync(
      file,
      `export const PROFILE = {
         name: 'outside',
         mode: 'extract',
         needsPack: false,
         async runEval() { return { pass: true, summary: 'from out of tree' } },
       }\n`,
    )
    const profile = await loadProfileModule('outside', file)
    assert.equal(profile.name, 'outside')
    const verdict = await profile.runEval({} as never)
    assert.equal(verdict.summary, 'from out of tree')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a module that does not exist names the resolved path, not the specifier', async () => {
  const missing = resolve('/opt/other-project/harness/oncology/profile.ts')
  await assert.rejects(
    () => loadProfileModule('oncology', missing),
    (e: Error) => {
      assert.ok(e instanceof ProfileError)
      assert.match(e.message, /harness\/oncology\/profile\.ts/)
      // The fix goes in the config or the env var, so both are named.
      assert.match(e.message, /profiles\.toml/)
      assert.match(e.message, /PROFILE_MODULE_ONCOLOGY/)
      return true
    },
  )
})

test('a module without a PROFILE export is rejected by the path it was loaded from', async () => {
  const dir = tmp()
  try {
    const file = join(dir, 'empty.ts')
    writeFileSync(file, 'export const NOT_A_PROFILE = 1\n')
    await assert.rejects(
      () => loadProfileModule('outside', file),
      (e: Error) => {
        assert.match(e.message, /empty\.ts must export a PROFILE/)
        return true
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * The name is still interpolated into an import specifier on the built-in path, so it is
 * still validated there. An explicit module is a path its author wrote and is not.
 */
test('a hostile name is refused only when it would become a specifier', async () => {
  await assert.rejects(() => loadProfileModule('../../etc/passwd'), ProfileError)
  const dir = tmp()
  try {
    const file = join(dir, 'ok.ts')
    writeFileSync(file, `export const PROFILE = { name: 'x', mode: 'extract', needsPack: false, runEval() {} }\n`)
    const profile = await loadProfileModule('../../etc/passwd', file)
    assert.equal(profile.name, 'x')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
