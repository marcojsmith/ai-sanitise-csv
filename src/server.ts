import { Hono } from "hono";
import { readFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";
import { runSanitisation, remapAndApply, type ProgressEvent, type SanitisationJob, type RemapData, type CancelToken } from "./sanitizer";
import { defaultOllamaOptions } from "./ollama";

const app = new Hono();

const jobs = new Map<string, SanitisationJob>();
const jobListeners = new Map<string, Array<(event: ProgressEvent) => void>>();
const jobEventBuffers = new Map<string, ProgressEvent[]>();
const jobConfirmResolvers = new Map<string, (entities: string[]) => void>();
const jobRemapData = new Map<string, RemapData>();
const jobCancelTokens = new Map<string, CancelToken>();
const jobOutputs = new Map<string, { filename: string; content: string }>();
const jobOpts = new Map<string, typeof defaultOllamaOptions>();

function generateJobId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function emit(jobId: string, event: ProgressEvent) {
  jobEventBuffers.get(jobId)?.push(event);
  for (const listener of jobListeners.get(jobId) ?? []) {
    listener(event);
  }
}

function resetJobForRerun(jobId: string) {
  jobEventBuffers.set(jobId, []);
  jobListeners.set(jobId, []);
  const job = jobs.get(jobId);
  if (job) {
    job.status = "running";
    job.startedAt = Date.now();
  }
}

// List available Ollama models
app.get("/api/models", async (c) => {
  try {
    const res = await fetch(`${defaultOllamaOptions.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return c.json({ models: [] });
    const data = await res.json() as { models: { name: string }[] };
    const names = (data.models ?? []).map((m) => m.name).sort();
    return c.json({ models: names, default: defaultOllamaOptions.model });
  } catch {
    return c.json({ models: [] });
  }
});

// Serve UI
app.get("/", (c) => {
  const html = readFileSync(path.join(import.meta.dir, "../public/index.html"), "utf-8");
  return c.html(html);
});

// Start sanitisation job — accepts multipart file upload
app.post("/api/sanitise", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file");

  if (!file || typeof file === "string") {
    return c.json({ error: "A CSV file must be uploaded" }, 400);
  }

  const modelParam = formData.get("model");
  const model = (typeof modelParam === "string" && modelParam.trim()) ? modelParam.trim() : defaultOllamaOptions.model;

  const originalName = (file as File).name;
  const baseName = path.basename(originalName, path.extname(originalName));
  const outputFilename = `${baseName}_sanitised.csv`;

  const tmpPath = path.join(os.tmpdir(), `sanitise_${generateJobId()}_${originalName}`);
  await Bun.write(tmpPath, await (file as File).arrayBuffer());

  const jobId = generateJobId();
  const job: SanitisationJob = { jobId, filePath: tmpPath, status: "pending", startedAt: Date.now() };
  jobs.set(jobId, job);
  jobListeners.set(jobId, []);
  jobEventBuffers.set(jobId, []);

  const waitForConfirmation = (): Promise<string[]> =>
    new Promise((resolve) => { jobConfirmResolvers.set(jobId, resolve); });

  const cancelToken: CancelToken = { cancelled: false };
  jobCancelTokens.set(jobId, cancelToken);

  const opts = { ...defaultOllamaOptions, model };
  jobOpts.set(jobId, opts);

  job.status = "running";
  runSanitisation(
    job,
    (event) => {
      emit(jobId, event);
      if (event.type === "done" && job.outputPath) {
        try {
          const content = readFileSync(job.outputPath, "utf-8");
          jobOutputs.set(jobId, { filename: outputFilename, content });
          unlinkSync(job.outputPath);
        } catch { /* ignore */ }
      }
      if (event.type === "error") {
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    },
    opts,
    waitForConfirmation,
    (remapData) => { jobRemapData.set(jobId, remapData); },
    cancelToken
  ).catch(console.error);

  return c.json({ jobId }, 202);
});

// SSE progress stream
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
          const listeners = jobListeners.get(jobId) ?? [];
          const idx = listeners.indexOf(send);
          if (idx !== -1) listeners.splice(idx, 1);
        }
      };

      for (const evt of jobEventBuffers.get(jobId) ?? []) send(evt);
      if (job.status === "done" || job.status === "error") return;

      const listeners = jobListeners.get(jobId) ?? [];
      listeners.push(send);
      jobListeners.set(jobId, listeners);
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
});

// Confirm entity list and resume the initial run
app.post("/api/jobs/:jobId/confirm", async (c) => {
  const jobId = c.req.param("jobId");
  const resolve = jobConfirmResolvers.get(jobId);
  if (!resolve) return c.json({ error: "Job not awaiting confirmation" }, 400);
  const { entities } = await c.req.json<{ entities: string[] }>();
  jobConfirmResolvers.delete(jobId);
  resolve(entities);
  return c.json({ ok: true });
});

// Cancel a running job
app.post("/api/jobs/:jobId/cancel", (c) => {
  const jobId = c.req.param("jobId");
  const token = jobCancelTokens.get(jobId);
  if (!token) return c.json({ error: "Job not found" }, 404);
  token.cancelled = true;
  // Also resolve any pending confirmation so the job isn't stuck waiting
  jobConfirmResolvers.get(jobId)?.([]);
  jobConfirmResolvers.delete(jobId);
  return c.json({ ok: true });
});

// Re-run mapping + applying + writing with a new entity list (skips extraction)
app.post("/api/jobs/:jobId/remap", async (c) => {
  const jobId = c.req.param("jobId");
  const remapData = jobRemapData.get(jobId);
  if (!remapData) return c.json({ error: "No extraction data found for this job" }, 400);

  const { entities } = await c.req.json<{ entities: string[] }>();
  const outputFilename = jobOutputs.get(jobId)?.filename ?? "sanitised.csv";

  resetJobForRerun(jobId);
  const remapCancelToken: CancelToken = { cancelled: false };
  jobCancelTokens.set(jobId, remapCancelToken);

  const remapOpts = jobOpts.get(jobId) ?? defaultOllamaOptions;
  remapAndApply(remapData, entities, (event) => {
    emit(jobId, event);
    if (event.type === "done") {
      const job = jobs.get(jobId);
      if (job) job.status = "done";
      try {
        const content = readFileSync(event.outputPath, "utf-8");
        jobOutputs.set(jobId, { filename: outputFilename, content });
        try { unlinkSync(event.outputPath); } catch { /* ignore */ }
      } catch { /* ignore */ }
    }
    if (event.type === "error") {
      const job = jobs.get(jobId);
      if (job) job.status = "error";
    }
  }, remapOpts, remapCancelToken).catch(console.error);

  return c.json({ ok: true }, 202);
});

// Download sanitised file (can be called multiple times)
app.get("/api/download/:jobId", (c) => {
  const output = jobOutputs.get(c.req.param("jobId"));
  if (!output) return c.json({ error: "File not found" }, 404);
  return new Response(output.content, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${output.filename}"`,
    },
  });
});

const port = 3000;
console.log(`CSV Sanitiser running at http://localhost:${port}`);
export default { port, idleTimeout: 0, fetch: app.fetch };
