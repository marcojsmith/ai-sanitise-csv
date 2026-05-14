import { afterEach, describe, expect, it } from "bun:test";
import { buildOutputPath, readCSV, writeCSV } from "../src/csv-processor";

const TEST_CSV = `preamble line
another meta line
col1,col2,col3,col4
a,b,c,d
e,f,g,h`;

const CSV_NO_HEADER = `just a single column`;

describe("readCSV", () => {
  const tmpFiles: string[] = [];

  afterEach(async () => {
    for (const f of tmpFiles) {
      try {
        await Bun.file(f).delete();
      } catch {}
    }
    tmpFiles.length = 0;
  });

  async function writeTmp(content: string): Promise<string> {
    const p = `tests/tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`;
    await Bun.write(p, content);
    tmpFiles.push(p);
    return p;
  }

  it("strips preamble and parses headers + rows", async () => {
    const p = await writeTmp(TEST_CSV);
    const result = await readCSV(p);
    expect(result.headers).toEqual(["col1", "col2", "col3", "col4"]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({
      col1: "a",
      col2: "b",
      col3: "c",
      col4: "d",
    });
  });

  it("throws if no header row with 4+ columns", async () => {
    const p = await writeTmp(CSV_NO_HEADER);
    expect(readCSV(p)).rejects.toThrow("Could not find a header row");
  });

  it("throws on fatal parse errors", async () => {
    const p = await writeTmp(
      `col1,col2,col3,col4\n"unclosed"quote,val2,val3,val4`,
    );
    expect(readCSV(p)).rejects.toThrow("CSV parse errors");
  });
});

describe("writeCSV", () => {
  const tmpFiles: string[] = [];

  afterEach(async () => {
    for (const f of tmpFiles) {
      try {
        await Bun.file(f).delete();
      } catch {}
    }
    tmpFiles.length = 0;
  });

  async function writeTmp(content: string): Promise<string> {
    const p = `tests/tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`;
    await Bun.write(p, content);
    tmpFiles.push(p);
    return p;
  }

  it("writes CSV and returns output path", async () => {
    const p = await writeTmp("h1,h2\n1,2");
    const out = await writeCSV(p, {
      headers: ["h1", "h2"],
      rows: [{ h1: "a", h2: "b" }],
    });
    expect(out).toEndWith("_sanitised.csv");
    const text = await Bun.file(out).text();
    expect(text).toContain("h1,h2");
    expect(text).toContain("a,b");
    await Bun.file(out).delete();
  });
});

describe("buildOutputPath", () => {
  it("appends _sanitised to the filename", () => {
    const result = buildOutputPath("path/input.csv");
    expect(result).toContain("input_sanitised.csv");
  });
});
