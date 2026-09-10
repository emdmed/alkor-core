export const bloodOxygenValidations = {
  spo2: {
    isValid: (value: string | number): boolean => {
      const num = parseFloat(String(value));
      return !isNaN(num) && num >= 70 && num <= 100;
    },

    isLow: (value: string | number): boolean => {
      const num = parseFloat(String(value));
      return !isNaN(num) && num < 95;
    },

    isCritical: (value: string | number): boolean => {
      const num = parseFloat(String(value));
      return !isNaN(num) && num < 90;
    },

    getErrorMessage: (value: string | number): string | null => {
      if (!value || value === "") return null;

      const num = parseFloat(String(value));
      if (isNaN(num)) return "Please enter a valid number";
      if (num < 70) return "SpO2 value must be at least 70%";
      if (num > 100) return "SpO2 value cannot exceed 100%";

      return null;
    },

    getSeverity: (value: string | number): "critical" | "low" | "normal" | "invalid" => {
      if (!bloodOxygenValidations.spo2.isValid(value)) return 'invalid';

      const num = parseFloat(String(value));
      if (num < 90) return 'critical';
      if (num < 95) return 'low';
      return 'normal';
    },

    MIN_VALUE: 70,
    MAX_VALUE: 100,
    LOW_THRESHOLD: 95,
    CRITICAL_THRESHOLD: 90
  },

  fio2: {
    isValid: (value: string | number): boolean => {
      const num = parseFloat(String(value));
      return !isNaN(num) && num >= 21 && num <= 100;
    },

    isSupplemental: (value: string | number): boolean => {
      const num = parseFloat(String(value));
      return !isNaN(num) && num > 21;
    },

    isRoomAir: (value: string | number): boolean => {
      const num = parseFloat(String(value));
      return !isNaN(num) && num === 21;
    },

    getErrorMessage: (value: string | number): string | null => {
      if (!value || value === "") return null;

      const num = parseFloat(String(value));
      if (isNaN(num)) return "Please enter a valid number";
      if (num < 21) return "FiO2 value must be at least 21%";
      if (num > 100) return "FiO2 value cannot exceed 100%";

      return null;
    },

    getDeliveryMethod: (value: string | number): string => {
      if (!bloodOxygenValidations.fio2.isValid(value)) return 'invalid';

      const num = parseFloat(String(value));
      if (num === 21) return 'room air';
      if (num <= 40) return 'low flow';
      return 'high flow';
    },

    MIN_VALUE: 21,
    MAX_VALUE: 100,
    DEFAULT_VALUE: 21,
    ROOM_AIR_VALUE: 21
  },

  utils: {
    toNumber: (value: string | number): number | null => {
      const num = parseFloat(String(value));
      return isNaN(num) ? null : num;
    },

    formatNumber: (value: string | number, decimals: number = 0): string => {
      const num = parseFloat(String(value));
      return isNaN(num) ? '' : num.toFixed(decimals);
    },

    isEmpty: (value: string | number | null | undefined): boolean => {
      return value === null || value === undefined || value === '';
    },

    calculateRatio: (spo2Value: string | number, fio2Value: string | number): string | null => {
      const spo2 = parseFloat(String(spo2Value));
      const fio2 = parseFloat(String(fio2Value));

      if (isNaN(spo2) || isNaN(fio2) || fio2 === 0) return null;

      return (spo2 / (fio2 / 100)).toFixed(0);
    }
  }
};

export const hasValidBloodOxygenInput = bloodOxygenValidations.spo2.isValid;
export const hasValidFio2Input = bloodOxygenValidations.fio2.isValid;

export const { spo2, fio2, utils } = bloodOxygenValidations;

/** @deprecated Use bloodOxygenValidations instead */
export const BloodOxygenValidations = bloodOxygenValidations;

export default bloodOxygenValidations;
