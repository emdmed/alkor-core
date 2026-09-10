import { parseArgs } from "node:util";
import {
  CATALOG,
  GLOBAL_FLAGS,
  calculationCount,
  findCommand,
  type CommandEntry,
} from "../catalog.ts";
import { formatHeader, formatTable, printResult, formatError } from "../lib/format.ts";

const USAGE = `Usage: medprotocol schema [command] [options]

Describes every calculation the CLI exposes — commands, sub-commands, flags,
types, and which flags are required. Intended for agents: run it once with
--json to discover the full surface, then invoke the calculation you need.

Options:
  --json              Output the machine-readable catalog (recommended)
  --help              Show this help

Examples:
  medprotocol schema --json           # everything
  medprotocol schema ckd --json       # one command
  medprotocol schema`;

const serialize = (entries: CommandEntry[]) => ({
  commands: entries.map((entry) => ({
    command: entry.command,
    description: entry.description,
    calculations: entry.calculations.map((calc) => ({
      invocation: calc.subcommand
        ? `medprotocol ${entry.command} ${calc.subcommand}`
        : `medprotocol ${entry.command}`,
      ...(calc.subcommand ? { subcommand: calc.subcommand } : {}),
      description: calc.description,
      flags: calc.flags.map((flag) => ({
        flag: flag.flag,
        type: flag.type,
        required: flag.required ?? false,
        description: flag.description,
        ...(flag.values ? { values: flag.values } : {}),
        ...(flag.default !== undefined ? { default: flag.default } : {}),
      })),
      examples: calc.examples,
    })),
  })),
  globalFlags: GLOBAL_FLAGS.map((flag) => ({
    flag: flag.flag,
    type: flag.type,
    description: flag.description,
  })),
});

export const run = (argv: string[]): void => {
  const target = argv[0] && !argv[0].startsWith("-") ? argv[0] : undefined;
  const flagArgs = target ? argv.slice(1) : argv;

  const { values } = parseArgs({
    args: flagArgs,
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  let entries = CATALOG;

  if (target) {
    const entry = findCommand(target);
    if (!entry) {
      process.stderr.write(
        formatError(`Unknown command: ${target}`) +
          `\n\nAvailable: ${CATALOG.map((c) => c.command).join(", ")}\n`,
      );
      process.exitCode = 1;
      return;
    }
    entries = [entry];
  }

  printResult(serialize(entries), values.json!, () => {
    const rows: [string, string][] = [];

    for (const entry of entries) {
      for (const calc of entry.calculations) {
        // First sentence only — enough to route on, without wrapping the table.
        const summary = calc.description.split(". ")[0].replace(/\.$/, "");
        rows.push([
          calc.subcommand ? `${entry.command} ${calc.subcommand}` : entry.command,
          summary,
        ]);
      }
    }

    return [
      formatHeader(
        target
          ? `medprotocol ${target}`
          : `medprotocol — ${calculationCount()} calculations`,
      ),
      formatTable(rows),
      "\nEvery calculation takes --json. Run `medprotocol schema --json` for the",
      "full flag-level catalog, or `medprotocol schema <command> --json` for one.",
    ].join("\n");
  });
};
