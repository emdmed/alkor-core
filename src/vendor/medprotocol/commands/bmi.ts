import { parseArgs } from "node:util";
import { calculateBMI, getBMICategory } from "../lib/bmi.ts";
import { formatHeader, formatTable, printResult, formatError } from "../lib/format.ts";

const USAGE = `Usage: medprotocol bmi [options]

Options:
  --weight <number>      Weight (lbs for imperial, kg for metric)
  --height-ft <number>   Height in feet (imperial)
  --height-in <number>   Height in inches (imperial)
  --height-m <number>    Height in meters (metric, requires --metric)
  --metric               Use metric units (kg, meters)
  --json                 Output as JSON
  --help                 Show this help

Examples:
  medprotocol bmi --weight 154 --height-ft 5 --height-in 9
  medprotocol bmi --weight 70 --height-m 1.75 --metric`;

export const run = (argv: string[]): void => {
  const { values } = parseArgs({
    args: argv,
    options: {
      weight: { type: "string" },
      "height-ft": { type: "string" },
      "height-in": { type: "string" },
      "height-m": { type: "string" },
      metric: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  if (!values.weight) {
    process.stderr.write(formatError("--weight is required") + "\n\n" + USAGE + "\n");
    process.exitCode = 1;
    return;
  }

  const isMetric = values.metric!;

  if (isMetric && !values["height-m"]) {
    process.stderr.write(formatError("--height-m is required with --metric") + "\n\n" + USAGE + "\n");
    process.exitCode = 1;
    return;
  }

  if (!isMetric && !values["height-ft"] && !values["height-in"]) {
    process.stderr.write(formatError("--height-ft and/or --height-in required (or use --metric --height-m)") + "\n\n" + USAGE + "\n");
    process.exitCode = 1;
    return;
  }

  const bmi = calculateBMI(
    values.weight!,
    values["height-ft"] || "0",
    values["height-in"] || "0",
    values["height-m"] || "0",
    isMetric,
  );

  const category = getBMICategory(bmi);

  if (!bmi) {
    process.stderr.write(formatError("Could not calculate BMI — check input values") + "\n");
    process.exitCode = 1;
    return;
  }

  const data = {
    bmi: parseFloat(bmi),
    category,
    units: isMetric ? "metric" : "imperial",
    weight: parseFloat(values.weight!),
    ...(isMetric
      ? { heightM: parseFloat(values["height-m"]!) }
      : {
          heightFt: parseFloat(values["height-ft"] || "0"),
          heightIn: parseFloat(values["height-in"] || "0"),
        }),
  };

  printResult(data, values.json!, () => {
    const heightDisplay = isMetric
      ? `${values["height-m"]}m`
      : `${values["height-ft"] || 0}'${values["height-in"] || 0}"`;

    const weightUnit = isMetric ? "kg" : "lbs";

    return [
      formatHeader("BMI Calculator"),
      formatTable([
        ["BMI", bmi],
        ["Category", category],
        ["Weight", `${values.weight} ${weightUnit}`],
        ["Height", heightDisplay],
      ]),
    ].join("\n");
  });
};
