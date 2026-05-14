import { describe, expect, it } from "bun:test";
import {
  applyAllReplacements,
  escapeRegex,
  extractUniqueEmails,
} from "../src/sanitizer";

describe("escapeRegex", () => {
  it("escapes special regex characters", () => {
    expect(escapeRegex("hello.world")).toBe("hello\\.world");
    expect(escapeRegex("foo*bar")).toBe("foo\\*bar");
    expect(escapeRegex("a+b?c")).toBe("a\\+b\\?c");
  });

  it("does not modify plain text", () => {
    expect(escapeRegex("hello")).toBe("hello");
    expect(escapeRegex("abc123")).toBe("abc123");
  });

  it("escapes brackets and backslashes", () => {
    expect(escapeRegex("[test]")).toBe("\\[test\\]");
    expect(escapeRegex("a\\b")).toBe("a\\\\b");
  });
});

describe("extractUniqueEmails", () => {
  it("finds emails across rows and columns", () => {
    const rows = [
      { text: "contact alice@test.com", other: "nope" },
      { text: "bob@test.com is here", other: "carol@test.com" },
    ];
    const result = extractUniqueEmails(rows, ["text", "other"]);
    expect(result.size).toBe(3);
    expect(result.has("alice@test.com")).toBeTrue();
    expect(result.has("bob@test.com")).toBeTrue();
    expect(result.has("carol@test.com")).toBeTrue();
  });

  it("lowercases emails", () => {
    const rows = [{ text: "ALICE@TEST.COM", other: "" }];
    const result = extractUniqueEmails(rows, ["text"]);
    expect(result.has("alice@test.com")).toBeTrue();
    expect(result.has("ALICE@TEST.COM")).toBeFalse();
  });

  it("returns empty set when no emails", () => {
    const rows = [{ text: "no emails here", other: "" }];
    const result = extractUniqueEmails(rows, ["text"]);
    expect(result.size).toBe(0);
  });
});

describe("applyAllReplacements", () => {
  it("replaces emails in text", () => {
    const emailMap = new Map([["alice@test.com", "alice1@example.com"]]);
    const entityMap = new Map();
    const result = applyAllReplacements(
      "email alice@test.com here",
      entityMap,
      emailMap,
    );
    expect(result).toBe("email alice1@example.com here");
  });

  it("replaces entities with word boundaries", () => {
    const emailMap = new Map();
    const entityMap = new Map([["Acme Corp", "Fake Inc"]]);
    const result = applyAllReplacements(
      "Acme Corp is great",
      entityMap,
      emailMap,
    );
    expect(result).toBe("Fake Inc is great");
  });

  it("does not replace partial word matches for entities", () => {
    const emailMap = new Map();
    const entityMap = new Map([["Acme", "Fake"]]);
    const result = applyAllReplacements(
      "AcmeCorp is here",
      entityMap,
      emailMap,
    );
    expect(result).toBe("AcmeCorp is here");
  });

  it("applies both email and entity replacements", () => {
    const emailMap = new Map([["user@test.com", "u1@x.com"]]);
    const entityMap = new Map([["John", "Jane"]]);
    const result = applyAllReplacements(
      "John at user@test.com",
      entityMap,
      emailMap,
    );
    expect(result).toBe("Jane at u1@x.com");
  });
});
