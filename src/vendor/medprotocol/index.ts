#!/usr/bin/env node
/**
 * VENDORED. This is medprotocol's own entrypoint, copied from medprotocol-core at v0.7.10 and
 * changed in exactly two ways: import specifiers carry the `.ts` extensions node's type
 * stripping requires, and the version below is a literal rather than a read of that package's
 * package.json, which does not travel with the copy. See VENDOR.md for why the copy exists and
 * what re-syncing it involves — and note that `[clinical.medprotocol].version` in
 * packs/clinical/pack.toml is checked against the constant below on every run, so the two move
 * together or the pack refuses to load.
 */

const VERSION = "0.7.10";

const USAGE = `medprotocol — Medical calculations from the terminal

Usage: medprotocol <command> [options]

Commands:
  bmi              Calculate Body Mass Index
  abg              Analyze arterial blood gas
  water-balance    Calculate fluid balance
  vitals           Evaluate vital signs
  pafi             Calculate PaO2/FiO2 ratio (ARDS classification)
  dka              Assess DKA parameters and resolution
  cardiology       Cardiology risk scores (ASCVD, HEART, CHA₂DS₂-VASc)
  sepsis           Sepsis assessment (SOFA, qSOFA, lactate clearance, hour-1 bundle)
  ckd              CKD evaluation (eGFR, staging, KFRE, treatment, anemia, MBD, trends)
  diabetes         Diabetes diagnosis and classification (ADA 2026)
  schema           Describe every calculation, flag, and type (for agents)
  overlay          Drain the dev overlay work-order queue (.medprotocol/queue/)

Global options:
  --json           Output as JSON (available on all commands)
  --help           Show help for a command
  --version        Show version

Examples:
  medprotocol bmi --weight 70 --height-m 1.75 --metric
  medprotocol abg --ph 7.25 --pco2 29 --hco3 14
  medprotocol water-balance --weight 70 --oral 1500 --iv 500 --diuresis 1200 --stools 2
  medprotocol vitals --bp 120/80 --hr 72 --temp 37.0
  medprotocol pafi --pao2 60 --fio2 40
  medprotocol dka --glucose 400 --prev-glucose 460 --hours 2 --unit mgdl
  medprotocol cardiology ascvd --age 55 --sex male --tc 213 --hdl 50 --sbp 120
  medprotocol cardiology heart --history 1 --ecg 0 --age 2 --risk-factors 1 --troponin 0
  medprotocol cardiology chadsvasc --hypertension --age75 --diabetes
  medprotocol sepsis sofa --pao2 80 --fio2 40 --platelets 90 --gcs 13
  medprotocol sepsis qsofa --rr 24 --sbp 90 --gcs 13
  medprotocol sepsis lactate --initial 4.2 --repeat 2.1
  medprotocol sepsis bundle --lactate-measured --cultures --antibiotics --fluids --vasopressors --elapsed 45
  medprotocol ckd egfr --creatinine 1.2 --age 55 --sex male
  medprotocol ckd stage --creatinine 1.2 --age 55 --sex male --acr 45
  medprotocol ckd kfre --age 65 --sex female --egfr 35 --acr 300
  medprotocol ckd treatment --egfr 35 --acr 300 --diabetes
  medprotocol ckd trend --prev-egfr 52 --egfr 38 --prev-acr 150 --acr 340
  medprotocol diabetes diagnose --a1c 6.8 --fpg 130
  medprotocol diabetes t1d-stage --autoantibodies 3 --a1c 5.9
  medprotocol diabetes t1-vs-t2 --age 25 --bmi 22 --autoantibodies --c-peptide 150
  medprotocol diabetes t2d-screen --age 40 --bmi 28 --hypertension
  medprotocol diabetes gdm --strategy one-step --fasting 95 --1h 185 --2h 160
  medprotocol diabetes confirm --readings '[{"a1c":"6.8"},{"fpg":"140"}]'
  medprotocol overlay --drain

Agents: run \`medprotocol schema --json\` to discover every calculation and flag,
then invoke the one you need with --json.`;

const command = process.argv[2];
const commandArgs = process.argv.slice(3);

if (command === "--version" || command === "-v") {
  process.stdout.write(`medprotocol v${VERSION}\n`);
  process.exit(0);
}

if (!command || command === "--help" || command === "-h") {
  process.stdout.write(USAGE + "\n");
  process.exit(0);
}

const commands: Record<string, () => Promise<{ run: (argv: string[]) => void }>> = {
  bmi: () => import("./commands/bmi.ts"),
  abg: () => import("./commands/abg.ts"),
  "water-balance": () => import("./commands/water-balance.ts"),
  vitals: () => import("./commands/vitals.ts"),
  pafi: () => import("./commands/pafi.ts"),
  dka: () => import("./commands/dka.ts"),
  cardiology: () => import("./commands/cardiology.ts"),
  sepsis: () => import("./commands/sepsis.ts"),
  ckd: () => import("./commands/ckd.ts"),
  diabetes: () => import("./commands/diabetes.ts"),
  schema: () => import("./commands/schema.ts"),
  overlay: () => import("./commands/overlay.ts"),
};

const loader = commands[command];

/** First meaningful line of an error, without the usage block appended after it. */
const errorSummary = (text: string): string =>
  text.split("\n\n")[0].replace(/^Error:\s*/, "").trim();

/**
 * Run a command. With --json, anything the command reports as an error is
 * re-emitted as a single JSON object so an agent can parse the failure the same
 * way it parses a result, instead of scraping prose off stderr.
 */
const invoke = (run: (argv: string[]) => void): void => {
  const wantsJson = commandArgs.includes("--json");

  if (!wantsJson) {
    try {
      run(commandArgs);
    } catch (error) {
      process.stderr.write(`Error: ${(error as Error).message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  const writeStderr = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: unknown) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    run(commandArgs);
  } catch (error) {
    captured += `Error: ${(error as Error).message}`;
  } finally {
    process.stderr.write = writeStderr;
  }

  if (captured.trim()) {
    process.exitCode = 1;
    writeStderr(
      JSON.stringify(
        {
          error: errorSummary(captured),
          command,
          hint: "Run `medprotocol schema --json` to see every flag this command accepts.",
        },
        null,
        2,
      ) + "\n",
    );
  }
};

if (!loader) {
  const message = `Unknown command: ${command}`;
  const available = Object.keys(commands).join(", ");
  if (commandArgs.includes("--json") || command.startsWith("-")) {
    process.stderr.write(
      JSON.stringify({ error: message, available }, null, 2) + "\n",
    );
  } else {
    process.stderr.write(`${message}\n\nAvailable commands: ${available}\n`);
  }
  process.exitCode = 1;
} else {
  loader().then((mod) => invoke(mod.run));
}
