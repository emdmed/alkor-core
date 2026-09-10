import { parseArgs } from "node:util";
import {
  getBloodPressureCategory,
  BLOOD_PRESSURE_LIMITS,
} from "../lib/vital-signs-validations/blood-pressure-validations.ts";
import {
  getHeartRateCategory,
  HEART_RATE_LIMITS,
} from "../lib/vital-signs-validations/heart-rate-validations.ts";
import {
  getRespiratoryRateCategory,
  RESPIRATORY_RATE_LIMITS,
} from "../lib/vital-signs-validations/respiratory-rate-validations.ts";
import {
  getTemperatureStatusCli,
  TEMPERATURE_LIMITS,
  validateTemperatureInput,
} from "../lib/vital-signs-validations/temperature-validations.ts";
import { bloodOxygenValidations } from "../lib/vital-signs-validations/blood-oxygen-validations.ts";
import { formatHeader, formatTable, printResult, formatError } from "../lib/format.ts";

const USAGE = `Usage: medprotocol vitals [options]

Options:
  --bp <sys/dia>       Blood pressure (e.g. 120/80)
  --hr <number>        Heart rate (bpm)
  --rr <number>        Respiratory rate (breaths/min)
  --temp <number>      Temperature
  --spo2 <number>      SpO2 percentage
  --fio2 <number>      FiO2 percentage (default: 21 = room air)
  --fahrenheit         Temperature in Fahrenheit (default: Celsius)
  --json               Output as JSON
  --help               Show this help

Examples:
  medprotocol vitals --bp 120/80 --hr 72 --temp 37.0
  medprotocol vitals --bp 150/95 --hr 110 --rr 22 --temp 101.2 --fahrenheit
  medprotocol vitals --spo2 92 --fio2 40 --json`;

export const run = (argv: string[]): void => {
  const { values } = parseArgs({
    args: argv,
    options: {
      bp: { type: "string" },
      hr: { type: "string" },
      rr: { type: "string" },
      temp: { type: "string" },
      spo2: { type: "string" },
      fio2: { type: "string" },
      fahrenheit: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  const hasAny = values.bp || values.hr || values.rr || values.temp || values.spo2 || values.fio2;
  if (!hasAny) {
    process.stderr.write(
      formatError("At least one vital sign is required") + "\n\n" + USAGE + "\n",
    );
    process.exitCode = 1;
    return;
  }

  const useFahrenheit = values.fahrenheit!;
  const results: Record<string, unknown> = {};
  const humanRows: [string, string][] = [];
  const errors: string[] = [];

  // Blood pressure
  if (values.bp) {
    const parts = values.bp.split("/");
    if (parts.length !== 2) {
      errors.push("--bp must be in format systolic/diastolic (e.g. 120/80)");
    } else {
      const systolic = parseInt(parts[0], 10);
      const diastolic = parseInt(parts[1], 10);

      if (isNaN(systolic) || isNaN(diastolic)) {
        errors.push("--bp values must be numbers");
      } else if (
        systolic < BLOOD_PRESSURE_LIMITS.SYSTOLIC.MIN ||
        systolic > BLOOD_PRESSURE_LIMITS.SYSTOLIC.MAX
      ) {
        errors.push(
          `Systolic must be ${BLOOD_PRESSURE_LIMITS.SYSTOLIC.MIN}–${BLOOD_PRESSURE_LIMITS.SYSTOLIC.MAX}`,
        );
      } else if (
        diastolic < BLOOD_PRESSURE_LIMITS.DIASTOLIC.MIN ||
        diastolic > BLOOD_PRESSURE_LIMITS.DIASTOLIC.MAX
      ) {
        errors.push(
          `Diastolic must be ${BLOOD_PRESSURE_LIMITS.DIASTOLIC.MIN}–${BLOOD_PRESSURE_LIMITS.DIASTOLIC.MAX}`,
        );
      } else if (systolic <= diastolic) {
        errors.push("Systolic must be higher than diastolic");
      } else {
        const category = getBloodPressureCategory(systolic, diastolic);
        results.bloodPressure = {
          systolic,
          diastolic,
          category: category?.category || "Normal",
        };
        const catLabel = category?.category ? ` (${category.category})` : " (Normal)";
        humanRows.push(["Blood Pressure", `${systolic}/${diastolic} mmHg${catLabel}`]);
      }
    }
  }

  // Heart rate
  if (values.hr) {
    const hr = parseInt(values.hr, 10);
    if (isNaN(hr) || hr < HEART_RATE_LIMITS.MIN || hr > HEART_RATE_LIMITS.MAX) {
      errors.push(`Heart rate must be ${HEART_RATE_LIMITS.MIN}–${HEART_RATE_LIMITS.MAX} bpm`);
    } else {
      const category = getHeartRateCategory(hr);
      results.heartRate = {
        value: hr,
        category: category?.category || "Normal",
      };
      humanRows.push(["Heart Rate", `${hr} bpm (${category?.category || "Normal"})`]);
    }
  }

  // Respiratory rate
  if (values.rr) {
    const rr = parseInt(values.rr, 10);
    if (isNaN(rr) || rr < RESPIRATORY_RATE_LIMITS.MIN || rr > RESPIRATORY_RATE_LIMITS.MAX) {
      errors.push(
        `Respiratory rate must be ${RESPIRATORY_RATE_LIMITS.MIN}–${RESPIRATORY_RATE_LIMITS.MAX} breaths/min`,
      );
    } else {
      const category = getRespiratoryRateCategory(rr);
      results.respiratoryRate = {
        value: rr,
        category: category?.category || "Normal",
      };
      humanRows.push([
        "Respiratory Rate",
        `${rr} breaths/min (${category?.category || "Normal"})`,
      ]);
    }
  }

  // Temperature
  if (values.temp) {
    const isValid = validateTemperatureInput(values.temp, useFahrenheit);
    if (!isValid) {
      const limits = useFahrenheit ? TEMPERATURE_LIMITS.FAHRENHEIT : TEMPERATURE_LIMITS.CELSIUS;
      const unit = useFahrenheit ? "°F" : "°C";
      errors.push(`Temperature must be ${limits.INPUT_MIN}–${limits.INPUT_MAX}${unit}`);
    } else {
      const temp = parseFloat(values.temp);
      const status = getTemperatureStatusCli(temp, useFahrenheit);
      const unit = useFahrenheit ? "°F" : "°C";
      results.temperature = {
        value: temp,
        unit,
        status: status?.type || "normal",
        label: status?.label || "Normal",
      };
      humanRows.push([
        "Temperature",
        `${temp}${unit} (${status?.label || "Normal"})`,
      ]);
    }
  }

  // SpO2 / FiO2
  if (values.spo2) {
    if (!bloodOxygenValidations.spo2.isValid(values.spo2)) {
      errors.push("SpO2 must be 70–100%");
    } else {
      const spo2 = parseFloat(values.spo2);
      const severity = bloodOxygenValidations.spo2.getSeverity(values.spo2);
      const fio2Val = values.fio2 ? parseFloat(values.fio2) : 21;
      const fio2Valid =
        !values.fio2 || bloodOxygenValidations.fio2.isValid(values.fio2);

      if (values.fio2 && !fio2Valid) {
        errors.push("FiO2 must be 21–100%");
      } else {
        const ratio = bloodOxygenValidations.utils.calculateRatio(
          values.spo2,
          String(fio2Val),
        );

        results.bloodOxygen = {
          spo2,
          fio2: fio2Val,
          severity,
          ...(ratio && { spO2FiO2Ratio: parseFloat(ratio) }),
        };

        let label = `${spo2}%`;
        if (severity !== "normal") label += ` (${severity})`;
        if (fio2Val !== 21) label += ` on FiO2 ${fio2Val}%`;
        if (ratio) label += ` — SpO2/FiO2: ${ratio}`;
        humanRows.push(["SpO2", label]);
      }
    }
  } else if (values.fio2) {
    errors.push("--fio2 requires --spo2");
  }

  if (errors.length > 0) {
    process.stderr.write(errors.map((e) => formatError(e)).join("\n") + "\n");
    process.exitCode = 1;
    return;
  }

  printResult(results, values.json!, () => {
    return [formatHeader("Vital Signs"), formatTable(humanRows)].join("\n");
  });
};
