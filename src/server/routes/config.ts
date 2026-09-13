/**
 * `GET /config`, `PATCH /config`, `DELETE /config` — what this server is configured to do,
 * and the subset of that a caller may change without restarting it.
 *
 * The payload is deliberately three-part, because a settings screen that showed only the
 * editable fields would be answering the wrong question. An operator opening it is usually
 * there to find out why something is refused — a second app's origin, a model that will not
 * stay resident, a trace they cannot read — and half of those answers live in facts this
 * process cannot change. So `settings` is what you may write, `runtime` is what this host is
 * running under and where it came from, and `sources` says, for every writable field,
 * whether the value on screen is the default, the environment's, or an override that is
 * currently winning over the environment.
 *
 * Writes are accepted by default and refused with 403 under `ALKOR_CONFIG_WRITE=0`. See
 * `configWritable` for what that default costs, and for why the flag is not itself settable
 * here — a lock a caller can open is not a lock.
 */
import { SETTING_ENV, SettingsError, configWritable } from '../../core/settings.ts'
import { modelBudgetBytes } from '../../core/budget.ts'
import { traceRoot } from '../../core/trace.ts'
import { totalmem } from 'node:os'
import type { RouteContext } from '../deps.ts'

/** The whole picture, assembled the same way for a read and for the answer to a write. */
const payload = (deps: RouteContext['deps']) => {
  const settings = deps.settings.current()
  return {
    settings,
    sources: deps.settings.sources(),
    /** What the environment asked for, so a `file` value can name what it is overriding. */
    env: deps.settings.env(),
    /** The variable behind each field, so the UI can tell you how to set it permanently. */
    envNames: SETTING_ENV,
    /** Whether writes are accepted at all. A read-only screen needs to know before it asks. */
    writable: configWritable(),
    /** Where an override is persisted. Named so the file is findable without guessing. */
    settingsPath: deps.settings.path,
    /**
     * Facts a running process cannot honestly change, reported rather than offered. Each is
     * paired with the variable that sets it, which is the actual answer to "how do I change
     * this" — the alternative is a disabled form field that explains nothing.
     */
    runtime: {
      profilesPath: deps.configPath,
      traceDir: traceRoot(),
      llamaBin: process.env.ALKOR_LLAMA_BIN?.trim() || undefined,
      llamaArgs: process.env.ALKOR_LLAMA_ARGS?.trim() || '--no-webui --parallel 1',
      defaultUrl: process.env.LLAMA_URL || undefined,
      backends: deps.backendUrls,
      profiles: Object.keys(deps.cfg.profiles),
      /**
       * The budget in bytes as the manager actually holds it, beside the spec string that
       * produced it. `50%` is not a number until you know the host's RAM, and the screen
       * that let you type it is the one place that ambiguity can be resolved.
       */
      budgetBytes: modelBudgetBytes(settings.modelBudget),
      /**
       * What this machine has, which is what makes the budget a QUANTITY rather than a
       * string. Without it a client can render the number the server resolved but cannot
       * say whether it is most of the host or a corner of it, and cannot offer the budget
       * as a position on a range — 6 GB means two different things on a 16 GB laptop and a
       * 128 GB workstation, and the person deciding is looking at exactly one of them.
       */
      totalBytes: totalmem(),
      resources: deps.manager.resources(),
    },
  }
}

export const configGet = async ({ reply, done, deps }: RouteContext): Promise<void> => {
  reply.ok(payload(deps))
  done(200)
}

export const configPatch = async ({ req, reply, done, deps }: RouteContext): Promise<void> => {
  if (!configWritable()) {
    reply.forbidden(
      'this server was started with ALKOR_CONFIG_WRITE=0, so its settings are read-only. ' +
        'Restart it without that variable to change them from here, or edit the settings ' +
        'file it names and restart.',
    )
    done(403)
    return
  }
  const body = (await deps.readBody(req)) as Record<string, unknown> | undefined
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    reply.bad('a settings patch is a JSON object of the fields to change')
    done(400)
    return
  }
  try {
    deps.settings.patch(body)
  } catch (e) {
    if (e instanceof SettingsError) {
      // The field travels with the message so a form can mark the input that was refused
      // rather than showing the whole screen an error about one of its rows.
      reply.bad(e.message, { field: e.field })
      done(400)
      return
    }
    reply.serverError(`could not save settings — ${(e as Error).message}`)
    done(500)
    return
  }
  reply.ok(payload(deps))
  done(200)
}

/** `DELETE /config` — drop every override and go back to what the environment says. */
export const configReset = async ({ reply, done, deps }: RouteContext): Promise<void> => {
  if (!configWritable()) {
    reply.forbidden('this server was started with ALKOR_CONFIG_WRITE=0, so its settings are read-only')
    done(403)
    return
  }
  deps.settings.reset()
  reply.ok(payload(deps))
  done(200)
}
