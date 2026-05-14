import { Hono } from "hono";
import { readFileSync, mkdirSync } from "fs";
import path from "path";
import { runExtraction, runMappingAndApply, type ProgressEvent, type RemapData, type CancelToken, type EntityReviewRow } from "./sanitizer";
import { defaultOllamaOptions } from "./ollama";
import { getStats, clear as clearCache, exportEntries, importEntries } from "./entity-cache";
import {
  initDataDirs, saveJob, moveJobFolder, saveRemapData, loadRemapData,
  deleteRemapData, saveOutput, readOutput, loadAllJobs, saveEntityCache,
  loadEntityCache, bucketForStatus, type PersistedJob
} from "./persistence";

const app = new Hono();

type JobStatus = "queued" | "extracting" | "scoring" | "awaiting_review" | "mapping" | "applying" | "done" | "error" | "cancelled";

interface QueueJob {
  jobId: string;
  originalFilename: string;
  inputPath: string;
  model: string;
  ollamaBaseUrl: string;
  status: JobStatus;
  queuePosition: number;
  createdAt: number;
  startedAt: number | null;
  reviewReadyAt: number | null;
  completedAt: number | null;
  errorMessage: string | null;
  currentPhase: string | null;
  phaseProgress: { current: number; total: number } | null;
  reviewRows: EntityReviewRow[] | null;
  emailRows: EntityReviewRow[] | null;
  entityCount: number | null;
  elapsedMs: number | null;
  outputFilename: string | null;
  cancelToken: { cancelled: boolean };
  remapData: RemapData | null;
  listeners: Array<(e: ProgressEvent) => void>;
  eventBuffer: ProgressEvent[];
}

const jobs = new Map<string, QueueJob>();

function generateJobId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function serialiseJob(job: QueueJob) {
  const { listeners, eventBuffer, cancelToken, remapData, approveResolve, ...rest } = job as any;
  return rest;
}

let ollamaQueue: Promise<void> = Promise.resolve();
function withOllama<T>(fn: () => Promise<T>): Promise<T> {
  const p = ollamaQueue.then(fn);
  ollamaQueue = p.then(() => {}, () => {});
  return p;
}

function emitToJob(job: QueueJob, event: ProgressEvent) {
  job.eventBuffer.push(event);
  for (const listener of job.listeners) listener(event);
}

let processorRunning = false;

async function runQueueProcessor(): Promise<void> {
  if (processorRunning) return;
  processorRunning = true;
  while (true) {
    const queued = [...jobs.values()]
      .filter(j => j.status === "queued")
      .sort((a, b) => a.queuePosition - b.queuePosition);

    const job = queued[0];
    if (!job) { processorRunning = false; return; }

    job.status = "extracting";
    job.startedAt = Date.now();
    job.inputPath = await moveJobFolder(job.jobId, "queued", "in-progress");
    await persistJob(job);
    emitToJob(job, { type: "phase", phase: "extracting" });

    try {
      const result = await withOllama(() => runExtraction(
        job.inputPath,
        job.originalFilename,
        (event) => {
          if (event.type === "phase") job.currentPhase = event.phase;
          if (event.type === "llm_batch") job.phaseProgress = { current: event.batch, total: event.total };
          if (event.type === "started") job.phaseProgress = { current: 0, total: event.total };
          emitToJob(job, event);
        },
        { ...defaultOllamaOptions, baseUrl: job.ollamaBaseUrl, model: job.model },
        job.cancelToken
      ));

      if (job.cancelToken.cancelled) {
        job.status = "cancelled";
        await moveJobFolder(job.jobId, "in-progress", "failed");
        await persistJob(job);
        continue;
      }

      job.reviewRows = result.reviewRows;
      job.emailRows = result.emailRows;
      job.remapData = result.remapData;
      job.entityCount = result.reviewRows.length + result.emailRows.length;
      job.status = "awaiting_review";
      job.reviewReadyAt = Date.now();
      job.currentPhase = null;
      job.phaseProgress = null;
      await saveRemapData(job.jobId, result.remapData);
      await persistJob(job);
      emitToJob(job, { type: "review" });
    } catch (err) {
      if (job.cancelToken.cancelled) {
        job.status = "cancelled";
        await moveJobFolder(job.jobId, "in-progress", "failed");
        await persistJob(job);
        continue;
      }
      if (job.status !== "cancelled") {
        job.status = "error";
        job.errorMessage = err instanceof Error ? err.message : String(err);
        await moveJobFolder(job.jobId, "in-progress", "failed");
        await persistJob(job);
        emitToJob(job, { type: "error", message: job.errorMessage! });
      }
    }
  }
}

function kickProcessor() {
  if (!processorRunning) runQueueProcessor().catch(console.error);
}

async function persistJob(job: QueueJob): Promise<void> {
  const pj: PersistedJob = {
    jobId: job.jobId,
    originalFilename: job.originalFilename,
    inputPath: job.inputPath,
    model: job.model,
    ollamaBaseUrl: job.ollamaBaseUrl,
    status: job.status,
    queuePosition: job.queuePosition,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    reviewReadyAt: job.reviewReadyAt,
    completedAt: job.completedAt,
    errorMessage: job.errorMessage,
    reviewRows: job.reviewRows,
    emailRows: job.emailRows,
    entityCount: job.entityCount,
    elapsedMs: job.elapsedMs,
    outputFilename: job.outputFilename,
  };
  await saveJob(pj);
}

async function startup() {
  await initDataDirs();

  const cacheEntries = await loadEntityCache();
  importEntries(cacheEntries);
  console.log(`[startup] Restored ${cacheEntries.length} entity cache entries`);

  const persistedJobs = await loadAllJobs();
  console.log(`[startup] Found ${persistedJobs.length} persisted jobs`);

  for (const pj of persistedJobs) {
    let status = pj.status;
    let errorMessage = pj.errorMessage;

    if (status === "extracting" || status === "scoring") {
      status = "queued";
      errorMessage = null;
      pj.inputPath = await moveJobFolder(pj.jobId, "in-progress", "queued");
    } else if (status === "mapping" || status === "applying") {
      const remapData = await loadRemapData(pj.jobId);
      if (remapData) {
        status = "awaiting_review";
        errorMessage = null;
      } else {
        status = "queued";
        errorMessage = null;
        pj.inputPath = await moveJobFolder(pj.jobId, "in-progress", "queued");
      }
    }

    const job: QueueJob = {
      ...pj,
      status,
      errorMessage,
      inputPath: pj.inputPath,
      currentPhase: null,
      phaseProgress: null,
      reviewRows: pj.reviewRows,
      emailRows: pj.emailRows,
      cancelToken: { cancelled: false },
      remapData: null,
      listeners: [],
      eventBuffer: [],
    };

    if (status === "awaiting_review") {
      job.remapData = await loadRemapData(pj.jobId);
    }

    jobs.set(job.jobId, job);
  }

  kickProcessor();
}

app.get("/api/models", async (c) => {
  try {
    const baseUrl = c.req.query("baseUrl") || defaultOllamaOptions.baseUrl;
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return c.json({ models: [] });
    const data = await res.json() as { models: { name: string }[] };
    const names = (data.models ?? []).map((m) => m.name).sort();
    return c.json({ models: names, default: defaultOllamaOptions.model });
  } catch {
    return c.json({ models: [] });
  }
});

app.get("/", (c) => {
  const html = readFileSync(path.join(import.meta.dir, "../public/index.html"), "utf-8");
  return c.html(html);
});

app.post("/api/queue/add", async (c) => {
  const formData = await c.req.formData();
  const files = formData.getAll("files");
  const modelParam = formData.get("model");
  const model = (typeof modelParam === "string" && modelParam.trim()) ? modelParam.trim() : defaultOllamaOptions.model;
  const ollamaBaseUrlParam = formData.get("ollamaBaseUrl");
  const ollamaBaseUrl = (typeof ollamaBaseUrlParam === "string" && ollamaBaseUrlParam.trim()) ? ollamaBaseUrlParam.trim() : defaultOllamaOptions.baseUrl;

  const validFiles = files.filter(f => f && typeof f !== "string" && (f as File).name);
  if (validFiles.length === 0) {
    return c.json({ error: "At least one CSV file must be uploaded" }, 400);
  }

  const maxPosition = Math.max(0, ...[...jobs.values()].map(j => j.queuePosition));
  const jobIds: string[] = [];

  for (const file of validFiles) {
    const originalName = (file as File).name;
    const jobId = generateJobId();
    const folder = path.join(import.meta.dir, "../data", "queued", jobId);
    mkdirSync(folder, { recursive: true });
    const inputPath = path.join(folder, "input.csv");
    await Bun.write(inputPath, await (file as File).arrayBuffer());

    const job: QueueJob = {
      jobId,
      originalFilename: originalName,
      inputPath,
      model,
      ollamaBaseUrl,
      status: "queued",
      queuePosition: maxPosition + jobIds.length + 1,
      createdAt: Date.now(),
      startedAt: null,
      reviewReadyAt: null,
      completedAt: null,
      errorMessage: null,
      currentPhase: null,
      phaseProgress: null,
      reviewRows: null,
      emailRows: null,
      entityCount: null,
      elapsedMs: null,
      outputFilename: null,
      cancelToken: { cancelled: false },
      remapData: null,
      listeners: [],
      eventBuffer: [],
    };
    jobs.set(jobId, job);
    jobIds.push(jobId);
    await persistJob(job);
  }

  kickProcessor();
  return c.json({ jobIds });
});

app.get("/api/queue", (c) => {
  const statusFilter = c.req.query("status");
  let jobsList = [...jobs.values()].map(serialiseJob).sort((a, b) => b.createdAt - a.createdAt);
  if (statusFilter) {
    const statuses = statusFilter.split(",");
    jobsList = jobsList.filter(j => statuses.includes(j.status));
  }
  return c.json({ jobs: jobsList });
});

app.post("/api/queue/reorder", async (c) => {
  const { jobId, direction } = await c.req.json<{ jobId: string; direction: "up" | "down" }>();
  const job = jobs.get(jobId);
  if (!job || job.status !== "queued") {
    return c.json({ error: "Job not found or not in queued status" }, 400);
  }

  const queuedJobs = [...jobs.values()]
    .filter(j => j.status === "queued")
    .sort((a, b) => a.queuePosition - b.queuePosition);

  const currentIndex = queuedJobs.findIndex(j => j.jobId === jobId);
  if (currentIndex === -1) return c.json({ error: "Job not in queue" }, 400);

  const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
  if (targetIndex < 0 || targetIndex >= queuedJobs.length) {
    return c.json({ error: "Cannot reorder beyond queue bounds" }, 400);
  }

  const targetJob = queuedJobs[targetIndex];
  const tempPos = job.queuePosition;
  job.queuePosition = targetJob.queuePosition;
  targetJob.queuePosition = tempPos;
  await persistJob(job);
  await persistJob(targetJob);

  const jobsList = [...jobs.values()].map(serialiseJob).sort((a, b) => b.createdAt - a.createdAt);
  return c.json({ jobs: jobsList });
});

app.delete("/api/jobs/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  const job = jobs.get(jobId);
  if (!job) return c.json({ error: "Job not found" }, 404);

  const fromBucket = job.status === "queued" ? "queued" : "in-progress";
  if (job.status === "queued") {
    job.status = "cancelled";
  } else if (job.status === "extracting" || job.status === "mapping" || job.status === "applying") {
    job.cancelToken.cancelled = true;
    job.status = "cancelled";
  } else if (job.status === "awaiting_review") {
    job.status = "cancelled";
  }

  try {
    await moveJobFolder(job.jobId, fromBucket, "failed");
  } catch { /* may already be in wrong place */ }
  await persistJob(job);

  return c.json({ ok: true });
});

app.get("/api/jobs/:jobId/review-data", (c) => {
  const jobId = c.req.param("jobId");
  const job = jobs.get(jobId);
  if (!job || job.status !== "awaiting_review") {
    return c.json({ error: "Job not found or not awaiting review" }, 404);
  }
  return c.json({
    reviewRows: job.reviewRows,
    emailRows: job.emailRows,
    originalFilename: job.originalFilename
  });
});

app.post("/api/jobs/:jobId/approve", async (c) => {
  const jobId = c.req.param("jobId");
  const job = jobs.get(jobId);
  if (!job || job.status !== "awaiting_review") {
    return c.json({ error: "Job not found or not awaiting review" }, 400);
  }

  const { reviewRows, emailRows } = await c.req.json<{ reviewRows: EntityReviewRow[]; emailRows: EntityReviewRow[] }>();

  job.status = "mapping";
  job.currentPhase = "mapping";

  withOllama(async () => {
    try {
      const result = await runMappingAndApply(
        reviewRows,
        emailRows,
        job.remapData!,
        (event) => {
          if (event.type === "phase") job.currentPhase = event.phase;
          if (event.type === "llm_batch") job.phaseProgress = { current: event.batch, total: event.total };
          if (event.type === "row") job.phaseProgress = { current: event.processed, total: event.total };
          emitToJob(job, event);
        },
        { ...defaultOllamaOptions, baseUrl: job.ollamaBaseUrl, model: job.model },
        job.cancelToken
      );

      job.status = "done";
      job.outputFilename = result.outputFilename;
      job.completedAt = Date.now();
      job.elapsedMs = result.elapsed;
      job.currentPhase = null;
      job.phaseProgress = null;
      await deleteRemapData(job.jobId);
      await moveJobFolder(job.jobId, "in-progress", "completed");
      await saveOutput(job.jobId, result.content, result.outputFilename);
      await persistJob(job);
      saveEntityCache(exportEntries()).catch(console.error);
    } catch (err) {
      if (job.cancelToken.cancelled) {
        job.status = "cancelled";
      } else {
        job.status = "error";
        job.errorMessage = err instanceof Error ? err.message : String(err);
      }
      await moveJobFolder(job.jobId, "in-progress", "failed");
      await persistJob(job);
    }
  }).catch(console.error);

  return c.json({ ok: true }, 202);
});

app.get("/api/cache/stats", (c) => {
  return c.json(getStats());
});

app.delete("/api/cache", (c) => {
  clearCache();
  return c.json({ ok: true });
});

app.get("/api/progress/:jobId", (c) => {
  const jobId = c.req.param("jobId");
  const job = jobs.get(jobId);
  if (!job) return c.json({ error: "Job not found" }, 404);

  let closed = false;
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: ProgressEvent) => {
        if (closed) return;
        try {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
          return;
        }
        if (event.type === "done" || event.type === "error" || event.type === "cancelled") {
          closed = true;
          try { controller.close(); } catch { /* already closed */ }
          const listeners = job.listeners;
          const idx = listeners.indexOf(send);
          if (idx !== -1) listeners.splice(idx, 1);
        }
      };

      for (const evt of job.eventBuffer) send(evt);
      if (job.status === "done" || job.status === "error" || job.status === "cancelled") return;

      job.listeners.push(send);
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
});

app.get("/api/download/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  const job = jobs.get(jobId);
  if (!job || !job.outputFilename) {
    return c.json({ error: "File not found" }, 404);
  }
  const output = await readOutput(jobId);
  if (!output) {
    return c.json({ error: "File not found" }, 404);
  }
  return new Response(output.content, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${output.filename}"`,
    },
  });
});

process.on("SIGINT", async () => {
  await saveEntityCache(exportEntries());
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await saveEntityCache(exportEntries());
  process.exit(0);
});

await startup();
const port = 3000;
console.log(`CSV Sanitiser running at http://localhost:${port}`);
export default { port, idleTimeout: 0, fetch: app.fetch };