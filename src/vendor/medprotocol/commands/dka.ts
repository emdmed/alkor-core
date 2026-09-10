import { parseArgs } from "node:util";
import {
  calculateGlucoseReductionRate,
  isGlucoseOnTarget,
  assessDKAResolution,
  suggestInsulinAdjustment,
  calculateKetoneReductionRate,
  isKetoneOnTarget,
  calculateBicarbonateIncreaseRate,
  isBicarbonateOnTarget,
  classifyPotassium,
  getPotassiumSeverity,
  calculateUrineOutputRate,
  isUrineOutputOnTarget,
  classifyGCS,
  isGCSDecreasing,
} from "../lib/dka.ts";
import { formatHeader, formatTable, printResult, formatError } from "../lib/format.ts";

const USAGE = `Usage: medprotocol dka [options]

Options:
  --glucose <number>       Current glucose value (required)
  --prev-glucose <number>  Previous glucose value (for rate calculation)
  --hours <number>         Hours between readings (default: 1)
  --ketones <number>       Current ketones (mmol/L)
  --prev-ketones <number>  Previous ketones (for rate calculation)
  --bicarbonate <number>   Current bicarbonate (mEq/L)
  --prev-bicarbonate <n>   Previous bicarbonate (for rate calculation)
  --ph <number>            Current pH
  --insulin-rate <number>  Current insulin rate (U/hr)
  --potassium <number>     Serum potassium (mEq/L)
  --gcs <number>           Glasgow Coma Scale (3-15)
  --prev-gcs <number>      Previous GCS (cerebral edema warning)
  --urine-output <number>  Urine output volume (mL)
  --weight <number>        Patient weight kg (required with --urine-output)
  --unit <mgdl|mmol>       Glucose unit (default: mgdl)
  --json                   Output as JSON
  --help                   Show this help

Examples:
  medprotocol dka --glucose 400 --prev-glucose 460 --hours 2 --unit mgdl
  medprotocol dka --glucose 350 --ketones 3.0 --bicarbonate 12 --ph 7.20 --unit mgdl
  medprotocol dka --glucose 350 --ketones 3.0 --prev-ketones 4.2 --bicarbonate 14 --prev-bicarbonate 9 --hours 2
  medprotocol dka --glucose 300 --potassium 3.1 --gcs 13 --prev-gcs 15 --urine-output 400 --weight 70 --hours 8`;

export const run = (argv: string[]): void => {
  const { values } = parseArgs({
    args: argv,
    options: {
      glucose: { type: "string" },
      "prev-glucose": { type: "string" },
      hours: { type: "string", default: "1" },
      ketones: { type: "string" },
      "prev-ketones": { type: "string" },
      bicarbonate: { type: "string" },
      "prev-bicarbonate": { type: "string" },
      ph: { type: "string" },
      "insulin-rate": { type: "string" },
      potassium: { type: "string" },
      gcs: { type: "string" },
      "prev-gcs": { type: "string" },
      "urine-output": { type: "string" },
      weight: { type: "string" },
      unit: { type: "string", default: "mgdl" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  if (!values.glucose) {
    process.stderr.write(formatError("--glucose is required") + "\n\n" + USAGE + "\n");
    process.exitCode = 1;
    return;
  }

  if (values["urine-output"] && !values.weight) {
    process.stderr.write(
      formatError("--weight is required with --urine-output") + "\n\n" + USAGE + "\n",
    );
    process.exitCode = 1;
    return;
  }

  const unit = (values.unit === "mmol" ? "mmol" : "mgdl") as "mmol" | "mgdl";
  const unitLabel = unit === "mgdl" ? "mg/dL" : "mmol/L";

  const rows: [string, string][] = [
    ["Glucose", `${values.glucose} ${unitLabel}`],
  ];

  const data: Record<string, unknown> = {
    glucose: parseFloat(values.glucose!),
    unit,
  };

  // Rate calculation
  if (values["prev-glucose"]) {
    const rate = calculateGlucoseReductionRate(
      values.glucose!,
      values["prev-glucose"]!,
      values.hours!,
    );

    if (rate) {
      const onTarget = isGlucoseOnTarget(rate, unit);
      rows.push(["Glucose rate", `${rate} ${unitLabel}/hr`]);
      rows.push(["On target", onTarget ? "Yes" : "No"]);
      data.glucoseRate = parseFloat(rate);
      data.glucoseOnTarget = onTarget;
    }
  }

  // Resolution assessment
  if (values.ketones && values.bicarbonate && values.ph) {
    const resolution = assessDKAResolution(
      values.glucose!,
      values.ketones!,
      values.bicarbonate!,
      values.ph!,
      unit,
    );

    rows.push(["Ketones", `${values.ketones} mmol/L`]);
    rows.push(["Bicarbonate", `${values.bicarbonate} mEq/L`]);
    rows.push(["pH", values.ph!]);
    rows.push(["DKA Resolved", resolution.resolved ? "Yes" : "No"]);

    data.ketones = parseFloat(values.ketones!);
    data.bicarbonate = parseFloat(values.bicarbonate!);
    data.pH = parseFloat(values.ph!);
    data.resolved = resolution.resolved;
    data.criteria = resolution.criteria;
  }

  // Insulin suggestion
  if (values["insulin-rate"]) {
    const rate = values["prev-glucose"]
      ? calculateGlucoseReductionRate(
          values.glucose!,
          values["prev-glucose"]!,
          values.hours!,
        )
      : null;

    const suggestion = suggestInsulinAdjustment(
      values.glucose!,
      rate,
      values["insulin-rate"]!,
      unit,
    );

    rows.push(["Insulin rate", `${values["insulin-rate"]} U/hr`]);
    rows.push(["Suggestion", suggestion]);
    data.insulinRate = parseFloat(values["insulin-rate"]!);
    data.insulinSuggestion = suggestion;
  }

  // Ketone clearance rate
  if (values.ketones && values["prev-ketones"]) {
    const ketoneRate = calculateKetoneReductionRate(
      values.ketones!,
      values["prev-ketones"]!,
      values.hours!,
    );

    if (ketoneRate) {
      const onTarget = isKetoneOnTarget(ketoneRate);
      rows.push(["Ketone rate", `${ketoneRate} mmol/L/hr`]);
      rows.push(["Ketones on target", onTarget ? "Yes" : "No"]);
      data.ketoneRate = parseFloat(ketoneRate);
      data.ketonesOnTarget = onTarget;
    }
  }

  // Bicarbonate recovery rate
  if (values.bicarbonate && values["prev-bicarbonate"]) {
    const bicarbRate = calculateBicarbonateIncreaseRate(
      values.bicarbonate!,
      values["prev-bicarbonate"]!,
      values.hours!,
    );

    if (bicarbRate) {
      const onTarget = isBicarbonateOnTarget(bicarbRate);
      rows.push(["Bicarbonate rate", `${bicarbRate} mEq/L/hr`]);
      rows.push(["Bicarbonate on target", onTarget ? "Yes" : "No"]);
      data.bicarbonateRate = parseFloat(bicarbRate);
      data.bicarbonateOnTarget = onTarget;
    }
  }

  // Potassium
  if (values.potassium) {
    const category = classifyPotassium(values.potassium!);
    const severity = getPotassiumSeverity(values.potassium!);
    rows.push(["Potassium", `${values.potassium} mEq/L`]);
    rows.push(["Potassium status", category]);
    data.potassium = parseFloat(values.potassium!);
    data.potassiumCategory = category;
    data.potassiumSeverity = severity;
  }

  // Neurological status
  if (values.gcs) {
    const category = classifyGCS(values.gcs!);
    rows.push(["GCS", values.gcs!]);
    rows.push(["GCS status", category]);
    data.gcs = parseFloat(values.gcs!);
    data.gcsCategory = category;

    if (values["prev-gcs"]) {
      const decreasing = isGCSDecreasing(values.gcs!, values["prev-gcs"]!);
      rows.push(["Previous GCS", values["prev-gcs"]!]);
      rows.push([
        "GCS drop ≥2",
        decreasing ? "Yes — assess for cerebral edema" : "No",
      ]);
      data.previousGcs = parseFloat(values["prev-gcs"]!);
      data.gcsDecreasing = decreasing;
    }
  }

  // Urine output
  if (values["urine-output"]) {
    const uoRate = calculateUrineOutputRate(
      values["urine-output"]!,
      values.weight!,
      values.hours!,
    );

    if (uoRate) {
      const onTarget = isUrineOutputOnTarget(uoRate);
      rows.push(["Urine output", `${values["urine-output"]} mL over ${values.hours} hr`]);
      rows.push(["Urine output rate", `${uoRate} mL/kg/hr`]);
      rows.push(["Urine output on target", onTarget ? "Yes" : "No"]);
      data.urineOutputRate = parseFloat(uoRate);
      data.urineOutputOnTarget = onTarget;
    }
  }

  printResult(data, values.json!, () => {
    return [formatHeader("DKA Assessment"), formatTable(rows)].join("\n");
  });
};
