export interface BloodPressureValue {
  systolic: number | null;
  diastolic: number | null;
}

export interface BloodPressureCategory {
  category: "High" | "Low" | "Normal";
}
