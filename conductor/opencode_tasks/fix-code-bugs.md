# Task: Fix code bugs (items 1, 3, 4, 7)

## Context

Key files:
- `src/server.ts` — line 50: `serialiseJob` destructures `approveResolve` from `job as any`; `QueueJob` has no such field
- `src/sanitizer.ts`:
  - lines 100-109: `countFrequency()` — O(entities × rows × columns), called per entity
  - lines 171-178: cache bug — all uncached chunks stored with combined entity list
  - lines 111-127: `runExtraction` — no warning when `textColumns` is empty

## Instructions

### Fix 1 — Remove dead `approveResolve` destructure (src/server.ts:50)

Change:
```ts
const { listeners, eventBuffer, cancelToken, remapData, approveResolve, ...rest } = job as any;
```
To:
```ts
const { listeners, eventBuffer, cancelToken, remapData, ...rest } = job as any;
```

### Fix 3 — Optimise entity frequency counting (src/sanitizer.ts)

Replace the `countFrequency` function and its call sites with a single-pass approach.

1. Delete the `countFrequency` function (lines 100-109).
2. After the scoring phase (after `const scoreMap = ...` line ~194), add a function `buildFrequencyMap` that does a single pass:

```ts
function buildFrequencyMap(
  entities: string[],
  rows: Record<string, string>[],
  textColumns: string[]
): Map<string, number> {
  const counts = new Map<string, number>(entities.map(e => [e, 0]));
  const patterns = new Map(entities.map(e => [e, new RegExp(`\\b${escapeRegex(e)}\\b`, "gi")]));
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
```

3. Before building `reviewRows`, call it for all entities + emails combined:
```ts
const allEntitiesArr = Array.from(allEntities);
const allEmailsArr = Array.from(emailMap.keys());
const freqMap = buildFrequencyMap([...allEntitiesArr, ...allEmailsArr], parsed.rows, textColumns);
```

4. In the `reviewRows` loop, replace `countFrequency(entity, ...)` with `freqMap.get(entity) ?? 0`.
5. In the `emailRows` loop, replace `countFrequency(email, ...)` with `freqMap.get(email) ?? 0`.

### Fix 4 — Cache granularity bug (src/sanitizer.ts:171-178)

The current code calls `extractPIIFromSubjects(uncachedChunks, opts)` with all uncached chunks at once, then caches the combined result against each chunk individually.

Replace the block (roughly lines 171-178):
```ts
let found: string[] = [...cachedResults];
if (uncachedChunks.length > 0) {
  const fromOllama = await extractPIIFromSubjects(uncachedChunks, opts);
  for (const chunk of uncachedChunks) {
    setCached(chunk, fromOllama);
  }
  found.push(...fromOllama);
}
```

With per-chunk calls so each chunk is cached with only its own entities:
```ts
let found: string[] = [...cachedResults];
for (const chunk of uncachedChunks) {
  const chunkEntities = await extractPIIFromSubjects([chunk], opts);
  setCached(chunk, chunkEntities);
  found.push(...chunkEntities);
}
```

### Fix 7 — Warn when no text columns detected (src/sanitizer.ts)

After the line:
```ts
const textColumns = detectTextColumns(parsed.headers, parsed.rows);
```

Add:
```ts
if (textColumns.length === 0) {
  const summary = parsed.headers.map(h => {
    const sample = parsed.rows.slice(0, 100).map(r => (r[h] ?? "").trim()).filter(Boolean);
    const avgLen = sample.length > 0 ? Math.round(sample.reduce((s, v) => s + v.length, 0) / sample.length) : 0;
    const hasWords = sample.some(v => v.includes(" "));
    return `  "${h}": avgLen=${avgLen}, hasWords=${hasWords}`;
  }).join("\n");
  throw new Error(
    `No text columns detected. Columns need avgLen > 30 and contain spaces.\n` +
    `Column analysis:\n${summary}`
  );
}
```

## Constraints
- TypeScript, no `any` types beyond what already exists
- Do not change function signatures
- Do not add tests

## Results

All 4 fixes applied:

- **Fix 1** — Removed `approveResolve` from destructure in `src/server.ts:50`
- **Fix 3** — Replaced O(n×entities×columns) `countFrequency` with single-pass `buildFrequencyMap` in `src/sanitizer.ts:100-118`; called once before `reviewRows`/`emailRows` loops
- **Fix 4** — Changed cache block to call `extractPIIFromSubjects` per chunk (each chunk cached with only its own entities)
- **Fix 7** — Added empty `textColumns` check that throws with column analysis summary after `detectTextColumns` call
