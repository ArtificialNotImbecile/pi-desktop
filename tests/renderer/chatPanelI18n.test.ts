import { describe, expect, test } from "vitest";
import { captureAlert, formatRelativeTime } from "../../src/renderer/components/chat/ArtifactsPane";
import type { FileChangeCaptureSummary, FileChangeCoverage } from "../../src/shared/ipc";
import { translate } from "../../src/shared/i18n";

describe("chat panel localization", () => {
  test("artifact relative timestamps keep English copy stable and translate short Chinese variants", () => {
    const now = Date.parse("2026-08-13T06:00:00.000Z");
    const ago = (milliseconds: number) => new Date(now - milliseconds).toISOString();

    expect(formatRelativeTime(ago(20_000), now, "en", translate("en"))).toBe("just now");
    expect(formatRelativeTime(ago(3 * 60_000), now, "en", translate("en"))).toBe("3 min ago");
    expect(formatRelativeTime(ago(2 * 60 * 60_000), now, "en", translate("en"))).toBe("2 hr ago");
    expect(formatRelativeTime(ago(2 * 24 * 60 * 60_000), now, "en", translate("en"))).toBe("2 d ago");

    expect(formatRelativeTime(ago(20_000), now, "zh", translate("zh"))).toBe("刚刚");
    expect(formatRelativeTime(ago(3 * 60_000), now, "zh", translate("zh"))).toBe("3 分钟前");
    expect(formatRelativeTime(ago(2 * 60 * 60_000), now, "zh", translate("zh"))).toBe("2 小时前");
    expect(formatRelativeTime(ago(2 * 24 * 60 * 60_000), now, "zh", translate("zh"))).toBe("2 天前");
  });

  test("every artifact coverage alert keeps its English label and has a Chinese label", () => {
    const capture = (coverage: Partial<FileChangeCoverage>, warnings: string[] = []): FileChangeCaptureSummary => ({
      id: "capture-1",
      threadId: "thread-1",
      runId: "run-1",
      schemaVersion: 1,
      startedAt: "2026-08-13T06:00:00.000Z",
      completedAt: "2026-08-13T06:00:01.000Z",
      capturedAt: "2026-08-13T06:00:01.000Z",
      cwd: "C:\\workspace",
      roots: [],
      excludes: [],
      warnings,
      coverage: { status: "complete", target: "local", ...coverage },
      changes: []
    });
    const variants = [
      capture({ status: "unsupported" }),
      capture({ status: "failed" }),
      capture({ status: "partial" }),
      capture({ trackingMode: "managed-tools-only", bashInvoked: true }),
      capture({}, ["one"]),
      capture({}, ["one", "two"])
    ];

    expect(variants.map((item) => captureAlert(item, translate("en"))?.label)).toEqual([
      "Tracking unavailable",
      "Tracking failed",
      "Partial coverage",
      "Shell not tracked",
      "1 warning",
      "2 warnings"
    ]);
    expect(variants.map((item) => captureAlert(item, translate("zh"))?.label)).toEqual([
      "变更跟踪不可用",
      "变更跟踪失败",
      "部分覆盖",
      "未跟踪 Shell 变更",
      "1 条警告",
      "2 条警告"
    ]);
  });
});
