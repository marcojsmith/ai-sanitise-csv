import { beforeEach, describe, expect, it } from "bun:test";
import {
  clear,
  exportEntries,
  getCached,
  getStats,
  importEntries,
  setCached,
} from "../src/entity-cache";

describe("entity-cache", () => {
  beforeEach(() => {
    clear();
  });

  it("getCached returns null for unknown key", () => {
    expect(getCached("unknown")).toBeNull();
  });

  it("setCached then getCached returns set value", () => {
    setCached("hello world", ["foo", "bar"]);
    expect(getCached("hello world")).toEqual(["foo", "bar"]);
  });

  it("getCached normalises casing", () => {
    setCached("Hello World", ["x"]);
    expect(getCached("hello world")).toEqual(["x"]);
  });

  it("getStats returns expected shape", () => {
    const stats = getStats();
    expect(stats).toHaveProperty("size");
    expect(stats).toHaveProperty("hits");
    expect(stats).toHaveProperty("misses");
    expect(stats.size).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
  });

  it("clear empties the cache and resets stats", () => {
    setCached("a", ["1"]);
    getCached("a"); // hit
    getCached("b"); // miss
    clear();
    const stats = getStats();
    expect(stats.size).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(getCached("a")).toBeNull();
  });

  it("exportEntries / importEntries round-trip", () => {
    setCached("key1", ["v1"]);
    setCached("key2", ["v2", "v3"]);
    const entries = exportEntries();
    expect(entries.length).toBe(2);

    clear();
    importEntries(entries);
    expect(getCached("key1")).toEqual(["v1"]);
    expect(getCached("key2")).toEqual(["v2", "v3"]);
  });

  it("importEntries clears previous entries", () => {
    setCached("old", ["value"]);
    const entries = exportEntries();
    setCached("other", ["stuff"]);
    importEntries(entries);
    expect(getCached("other")).toBeNull();
    expect(getCached("old")).toEqual(["value"]);
  });
});
