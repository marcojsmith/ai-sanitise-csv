# Improvement Plan

## 1. Remove dead `approveResolve` destructure

**File:** `src/server.ts:50`

`serialiseJob` destructures `approveResolve` from the job object, but `QueueJob` has no such field. This is a no-op at runtime but misleading.

**Fix:** Remove `approveResolve` from the destructured exclusion list.

---

## 2. Distinguish person vs company entities

**File:** `src/sanitizer.ts:204`, `src/ollama.ts:97-139`

All LLM-detected entities are typed as `"person"` regardless of whether they are actually companies. The scoring LLM call (`scoreEntityConfidence`) already knows this information but discards it.

**Fix:** Extend the `EntityScore` interface to include a `type: "person" | "company"` field. Update the scoring prompt to return type alongside confidence. Use this type when building review rows.

---

## 3. Optimise entity frequency counting

**File:** `src/sanitizer.ts:100-109`

`countFrequency()` iterates every row × textColumn for each entity independently — O(entities × rows × columns). For files with many entities or rows this is unnecessarily slow.

**Fix:** Replace with a single pass over all rows. Build a `Map<string, number>` by scanning each text column value once per row and incrementing counts for all matched entities in one go. Reduces to O(rows × columns) total.

---

## 4. Fix cache granularity bug

**File:** `src/sanitizer.ts:171-178`

When multiple chunks are uncached, `extractPIIFromSubjects` is called with ALL uncached chunks and returns a combined entity list. That combined list is then cached against EACH individual chunk via `setCached(chunk, fromOllama)`. This means chunk A gets cached with entities that only appear in chunk B, causing false positives on future cache hits.

**Fix:** Pass chunks to Ollama one at a time (or batch but track per-chunk results), so each chunk is cached with only its own entities.

---

## 5. Add test infrastructure

**Files:** New `tests/` directory, update `package.json`

No tests exist anywhere in the project.

**Plan:**
- Add a test runner (e.g. `bun test` with built-in test runner)
- Create `tests/` directory with tests for:
  - `csv-processor.ts` — preamble stripping, header detection, CSV read/write round-trip
  - `entity-cache.ts` — get/set/stats/clear/export/import
  - `sanitizer.ts` — `detectTextColumns`, `extractUniqueEmails`, `applyAllReplacements`, `escapeRegex`, `countFrequency`
  - `ollama.ts` — prompt construction, response parsing (mock the fetch)
- Add test script to `package.json`

---

## 6. Graceful SSE reconnection on frontend

**File:** `public/index.html`

When the review page's SSE connection drops, the progress view stops updating with no indication to the user. The `EventSource` built-in reconnection helps but isn't handled gracefully in the review flow.

**Fix:** In `startReviewSSE`, handle the `onerror` event by showing a "Connection lost, reconnecting..." message and attempting to reconnect after a delay rather than silently closing.

---

## 7. Warn when no text columns detected

**File:** `src/sanitizer.ts:48-57`, review rows in `public/index.html`

If `detectTextColumns` returns an empty array (no columns match the heuristic of avgLen > 30 and containing spaces), extraction silently produces zero entities with no user feedback. The job gets stuck at `awaiting_review` with nothing to review.

**Fix:** In `runExtraction`, check if `textColumns` is empty and throw a descriptive error telling the user which columns were evaluated and why none matched.
