import { parseArgs } from "node:util";
import { analyze } from "../lib/acid-base/index.ts";
import { formatHeader, formatTable, printResult, formatError } from "../lib/format.ts";

const USAGE = `Usage: medprotocol abg [options]

Options:
  --ph <number>       Arterial pH (required)
  --pco2 <number>     pCO2 in mmHg (required)
  --hco3 <number>     HCO3 in mEq/L (required)
  --na <number>       Sodium in mEq/L (for anion gap)
  --cl <number>       Chloride in mEq/L (for anion gap)
  --albumin <number>  Albumin in g/dL (for corrected anion gap)
  --chronic           Chronic respiratory disorder
  --json              Output as JSON
  --help              Show this help

Examples:
  medprotocol abg --ph 7.25 --pco2 29 --hco3 14
  medprotocol abg --ph 7.25 --pco2 29 --hco3 14 --na 140 --cl 105 --albumin 4.0`;

export const run = (argv: string[]): void => {
  const { values } = parseArgs({
    args: argv,
    options: {
      ph: { type: "string" },
      pco2: { type: "string" },
      hco3: { type: "string" },
      na: { type: "string" },
      cl: { type: "string" },
      albumin: { type: "string" },
      chronic: { type: "boolean", default: false },
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
  if (!values.ph) missing.push("--ph");
  if (!values.pco2) missing.push("--pco2");
  if (!values.hco3) missing.push("--hco3");

  if (missing.length > 0) {
    process.stderr.write(
      formatError(`Missing required flags: ${missing.join(", ")}`) + "\n\n" + USAGE + "\n",
    );
    process.exitCode = 1;
    return;
  }

  const result = analyze({
    values: {
      pH: values.ph!,
      pCO2: values.pco2!,
      HCO3: values.hco3!,
      Na: values.na || "",
      Cl: values.cl || "",
      Albumin: values.albumin || "",
    },
    isChronic: values.chronic!,
  });

  if (!result) {
    process.stderr.write(formatError("Could not analyze ABG — check input values") + "\n");
    process.exitCode = 1;
    return;
  }

  const data = {
    disorder: result.disorder,
    compensation: result.compensation,
    compensatoryResponse: result.compensatoryResponse,
    interpretation: result.interpretation,
    expectedValues: result.expectedValues,
    additionalDisorders: result.additionalDisorders,
    ...(result.anionGap !== null && {
      anionGap: parseFloat(result.anionGap),
      agStatus: result.agStatus,
    }),
    ...(result.correctedAG !== null && {
      correctedAG: parseFloat(result.correctedAG),
    }),
    ...(result.deltaRatio !== null && {
      deltaRatio: parseFloat(result.deltaRatio),
      deltaRatioInterpretation: result.deltaRatioInterpretation,
    }),
  };

  printResult(data, values.json!, () => {
    const rows: [string, string][] = [
      ["Disorder", result.disorder],
      ["Compensation", result.compensation],
      ["Interpretation", result.interpretation],
    ];

    if (result.expectedValues?.low && result.expectedValues?.high) {
      rows.push(["Expected range", `${result.expectedValues.low}–${result.expectedValues.high}`]);
    }

    if (result.anionGap !== null) {
      rows.push(["Anion Gap", `${result.anionGap} (${result.agStatus})`]);
    }

    if (result.correctedAG !== null) {
      rows.push(["Corrected AG", result.correctedAG]);
    }

    if (result.deltaRatio !== null) {
      rows.push(["Delta Ratio", `${result.deltaRatio} — ${result.deltaRatioInterpretation}`]);
    }

    if (result.additionalDisorders.length > 0) {
      rows.push(["Additional", result.additionalDisorders.join(", ")]);
    }

    return [formatHeader("ABG Analysis"), formatTable(rows)].join("\n");
  });
};
