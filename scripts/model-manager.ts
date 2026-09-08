#!/usr/bin/env node
/**
 * Model manager: start, stop, and monitor one llama-server per profile.
 *
 * The harness never starts a server itself — a server's flags are part of a measurement
 * and outlive many runs — but a multi-model product needs many servers, and starting
 * them by hand is error-prone. This script reads profiles.toml, starts one llama-server
 * per profile on the port and with the model that profile names, and tracks PIDs so it
 * can stop or restart them later.
 *
 * Usage:
 *   scripts/model-manager.ts start   # start all servers
 *   scripts/model-manager.ts stop    # stop all tracked servers
 *   scripts/model-manager.ts restart # stop then start
 *   scripts/model-manager.ts status  # show running servers and their models
 *
 * Each server is started with the model path from `profiles.toml`, the port from the
 * same file, and `--jinja` enabled (required for tool-calling profiles). Extra flags
 * (e.g. `-ngl 99`) are passed through after the command name.
 *
 * PID files are written to `${XDG_RUNTIME_DIR:-/tmp}/medextract-servers/`. This
 * directory is outside the repository so a `git clean` does not kill running servers.
 */

import { spawn, execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'

const PID_DIR = join(process.env.XDG_RUNTIME_DIR ?? '/tmp', 'medextract-servers')

interface ServerConfig {
  name: string
  model: string
  port: number
  ctx: number
  args: string[]
}

const loadConfigs = (): ServerConfig[] => {
  // Find profiles.toml the same way the harness does: walk up from cwd.
  let dir = process.cwd()
  for (;;) {
    const candidate = join(dir, 'profiles.toml')
    if (existsSync(candidate)) break
    const parent = resolve(dir, '..')
    if (parent === dir) {
      console.error('model-manager: no profiles.toml found')
      process.exit(1)
    }
    dir = parent
  }

  const raw = parseToml(readFileSync(join(dir, 'profiles.toml'), 'utf8')) as Record<string, unknown>
  const configs: ServerConfig[] = []

  for (const [name, value] of Object.entries(raw)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const t = value as Record<string, unknown>
    const model = t.model
    const url = t.url
    if (typeof model !== 'string' || typeof url !== 'string') continue

    const portMatch = url.match(/:(\d+)$/)
    if (!portMatch) continue

    const port = Number(portMatch[1])
    const ctx = Number(t.ctx ?? 32768)
    configs.push({ name, model, port, ctx, args: [] })
  }

  return configs
}

const pidFile = (name: string) => join(PID_DIR, `${name}.pid`)

const start = (configs: ServerConfig[], extraArgs: string[]) => {
  if (!existsSync(PID_DIR)) mkdirSync(PID_DIR, { recursive: true })

  for (const cfg of configs) {
    const pidPath = pidFile(cfg.name)
    if (existsSync(pidPath)) {
      const existing = readFileSync(pidPath, 'utf8').trim()
      try {
        execSync(`kill -0 ${existing} 2>/dev/null`)
        console.log(`${cfg.name}: already running (pid ${existing})`)
        continue
      } catch {
        // Process is dead, remove stale PID file.
        unlinkSync(pidPath)
      }
    }

    if (!existsSync(cfg.model) && !cfg.model.startsWith('~')) {
      console.error(`${cfg.name}: model not found: ${cfg.model}`)
      continue
    }

    const resolvedModel = cfg.model.startsWith('~') ? join(process.env.HOME ?? '', cfg.model.slice(1)) : cfg.model
    if (!existsSync(resolvedModel)) {
      console.error(`${cfg.name}: model not found: ${resolvedModel}`)
      continue
    }

    const args = [
      '--model', resolvedModel,
      '--port', String(cfg.port),
      '--ctx-size', String(cfg.ctx),
      '--jinja',
      ...extraArgs,
    ]

    const child = spawn('llama-server', args, {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()

    writeFileSync(pidPath, String(child.pid))
    console.log(`${cfg.name}: started on port ${cfg.port} (pid ${child.pid}, model ${resolvedModel})`)
  }
}

const stop = (configs: ServerConfig[]) => {
  for (const cfg of configs) {
    const pidPath = pidFile(cfg.name)
    if (!existsSync(pidPath)) {
      console.log(`${cfg.name}: not running (no pid file)`)
      continue
    }

    const pid = readFileSync(pidPath, 'utf8').trim()
    try {
      execSync(`kill ${pid} 2>/dev/null`)
      console.log(`${cfg.name}: stopped (pid ${pid})`)
    } catch {
      console.log(`${cfg.name}: process ${pid} already dead`)
    }
    unlinkSync(pidPath)
  }
}

const status = (configs: ServerConfig[]) => {
  console.log('profile      port   model                                    status')
  console.log('------------- ------ ---------------------------------------- ----------')
  for (const cfg of configs) {
    const pidPath = pidFile(cfg.name)
    let state = 'not running'
    let pid = '-'
    if (existsSync(pidPath)) {
      const p = readFileSync(pidPath, 'utf8').trim()
      try {
        execSync(`kill -0 ${p} 2>/dev/null`)
        state = 'running'
        pid = p
      } catch {
        state = 'dead (stale pid)'
      }
    }
    const modelName = cfg.model.split('/').pop() ?? cfg.model
    console.log(`${cfg.name.padEnd(12)} ${String(cfg.port).padEnd(6)} ${modelName.padEnd(40)} ${state}${pid !== '-' ? ` (pid ${pid})` : ''}`)
  }
}

const command = process.argv[2]
const extraArgs = process.argv.slice(3)

const configs = loadConfigs()

if (!configs.length) {
  console.error('model-manager: no profiles with models found in profiles.toml')
  process.exit(1)
}

if (command === 'start') {
  start(configs, extraArgs)
} else if (command === 'stop') {
  stop(configs)
} else if (command === 'restart') {
  stop(configs)
  start(configs, extraArgs)
} else if (command === 'status') {
  status(configs)
} else {
  console.error('usage: scripts/model-manager.ts start|stop|restart|status [extra llama-server args...]')
  process.exit(1)
}
