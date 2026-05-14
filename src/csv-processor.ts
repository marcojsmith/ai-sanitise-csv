import path from "node:path";
import Papa from "papaparse";

export interface ParsedCSV {
  headers: string[];
  rows: Record<string, string>[];
}

export async function readCSV(filePath: string): Promise<ParsedCSV> {
  const text = await Bun.file(filePath).text();
  const lines = text.split(/\r?\n/);

  // Find the header row: first line that contains 4+ comma-separated fields
  // (preamble lines are single-value metadata rows)
  let headerLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const parsed = Papa.parse<string[]>(lines[i]);
    if (parsed.data[0] && (parsed.data[0] as string[]).length >= 4) {
      headerLineIndex = i;
      break;
    }
  }
  if (headerLineIndex === -1) {
    throw new Error(
      "Could not find a header row (expected a line with 4 or more columns)",
    );
  }

  // Strip preamble - only parse from the header row onwards
  const csvContent = lines.slice(headerLineIndex).join("\n");

  const result = Papa.parse<Record<string, string>>(csvContent, {
    header: true,
    skipEmptyLines: true,
  });

  if (result.errors.length > 0) {
    const fatal = result.errors.filter(
      (e) => e.type === "Delimiter" || e.type === "Quotes",
    );
    if (fatal.length > 0) {
      throw new Error(
        `CSV parse errors: ${fatal.map((e) => e.message).join(", ")}`,
      );
    }
  }

  return {
    headers: result.meta.fields ?? [],
    rows: result.data,
  };
}

export async function writeCSV(
  filePath: string,
  data: ParsedCSV,
): Promise<string> {
  const outputPath = buildOutputPath(filePath);
  const csv = Papa.unparse(data.rows, { columns: data.headers });
  await Bun.write(outputPath, csv);
  return outputPath;
}

export function buildOutputPath(inputPath: string): string {
  const dir = path.dirname(inputPath);
  const ext = path.extname(inputPath);
  const base = path.basename(inputPath, ext);
  return path.join(dir, `${base}_sanitised${ext}`);
}
