# Task: Distinguish person vs company entities (item 2)

## Context

- `src/ollama.ts` lines 1-4: `EntityScore` interface only has `entity` and `confidence`
- `src/ollama.ts` lines 97-139: `scoreEntityConfidence` prompt and response parsing
- `src/sanitizer.ts` lines 194-206: builds `reviewRows`, hardcodes `type: "person"`
- `EntityReviewRow` already has `type: "person" | "company" | "email"` (line 34)

## Instructions

### Step 1 — Extend EntityScore interface (src/ollama.ts)

Change:
```ts
export interface EntityScore {
  entity: string;
  confidence: "high" | "medium" | "low";
}
```
To:
```ts
export interface EntityScore {
  entity: string;
  confidence: "high" | "medium" | "low";
  type: "person" | "company";
}
```

### Step 2 — Update scoring prompt to return type (src/ollama.ts)

In `scoreEntityConfidence`, update the prompt string. Change the instruction section to request type alongside confidence. New prompt:

```
You are a data anonymisation assistant. Below is a list of strings extracted as potential PII (person names or company/organisation names) from support ticket text.

Rate each one's confidence as genuine PII and classify its type:
- confidence "high": clearly a real person name or company/organisation name
- confidence "medium": plausible name but ambiguous
- confidence "low": likely a false positive (software product, tech term, job title, department name, generic word, etc.)
- type "person": human individual name
- type "company": business, organisation, or brand name

Return ONLY a JSON array, one object per input, in this exact format:
[{"entity":"Alice Smith","confidence":"high","type":"person"},{"entity":"Acme Corp","confidence":"high","type":"company"},{"entity":"SAP","confidence":"low","type":"company"}]

Inputs:
${JSON.stringify(entities)}
```

### Step 3 — Update parse function to validate type field (src/ollama.ts)

In the `parse` arrow function inside `scoreEntityConfidence`, update the filter to also validate the type field:

```ts
const parse = (raw: string): EntityScore[] | null => {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is EntityScore =>
        typeof v?.entity === "string" &&
        ["high", "medium", "low"].includes(v?.confidence) &&
        ["person", "company"].includes(v?.type)
      );
    }
  } catch { /* fall through */ }
  return null;
};
```

### Step 4 — Update fallback in scoreEntityConfidence (src/ollama.ts)

Change the fallback at the end of `scoreEntityConfidence` to include `type: "person"` as default:
```ts
return entities.map(e => ({ entity: e, confidence: "medium" as const, type: "person" as const }));
```

### Step 5 — Use type when building reviewRows (src/sanitizer.ts)

In `runExtraction`, change how `scoreMap` is built and used. Currently:
```ts
const scoreMap = new Map(scores.map(s => [s.entity, s.confidence]));
```

Change to store the full score:
```ts
const scoreMap = new Map(scores.map(s => [s.entity, s]));
```

Then in the `reviewRows` loop, change:
```ts
reviewRows.push({
  original: entity,
  replacement: "",
  confidence: scoreMap.get(entity) ?? "medium",
  frequency,
  type: "person"
});
```
To:
```ts
const score = scoreMap.get(entity);
reviewRows.push({
  original: entity,
  replacement: "",
  confidence: score?.confidence ?? "medium",
  frequency,
  type: score?.type ?? "person"
});
```

## Constraints
- TypeScript strict — no implicit `any`
- Do not change function signatures of exported functions

## Results

- **Step 1** — `EntityScore` interface extended with `type: "person" | "company"` (`src/ollama.ts:4`)
- **Step 2** — Scoring prompt updated to request type classification (`src/ollama.ts:106-114`)
- **Step 3** — `parse` filter updated to validate type field (`src/ollama.ts:124-128`)
- **Step 4** — Fallback now includes `type: "person"` (`src/ollama.ts:143`)
- **Step 5** — `scoreMap` stores full `EntityScore` objects; `reviewRows` uses `score?.confidence` and `score?.type` (`src/sanitizer.ts:222-229`)
- TypeScript typecheck passes with zero errors.
