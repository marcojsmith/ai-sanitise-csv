# Task: Add test infrastructure (item 5)

## Context

Project uses Bun. Key source files to test:
- `src/csv-processor.ts` — `readCSV`, `writeCSV`
- `src/entity-cache.ts` — `getCached`, `setCached`, `getStats`, `clear`, `exportEntries`, `importEntries`
- `src/sanitizer.ts` — exports: `detectTextColumns` (not exported, test indirectly), `extractUniqueEmails` (not exported), `applyAllReplacements` (not exported), `escapeRegex` (not exported), `countFrequency` (not exported or replaced)
- `src/ollama.ts` — `extractPIIFromSubjects`, `scoreEntityConfidence` (mock fetch)

Read these files before writing tests to understand exact function signatures and exports.

## Instructions

1. Read `src/csv-processor.ts`, `src/entity-cache.ts`, `src/sanitizer.ts`, `src/ollama.ts` to understand what is exported.

2. Add `"test": "bun test"` script to `package.json`.

3. Create `tests/csv-processor.test.ts`:
   - Test preamble stripping (if implemented)
   - Test CSV round-trip: write a temp CSV, read it back, check headers + rows match
   - Test header detection

4. Create `tests/entity-cache.test.ts`:
   - Test `getCached` returns null for unknown key
   - Test `setCached` then `getCached` returns set value
   - Test `getStats` returns expected shape
   - Test `clear` empties the cache
   - Test `exportEntries` / `importEntries` round-trip

5. Create `tests/sanitizer.test.ts`:
   - Only test functions that are exported from `src/sanitizer.ts`
   - If internal functions like `escapeRegex`, `applyAllReplacements`, `extractUniqueEmails` are not exported, either export them or test their behavior through exported functions
   - Specifically add export keywords to these internal functions in `src/sanitizer.ts` if they are not exported (add `export` to `escapeRegex`, `extractUniqueEmails`, `applyAllReplacements`):
     - `escapeRegex`: test special chars are escaped
     - `extractUniqueEmails`: test finds emails across rows/columns, lowercases
     - `applyAllReplacements`: test entity and email substitution, word boundary for entities

6. Create `tests/ollama.test.ts`:
   - Mock `fetch` using `jest.fn()` or Bun's built-in mock: `import { mock } from "bun:test"`
   - Test `extractPIIFromSubjects`: mock fetch to return a JSON array response, assert returned array matches
   - Test `scoreEntityConfidence`: mock fetch to return scored JSON, assert EntityScore[] result including `type` field
   - Test fallback: mock fetch to throw, assert fallback result returned

## Constraints
- Use `bun:test` (`import { describe, expect, it, mock, beforeEach } from "bun:test"`)
- No third-party test libraries
- Use `Bun.file` / `Bun.write` for temp files in csv-processor tests
- Clean up temp files after tests
- Tests must pass with `bun test`

## Results

All tasks completed:

1. **package.json**: Added `"test": "bun test"` script.
2. **src/sanitizer.ts**: Added `export` to `escapeRegex`, `extractUniqueEmails`, `applyAllReplacements`.
3. **tests/csv-processor.test.ts** (6 tests): preamble stripping, CSV round-trip, header detection, fatal parse errors, writeCSV, buildOutputPath.
4. **tests/entity-cache.test.ts** (7 tests): getCached miss, setCached/getCached, normalisation, getStats shape, clear, export/import round-trip, importEntries clearing.
5. **tests/sanitizer.test.ts** (8 tests): escapeRegex special chars/plain/brackets, extractUniqueEmails multi-column/case/no-emails, applyAllReplacements email/entity/word-boundary/combined.
6. **tests/ollama.test.ts** (6 tests): extractPIIFromSubjects parsed/fetch-throws, scoreEntityConfidence with type/fetch-throws/empty-input.

**Result**: `bun test` — 27 pass, 0 fail, 52 expect() calls.
