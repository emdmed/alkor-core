/**
 * Settings: the store, the validation, and the route that exposes both.
 *
 * Four properties carry the weight here, and three of them are about a value MEANING what it
 * says on screen:
 *
 * 1. A change applies to the running server. The whole point of the settings screen is that
 *    CORS, the model budget and the idle window stop being restarts; a test that only checked
 *    the file was written would pass on a server that kept refusing the origin it had just
 *    been told to allow.
 * 2. A persisted override outranks the environment, and says so. The precedence is backwards
 *    from the usual rule on purpose (see `core/settings.ts`), which makes it exactly the kind
 *    of decision that gets "fixed" by someone who did not read why.
 * 3. A rejected write changes nothing — not the file, not the running server, and not the
 *    other fields in the same body.
 * 4. Writes are refused unless the server was started to accept them. This is the only thing
 *    standing between an unauthenticated local server and a page that widens it to the world.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Server } from 'node:http'
import { isolateTraces } from './traces.ts'
import {
  createSettingsStore,
  configWritable,
  validatePatch,
  SettingsError,
} from '../src/core/settings.ts'
import { createServer as createAlkorServer } from '../src/server.ts'

isolateTraces('settings')

const scratch = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `alkor-settings-${label}-`))
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// --- Validation -------------------------------------------------------------------------

test('an origin must be spelled the way a browser spells it', () => {
  // The trailing slash is the failure this check exists for: it looks correct in a list and
  // never matches the header, so the operator sees an allowlist refusing what it contains.
  assert.throws(() => validatePatch({ cors: ['https://app.example/'] }), SettingsError)
  assert.throws(() => validatePatch({ cors: ['https://app.example/dashboard'] }), SettingsError)
  assert.throws(() => validatePatch({ cors: ['app.example'] }), SettingsError)
  assert.deepEqual(validatePatch({ cors: ['https://app.example'] }), { cors: ['https://app.example'] })
  assert.deepEqual(validatePatch({ cors: ['*'] }), { cors: ['*'] })
})

test("'*' beside a named origin is refused rather than stored as a narrower-looking list", () => {
  assert.throws(
    () => validatePatch({ cors: ['*', 'https://app.example'] }),
    (e: SettingsError) => e.field === 'cors' && /already allows every origin/.test(e.message),
  )
})

test('a duplicate origin is collapsed rather than stored twice', () => {
  assert.deepEqual(validatePatch({ cors: ['https://a.example', 'https://a.example'] }), {
    cors: ['https://a.example'],
  })
})

test('a budget that is not a size is refused, unlike the same value in the environment', () => {
  // `modelBudgetBytes` deliberately falls back on an unreadable env var rather than refusing
  // to boot. A typed value gets the opposite treatment: storing "60% of RAM" under a label
  // someone typed `6 gigs` into is how a setting comes to mean something nobody chose.
  assert.throws(() => validatePatch({ modelBudget: '6 gigs' }), SettingsError)
  assert.deepEqual(validatePatch({ modelBudget: '6GiB' }), { modelBudget: '6GiB' })
  assert.deepEqual(validatePatch({ modelBudget: '50%' }), { modelBudget: '50%' })
  assert.deepEqual(validatePatch({ modelBudget: '0' }), { modelBudget: '0' })
})

test('an idle window shorter than a second is refused', () => {
  assert.throws(
    () => validatePatch({ idleMs: 200 }),
    (e: SettingsError) => e.field === 'idleMs' && /mid-workflow/.test(e.message),
  )
  assert.deepEqual(validatePatch({ idleMs: 30_000 }), { idleMs: 30_000 })
})

test('an unknown key is refused by name rather than silently kept', () => {
  assert.throws(
    () => validatePatch({ nonsense: true }),
    (e: SettingsError) => e.field === 'nonsense',
  )
})

// --- The store --------------------------------------------------------------------------

test('a saved override outranks the environment, and the source says which won', () => {
  const file = join(scratch('precedence'), 'settings.json')
  const store = createSettingsStore({ file, env: { ALKOR_CORS: 'https://from-env.example' } })

  assert.deepEqual(store.current().cors, ['https://from-env.example'])
  assert.equal(store.sources().cors, 'env')

  store.patch({ cors: ['https://from-file.example'] })
  assert.deepEqual(store.current().cors, ['https://from-file.example'])
  assert.equal(store.sources().cors, 'file')
  // What it is overriding stays reportable, which is what lets the dashboard explain itself
  // rather than leaving two plausible readings of the same screen.
  assert.deepEqual(store.env().cors, ['https://from-env.example'])
})

test('an override survives a restart, and a reset returns the environment to charge', () => {
  const file = join(scratch('persist'), 'settings.json')
  const env = { ALKOR_IDLE_MS: '45000' }
  const first = createSettingsStore({ file, env })
  first.patch({ idleMs: 600_000, manageModels: false })

  const second = createSettingsStore({ file, env })
  assert.equal(second.current().idleMs, 600_000)
  assert.equal(second.current().manageModels, false)
  assert.equal(second.sources().idleMs, 'file')

  second.reset()
  assert.equal(second.current().idleMs, 45_000, 'the environment is back in charge')
  assert.equal(second.sources().idleMs, 'env')
  assert.equal(existsSync(file), false, 'an empty override set leaves no file behind')
})

test('a settings file that has been hand-edited into nonsense does not stop a server starting', () => {
  const file = join(scratch('corrupt'), 'settings.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '{ this is not json')
  assert.equal(createSettingsStore({ file, env: {} }).current().idleMs, 120_000)

  // One unusable key does not discard the others: the recovery for a settings file that
  // bricks the server requires knowing the file exists, and nothing in the product says so.
  writeFileSync(file, JSON.stringify({ idleMs: 5, serverTrace: false }))
  const store = createSettingsStore({ file, env: {} })
  assert.equal(store.current().idleMs, 120_000, 'the invalid entry was dropped')
  assert.equal(store.current().serverTrace, false, 'the valid one beside it was kept')
})

test('a refused patch changes nothing, including the valid fields beside it', () => {
  const file = join(scratch('atomic'), 'settings.json')
  const store = createSettingsStore({ file, env: {} })
  assert.throws(() => store.patch({ serverTrace: false, idleMs: 12 }), SettingsError)
  assert.equal(store.current().serverTrace, true, 'the valid half of a refused body is not applied')
  assert.equal(existsSync(file), false)
})

test('writes are on unless the process was started with the lock', () => {
  // The default is on: the settings screen exists so that letting another app talk to this
  // server is something done in the dashboard rather than by editing a shell and restarting.
  // `ALKOR_CONFIG_WRITE=0` is the lock, and nothing reachable over HTTP can undo it.
  assert.equal(configWritable({}), true)
  assert.equal(configWritable({ ALKOR_CONFIG_WRITE: '1' }), true)
  assert.equal(configWritable({ ALKOR_CONFIG_WRITE: '0' }), false)
  assert.equal(configWritable({ ALKOR_CONFIG_WRITE: 'off' }), true, 'only an explicit 0 locks it')
})

// --- The route --------------------------------------------------------------------------

const startServer = async (): Promise<{ url: string; close: () => Promise<void> }> => {
  const server: Server = await createAlkorServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    },
  }
}

/** Run one server under a chosen environment, restoring it afterwards. */
const withEnv = async (vars: Record<string, string | undefined>, body: (url: string) => Promise<void>) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  const { url, close } = await startServer()
  try {
    await body(url)
  } finally {
    await close()
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    // Every test here writes through a real server, so the file it persisted has to go or the
    // next one inherits it — the same isolation problem the store has on a developer's machine.
    rmSync(join(process.env.XDG_STATE_HOME ?? '', 'alkor', 'settings.json'), { force: true })
  }
}

test('GET /config reports the settings, where each came from, and the host facts around them', async () => {
  await withEnv({ ALKOR_CONFIG_WRITE: undefined }, async (url) => {
    const res = await fetch(`${url}/config`)
    const body = (await res.json()) as Record<string, any>
    assert.equal(res.status, 200)
    assert.equal(body.writable, true, 'a server with no flag set accepts writes')
    assert.deepEqual(body.settings.cors, [])
    assert.equal(body.envNames.cors, 'ALKOR_CORS')
    assert.equal(typeof body.settingsPath, 'string')
    // The read-only half is most of why the screen exists: it answers "why is this refused"
    // for the facts a running process cannot change.
    assert.ok(Array.isArray(body.runtime.backends))
    assert.ok(typeof body.runtime.traceDir === 'string')
    assert.ok(body.runtime.budgetBytes > 0, 'the spec string is resolved to bytes for the reader')
    // Total RAM travels with it: the budget is a share of a machine, and a client cannot draw
    // it as one — nor say whether 6 GB is most of the host or a corner of it — without this.
    assert.ok(body.runtime.totalBytes > body.runtime.budgetBytes, 'the default is a share of the host, not all of it')
  })
})

test('a locked server refuses the write and says nothing changed', async () => {
  await withEnv({ ALKOR_CONFIG_WRITE: '0' }, async (url) => {
    const res = await fetch(`${url}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cors: ['https://app.example'] }),
    })
    assert.equal(res.status, 403)
    const body = (await res.json()) as { error: string }
    assert.match(body.error, /ALKOR_CONFIG_WRITE=0/, 'the refusal names what is refusing it')

    // And the refusal is real rather than cosmetic: the origin is not in the allowlist after.
    const after = (await (await fetch(`${url}/config`)).json()) as Record<string, any>
    assert.deepEqual(after.settings.cors, [])
    assert.equal(after.writable, false)
  })
})

test('DELETE /config is refused on a locked server too', async () => {
  // Reset is a write. A lock that stopped PATCH but let DELETE through would let a caller
  // clear an operator's saved allowlist, which is the same door in a different frame.
  await withEnv({ ALKOR_CONFIG_WRITE: '0' }, async (url) => {
    const res = await fetch(`${url}/config`, { method: 'DELETE' })
    assert.equal(res.status, 403)
  })
})

test('a refused value comes back naming the field, so a form marks one row', async () => {
  await withEnv({ ALKOR_CONFIG_WRITE: '1' }, async (url) => {
    const res = await fetch(`${url}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelBudget: 'as much as it takes' }),
    })
    assert.equal(res.status, 400)
    const body = (await res.json()) as { error: string; field: string }
    assert.equal(body.field, 'modelBudget')
  })
})

test('an origin added through /config is allowed by the very next request', async () => {
  // THE property. A settings screen that wrote a file the running server did not consult
  // would look identical until the operator restarted and discovered it had worked all along.
  await withEnv({ ALKOR_CONFIG_WRITE: '1', ALKOR_CORS: undefined }, async (url) => {
    const origin = 'https://another-app.example'

    const before = await fetch(`${url}/health`, { headers: { Origin: origin } })
    assert.equal(
      before.headers.get('access-control-allow-origin'),
      null,
      'a non-loopback page is refused by default',
    )

    const write = await fetch(`${url}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cors: [origin] }),
    })
    assert.equal(write.status, 200)

    const after = await fetch(`${url}/health`, { headers: { Origin: origin } })
    assert.equal(after.headers.get('access-control-allow-origin'), origin, 'no restart needed')

    // And the preflight the browser sends first agrees with it, which is what the fetch
    // actually depends on — an allowed origin whose OPTIONS still refused would fail earlier
    // and more confusingly than one that was never allowed.
    const preflight = await fetch(`${url}/config`, { method: 'OPTIONS', headers: { Origin: origin } })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin)
    assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /PATCH/)
  })
})

test('trace contents stay refused to a page that is merely allowed to use the server', async () => {
  // The two lists are separate on purpose: `cors` lets an app send prompts, and a trace holds
  // what the model was asked and answered. Widening the first must never widen the second.
  await withEnv({ ALKOR_CONFIG_WRITE: '1', ALKOR_CORS: undefined, ALKOR_TRACE_CORS: undefined }, async (url) => {
    const origin = 'https://another-app.example'
    await fetch(`${url}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cors: [origin] }),
    })

    const res = await fetch(`${url}/runs/whatever`, { headers: { Origin: origin } })
    assert.equal(res.status, 403)
    const body = (await res.json()) as { error: string }
    assert.match(body.error, /metadata but not its contents/)

    // Named in the second list, it gets past the content gate and on to the real lookup.
    await fetch(`${url}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ traceCors: [origin] }),
    })
    const allowed = await fetch(`${url}/runs/whatever`, { headers: { Origin: origin } })
    assert.equal(allowed.status, 404, 'the gate is open; there is simply no such run')
  })
})

test('DELETE /config drops the overrides and the file with them', async () => {
  await withEnv({ ALKOR_CONFIG_WRITE: '1' }, async (url) => {
    await fetch(`${url}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverTrace: false }),
    })
    const written = (await (await fetch(`${url}/config`)).json()) as Record<string, any>
    assert.equal(written.settings.serverTrace, false)
    assert.equal(written.sources.serverTrace, 'file')
    assert.equal(JSON.parse(readFileSync(written.settingsPath, 'utf8')).serverTrace, false)

    const res = await fetch(`${url}/config`, { method: 'DELETE' })
    const body = (await res.json()) as Record<string, any>
    assert.equal(res.status, 200)
    assert.equal(body.settings.serverTrace, true)
    assert.equal(body.sources.serverTrace, 'default')
    assert.equal(existsSync(body.settingsPath), false)
  })
})

test('a budget set as a percentage resolves against this host, not a stored number', async () => {
  // What the slider writes. The stored value stays `40%` — portable to a machine with
  // different memory — while `budgetBytes` is what it means on this one.
  await withEnv({ ALKOR_CONFIG_WRITE: '1', ALKOR_MODEL_BUDGET: undefined }, async (url) => {
    const res = await fetch(`${url}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelBudget: '40%' }),
    })
    const body = (await res.json()) as Record<string, any>
    assert.equal(body.settings.modelBudget, '40%')
    assert.equal(body.runtime.budgetBytes, Math.floor((body.runtime.totalBytes * 40) / 100))
    assert.equal(body.runtime.resources.budgetBytes, body.runtime.budgetBytes)
  })
})

test('a budget of zero is unbounded rather than a refusal to hold anything', async () => {
  // The slider's other mode. Zero has always meant "no limit" here, and a settings screen
  // that stored it as a limit of nothing would stop every run on the host.
  await withEnv({ ALKOR_CONFIG_WRITE: '1', ALKOR_MODEL_BUDGET: undefined }, async (url) => {
    const res = await fetch(`${url}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelBudget: '0' }),
    })
    const body = (await res.json()) as Record<string, any>
    assert.equal(body.runtime.budgetBytes, 0)
    assert.equal(body.runtime.resources.budgetBytes, 0)
  })
})

test('the model budget written through /config is the one the manager is holding', async () => {
  await withEnv({ ALKOR_CONFIG_WRITE: '1', ALKOR_MODEL_BUDGET: undefined }, async (url) => {
    const res = await fetch(`${url}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelBudget: '3GiB' }),
    })
    const body = (await res.json()) as Record<string, any>
    assert.equal(res.status, 200)
    assert.equal(body.runtime.budgetBytes, 3 * 1024 ** 3)
    // `resources` is the manager's own answer rather than a re-read of the setting, so this
    // is what proves the write reached the lifecycle and not just the file.
    assert.equal(body.runtime.resources.budgetBytes, 3 * 1024 ** 3)
  })
})
