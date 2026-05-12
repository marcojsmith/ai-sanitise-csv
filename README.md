# ai-sanitise-csv

A local web tool that sanitises PII (names, company names, email addresses) in CSV files using [Ollama](https://ollama.com). Designed for support ticket exports where text columns contain email threads and free-form descriptions.

## How it works

1. Upload a CSV file via the browser UI
2. The tool auto-detects free-text columns (long values containing spaces)
3. Ollama scans the text in batches to extract person names and company names
4. Email addresses are detected with a regex — no LLM needed
5. You review the detected entities and remove any false positives
6. Ollama generates realistic fake replacements (culturally matched names)
7. All replacements are applied and the sanitised file is available to download
8. You can re-run the mapping step with a different entity list without re-scanning

## Prerequisites

- [Bun](https://bun.sh) runtime
- [Ollama](https://ollama.com) running locally
- A compatible model pulled, e.g.:
  ```
  ollama pull gemma4:e4b
  ```

## Setup

```bash
bun install
bun run src/server.ts
```

Then open [http://localhost:3000](http://localhost:3000).

## Changing the model

Edit `src/ollama.ts` and update the `model` field in `defaultOllamaOptions`:

```ts
export const defaultOllamaOptions: OllamaOptions = {
  baseUrl: "http://localhost:11434",
  model: "gemma4:e4b",   // change this
  timeoutMs: 120000,
};
```

Restart the server after changing.

## Input file format

- Any CSV with a standard header row
- Files with a metadata preamble (rows before the header) are handled automatically — the preamble is stripped from the output
- Free-text columns are detected automatically based on average value length and word count

## Output

The sanitised file is saved as `<original-name>_sanitised.csv` and can be downloaded directly from the UI. The original file is not modified.
