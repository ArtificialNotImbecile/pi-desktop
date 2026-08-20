import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { I18nProvider } from "../../src/renderer/i18n";
import { MarkdownMessage } from "../../src/renderer/components/chat/MarkdownMessage";
import { resetLocalFileStore } from "../../src/renderer/components/chat/localFileStore";
import { installFakeBridge, type FakeBridge } from "./fakeBridge";

let fake: FakeBridge;

beforeEach(() => {
  resetLocalFileStore();
  fake = installFakeBridge();
});

afterEach(() => {
  resetLocalFileStore();
});

function mount(content: string, streaming = false) {
  return render(
    <I18nProvider language="en">
      <MarkdownMessage content={content} onCopyCode={vi.fn()} streaming={streaming} />
    </I18nProvider>
  );
}

/** The chip settles only once the main process has answered about the path. */
function chip(): Promise<HTMLButtonElement> {
  return waitFor(() => {
    const found = document.querySelector<HTMLButtonElement>(".file-reference");
    if (!found) throw new Error("no file reference rendered");
    return found;
  });
}

function image(): Promise<HTMLImageElement> {
  return waitFor(() => {
    const found = document.querySelector<HTMLImageElement>(".message-image img");
    if (!found) throw new Error("no inline image rendered");
    return found;
  });
}

describe("local file references in an answer", () => {
  test("renders a local file link as a chip that opens with the system default", async () => {
    fake.setLocalFiles([{ path: "/Users/me/reports/Q3.docx" }]);
    mount("See [Q3 summary](/Users/me/reports/Q3.docx) for the numbers.");

    const button = await chip();
    expect(button.textContent).toContain("Q3 summary");
    expect(button.querySelector(".file-reference-badge")?.textContent).toBe("DOCX");
    expect(button.dataset.category).toBe("document");
    expect(screen.getByRole("button", { name: /Q3 summary/ })).toBe(button);

    fireEvent.click(button);
    expect(fake.calls.openLocalPath).toEqual(["/Users/me/reports/Q3.docx"]);
  });

  test("keeps a line number out of the opened path but shows it on the chip", async () => {
    fake.setLocalFiles([{ path: "/srv/app.py" }]);
    mount("Fixed in [app.py](/srv/app.py:42).");

    const button = await chip();
    expect(button.querySelector(".file-reference-line")?.textContent).toBe(":42");
    fireEvent.click(button);
    expect(fake.calls.openLocalPath).toEqual(["/srv/app.py"]);
  });

  test("survives a Windows drive path that the default sanitizer would delete", async () => {
    fake.setLocalFiles([{ path: "C:/work/notes.md" }]);
    mount("Notes are in [notes.md](C:/work/notes.md).");

    const button = await chip();
    fireEvent.click(button);
    expect(fake.calls.openLocalPath).toEqual(["C:/work/notes.md"]);
  });

  test("marks a path that does not exist and refuses to open it", async () => {
    mount("Check [gone.txt](/tmp/gone.txt).");

    const button = await chip();
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(button.textContent).toContain("File not found");
    fireEvent.click(button);
    expect(fake.calls.openLocalPath).toEqual([]);
  });

  test("reveals a file in its folder on secondary click", async () => {
    fake.setLocalFiles([{ path: "/Users/me/a.csv" }]);
    mount("Data: [a.csv](/Users/me/a.csv)");

    const button = await chip();
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.contextMenu(button);
    expect(fake.calls.revealLocalPath).toEqual(["/Users/me/a.csv"]);
  });

  test("keeps credential-bearing local paths out of visible file chrome", async () => {
    const sensitivePath = "/tmp/access_token=hidden/report.docx";
    fake.setLocalFiles([{ path: sensitivePath }]);
    mount(`See [report](<${sensitivePath}>).`);

    const button = await chip();
    await waitFor(() => expect(fake.calls.describeLocalFiles).toEqual([[sensitivePath]]));
    expect(button.getAttribute("title")).toBeNull();
    expect(button.querySelector(".file-reference-path")).toBeNull();
    expect(button.outerHTML).not.toContain("access_token");

    fireEvent.click(button);
    expect(fake.calls.openLocalPath).toEqual([sensitivePath]);
  });

  test("shows an actionable error when opening a file fails", async () => {
    const filePath = "/tmp/report.docx";
    fake.setLocalFiles([{ path: filePath }]);
    fake.setOpenLocalPathBehavior(() => Promise.reject(new Error("private OS detail")));
    mount(`[report](${filePath})`);

    const button = await chip();
    fireEvent.click(button);
    expect(await screen.findByText(/Could not open file/)).toBeTruthy();
    expect(button.outerHTML).not.toContain("private OS detail");

    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByText(/Could not open file/)).toBeNull());
    expect(fake.calls.openLocalPath).toEqual([filePath, filePath]);
  });

  test("shows an actionable error when revealing a file fails", async () => {
    const filePath = "/tmp/report.docx";
    fake.setLocalFiles([{ path: filePath }]);
    fake.setRevealLocalPathBehavior(() => Promise.reject(new Error("private OS detail")));
    mount(`[report](${filePath})`);

    const button = await chip();
    fireEvent.contextMenu(button);
    expect(await screen.findByText(/Could not show file in its folder/)).toBeTruthy();
    expect(button.outerHTML).not.toContain("private OS detail");
    expect(fake.calls.revealLocalPath).toEqual([filePath]);
  });

  test("asks the main process about each referenced path exactly once", async () => {
    fake.setLocalFiles([{ path: "/a/one.ts" }, { path: "/a/two.ts" }]);
    mount("[one](/a/one.ts) and [two](/a/two.ts) and [one again](/a/one.ts)");

    await chip();
    await waitFor(() => expect(fake.calls.describeLocalFiles.length).toBeGreaterThan(0));
    // Batched into a single round trip, with the repeated path asked for once.
    expect(fake.calls.describeLocalFiles).toEqual([["/a/one.ts", "/a/two.ts"]]);
  });

  test("splits a large restore before the IPC metadata limit", async () => {
    const paths = Array.from({ length: 205 }, (_, index) => `/tmp/reference-${index}.txt`);
    fake.setLocalFiles(paths.map((path) => ({ path })));
    mount(paths.map((path, index) => `[reference ${index}](${path})`).join("\n"));

    await waitFor(() => expect(fake.calls.describeLocalFiles).toHaveLength(2));
    expect(fake.calls.describeLocalFiles.map((batch) => batch.length)).toEqual([200, 5]);
    await waitFor(() => expect(document.querySelectorAll(".file-reference")).toHaveLength(205));
    expect([...document.querySelectorAll<HTMLButtonElement>(".file-reference")]
      .every((button) => !button.disabled)).toBe(true);
  });

  test("revalidates a missing path when a later answer references the created file", async () => {
    const first = mount("Not ready: [report](/tmp/report.docx)");
    const missing = await chip();
    await waitFor(() => expect(missing.disabled).toBe(true));
    first.unmount();

    fake.setLocalFiles([{ path: "/tmp/report.docx" }]);
    mount("Now ready: [report](/tmp/report.docx)");

    const available = await chip();
    await waitFor(() => expect(fake.calls.describeLocalFiles).toHaveLength(2));
    await waitFor(() => expect(available.disabled).toBe(false));
    fireEvent.click(available);
    expect(fake.calls.describeLocalFiles).toEqual([
      ["/tmp/report.docx"],
      ["/tmp/report.docx"]
    ]);
    expect(fake.calls.openLocalPath).toEqual(["/tmp/report.docx"]);
  });
});

describe("local images in an answer", () => {
  test("displays an image over the local-file protocol and previews it on click", async () => {
    fake.setLocalFiles([{ path: "/Users/me/chart.png", isImage: true, mediaType: "image/png" }]);
    mount("![Revenue chart](/Users/me/chart.png)");

    const rendered = await image();
    expect(rendered.getAttribute("src")).toBe("jasmine-file://local/Users/me/chart.png");
    expect(rendered.getAttribute("alt")).toBe("Revenue chart");

    fireEvent.click(screen.getByRole("button", { name: "Revenue chart" }));
    expect(document.querySelector(".image-lightbox")).not.toBeNull();
  });

  test("encodes spaces in an image path rather than truncating it", async () => {
    fake.setLocalFiles([{ path: "/Users/me/My Shots/a b.png", isImage: true }]);
    mount("![shot](</Users/me/My Shots/a b.png>)");

    const rendered = await image();
    expect(rendered.getAttribute("src")).toBe("jasmine-file://local/Users/me/My%20Shots/a%20b.png");
  });

  test("falls back to a chip when the image does not exist", async () => {
    mount("![missing](/tmp/nope.png)");

    const button = await chip();
    expect(button.textContent).toContain("missing");
    expect(document.querySelector(".message-image")).toBeNull();
  });

  test("falls back to a chip when a present file is not displayable", async () => {
    // An oversized or undecodable image describes as a file, not an image.
    fake.setLocalFiles([{ path: "/tmp/huge.png", isImage: false }]);
    mount("![huge](/tmp/huge.png)");

    const button = await chip();
    expect(button.textContent).toContain("huge");
    expect(document.querySelector(".message-image")).toBeNull();
  });

  test("revalidates image capability when a later answer references a replaced file", async () => {
    fake.setLocalFiles([{ path: "/tmp/chart.png", isImage: false }]);
    const first = mount("![chart](/tmp/chart.png)");
    await chip();
    first.unmount();

    fake.setLocalFiles([{ path: "/tmp/chart.png", isImage: true, mediaType: "image/png" }]);
    mount("![updated chart](/tmp/chart.png)");

    const rendered = await image();
    expect(rendered.getAttribute("alt")).toBe("updated chart");
    expect(fake.calls.describeLocalFiles).toEqual([
      ["/tmp/chart.png"],
      ["/tmp/chart.png"]
    ]);
  });

  test("never fetches a remote image", async () => {
    mount("![remote](https://example.com/a.png)");

    await waitFor(() => expect(document.querySelector("a.message-link")).not.toBeNull());
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("web links in an answer", () => {
  test("hands a web link to the OS browser instead of navigating", async () => {
    mount("Read the [docs](https://example.com/docs).");

    const link = await waitFor(() => {
      const found = document.querySelector<HTMLAnchorElement>("a.message-link");
      if (!found) throw new Error("no link rendered");
      return found;
    });
    fireEvent.click(link);
    expect(fake.calls.openExternalUrl).toEqual(["https://example.com/docs"]);
    expect(screen.getByRole("link", { name: "docs" })).toBe(link);
    // Nothing in the app may open a window for model-authored content.
    expect(link.getAttribute("target")).toBeNull();
  });

  test("keeps credentials out of link chrome while opening the original destination", async () => {
    const destination = "https://user:pass@example.test/file?access_token=hidden";
    mount(`Read the [report](<${destination}>).`);

    const link = await waitFor(() => screen.getByRole<HTMLAnchorElement>("link", { name: "report" }));
    expect(link.getAttribute("href")).toBe("https://example.test/file");
    expect(link.getAttribute("title")).toBe("https://example.test/file");
    expect(link.outerHTML).not.toContain("user:pass");
    expect(link.outerHTML).not.toContain("access_token");

    fireEvent.click(link);
    expect(fake.calls.openExternalUrl).toEqual([destination]);
  });

  test.each([
    ["angle autolink", "<https://user:pass@example.test/file?access_token=hidden>"],
    ["bare URL", "https://user:pass@example.test/file?access_token=hidden"]
  ])("sanitizes credential-bearing %s text as well as its link chrome", async (_label, markdown) => {
    const destination = "https://user:pass@example.test/file?access_token=hidden";
    mount(markdown);

    const link = await screen.findByRole("link", { name: "https://example.test/file" });
    expect(link.getAttribute("href")).toBe("https://example.test/file");
    expect(link.outerHTML).not.toContain("user:pass");
    expect(link.outerHTML).not.toContain("access_token");
    fireEvent.click(link);
    expect(fake.calls.openExternalUrl).toEqual([destination]);
  });

  test("preserves each web link label as its accessible name", async () => {
    mount("Open the [report](https://example.com/report) or [dashboard](https://example.com/dashboard).");

    expect(await screen.findByRole("link", { name: "report" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "dashboard" })).toBeTruthy();
  });

  test("shows an actionable error when the OS cannot open a web link", async () => {
    fake.setOpenExternalUrlBehavior(() => Promise.reject(new Error("private OS detail")));
    mount("Open the [report](https://example.com/report).");

    const link = await screen.findByRole("link", { name: "report" });
    fireEvent.click(link);
    expect(await screen.findByText(/Could not open link/)).toBeTruthy();
    expect(link.outerHTML).not.toContain("private OS detail");

    fireEvent.click(link);
    await waitFor(() => expect(screen.queryByText(/Could not open link/)).toBeNull());
    expect(fake.calls.openExternalUrl).toEqual([
      "https://example.com/report",
      "https://example.com/report"
    ]);
  });

  test("strips a destination whose scheme the contract excludes", async () => {
    mount("Do not [click](javascript:alert(1)) this.");

    await waitFor(() => expect(screen.getByText("click")).toBeTruthy());
    expect(document.querySelector("a")).toBeNull();
  });
});

describe("linked images in an answer", () => {
  test("renders a remote image nested in a web link as one outer link", async () => {
    mount("[![preview](https://images.example/chart.png)](https://example.com/report)");

    const link = await screen.findByRole("link", { name: "preview" });
    expect(document.querySelectorAll("a")).toHaveLength(1);
    expect(document.querySelector("button")).toBeNull();
    fireEvent.click(link);
    expect(fake.calls.openExternalUrl).toEqual(["https://example.com/report"]);
  });

  test("renders a file image nested in a local link as one outer file control", async () => {
    fake.setLocalFiles([{ path: "/tmp/report.pdf" }]);
    mount("[![preview](/tmp/readme.txt)](/tmp/report.pdf)");

    const button = await chip();
    await waitFor(() => expect(fake.calls.describeLocalFiles).toEqual([["/tmp/report.pdf"]]));
    expect(document.querySelectorAll("button")).toHaveLength(1);
    expect(document.querySelector("a")).toBeNull();
    fireEvent.click(button);
    expect(fake.calls.openLocalPath).toEqual(["/tmp/report.pdf"]);
  });

  test.each([
    ["mixed label", "[![preview](/tmp/readme.txt) chart](https://example.com/report)", "preview chart"],
    ["formatted mixed label", "[**![preview](https://images.example/chart.png) chart** details](https://example.com/report)", "preview chart details"]
  ])("flattens images anywhere inside a %s into one outer control", async (_label, markdown, accessibleName) => {
    mount(markdown);

    const link = await screen.findByRole("link", { name: accessibleName });
    expect(document.querySelectorAll("a")).toHaveLength(1);
    expect(document.querySelector("button")).toBeNull();
    expect(fake.calls.describeLocalFiles).toEqual([]);
    fireEvent.click(link);
    expect(fake.calls.openExternalUrl).toEqual(["https://example.com/report"]);
  });
});

describe("references while an answer is still streaming", () => {
  test("holds off resolving a path in the chunk still being written", async () => {
    mount("Writing to [partial](/Users/me/rep", true);

    // A half-typed path must not be reported to the reader as a missing file.
    await Promise.resolve();
    expect(fake.calls.describeLocalFiles).toEqual([]);
  });

  test("resolves references once the answer settles", async () => {
    fake.setLocalFiles([{ path: "/Users/me/report.docx" }]);
    const view = mount("Saved to [report](/Users/me/report.docx)", true);
    expect(fake.calls.describeLocalFiles).toEqual([]);

    view.rerender(
      <I18nProvider language="en">
        <MarkdownMessage
          content="Saved to [report](/Users/me/report.docx)"
          onCopyCode={vi.fn()}
          streaming={false}
        />
      </I18nProvider>
    );

    await chip();
    await waitFor(() => expect(fake.calls.describeLocalFiles).toEqual([["/Users/me/report.docx"]]));
  });
});
