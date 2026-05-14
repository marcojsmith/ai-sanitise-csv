import path from "node:path";
import { readCSV, writeCSV } from "./csv-processor";
import { getCached, setCached } from "./entity-cache";
import {
  checkOllamaHealth,
  defaultOllamaOptions,
  type EntityScore,
  extractPIIFromSubjects,
  generateEntityMapping,
  type OllamaOptions,
  scoreEntityConfidence,
} from "./ollama";

export type ProgressEvent =
  | { type: "started"; total: number; filePath: string; textColumns: string[] }
  | {
      type: "phase";
      phase:
        | "reading"
        | "extracting"
        | "scoring"
        | "mapping"
        | "applying"
        | "writing";
    }
  | { type: "llm_batch"; batch: number; total: number }
  | { type: "entities_start"; emails: string[] }
  | { type: "entities_found"; entities: string[] }
  | { type: "entities_scored"; scores: EntityScore[] }
  | { type: "review" }
  | { type: "row"; processed: number; total: number }
  | { type: "cancelled" }
  | { type: "done"; outputPath: string; elapsed: number }
  | { type: "error"; message: string };

export interface CancelToken {
  cancelled: boolean;
}

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
  originalFilename: string;
}

const EMAIL_REGEX = /[\w.+%-]+@[\w-]+\.[a-z]{2,}/gi;

function detectTextColumns(
  headers: string[],
  rows: Record<string, string>[],
): string[] {
  const sample = rows.slice(0, 100);
  return headers.filter((col) => {
    const values = sample.map((r) => (r[col] ?? "").trim()).filter(Boolean);
    if (values.length === 0) return false;
    const avgLen = values.reduce((s, v) => s + v.length, 0) / values.length;
    const hasWords = values.some((v) => v.includes(" "));
    return avgLen > 30 && hasWords;
  });
}

export function extractUniqueEmails(
  rows: Record<string, string>[],
  textColumns: string[],
): Set<string> {
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

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function applyAllReplacements(
  text: string,
  entityMap: Map<string, string>,
  emailMap: Map<string, string>,
): string {
  let result = text;
  for (const [real, fake] of emailMap) {
    result = result.replace(new RegExp(escapeRegex(real), "gi"), fake);
  }
  for (const [real, fake] of entityMap) {
    result = result.replace(
      new RegExp(`\\b${escapeRegex(real)}\\b`, "gi"),
      fake,
    );
  }
  return result;
}

function buildFrequencyMap(
  entities: string[],
  rows: Record<string, string>[],
  textColumns: string[],
): Map<string, number> {
  const counts = new Map<string, number>(entities.map((e) => [e, 0]));
  const patterns = new Map(
    entities.map((e) => [e, new RegExp(`\\b${escapeRegex(e)}\\b`, "gi")]),
  );
  for (const row of rows) {
    for (const col of textColumns) {
      const val = row[col] ?? "";
      if (!val) continue;
      for (const [entity, re] of patterns) {
        re.lastIndex = 0;
        if (re.test(val)) counts.set(entity, (counts.get(entity) ?? 0) + 1);
      }
    }
  }
  return counts;
}

export async function runExtraction(
  filePath: string,
  originalFilename: string,
  emit: (event: ProgressEvent) => void,
  opts: OllamaOptions = defaultOllamaOptions,
  cancelToken: CancelToken = { cancelled: false },
): Promise<{
  reviewRows: EntityReviewRow[];
  emailRows: EntityReviewRow[];
  remapData: RemapData;
}> {
  const healthy = await checkOllamaHealth(opts.baseUrl);
  if (!healthy) {
    throw new Error(
      "Ollama is not reachable at " +
        opts.baseUrl +
        ". Please start Ollama and ensure the model is downloaded.",
    );
  }

  emit({ type: "phase", phase: "reading" });
  const parsed = await readCSV(filePath);
  const textColumns = detectTextColumns(parsed.headers, parsed.rows);
  if (textColumns.length === 0) {
    const summary = parsed.headers
      .map((h) => {
        const sample = parsed.rows
          .slice(0, 100)
          .map((r) => (r[h] ?? "").trim())
          .filter(Boolean);
        const avgLen =
          sample.length > 0
            ? Math.round(
                sample.reduce((s, v) => s + v.length, 0) / sample.length,
              )
            : 0;
        const hasWords = sample.some((v) => v.includes(" "));
        return `  "${h}": avgLen=${avgLen}, hasWords=${hasWords}`;
      })
      .join("\n");
    throw new Error(
      `No text columns detected. Columns need avgLen > 30 and contain spaces.\n` +
        `Column analysis:\n${summary}`,
    );
  }
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
    if (cancelToken.cancelled) {
      emit({ type: "cancelled" });
      throw new Error("cancelled");
    }
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

    const found: string[] = [...cachedResults];
    for (const chunk of uncachedChunks) {
      const chunkEntities = await extractPIIFromSubjects([chunk], opts);
      setCached(chunk, chunkEntities);
      found.push(...chunkEntities);
    }

    const newEntities = found.filter((e) => !allEntities.has(e));
    for (const e of newEntities) allEntities.add(e);
    if (newEntities.length > 0)
      emit({ type: "entities_found", entities: newEntities.sort() });
  }

  if (allEntities.size === 0) {
    emit({ type: "entities_found", entities: [] });
  }

  emit({ type: "phase", phase: "scoring" });
  const scores = await scoreEntityConfidence(Array.from(allEntities), opts);
  if (cancelToken.cancelled) {
    emit({ type: "cancelled" });
    throw new Error("cancelled");
  }
  emit({ type: "entities_scored", scores });

  const scoreMap = new Map(scores.map((s) => [s.entity, s]));

  const allEntitiesArr = Array.from(allEntities);
  const allEmailsArr = Array.from(emailMap.keys());
  const freqMap = buildFrequencyMap(
    [...allEntitiesArr, ...allEmailsArr],
    parsed.rows,
    textColumns,
  );

  const reviewRows: EntityReviewRow[] = [];
  for (const entity of allEntitiesArr.sort()) {
    const frequency = freqMap.get(entity) ?? 0;
    const score = scoreMap.get(entity);
    reviewRows.push({
      original: entity,
      replacement: "",
      confidence: score?.confidence ?? "medium",
      frequency,
      type: score?.type ?? "person",
    });
  }

  const emailRows: EntityReviewRow[] = [];
  for (const [email, replacement] of emailMap) {
    const frequency = freqMap.get(email) ?? 0;
    emailRows.push({
      original: email,
      replacement,
      confidence: "high",
      frequency,
      type: "email",
    });
  }
  emailRows.sort((a, b) => b.frequency - a.frequency);

  const remapData: RemapData = {
    originalRows: parsed.rows.map((r) => ({ ...r })),
    headers: parsed.headers,
    textColumns,
    emailMap,
    filePath,
    originalFilename,
  };

  emit({ type: "review" });

  return { reviewRows, emailRows, remapData };
}

export async function runMappingAndApply(
  approvedRows: EntityReviewRow[],
  _approvedEmails: EntityReviewRow[],
  remapData: RemapData,
  emit: (event: ProgressEvent) => void,
  opts: OllamaOptions = defaultOllamaOptions,
  cancelToken: CancelToken = { cancelled: false },
): Promise<{ content: string; outputFilename: string; elapsed: number }> {
  const startedAt = Date.now();

  try {
    emit({ type: "phase", phase: "mapping" });

    const entityList = approvedRows.map((r) => r.original);
    const entityMap = await generateEntityMapping(
      entityList,
      opts,
      (batch, total) => {
        emit({ type: "llm_batch", batch, total });
      },
      cancelToken,
    );

    for (const row of approvedRows) {
      if (row.replacement && row.replacement.trim() !== "") {
        entityMap.set(row.original, row.replacement);
      }
    }

    if (cancelToken.cancelled) {
      emit({ type: "cancelled" });
      throw new Error("cancelled");
    }

    emit({ type: "phase", phase: "applying" });
    const rows = remapData.originalRows.map((r) => ({ ...r }));
    let processed = 0;
    const REPORT_EVERY = 50;

    for (const row of rows) {
      if (cancelToken.cancelled) {
        emit({ type: "cancelled" });
        throw new Error("cancelled");
      }
      for (const col of remapData.textColumns) {
        if (row[col]) {
          row[col] = applyAllReplacements(
            row[col],
            entityMap,
            remapData.emailMap,
          );
        }
      }
      processed++;
      if (processed % REPORT_EVERY === 0 || processed === rows.length) {
        emit({ type: "row", processed, total: rows.length });
      }
    }

    emit({ type: "phase", phase: "writing" });
    const outputPath = await writeCSV(remapData.filePath, {
      headers: remapData.headers,
      rows,
    });
    const content = await Bun.file(outputPath).text();
    const { unlinkSync } = await import("node:fs");
    try {
      unlinkSync(outputPath);
    } catch {
      /* ignore */
    }

    const baseName = path.basename(
      remapData.originalFilename,
      path.extname(remapData.originalFilename),
    );
    const outputFilename = `${baseName}_sanitised.csv`;

    emit({ type: "done", outputPath, elapsed: Date.now() - startedAt });

    return { content, outputFilename, elapsed: Date.now() - startedAt };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: "error", message });
    throw err;
  }
}
