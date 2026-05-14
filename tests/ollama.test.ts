import { describe, expect, it, mock } from "bun:test";
import {
  defaultOllamaOptions,
  extractPIIFromSubjects,
  scoreEntityConfidence,
} from "../src/ollama";

const opts = defaultOllamaOptions;

describe("extractPIIFromSubjects", () => {
  it("returns parsed array from fetch response", async () => {
    const fakeResponse = new Response(
      JSON.stringify({ response: '["Alice Smith","Acme Corp"]' }),
    );
    mock.module("..", () => {});
    globalThis.fetch = mock(async () => fakeResponse);

    const result = await extractPIIFromSubjects(["Hi Alice"], opts);
    expect(result).toEqual(["Alice Smith", "Acme Corp"]);
  });

  it("returns empty array when fetch throws", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network error");
    });

    const result = await extractPIIFromSubjects(["test"], opts);
    expect(result).toEqual([]);
  });
});

describe("scoreEntityConfidence", () => {
  it("returns EntityScore[] including type field", async () => {
    const fakeResponse = new Response(
      JSON.stringify({
        response: JSON.stringify([
          { entity: "Alice Smith", confidence: "high", type: "person" },
          { entity: "Acme Corp", confidence: "high", type: "company" },
        ]),
      }),
    );
    globalThis.fetch = mock(async () => fakeResponse);

    const result = await scoreEntityConfidence(
      ["Alice Smith", "Acme Corp"],
      opts,
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveProperty("type", "person");
    expect(result[1]).toHaveProperty("type", "company");
  });

  it("returns fallback (all medium/person) when fetch throws", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("timeout");
    });

    const result = await scoreEntityConfidence(["Alice"], opts);
    expect(result).toEqual([
      { entity: "Alice", confidence: "medium", type: "person" },
    ]);
  });

  it("returns empty array for empty input", async () => {
    const result = await scoreEntityConfidence([], opts);
    expect(result).toEqual([]);
  });
});
