/**
 * Output formatters for CLI tools — human-readable and JSON.
 */

export const formatJson = (data: Record<string, unknown>): string => {
  return JSON.stringify(data, null, 2);
};

export const formatTable = (rows: [string, string][]): string => {
  const maxLabel = Math.max(...rows.map(([label]) => label.length));
  return rows
    .map(([label, value]) => `  ${label.padEnd(maxLabel)}  ${value}`)
    .join("\n");
};

export const formatHeader = (title: string): string => {
  return `\n${title}\n${"─".repeat(title.length)}`;
};

export const formatError = (message: string): string => {
  return `Error: ${message}`;
};

export const printResult = (
  data: Record<string, unknown>,
  json: boolean,
  humanFn: () => string,
): void => {
  if (json) {
    process.stdout.write(formatJson(data) + "\n");
  } else {
    process.stdout.write(humanFn() + "\n");
  }
};
