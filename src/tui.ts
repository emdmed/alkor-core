#!/usr/bin/env node
/**
 * alkor TUI entry point.
 *
 * Runtime guard first: needs Node ≥ 26.4 with --experimental-ffi, or Bun ≥ 1.3.
 * Everything except the thin view layer is plain TypeScript that runs on Node 24.
 */

const parseArgs = (): { url: string } => {
  const args = process.argv.slice(2)
  let url = `http://127.0.0.1:${process.env.PORT ?? 3000}`
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
      url = args[i + 1]!
      i++
    }
  }
  return { url }
}

const hasFfi = (): boolean => {
  try {
    // Node 26.4+ with --experimental-ffi may expose process.features.ffi
    if ((process.features as any)?.ffi === true) return true
    // Fallback: check argv directly when the property is missing
    if (process.execArgv.includes('--experimental-ffi')) return true
    return false
  } catch {
    return false
  }
}

const isBun = (): boolean => {
  try {
    const bun = (globalThis as any).Bun
    return typeof bun === 'object' && bun?.version != null
  } catch {
    return false
  }
}

const runtimeOk = (): boolean => {
  if (isBun()) {
    const major = Number(String((globalThis as any).Bun?.version).split('.')[0])
    return major >= 1
  }
  const nodeVersion = process.version.slice(1) // 'v24.11.1' -> '24.11.1'
  const parts = nodeVersion.split('.').map(Number)
  const major = parts[0] ?? 0
  const minor = parts[1] ?? 0
  if (major > 26) return hasFfi()
  if (major === 26 && minor >= 4) return hasFfi()
  return false
}

const main = async () => {
  if (!runtimeOk()) {
    console.error(
      'tui: needs Node ≥ 26.4 with --experimental-ffi, or Bun ≥ 1.3 — ' +
        'the rest of the harness runs fine on Node 24',
    )
    process.exit(1)
  }

  const { url } = parseArgs()
  const { runApp } = await import('./tui/app.ts')
  await runApp(url)
}

main().catch((e) => {
  console.error('tui error:', e)
  process.exit(1)
})
