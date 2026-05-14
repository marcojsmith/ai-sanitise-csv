function fnv32(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function normalise(chunk: string): string {
  return chunk.toLowerCase().replace(/\s+/g, " ").trim();
}

const cache = new Map<string, string[]>();
let hits = 0;
let misses = 0;

export function getCached(chunk: string): string[] | null {
  const key = fnv32(normalise(chunk));
  if (cache.has(key)) { hits++; return cache.get(key)!; }
  misses++;
  return null;
}

export function setCached(chunk: string, entities: string[]): void {
  cache.set(fnv32(normalise(chunk)), entities);
}

export function getStats() {
  return { size: cache.size, hits, misses };
}

export function clear(): void {
  cache.clear();
  hits = 0;
  misses = 0;
}

export function exportEntries(): [string, string[]][] {
  return Array.from(cache.entries());
}

export function importEntries(entries: [string, string[]][]): void {
  cache.clear();
  for (const [k, v] of entries) cache.set(k, v);
}