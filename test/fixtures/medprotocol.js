#!/usr/bin/env node
/**
 * Minimal medprotocol v0.7.10 fixture for test isolation.
 *
 * Handles the three commands the clinical profile delegates to:
 *   --version          → raw version text
 *   vitals --bp ...    → bloodPressure + heartRate JSON
 *   sepsis qsofa ...   → score + positive JSON
 *
 * All other commands exit 1 with {"error": ...} on stdout, matching the medprotocol
 * v0.7.10 error contract that `run()` in medprotocol.ts handles: a non-zero exit
 * whose stdout carries {"error": "..."} is treated as a refusal, not a spawn failure.
 *
 * BP categorisation (pinned by shock.test.ts):
 *   Low       → systolic < 90 OR diastolic < 60
 *   Elevated  → systolic >= 120 AND diastolic >= 60
 *   Normal    → everything else (systolic 90-119, diastolic 60-79)
 *
 * HR categorisation:
 *   Low       → hr < 60
 *   Elevated  → hr >= 100
 *   Normal    → 60-99
 *
 * qSOFA (pinned by sepsis.test.ts):
 *   respiratory rate >= 22 → criterion met
 *   systolic blood pressure <= 100 → criterion met
 *   GCS < 15 → altered_mental_status criterion met
 *   positive = score >= 2
 */
const args = process.argv.slice(2)

// --- --version (called bare, no --json) --------------------------------------------------------
if (args.includes('--version')) {
  process.stdout.write('v0.7.10\n')
  process.exit(0)
}

// --- All paths below require --json, matching the real CLI's flag ------------------------------
const clean = args.filter(a => a !== '--json')

function flag(name) {
  const i = clean.indexOf(name)
  return i >= 0 && i + 1 < clean.length ? clean[i + 1] : undefined
}

function error(msg) {
  process.stdout.write(JSON.stringify({ error: msg }))
  process.exit(1)
}

const sub = clean[0]

// --- vitals --bp SYS/DIA --hr HR --------------------------------------------------------------
if (sub === 'vitals') {
  const bp = flag('--bp')
  const hr = flag('--hr')
  if (!bp || !hr) error('missing --bp or --hr')

  const [sStr, dStr] = bp.split('/')
  const systolic = Number(sStr)
  const diastolic = Number(dStr)
  const heartRate = Number(hr)

  if (isNaN(systolic) || isNaN(diastolic) || isNaN(heartRate)) {
    error('NaN values are not valid vital signs')
  }

  let bpCat
  if (systolic < 90 || diastolic < 60) bpCat = 'Low'
  else if (systolic >= 120 && diastolic >= 60) bpCat = 'Elevated'
  else bpCat = 'Normal'

  let hrCat
  if (heartRate < 60) hrCat = 'Low'
  else if (heartRate >= 100) hrCat = 'Elevated'
  else hrCat = 'Normal'

  const result = {
    bloodPressure: { systolic, diastolic, category: bpCat },
    heartRate: { value: heartRate, category: hrCat },
  }
  process.stdout.write(JSON.stringify(result))
  process.exit(0)
}

// --- sepsis qsofa --rr RR --sbp SBP --gcs GCS -------------------------------------------------
if (sub === 'sepsis' && clean[1] === 'qsofa') {
  const rr = Number(flag('--rr'))
  const sbp = Number(flag('--sbp'))
  const gcs = Number(flag('--gcs'))

  if (isNaN(rr) || isNaN(sbp) || isNaN(gcs)) {
    error('NaN values are not valid qSOFA inputs')
  }

  let score = 0
  if (rr >= 22) score++
  if (sbp <= 100) score++
  if (gcs < 15) score++

  const result = { score, positive: score >= 2 }
  process.stdout.write(JSON.stringify(result))
  process.exit(0)
}

error(`unknown command: ${clean.join(' ')}`)
