import type { RightPanelTab } from "../../navigation/routes";

export function nextTerminalTabTitle(openTabs: RightPanelTab[]): string {
  const used = new Set<number>();
  for (const tab of openTabs) {
    if (tab.mode !== "terminal") continue;
    const match = /^Terminal(?: (\d+))?$/.exec(tab.title);
    if (!match) continue;
    used.add(match[1] ? Number(match[1]) : 1);
  }
  let index = 1;
  while (used.has(index)) index += 1;
  return index === 1 ? "Terminal" : `Terminal ${index}`;
}
