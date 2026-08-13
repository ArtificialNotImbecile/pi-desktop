import { describe, expect, test } from "vitest";
import { formatRelativeTime } from "../../src/renderer/components/chat/ArtifactsPane";
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
});
