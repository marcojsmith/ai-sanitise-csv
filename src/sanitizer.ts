import { readCSV, writeCSV } from "./csv-processor";
import {
  checkOllamaHealth,
  defaultOllamaOptions,
  extractPIIFromSubjects,
  generateEntityMapping,
  scoreEntityConfidence,
  type EntityScore,
  type OllamaOptions,
} from "./ollama";
import { getCached, setCached } from "./entity-cache";

export type ProgressEvent =
  | { type: "started"; total: number; filePath: string; textColumns: string[] }
  | { type: "phase"; phase: "reading" | "extracting" | "scoring" | "mapping" | "applying" | "writing" }
  | { type: "llm_batch"; batch: number; total: number }
  | { type: "entities_start"; emails: string[] }
  | { type: "entities_found"; entities: string[] }
  | { type: "entities_scored"; scores: EntityScore[] }
  | { type: "review" }
  | { type: "row"; processed: number; total: number }
  | { type: "cancelled" }
  | { type: "done"; outputPath: string; elapsed: number }
  | { type: "error"; message: string };

export interface CancelToken { cancelled: boolean }

export interface EntityReviewRow {
  original: string;
  replacement: string;
  confidence: "high" | "medium" | "low";
  frequency: number;
  type: "person" | "company" | "email";
}

export interface RemapData {
  originalRows: Record<string, string>[];
  headers: string[];
  textColumns: string[];
  emailMap: Map<string, string>;
  filePath: string;
}

const EMAIL_REGEX = /[\w.+%-]+@[\w-]+\.[a-z]{2,}/gi;

function detectTextColumns(headers: string[], rows: Record<string, string>[]): string[] {
  const sample = rows.slice(0, 100);
  return headers.filter((col) => {
    const values = sample.map((r) => (r[col] ?? "").trim()).filter(Boolean);
    if (values.length === 0) return false;
    const avgLen = values.reduce((s, v) => s + v.length, 0) / values.length;
    const hasWords = values.some((v) => v.includes(" "));
    return avgLen > 30 && hasWords;
  });
}

function extractUniqueEmails(rows: Record<string, string>[], textColumns: string[]): Set<string> {
  const emails = new Set<string>();
  for (const row of rows) {
    for (const col of textColumns) {
      const matches = (row[col] ?? "").match(EMAIL_REGEX) ?? [];
      for (const m of matches) emails.add(m.toLowerCase());
    }
  }
  return emails;
}

function buildEmailMap(emails: Set<string>): Map<string, string> {
  const map = new Map<string, string>();
  let i = 1;
  for (const email of emails) {
    const [user] = email.split("@");
    map.set(email, `${user}${i}@example.com`);
    i++;
  }
  return map;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyAllReplacements(
  text: string,
  entityMap: Map<string, string>,
  emailMap: Map<string, string>
): string {
  let result = text;
  for (const [real, fake] of emailMap) {
    result = result.replace(new RegExp(escapeRegex(real), "gi"), fake);
  }
  for (const [real, fake] of entityMap) {
    result = result.replace(new RegExp(`\\b${escapeRegex(real)}\\b`, "gi"), fake);
  }
  return result;
}

function countFrequency(entity: string, rows: Record<string, string>[], textColumns: string[]): number {
  const re = new RegExp(`\\b${escapeRegex(entity)}\\b`, "gi");
  let count = 0;
  for (const row of rows) {
    for (const col of textColumns) {
      if (re.test(row[col] ?? "")) { count++; re.lastIndex = 0; }
    }
  }
  return count;
}

export async function runExtraction(
  filePath: string,
  emit: (event: ProgressEvent) => void,
  opts: OllamaOptions = defaultOllamaOptions,
  cancelToken: CancelToken = { cancelled: false }
): Promise<{ reviewRows: EntityReviewRow[]; emailRows: EntityReviewRow[]; remapData: RemapData }> {
  const healthy = await checkOllamaHealth(opts.baseUrl);
  if (!healthy) {
    throw new Error("Ollama is not reachable at " + opts.baseUrl + ". Please start Ollama and ensure the model is downloaded.");
  }

  emit({ type: "phase", phase: "reading" });
  const parsed = await readCSV(filePath);
  const textColumns = detectTextColumns(parsed.headers, parsed.rows);
  emit({ type: "started", total: parsed.rows.length, filePath, textColumns });

  emit({ type: "phase", phase: "extracting" });
  const uniqueEmails = extractUniqueEmails(parsed.rows, textColumns);
  const emailMap = buildEmailMap(uniqueEmails);

  const CHUNK_SIZE = 1000;
  const seen = new Set<string>();
  const textSamples: string[] = [];
  for (const row of parsed.rows) {
    for (const col of textColumns) {
      const val = (row[col] ?? "").trim();
      if (!val) continue;
      for (let i = 0; i < val.length; i += CHUNK_SIZE) {
        const chunk = val.slice(i, i + CHUNK_SIZE).trim();
        if (chunk && !seen.has(chunk)) {
          seen.add(chunk);
          textSamples.push(chunk);
        }
      }
    }
  }

  const SCAN_BATCH = 10;
  const scanBatches = Math.ceil(textSamples.length / SCAN_BATCH);
  const allEntities = new Set<string>();

  emit({ type: "entities_start", emails: Array.from(uniqueEmails).sort() });

  for (let b = 0; b < scanBatches; b++) {
    if (cancelToken.cancelled) { emit({ type: "cancelled" }); throw new Error("cancelled"); }
    emit({ type: "llm_batch", batch: b + 1, total: scanBatches });
    const batch = textSamples.slice(b * SCAN_BATCH, (b + 1) * SCAN_BATCH);

    const cachedResults: string[] = [];
    const uncachedChunks: string[] = [];
    for (const chunk of batch) {
      const cached = getCached(chunk);
      if (cached !== null) {
        cachedResults.push(...cached);
      } else {
        uncachedChunks.push(chunk);
      }
    }

    let found: string[] = [...cachedResults];
    if (uncachedChunks.length > 0) {
      const fromOllama = await extractPIIFromSubjects(uncachedChunks, opts);
      for (const chunk of uncachedChunks) {
        setCached(chunk, fromOllama);
      }
      found.push(...fromOllama);
    }

    const newEntities = found.filter(e => !allEntities.has(e));
    for (const e of newEntities) allEntities.add(e);
    if (newEntities.length > 0) emit({ type: "entities_found", entities: newEntities.sort() });
  }

  if (allEntities.size === 0) {
    emit({ type: "entities_found", entities: [] });
  }

  emit({ type: "phase", phase: "scoring" });
  const scores = await scoreEntityConfidence(Array.from(allEntities), opts);
  if (cancelToken.cancelled) { emit({ type: "cancelled" }); throw new Error("cancelled"); }
  emit({ type: "entities_scored", scores });

  const scoreMap = new Map(scores.map(s => [s.entity, s.confidence]));

  const reviewRows: EntityReviewRow[] = [];
  for (const entity of Array.from(allEntities).sort()) {
    const frequency = countFrequency(entity, parsed.rows, textColumns);
    reviewRows.push({
      original: entity,
      replacement: "",
      confidence: scoreMap.get(entity) ?? "medium",
      frequency,
      type: "person"
    });
  }

  const emailRows: EntityReviewRow[] = [];
  for (const [email, replacement] of emailMap) {
    const frequency = countFrequency(email, parsed.rows, textColumns);
    emailRows.push({
      original: email,
      replacement,
      confidence: "high",
      frequency,
      type: "email"
    });
  }
  emailRows.sort((a, b) => b.frequency - a.frequency);

  const remapData: RemapData = {
    originalRows: parsed.rows.map(r => ({ ...r })),
    headers: parsed.headers,
    textColumns,
    emailMap,
    filePath,
  };

  emit({ type: "review" });

  return { reviewRows, emailRows, remapData };
}

export async function runMappingAndApply(
  approvedRows: EntityReviewRow[],
  approvedEmails: EntityReviewRow[],
  remapData: RemapData,
  emit: (event: ProgressEvent) => void,
  opts: OllamaOptions = defaultOllamaOptions,
  cancelToken: CancelToken = { cancelled: false }
): Promise<{ content: string; outputFilename: string; elapsed: number }> {
  const startedAt = Date.now();

  try {
    emit({ type: "phase", phase: "mapping" });

    const entityList = approvedRows.map(r => r.original);
    const entityMap = await generateEntityMapping(entityList, opts, (batch, total) => {
      emit({ type: "llm_batch", batch, total });
    }, cancelToken);

    for (const row of approvedRows) {
      if (row.replacement && row.replacement.trim() !== "") {
        entityMap.set(row.original, row.replacement);
      }
    }

    if (cancelToken.cancelled) { emit({ type: "cancelled" }); throw new Error("cancelled"); }

    emit({ type: "phase", phase: "applying" });
    const rows = remapData.originalRows.map(r => ({ ...r }));
    let processed = 0;
    const REPORT_EVERY = 50;

    for (const row of rows) {
      if (cancelToken.cancelled) { emit({ type: "cancelled" }); throw new Error("cancelled"); }
      for (const col of remapData.textColumns) {
        if (row[col]) {
          row[col] = applyAllReplacements(row[col], entityMap, remapData.emailMap);
        }
      }
      processed++;
      if (processed % REPORT_EVERY === 0 || processed === rows.length) {
        emit({ type: "row", processed, total: rows.length });
      }
    }

    emit({ type: "phase", phase: "writing" });
    const outputPath = await writeCSV(remapData.filePath, { headers: remapData.headers, rows });
    const content = await Bun.file(outputPath).text();
    const { unlinkSync } = await import("fs");
    try { unlinkSync(outputPath); } catch { /* ignore */ }

    const baseName = remapData.filePath.split(/[\\/]/).pop()?.replace(/\.csv$/i, "") ?? "file";
    const outputFilename = `${baseName}_sanitised.csv`;

    emit({ type: "done", outputPath, elapsed: Date.now() - startedAt });

    return { content, outputFilename, elapsed: Date.now() - startedAt };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: "error", message });
    throw err;
  }
}