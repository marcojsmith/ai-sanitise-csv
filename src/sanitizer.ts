import { readCSV, writeCSV } from "./csv-processor";
import {
  checkOllamaHealth,
  defaultOllamaOptions,
  extractPIIFromSubjects,
  generateEntityMapping,
  type OllamaOptions,
} from "./ollama";

export type ProgressEvent =
  | { type: "started"; total: number; filePath: string; textColumns: string[] }
  | { type: "phase"; phase: "reading" | "extracting" | "mapping" | "applying" | "writing" }
  | { type: "llm_batch"; batch: number; total: number }
  | { type: "entities_start"; emails: string[] }
  | { type: "entities_found"; entities: string[] }
  | { type: "review" }
  | { type: "row"; processed: number; total: number }
  | { type: "cancelled" }
  | { type: "done"; outputPath: string; elapsed: number }
  | { type: "error"; message: string };

export interface CancelToken { cancelled: boolean }

export interface SanitisationJob {
  jobId: string;
  filePath: string;
  status: "pending" | "running" | "done" | "error";
  outputPath?: string;
  errorMessage?: string;
  startedAt: number;
}

/** Stored after extraction so mapping can be re-run without re-reading the file. */
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

/** Re-runs only the mapping + applying + writing phases using previously stored data. */
export async function remapAndApply(
  remapData: RemapData,
  entities: string[],
  emit: (event: ProgressEvent) => void,
  opts: OllamaOptions = defaultOllamaOptions,
  cancelToken: CancelToken = { cancelled: false }
): Promise<void> {
  const startedAt = Date.now();
  try {
    emit({ type: "phase", phase: "mapping" });
    const entityMap = await generateEntityMapping(entities, opts, (batch, total) => {
      emit({ type: "llm_batch", batch, total });
    }, cancelToken);

    if (cancelToken.cancelled) { emit({ type: "cancelled" }); return; }

    emit({ type: "phase", phase: "applying" });
    // Work on a fresh deep copy so repeated remaps always start from the original
    const rows = remapData.originalRows.map(r => ({ ...r }));
    let processed = 0;
    const REPORT_EVERY = 50;

    for (const row of rows) {
      if (cancelToken.cancelled) { emit({ type: "cancelled" }); return; }
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

    emit({ type: "done", outputPath, elapsed: Date.now() - startedAt });
  } catch (err) {
    emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}

export async function runSanitisation(
  job: SanitisationJob,
  emit: (event: ProgressEvent) => void,
  opts: OllamaOptions = defaultOllamaOptions,
  waitForConfirmation: () => Promise<string[]> = () => Promise.resolve([]),
  onRemapReady: (data: RemapData) => void = () => {},
  cancelToken: CancelToken = { cancelled: false }
): Promise<void> {
  const startedAt = Date.now();

  try {
    const healthy = await checkOllamaHealth(opts.baseUrl);
    if (!healthy) {
      emit({ type: "error", message: "Ollama is not reachable at " + opts.baseUrl + ". Please start Ollama and ensure the model is downloaded." });
      job.status = "error";
      return;
    }

    emit({ type: "phase", phase: "reading" });
    const parsed = await readCSV(job.filePath);
    const textColumns = detectTextColumns(parsed.headers, parsed.rows);
    emit({ type: "started", total: parsed.rows.length, filePath: job.filePath, textColumns });

    emit({ type: "phase", phase: "extracting" });
    const uniqueEmails = extractUniqueEmails(parsed.rows, textColumns);
    const emailMap = buildEmailMap(uniqueEmails);

    // Break every text cell into ≤500-char chunks so long email threads don't
    // overwhelm Ollama. Deduplicate to avoid scanning identical boilerplate repeatedly.
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
      if (cancelToken.cancelled) { emit({ type: "cancelled" }); return; }
      emit({ type: "llm_batch", batch: b + 1, total: scanBatches });
      const batch = textSamples.slice(b * SCAN_BATCH, (b + 1) * SCAN_BATCH);
      const found = await extractPIIFromSubjects(batch, opts);
      const newEntities = found.filter(e => !allEntities.has(e));
      for (const e of newEntities) allEntities.add(e);
      if (newEntities.length > 0) {
        emit({ type: "entities_found", entities: newEntities.sort() });
      }
    }

    if (allEntities.size === 0) {
      emit({ type: "entities_found", entities: [] });
    }

    // Store original rows (deep copy) before any replacements
    const remapData: RemapData = {
      originalRows: parsed.rows.map(r => ({ ...r })),
      headers: parsed.headers,
      textColumns,
      emailMap,
      filePath: job.filePath,
    };
    onRemapReady(remapData);

    emit({ type: "review" });
    const confirmedEntities = await waitForConfirmation();

    if (cancelToken.cancelled) { emit({ type: "cancelled" }); return; }

    emit({ type: "phase", phase: "mapping" });
    const entityMap = await generateEntityMapping(confirmedEntities, opts, (batch, total) => {
      emit({ type: "llm_batch", batch, total });
    }, cancelToken);

    emit({ type: "phase", phase: "applying" });
    let processed = 0;
    const REPORT_EVERY = 50;

    for (const row of parsed.rows) {
      if (cancelToken.cancelled) { emit({ type: "cancelled" }); return; }
      for (const col of textColumns) {
        if (row[col]) {
          row[col] = applyAllReplacements(row[col], entityMap, emailMap);
        }
      }
      processed++;
      if (processed % REPORT_EVERY === 0 || processed === parsed.rows.length) {
        emit({ type: "row", processed, total: parsed.rows.length });
      }
    }

    emit({ type: "phase", phase: "writing" });
    const outputPath = await writeCSV(job.filePath, parsed);

    job.status = "done";
    job.outputPath = outputPath;
    emit({ type: "done", outputPath, elapsed: Date.now() - startedAt });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    job.status = "error";
    job.errorMessage = message;
    emit({ type: "error", message });
  }
}
