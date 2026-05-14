import path from "path";
import { mkdirSync, renameSync, rmSync, existsSync } from "fs";
import type { EntityReviewRow, RemapData } from "./sanitizer";

const dataDir = path.join(import.meta.dir, "../data");

type JobStatus = "queued" | "extracting" | "scoring" | "awaiting_review" | "mapping" | "applying" | "done" | "error" | "cancelled";

export interface PersistedJob {
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
  reviewRows: EntityReviewRow[] | null;
  emailRows: EntityReviewRow[] | null;
  entityCount: number | null;
  elapsedMs: number | null;
  outputFilename: string | null;
}

interface PersistedRemapData {
  originalRows: Record<string, string>[];
  headers: string[];
  textColumns: string[];
  emailMap: [string, string][];
  originalFilename: string;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = filePath + ".tmp";
  await Bun.write(tmp, content);
  renameSync(tmp, filePath);
}

export async function initDataDirs(): Promise<void> {
  const dirs = ["queued", "in-progress", "completed", "failed", "cache"];
  for (const d of dirs) {
    mkdirSync(path.join(dataDir, d), { recursive: true });
  }
}

export function jobFolder(jobId: string, bucket: "queued" | "in-progress" | "completed" | "failed"): string {
  return path.join(dataDir, bucket, jobId);
}

export function bucketForStatus(status: JobStatus): "queued" | "in-progress" | "completed" | "failed" {
  switch (status) {
    case "queued": return "queued";
    case "extracting":
    case "scoring":
    case "awaiting_review":
    case "mapping":
    case "applying": return "in-progress";
    case "done": return "completed";
    case "error":
    case "cancelled": return "failed";
  }
}

export async function saveJob(job: PersistedJob): Promise<void> {
  const bucket = bucketForStatus(job.status);
  const folder = path.join(dataDir, bucket, job.jobId);
  mkdirSync(folder, { recursive: true });
  await atomicWrite(path.join(folder, "job.json"), JSON.stringify(job, null, 2));
}

export async function moveJobFolder(jobId: string, fromBucket: string, toBucket: string): Promise<string> {
  const oldFolder = path.join(dataDir, fromBucket, jobId);
  const newFolder = path.join(dataDir, toBucket, jobId);

  mkdirSync(path.dirname(newFolder), { recursive: true });

  if (existsSync(newFolder)) {
    rmSync(newFolder, { recursive: true });
  }

  renameSync(oldFolder, newFolder);

  const newInputPath = path.join(newFolder, "input.csv");

  const jobPath = path.join(newFolder, "job.json");
  try {
    const jobData = JSON.parse(await Bun.file(jobPath).text());
    jobData.inputPath = newInputPath;
    await atomicWrite(jobPath, JSON.stringify(jobData, null, 2));
  } catch { /* ignore if job.json can't be read */ }

  return newInputPath;
}

export async function saveRemapData(jobId: string, remapData: RemapData): Promise<void> {
  const folder = path.join(dataDir, "in-progress", jobId);
  mkdirSync(folder, { recursive: true });
  const persisted: PersistedRemapData = {
    originalRows: remapData.originalRows,
    headers: remapData.headers,
    textColumns: remapData.textColumns,
    emailMap: Array.from(remapData.emailMap.entries()),
    originalFilename: remapData.originalFilename,
  };
  await atomicWrite(path.join(folder, "remapdata.json"), JSON.stringify(persisted, null, 2));
}

export async function loadRemapData(jobId: string): Promise<RemapData | null> {
  const remapPath = path.join(dataDir, "in-progress", jobId, "remapdata.json");
  try {
    const data = await Bun.file(remapPath).json() as PersistedRemapData;

    const jobPath = path.join(dataDir, "in-progress", jobId, "job.json");
    let filePath: string;
    try {
      const jobData = await Bun.file(jobPath).json() as { inputPath: string };
      filePath = jobData.inputPath;
    } catch {
      filePath = path.join(dataDir, "in-progress", jobId, "input.csv");
    }

    return {
      originalRows: data.originalRows,
      headers: data.headers,
      textColumns: data.textColumns,
      emailMap: new Map(data.emailMap),
      filePath,
      originalFilename: data.originalFilename,
    };
  } catch {
    return null;
  }
}

export async function deleteRemapData(jobId: string): Promise<void> {
  const remapPath = path.join(dataDir, "in-progress", jobId, "remapdata.json");
  try {
    const { unlinkSync } = await import("fs");
    unlinkSync(remapPath);
  } catch { /* ignore if not found */ }
}

export async function saveOutput(jobId: string, content: string, filename: string): Promise<void> {
  const folder = path.join(dataDir, "completed", jobId);
  mkdirSync(folder, { recursive: true });
  await atomicWrite(path.join(folder, filename), content);
}

export async function readOutput(jobId: string): Promise<{ content: string; filename: string } | null> {
  const folder = path.join(dataDir, "completed", jobId);
  try {
    const entries = new Bun.Glob("*").scanSync({ cwd: folder, absolute: false });
    for (const entry of entries) {
      if (entry.endsWith(".csv") && entry !== "job.json") {
        const content = await Bun.file(path.join(folder, entry)).text();
        return { content, filename: entry };
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function loadAllJobs(): Promise<PersistedJob[]> {
  const jobs: PersistedJob[] = [];
  const buckets = ["queued", "in-progress", "completed", "failed"];

  for (const bucket of buckets) {
    const bucketDir = path.join(dataDir, bucket);
    try {
      const dir = await fsReaddir(bucketDir);
      for (const entry of dir) {
        const jobDir = path.join(bucketDir, entry);
        const jobFilePath = path.join(jobDir, "job.json");
        try {
          const stat = await fsStat(jobDir);
          if (!stat.isDirectory) continue;
          const data = await Bun.file(jobFilePath).json() as PersistedJob;
          jobs.push(data);
        } catch {
          console.warn(`[persistence] Skipping corrupt/missing job.json in ${jobDir}`);
        }
      }
    } catch {
      // bucket dir may not exist yet
    }
  }

  return jobs;
}

async function fsReaddir(dir: string): Promise<string[]> {
  const { readdirSync } = await import("fs");
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

async function fsStat(p: string): Promise<{ isDirectory: boolean }> {
  const { statSync } = await import("fs");
  try {
    const s = statSync(p);
    return { isDirectory: s.isDirectory() };
  } catch {
    return { isDirectory: false };
  }
}

export async function saveEntityCache(entries: [string, string[]][]): Promise<void> {
  const cacheDir = path.join(dataDir, "cache");
  mkdirSync(cacheDir, { recursive: true });
  await atomicWrite(path.join(cacheDir, "entity-cache.json"), JSON.stringify(entries));
}

export async function loadEntityCache(): Promise<[string, string[]][]> {
  const cachePath = path.join(dataDir, "cache", "entity-cache.json");
  try {
    return await Bun.file(cachePath).json() as [string, string[]][];
  } catch {
    return [];
  }
}
