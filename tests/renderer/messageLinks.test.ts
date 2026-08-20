import { describe, expect, test } from "vitest";
import {
  classifyMessageLink,
  fileBadge,
  fileCategory,
  fileDirectory,
  fileName,
  localFileSrc,
  messageUrlTransform
} from "../../src/renderer/components/chat/messageLinks";

describe("message link classification", () => {
  test("treats web URLs as external targets", () => {
    expect(classifyMessageLink("https://example.com/a?b=1#c")).toEqual({
      kind: "external",
      href: "https://example.com/a?b=1#c"
    });
    expect(classifyMessageLink("mailto:someone@example.com").kind).toBe("external");
  });

  test("treats POSIX absolute paths as local files", () => {
    expect(classifyMessageLink("/Users/me/project/app.py")).toEqual({
      kind: "local-file",
      path: "/Users/me/project/app.py"
    });
  });

  test("treats Windows drive paths as local files rather than a `c:` scheme", () => {
    expect(classifyMessageLink("C:/Users/me/app.ts")).toEqual({
      kind: "local-file",
      path: "C:/Users/me/app.ts"
    });
    expect(classifyMessageLink("D:\\work\\notes.docx")).toEqual({
      kind: "local-file",
      path: "D:\\work\\notes.docx"
    });
  });

  test("treats UNC and home-relative paths as local files", () => {
    expect(classifyMessageLink("\\\\server\\share\\a.txt").kind).toBe("local-file");
    expect(classifyMessageLink("~/Documents/a.pdf")).toEqual({
      kind: "local-file",
      path: "~/Documents/a.pdf"
    });
  });

  test("routes image extensions to the inline image form", () => {
    expect(classifyMessageLink("/tmp/chart.PNG")).toEqual({ kind: "local-image", path: "/tmp/chart.PNG" });
    expect(classifyMessageLink("C:/tmp/shot.webp").kind).toBe("local-image");
  });

  test("splits an optional line suffix off a local path", () => {
    expect(classifyMessageLink("/src/app.py:12")).toEqual({ kind: "local-file", path: "/src/app.py", line: 12 });
    expect(classifyMessageLink("/src/app.py:12:4")).toEqual({ kind: "local-file", path: "/src/app.py", line: 12 });
  });

  test("never mistakes a Windows drive colon for a line number", () => {
    expect(classifyMessageLink("C:/a.ts")).toEqual({ kind: "local-file", path: "C:/a.ts" });
    expect(classifyMessageLink("C:/src/a.ts:9")).toEqual({ kind: "local-file", path: "C:/src/a.ts", line: 9 });
  });

  test("keeps paths that merely end in digits intact", () => {
    expect(classifyMessageLink("/var/log/app.2026")).toEqual({ kind: "local-file", path: "/var/log/app.2026" });
    expect(classifyMessageLink("C:\\Users\\12")).toEqual({ kind: "local-file", path: "C:\\Users\\12" });
  });

  test("keeps a protocol-relative URL out of the local path branch", () => {
    expect(classifyMessageLink("//example.com/a.png").kind).not.toBe("local-image");
  });

  test("refuses to give an affordance to schemes the contract excludes", () => {
    for (const href of ["javascript:alert(1)", "file:///etc/passwd", "vscode://file/a.ts", "data:text/html,x"]) {
      expect(classifyMessageLink(href)).toEqual({ kind: "plain", href: "" });
    }
  });

  // Destinations arrive percent-encoded from the mdast-to-hast normalization,
  // so the path handed to the main process has to be decoded back first.
  test("decodes a percent-encoded local path", () => {
    expect(classifyMessageLink("/Users/me/My%20Shots/a%20b.png")).toEqual({
      kind: "local-image",
      path: "/Users/me/My Shots/a b.png"
    });
    expect(classifyMessageLink("C:/My%20Work/a.ts")).toEqual({
      kind: "local-file",
      path: "C:/My Work/a.ts"
    });
  });

  test("restores a literal percent in a filename", () => {
    expect(classifyMessageLink("/tmp/100%25%20done.txt")).toEqual({
      kind: "local-file",
      path: "/tmp/100% done.txt"
    });
  });

  test("does not read an encoded colon as a line separator", () => {
    expect(classifyMessageLink("/tmp/a%3A12.txt")).toEqual({ kind: "local-file", path: "/tmp/a:12.txt" });
  });

  test("keeps in-document anchors as ordinary links", () => {
    expect(classifyMessageLink("#section")).toEqual({ kind: "plain", href: "#section" });
  });

  test("handles a missing or blank destination", () => {
    expect(classifyMessageLink(undefined)).toEqual({ kind: "plain", href: "" });
    expect(classifyMessageLink("   ")).toEqual({ kind: "plain", href: "" });
  });
});

describe("markdown URL transform", () => {
  // react-markdown's default sanitizer reads `C:` as an unsafe protocol and
  // returns an empty string, which would silently delete every Windows path.
  test("passes local paths through untouched", () => {
    expect(messageUrlTransform("C:/Users/me/a.ts")).toBe("C:/Users/me/a.ts");
    expect(messageUrlTransform("D:\\work\\a.docx")).toBe("D:\\work\\a.docx");
    expect(messageUrlTransform("/Users/me/a.png")).toBe("/Users/me/a.png");
    expect(messageUrlTransform("~/a.pdf")).toBe("~/a.pdf");
  });

  test("still strips destinations the default sanitizer rejects", () => {
    expect(messageUrlTransform("javascript:alert(1)")).toBe("");
  });

  test("leaves ordinary web URLs alone", () => {
    expect(messageUrlTransform("https://example.com/a")).toBe("https://example.com/a");
  });
});

describe("file presentation", () => {
  test("derives a name and directory from either separator", () => {
    expect(fileName("/Users/me/Q3 report.docx")).toBe("Q3 report.docx");
    expect(fileDirectory("/Users/me/Q3 report.docx")).toBe("/Users/me");
    expect(fileName("C:\\work\\deck.pptx")).toBe("deck.pptx");
    expect(fileDirectory("C:\\work\\deck.pptx")).toBe("C:\\work");
  });

  test("groups extensions into the families the chip is coloured by", () => {
    expect(fileCategory("/a/report.docx")).toBe("document");
    expect(fileCategory("/a/model.xlsx")).toBe("spreadsheet");
    expect(fileCategory("/a/deck.pptx")).toBe("presentation");
    expect(fileCategory("/a/main.rs")).toBe("code");
    expect(fileCategory("/a/config.yaml")).toBe("data");
    expect(fileCategory("/a/archive.unknownext")).toBe("other");
  });

  test("keeps the badge short enough for the chip's leading slot", () => {
    expect(fileBadge("/a/report.docx")).toBe("DOCX");
    expect(fileBadge("/a/notes.markdown")).toBe("FILE");
    expect(fileBadge("/a/Makefile")).toBe("FILE");
  });

  test("encodes a local image into a routable protocol URL", () => {
    expect(localFileSrc("/Users/me/My Photos/a b.png")).toBe(
      "jasmine-file://local/Users/me/My%20Photos/a%20b.png"
    );
    expect(localFileSrc("C:\\work\\a.png")).toBe("jasmine-file://local/C%3A/work/a.png");
  });
});
