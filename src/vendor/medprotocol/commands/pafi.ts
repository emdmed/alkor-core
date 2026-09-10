import { parseArgs } from "node:util";
import { calculatePaFi, getPaFiClassification, getPaFiSeverity } from "../lib/pafi.ts";
import { formatHeader, formatTable, printResult, formatError } from "../lib/format.ts";

const USAGE = `Usage: medprotocol pafi [options]

Options:
  --pao2 <number>    PaO2 in mmHg (required)
  --fio2 <number>    FiO2 as percentage, 21-100 (required)
  --json             Output as JSON
  --help             Show this help

Examples:
  medprotocol pafi --pao2 60 --fio2 40
  medprotocol pafi --pao2 90 --fio2 21`;

export const run = (argv: string[]): void => {
  const { values } = parseArgs({
    args: argv,
    options: {
      pao2: { type: "string" },
      fio2: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  const missing: string[] = [];
  if (!values.pao2) missing.push("--pao2");
  if (!values.fio2) missing.push("--fio2");

  if (missing.length > 0) {
    process.stderr.write(
      formatError(`Missing required flags: ${missing.join(", ")}`) + "\n\n" + USAGE + "\n",
    );
    process.exitCode = 1;
    return;
  }

  const paFi = calculatePaFi(values.pao2!, values.fio2!);

  if (!paFi) {
    process.stderr.write(formatError("Could not calculate PaFi — check input values (PaO2 > 0, FiO2 21-100)") + "\n");
    process.exitCode = 1;
    return;
  }

  const classification = getPaFiClassification(paFi);
  const severity = getPaFiSeverity(paFi);

  const data = {
    paFi: parseFloat(paFi),
    classification,
    severity,
    paO2: parseFloat(values.pao2!),
    fiO2: parseFloat(values.fio2!),
  };

  printResult(data, values.json!, () => {
    return [
      formatHeader("PaFi Calculator"),
      formatTable([
        ["PaFi Ratio", paFi],
        ["Classification", classification],
        ["Severity", severity],
        ["PaO2", `${values.pao2} mmHg`],
        ["FiO2", `${values.fio2}%`],
      ]),
    ].join("\n");
  });
};
