/**
 * Barrel export for all lib/ calculation modules.
 * Provides a single import point: import { calculateBMI, analyze, ... } from '../lib/index.ts';
 */

export { safeParseFloat, safeParseFloatOrNull } from "./utils/safeParseFloat.ts";

export { calculateBMI, getBMICategory } from "./bmi.ts";

export { calculatePaFi, getPaFiClassification, getPaFiSeverity } from "./pafi.ts";

export {
  calculateInsensibleLoss,
  calculateEndogenousGeneration,
  calculateDefecationLoss,
  calculateWaterBalance,
} from "./water-balance.ts";

export { analyze } from "./acid-base/index.ts";
export type { ABGValues, ABGResult } from "./acid-base/index.ts";

export type {
  ASCVDInputs,
  HEARTInputs,
  CHADSVAScInputs,
} from "./cardiology-types.ts";

export {
  calculateASCVD,
  getASCVDCategory,
  getASCVDSeverity,
  calculateHEARTScore,
  getHEARTCategory,
  getHEARTAction,
  getHEARTSeverity,
  calculateCHADSVASc,
  getCHADSVAScCategory,
  getCHADSVAScAction,
  getCHADSVAScSeverity,
} from "./cardiology.ts";

export {
  calculateGlucoseReductionRate,
  isGlucoseOnTarget,
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
  assessDKAResolution,
  suggestInsulinAdjustment,
} from "./dka.ts";

export {
  calculateRespirationSOFA,
  calculateCoagulationSOFA,
  calculateLiverSOFA,
  calculateCardiovascularSOFA,
  calculateCNSSOFA,
  calculateRenalSOFA,
  calculateTotalSOFA,
  calculateSOFADelta,
  calculateQSOFA,
  isQSOFAPositive,
  assessSepsis,
  assessSepticShock,
  assessBundleCompliance,
  calculateLactateClearance,
  isLactateClearanceAdequate,
  getSOFASeverityLevel,
  getSOFASeverity,
  hasVasopressors,
} from "./sepsis.ts";

export {
  calculateEGFR,
  classifyGFRCategory,
  getGFRCategoryLabel,
  classifyAlbuminuriaCategory,
  getAlbuminuriaCategoryLabel,
  getCKDRiskLevel,
  getMonitoringFrequency,
  calculateKFRE,
  assessReferralNeed,
  checkRASiEligibility,
  checkSGLT2iEligibility,
  checkFinerenoneEligibility,
  calculateEGFRSlope,
  isRapidDecline,
  hasSignificantEGFRChange,
  hasACRDoubling,
  classifyAnemia,
  assessIronStatus,
  checkESAEligibility,
  assessPhosphate,
  correctCalcium,
  assessPTH,
  assessVitaminD,
  getCKDMBDMonitoring,
  getCKDSeverity,
} from "./ckd.ts";
