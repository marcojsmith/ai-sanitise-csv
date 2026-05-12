# Task: CSV PII Sanitiser with Ollama

## Context

Project root: `C:\Users\marco\Projects\ai-sanitise-csv`

No package.json exists yet. Runtime is Bun. The example CSV is at `example-csv/tickets_report_2026-05-12.csv`.

The CSV file has a 5-line preamble before the actual column headers. Line 6 starts with `"Assignee"` and is the real header row. The preamble must be completely stripped from the output.

PII columns:
- `Assignee` — person name
- `Owner` — person name
- `Subject` — free text that may contain person names, company names, email addresses

Ollama runs at `http://localhost:11434`, model `gemma4:latest`. Use `POST /api/generate` with `stream: false`.

## Instructions

1. **Create `package.json`** at project root:
```json
{
  "name": "ai-sanitise-csv",
  "version": "1.0.0",
  "scripts": {
    "dev": "bun run --watch src/server.ts",
    "start": "bun run src/server.ts"
  },
  "dependencies": {
    "hono": "latest",
    "papaparse": "latest"
  },
  "devDependencies": {
    "@types/papaparse": "latest",
    "bun-types": "latest"
  }
}
```

2. **Create `tsconfig.json`** at project root:
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
```

3. **Create `src/csv-processor.ts`**:

```ts
import Papa from "papaparse";
import path from "path";

export interface ParsedCSV {
  headers: string[];
  rows: Record<string, string>[];
}

export async function readCSV(filePath: string): Promise<ParsedCSV> {
  const text = await Bun.file(filePath).text();
  const lines = text.split(/\r?\n/);

  // Find the header row: first line that starts with "Assignee" (quoted or not)
  let headerLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].replace(/^"/, "");
    if (stripped.startsWith("Assignee")) {
      headerLineIndex = i;
      break;
    }
  }
  if (headerLineIndex === -1) {
    throw new Error('Could not find header row starting with "Assignee"');
  }

  // Strip preamble - only parse from the header row onwards
  const csvContent = lines.slice(headerLineIndex).join("\n");

  const result = Papa.parse<Record<string, string>>(csvContent, {
    header: true,
    skipEmptyLines: true,
  });

  if (result.errors.length > 0) {
    const fatal = result.errors.filter((e) => e.type === "Delimiter" || e.type === "Quotes");
    if (fatal.length > 0) {
      throw new Error(`CSV parse errors: ${fatal.map((e) => e.message).join(", ")}`);
    }
  }

  return {
    headers: result.meta.fields ?? [],
    rows: result.data,
  };
}

export async function writeCSV(filePath: string, data: ParsedCSV): Promise<string> {
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
```

4. **Create `src/ollama.ts`**:

```ts
export interface OllamaOptions {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export const defaultOllamaOptions: OllamaOptions = {
  baseUrl: "http://localhost:11434",
  model: "gemma4:latest",
  timeoutMs: 120000,
};

export async function checkOllamaHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ask Ollama to generate fake replacements for a batch of real names.
 * Returns a map of { "Real Name": "Fake Name" }.
 */
export async function generateNameMapping(
  names: string[],
  opts: OllamaOptions
): Promise<Record<string, string>> {
  const prompt = `You are a data anonymisation assistant. Replace each real person name with a realistic but entirely fictitious name of similar cultural origin.
Return ONLY a JSON object mapping each input name to its replacement.
Do not add any explanation, markdown code fences, or extra keys.

Input names:
${JSON.stringify(names)}

Output format (strict JSON, no markdown):
{"Name One": "Fake Name One", "Name Two": "Fake Name Two"}`;

  return await callOllamaForJSON(prompt, opts);
}

/**
 * Ask Ollama to extract company names from a list of subject lines,
 * then return fake replacements for each unique company found.
 */
export async function extractAndMapCompanies(
  subjects: string[],
  opts: OllamaOptions
): Promise<Record<string, string>> {
  // Step 1: extract unique company names from subjects
  const extractPrompt = `You are a data anonymisation assistant. From the following list of support ticket subject lines, identify any real company or organisation names that appear.
Return ONLY a JSON array of unique company name strings. If no company names are found, return [].
Do not include generic software product names (e.g. "Salesforce", "SAP") unless they are clearly used as an organisation name.

Subjects:
${JSON.stringify(subjects.slice(0, 200))}

Output (strict JSON array, no markdown):
["Company A", "Company B"]`;

  let companies: string[] = [];
  try {
    const raw = await callOllamaRaw(extractPrompt, opts);
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      companies = parsed.filter((c): c is string => typeof c === "string" && c.trim().length > 0);
    }
  } catch {
    return {};
  }

  if (companies.length === 0) return {};

  // Step 2: generate fake replacements for extracted companies
  const mapPrompt = `You are a data anonymisation assistant. Replace each real company or organisation name with a realistic but entirely fictitious company name.
Return ONLY a JSON object mapping each input name to its replacement.
Do not add any explanation, markdown code fences, or extra keys.

Input company names:
${JSON.stringify(companies)}

Output format (strict JSON, no markdown):
{"Real Co": "Fake Co"}`;

  try {
    return await callOllamaForJSON(mapPrompt, opts);
  } catch {
    // Fallback: generate deterministic replacements
    const map: Record<string, string> = {};
    companies.forEach((c, i) => { map[c] = `Acme Corp ${i + 1}`; });
    return map;
  }
}

async function callOllamaRaw(prompt: string, opts: OllamaOptions): Promise<string> {
  const res = await fetch(`${opts.baseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: opts.model, prompt, stream: false }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
  }
  const data = await res.json() as { response: string };
  return data.response.trim();
}

async function callOllamaForJSON(prompt: string, opts: OllamaOptions): Promise<Record<string, string>> {
  let raw = await callOllamaRaw(prompt, opts);

  // Strip markdown code fences if present
  raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    // Retry once with stricter instruction
    const retryPrompt = `${prompt}\n\nIMPORTANT: Your previous response was not valid JSON. Return ONLY the raw JSON object with no extra text.`;
    const retryRaw = (await callOllamaRaw(retryPrompt, opts))
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    try {
      return JSON.parse(retryRaw) as Record<string, string>;
    } catch {
      return {};
    }
  }
}
```

5. **Create `src/sanitizer.ts`**:

```ts
import { readCSV, writeCSV } from "./csv-processor";
import {
  checkOllamaHealth,
  defaultOllamaOptions,
  extractAndMapCompanies,
  generateNameMapping,
  type OllamaOptions,
} from "./ollama";

export type ProgressEvent =
  | { type: "started"; total: number; filePath: string }
  | { type: "phase"; phase: "reading" | "extracting" | "mapping" | "applying" | "writing" }
  | { type: "llm_batch"; batch: number; total: number }
  | { type: "row"; processed: number; total: number }
  | { type: "done"; outputPath: string; elapsed: number }
  | { type: "error"; message: string };

export interface SanitisationJob {
  jobId: string;
  filePath: string;
  status: "pending" | "running" | "done" | "error";
  outputPath?: string;
  errorMessage?: string;
  startedAt: number;
}

const EMAIL_REGEX = /[\w.+%-]+@[\w-]+\.[a-z]{2,}/gi;

function extractUniqueNames(rows: Record<string, string>[]): Set<string> {
  const names = new Set<string>();
  for (const row of rows) {
    const assignee = row["Assignee"]?.trim();
    const owner = row["Owner"]?.trim();
    if (assignee) names.add(assignee);
    if (owner) names.add(owner);
  }
  return names;
}

function extractUniqueEmails(rows: Record<string, string>[]): Set<string> {
  const emails = new Set<string>();
  for (const row of rows) {
    const subject = row["Subject"] ?? "";
    const matches = subject.match(EMAIL_REGEX) ?? [];
    for (const m of matches) emails.add(m.toLowerCase());
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

function applyAllReplacements(
  text: string,
  nameMap: Map<string, string>,
  emailMap: Map<string, string>,
  companyMap: Map<string, string>
): string {
  let result = text;
  // Apply email replacements first (more specific)
  for (const [real, fake] of emailMap) {
    result = result.split(real).join(fake);
  }
  // Apply company replacements
  for (const [real, fake] of companyMap) {
    result = result.split(real).join(fake);
  }
  // Apply name replacements
  for (const [real, fake] of nameMap) {
    result = result.split(real).join(fake);
  }
  return result;
}

export async function runSanitisation(
  job: SanitisationJob,
  emit: (event: ProgressEvent) => void,
  opts: OllamaOptions = defaultOllamaOptions
): Promise<void> {
  const startedAt = Date.now();

  try {
    // Health check
    const healthy = await checkOllamaHealth(opts.baseUrl);
    if (!healthy) {
      emit({ type: "error", message: "Ollama is not reachable at " + opts.baseUrl + ". Please start Ollama and ensure the model is downloaded." });
      job.status = "error";
      return;
    }

    // Phase: reading
    emit({ type: "phase", phase: "reading" });
    const parsed = await readCSV(job.filePath);
    emit({ type: "started", total: parsed.rows.length, filePath: job.filePath });

    // Phase: extracting
    emit({ type: "phase", phase: "extracting" });
    const uniqueNames = extractUniqueNames(parsed.rows);
    const uniqueEmails = extractUniqueEmails(parsed.rows);
    const emailMap = buildEmailMap(uniqueEmails);
    const subjectSample = parsed.rows.map((r) => r["Subject"] ?? "").filter(Boolean);

    // Phase: mapping
    emit({ type: "phase", phase: "mapping" });

    // Build name map via Ollama (batches of 20)
    const nameArray = Array.from(uniqueNames);
    const nameMap = new Map<string, string>();
    const batchSize = 20;
    const batches = Math.ceil(nameArray.length / batchSize);

    for (let b = 0; b < batches; b++) {
      emit({ type: "llm_batch", batch: b + 1, total: batches });
      const batch = nameArray.slice(b * batchSize, (b + 1) * batchSize);
      const mapping = await generateNameMapping(batch, opts);
      // Fill in fallback for any missing
      for (let i = 0; i < batch.length; i++) {
        const real = batch[i];
        nameMap.set(real, mapping[real] ?? `Person_${nameMap.size + 1}`);
      }
    }

    // Extract and map company names from subjects
    const companyMapping = await extractAndMapCompanies(subjectSample, opts);
    const companyMap = new Map(Object.entries(companyMapping));

    // Phase: applying
    emit({ type: "phase", phase: "applying" });
    let processed = 0;
    const REPORT_EVERY = 50;

    for (const row of parsed.rows) {
      const assignee = row["Assignee"]?.trim();
      const owner = row["Owner"]?.trim();

      if (assignee) row["Assignee"] = nameMap.get(assignee) ?? assignee;
      if (owner) row["Owner"] = nameMap.get(owner) ?? owner;

      const subject = row["Subject"];
      if (subject) {
        row["Subject"] = applyAllReplacements(subject, nameMap, emailMap, companyMap);
      }

      processed++;
      if (processed % REPORT_EVERY === 0 || processed === parsed.rows.length) {
        emit({ type: "row", processed, total: parsed.rows.length });
      }
    }

    // Phase: writing
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
```

6. **Create `src/server.ts`**:

```ts
import { Hono } from "hono";
import { readFileSync } from "fs";
import path from "path";
import { runSanitisation, type ProgressEvent, type SanitisationJob } from "./sanitizer";
import { defaultOllamaOptions } from "./ollama";

const app = new Hono();

// In-memory job store
const jobs = new Map<string, SanitisationJob>();
const jobListeners = new Map<string, Array<(event: ProgressEvent) => void>>();

function generateJobId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// Serve UI
app.get("/", (c) => {
  const html = readFileSync(path.join(import.meta.dir, "../public/index.html"), "utf-8");
  return c.html(html);
});

// Start sanitisation job
app.post("/api/sanitise", async (c) => {
  const body = await c.req.json<{ filePath?: string }>();
  const filePath = body?.filePath?.trim();
  if (!filePath) {
    return c.json({ error: "filePath is required" }, 400);
  }

  // Quick existence check
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return c.json({ error: `File not found: ${filePath}` }, 400);
  }

  const jobId = generateJobId();
  const job: SanitisationJob = {
    jobId,
    filePath,
    status: "pending",
    startedAt: Date.now(),
  };
  jobs.set(jobId, job);
  jobListeners.set(jobId, []);

  // Run in background
  job.status = "running";
  runSanitisation(job, (event) => {
    const listeners = jobListeners.get(jobId) ?? [];
    for (const listener of listeners) {
      listener(event);
    }
  }, defaultOllamaOptions).catch(console.error);

  return c.json({ jobId }, 202);
});

// SSE progress stream
app.get("/api/progress/:jobId", (c) => {
  const jobId = c.req.param("jobId");
  const job = jobs.get(jobId);
  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: ProgressEvent) => {
        const data = `data: ${JSON.stringify(event)}\n\n`;
        controller.enqueue(new TextEncoder().encode(data));
        if (event.type === "done" || event.type === "error") {
          controller.close();
          const listeners = jobListeners.get(jobId) ?? [];
          const idx = listeners.indexOf(send);
          if (idx !== -1) listeners.splice(idx, 1);
        }
      };

      // If job already finished, send terminal event immediately
      if (job.status === "done" && job.outputPath) {
        send({ type: "done", outputPath: job.outputPath, elapsed: Date.now() - job.startedAt });
        return;
      }
      if (job.status === "error") {
        send({ type: "error", message: job.errorMessage ?? "Unknown error" });
        return;
      }

      const listeners = jobListeners.get(jobId) ?? [];
      listeners.push(send);
      jobListeners.set(jobId, listeners);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

// Job status fallback
app.get("/api/jobs/:jobId", (c) => {
  const job = jobs.get(c.req.param("jobId"));
  if (!job) return c.json({ error: "Not found" }, 404);
  return c.json(job);
});

const port = 3000;
console.log(`CSV Sanitiser running at http://localhost:${port}`);
export default { port, fetch: app.fetch };
```

7. **Create `public/index.html`** — a clean, modern single-page UI:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CSV PII Sanitiser</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .card {
      background: #1e293b;
      border-radius: 12px;
      padding: 2rem;
      width: 100%;
      max-width: 680px;
      box-shadow: 0 4px 32px rgba(0,0,0,0.4);
    }
    h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 0.25rem; color: #f1f5f9; }
    .subtitle { font-size: 0.85rem; color: #94a3b8; margin-bottom: 1.5rem; }
    label { display: block; font-size: 0.8rem; color: #94a3b8; margin-bottom: 0.4rem; }
    input[type="text"] {
      width: 100%;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 6px;
      padding: 0.6rem 0.8rem;
      color: #f1f5f9;
      font-size: 0.9rem;
      outline: none;
      transition: border-color 0.2s;
    }
    input[type="text"]:focus { border-color: #6366f1; }
    button {
      margin-top: 1rem;
      width: 100%;
      background: #6366f1;
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 0.7rem 1.2rem;
      font-size: 0.95rem;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover:not(:disabled) { background: #4f46e5; }
    button:disabled { background: #334155; cursor: not-allowed; color: #64748b; }
    .progress-wrap { margin-top: 1.5rem; display: none; }
    .progress-label {
      font-size: 0.8rem;
      color: #94a3b8;
      margin-bottom: 0.4rem;
      display: flex;
      justify-content: space-between;
    }
    progress {
      width: 100%;
      height: 6px;
      border-radius: 3px;
      appearance: none;
      background: #0f172a;
      border: none;
    }
    progress::-webkit-progress-bar { background: #0f172a; border-radius: 3px; }
    progress::-webkit-progress-value { background: #6366f1; border-radius: 3px; transition: width 0.3s; }
    progress::-moz-progress-bar { background: #6366f1; border-radius: 3px; }
    .log {
      margin-top: 1rem;
      background: #0f172a;
      border-radius: 6px;
      padding: 0.8rem;
      max-height: 260px;
      overflow-y: auto;
      font-size: 0.78rem;
      font-family: ui-monospace, monospace;
      display: none;
    }
    .log li { list-style: none; padding: 0.15rem 0; color: #94a3b8; border-bottom: 1px solid #1e293b; }
    .log li:last-child { border: none; }
    .log .ok { color: #34d399; }
    .log .phase { color: #818cf8; font-weight: 600; }
    .log .err { color: #f87171; }
    .result {
      margin-top: 1rem;
      padding: 0.75rem 1rem;
      border-radius: 6px;
      font-size: 0.85rem;
      display: none;
    }
    .result.success { background: #052e16; color: #4ade80; border: 1px solid #166534; }
    .result.error { background: #2d0808; color: #f87171; border: 1px solid #7f1d1d; }
  </style>
</head>
<body>
<div class="card">
  <h1>CSV PII Sanitiser</h1>
  <p class="subtitle">Replaces names, email addresses, and company references using Ollama (gemma4:latest)</p>

  <label for="filePath">Absolute path to CSV file</label>
  <input type="text" id="filePath" placeholder="C:\Users\you\data\tickets.csv" />
  <button id="startBtn">Sanitise File</button>

  <div class="progress-wrap" id="progressWrap">
    <div class="progress-label">
      <span id="phaseLabel">Processing…</span>
      <span id="rowLabel"></span>
    </div>
    <progress id="progressBar" value="0" max="100"></progress>
  </div>

  <ul class="log" id="log"></ul>
  <div class="result" id="result"></div>
</div>

<script>
  const filePathInput = document.getElementById('filePath');
  const startBtn = document.getElementById('startBtn');
  const progressWrap = document.getElementById('progressWrap');
  const progressBar = document.getElementById('progressBar');
  const phaseLabel = document.getElementById('phaseLabel');
  const rowLabel = document.getElementById('rowLabel');
  const logEl = document.getElementById('log');
  const resultEl = document.getElementById('result');

  let totalRows = 0;

  function addLog(text, cls = '') {
    const li = document.createElement('li');
    if (cls) li.className = cls;
    li.textContent = text;
    logEl.appendChild(li);
    logEl.scrollTop = logEl.scrollHeight;
  }

  const phaseLabels = {
    reading: '📖 Reading CSV file…',
    extracting: '🔍 Extracting unique PII values…',
    mapping: '🤖 Generating fake replacements via Ollama…',
    applying: '✏️ Applying replacements…',
    writing: '💾 Writing sanitised file…',
  };

  startBtn.addEventListener('click', async () => {
    const filePath = filePathInput.value.trim();
    if (!filePath) {
      alert('Please enter a file path.');
      return;
    }

    // Reset UI
    logEl.innerHTML = '';
    resultEl.style.display = 'none';
    resultEl.className = 'result';
    progressBar.value = 0;
    rowLabel.textContent = '';
    phaseLabel.textContent = 'Starting…';
    progressWrap.style.display = 'block';
    logEl.style.display = 'block';
    startBtn.disabled = true;
    totalRows = 0;

    let jobId;
    try {
      const res = await fetch('/api/sanitise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? 'Failed to start job');
      }
      jobId = data.jobId;
    } catch (err) {
      addLog('Error: ' + err.message, 'err');
      resultEl.textContent = '❌ ' + err.message;
      resultEl.className = 'result error';
      resultEl.style.display = 'block';
      startBtn.disabled = false;
      return;
    }

    const es = new EventSource('/api/progress/' + jobId);
    es.onmessage = (e) => {
      const event = JSON.parse(e.data);

      if (event.type === 'started') {
        totalRows = event.total;
        addLog(`Found ${event.total} rows to process`);
      }
      else if (event.type === 'phase') {
        const label = phaseLabels[event.phase] ?? event.phase;
        phaseLabel.textContent = label;
        addLog(label, 'phase');
        if (event.phase === 'mapping') progressBar.value = 20;
        if (event.phase === 'applying') progressBar.value = 50;
        if (event.phase === 'writing') progressBar.value = 90;
      }
      else if (event.type === 'llm_batch') {
        addLog(`  LLM batch ${event.batch}/${event.total}…`);
      }
      else if (event.type === 'row') {
        rowLabel.textContent = `${event.processed} / ${event.total}`;
        const pct = 50 + Math.round((event.processed / event.total) * 40);
        progressBar.value = pct;
      }
      else if (event.type === 'done') {
        progressBar.value = 100;
        phaseLabel.textContent = 'Complete';
        const secs = (event.elapsed / 1000).toFixed(1);
        addLog(`Done in ${secs}s`, 'ok');
        resultEl.textContent = `✅ Saved to: ${event.outputPath}`;
        resultEl.className = 'result success';
        resultEl.style.display = 'block';
        startBtn.disabled = false;
        es.close();
      }
      else if (event.type === 'error') {
        addLog('Error: ' + event.message, 'err');
        resultEl.textContent = '❌ ' + event.message;
        resultEl.className = 'result error';
        resultEl.style.display = 'block';
        startBtn.disabled = false;
        es.close();
      }
    };

    es.onerror = () => {
      addLog('Connection to server lost', 'err');
      startBtn.disabled = false;
      es.close();
    };
  });
</script>
</body>
</html>
```

8. Run `bun install` to install dependencies.

## Constraints

- No `any` types in TypeScript
- Use Bun APIs (`Bun.file`, `Bun.write`) for file I/O
- No framework on the frontend — plain HTML/JS
- All files written exactly as specified above
- After writing all files, run `bun install` to install dependencies

## Results

- Created `package.json` with hono and papaparse dependencies
- Created `tsconfig.json` for TypeScript configuration
- Created `src/csv-processor.ts` — CSV parsing and writing with preamble stripping
- Created `src/ollama.ts` — Ollama API client with JSON generation and company extraction
- Created `src/sanitizer.ts` — PII extraction, replacement mapping, and sanitisation orchestration
- Created `src/server.ts` — Hono server with SSE progress streaming and job management
- Created `public/index.html` — Modern dark-themed UI for file sanitisation
- Ran `bun install` — installed all dependencies successfully
