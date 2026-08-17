import { describe, expect, test } from "vitest";
import { credentialSafeText, sanitizedHttpUrl } from "../../src/renderer/components/chat/safeDisplay";

describe("collapsed chat display sanitization", () => {
  test.each([
    ["ghp_", "0123456789abcdefghijklmnopqrstuv"].join(""),
    ["github_pat_", "0123456789abcdefghijklmnopqrstuvwxyz"].join(""),
    ["glpat-", "0123456789abcdefghijklmnop"].join(""),
    ["sk-proj-", "0123456789abcdefghijklmnopqrstuvwxyz"].join(""),
    ["sk_live_", "0123456789abcdefghijklmnop"].join(""),
    ["npm_", "0123456789abcdefghijklmnopqrstuv"].join(""),
    ["xoxb-", "0123456789-0123456789-abcdefghijklmnop"].join(""),
    ["AIza", "0123456789abcdefghijklmnopqrstuvABCDE"].join(""),
    ["AKIA", "0123456789ABCDEF"].join(""),
    ["eyJabcdefghijklmno", "eyJpqrstuvwxyz12", "abcdefghijklmnop"].join(".")
  ])("hides standalone credential %s", (credential) => {
    expect(credentialSafeText(`provider output ${credential}`)).toBe("");
  });

  test("keeps ordinary collapsed text", () => {
    expect(credentialSafeText("Reviewed src/renderer/App.tsx")).toBe("Reviewed src/renderer/App.tsx");
  });

  test("hides authenticated URLs embedded in otherwise ordinary text", () => {
    expect(credentialSafeText("Mirror: https://alice:hunter2@private.example.test/report")).toBe("");
    expect(credentialSafeText("Mirror: https://alice@private.example.test/report")).toBe("");
    expect(credentialSafeText("Mirror: //alice:hunter2@private.example.test/report")).toBe("");
    expect(credentialSafeText("Mirror: //alice@private.example.test/report")).toBe("");
  });

  test("keeps a safe URL path but removes credential-bearing paths, auth, query, and hash", () => {
    expect(sanitizedHttpUrl("https://user:pass@example.test/docs/guide?access_token=hidden#secret"))
      .toBe("https://example.test/docs/guide");
    expect(sanitizedHttpUrl(`https://example.test/private/${["ghp_", "0123456789abcdefghijklmnopqrstuv"].join("")}?download=1`))
      .toBe("https://example.test");
    expect(sanitizedHttpUrl(`https://example.test/private/${["sk-proj-", "0123456789abcdefghijklmnopqrstuvwxyz"].join("")}`))
      .toBe("https://example.test");
  });
});
