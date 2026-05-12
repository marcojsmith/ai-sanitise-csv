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
 * Scan a batch of subject lines and return any PII entities found
 * (person names, company/organisation names, email addresses).
 */
export async function extractPIIFromSubjects(
  subjects: string[],
  opts: OllamaOptions
): Promise<string[]> {
  const numberedExcerpts = subjects.map((s, i) => `[${i + 1}] ${s}`).join("\n\n");

  const prompt = `You are a data anonymisation assistant. Read the text excerpts below and extract every real person name and real company or organisation name you find.

The excerpts come from support ticket descriptions and email threads. Names appear as:
- Greetings: "Hi Marco", "Dear Lindie"
- Sign-offs: "Regards, John Smith", "Thanks, Tumi"
- Inline: "assigned to Pieter", "sent by Sarah"
- Email signatures: name + title + company on separate lines

Rules:
- Extract the name ONLY, not surrounding words. "Hi Adele," → "Adele"
- Include first names alone when clearly a person. "Hi Tumi" → "Tumi"
- For companies, use the core brand name only. "Capitec Bank Limited" → "Capitec Bank"
- Do NOT extract: software product names (SAP, Excel), ticket IDs, job titles, department names

Return a JSON array of unique name strings found. If nothing found, return [].
Return ONLY the JSON array — no explanation, no markdown.

TEXT EXCERPTS:
${numberedExcerpts}`;

  console.log(`[EXTRACT] batch of ${subjects.length} excerpts, prompt length: ${prompt.length}`);

  try {
    const raw = (await callOllamaRaw(prompt, opts))
      .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    console.log(`[EXTRACT] raw response: ${raw.slice(0, 300)}`);
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const results = parsed.filter((v): v is string =>
        typeof v === "string" &&
        v.trim().length > 0 &&
        !/^\[.*\]$/.test(v.trim())  // strip placeholder values like "[Name not found]"
      );
      console.log(`[EXTRACT] found ${results.length} entities:`, results.slice(0, 10));
      return results;
    }
  } catch {
    // Retry once
    try {
      const retry = `${prompt}\n\nIMPORTANT: Your previous response was not valid JSON. Return ONLY the raw JSON array with no extra text, e.g. ["Alice Smith","Acme Corp"]`;
      const raw2 = (await callOllamaRaw(retry, opts))
        .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      console.log(`[EXTRACT] retry response: ${raw2.slice(0, 300)}`);
      const parsed2 = JSON.parse(raw2);
      if (Array.isArray(parsed2)) {
        return parsed2.filter((v): v is string =>
          typeof v === "string" &&
          v.trim().length > 0 &&
          !/^\[.*\]$/.test(v.trim())
        );
      }
    } catch { /* fall through */ }
  }
  return [];
}

/**
 * Given a list of real PII entities, return a map of { "Real": "Fake" }.
 * Batches in groups of 20 to keep prompts manageable.
 */
export async function generateEntityMapping(
  entities: string[],
  opts: OllamaOptions,
  onBatch?: (batch: number, total: number) => void,
  cancelToken?: { cancelled: boolean }
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const batchSize = 20;
  const batches = Math.ceil(entities.length / batchSize);

  for (let b = 0; b < batches; b++) {
    if (cancelToken?.cancelled) break;
    onBatch?.(b + 1, batches);
    const batch = entities.slice(b * batchSize, (b + 1) * batchSize);
    const mapping = await generateReplacementsForBatch(batch, opts);
    for (const entity of batch) {
      result.set(entity, mapping[entity] ?? `Entity_${result.size + 1}`);
    }
  }
  return result;
}

async function generateReplacementsForBatch(
  entities: string[],
  opts: OllamaOptions
): Promise<Record<string, string>> {
  const prompt = `You are a data anonymisation assistant. Replace each real person name, company name, or organisation name with a realistic but entirely fictitious equivalent of similar cultural origin.
Return ONLY a JSON object mapping each input to its replacement.
Do not add any explanation, markdown code fences, or extra keys.

Input:
${JSON.stringify(entities)}

Output format (strict JSON, no markdown):
{"Real Name": "Fake Name", "Real Co": "Fake Co"}`;

  return await callOllamaForJSON(prompt, opts);
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
  raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    const retryPrompt = `${prompt}\n\nIMPORTANT: Your previous response was not valid JSON. Return ONLY the raw JSON object with no extra text.`;
    const retryRaw = (await callOllamaRaw(retryPrompt, opts))
      .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    try {
      return JSON.parse(retryRaw) as Record<string, string>;
    } catch {
      return {};
    }
  }
}
