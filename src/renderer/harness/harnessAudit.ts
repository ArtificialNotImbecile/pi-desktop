import type { HarnessAuditResult, HarnessBridgeInput, HarnessControl, HarnessIssue, HarnessSnapshot } from "./harnessTypes";

export function collectSnapshot(input: HarnessBridgeInput): HarnessSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    app: {
      activeThreadId: input.activeThreadId,
      activeThreadTitle: input.activeThread?.title ?? null,
      threadCount: input.threads.length,
      messageCount: input.messages.length,
      runState: input.runState,
      activeProviderId: input.activeProviderId,
      activeModelId: input.activeModelId,
      sidebarCollapsed: input.sidebarCollapsed,
      memoryEnabled: input.memoryEnabled,
      toolsEnabled: input.toolsEnabled,
      voiceEnabled: input.voiceEnabled,
      selectedSkillCount: input.selectedSkillCount,
      navigation: input.navigation
    },
    surfaces: Object.entries(input.openSurfaces)
      .filter(([, open]) => open)
      .map(([name]) => name),
    controls: collectControls(),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight
    }
  };
}

export function auditSnapshot(snapshot: HarnessSnapshot): HarnessAuditResult {
  const issues: HarnessIssue[] = [];

  if (!document.querySelector(".app-shell")) {
    issues.push({
      id: "HARNESS-AUDIT-APP-SHELL",
      severity: "error",
      summary: "The app shell is missing, so the desktop page may be blank."
    });
  }

  for (const control of snapshot.controls) {
    if (!control.label) {
      issues.push({
        id: "HARNESS-AUDIT-CONTROL-LABEL",
        severity: "error",
        summary: "Visible interactive control has no accessible label.",
        selector: control.selector
      });
    }

    if (isIconOnly(control) && (!control.label || !control.title)) {
      issues.push({
        id: "HARNESS-AUDIT-ICON-LABEL",
        severity: "error",
        summary: "Icon-only control must have both an accessible label and title.",
        selector: control.selector,
        label: control.label
      });
    }

    if (control.disabled && !control.disabledReason) {
      issues.push({
        id: "HARNESS-AUDIT-DISABLED-REASON",
        severity: "warning",
        summary: "Disabled control should expose a visible or tooltip reason.",
        selector: control.selector,
        label: control.label
      });
    }

    if (control.bounds.width < 24 || control.bounds.height < 24) {
      issues.push({
        id: "HARNESS-AUDIT-HIT-TARGET",
        severity: "warning",
        summary: "Visible control has a small hit target.",
        selector: control.selector,
        label: control.label
      });
    }

    const element = document.querySelector<HTMLElement>(control.selector);
    if (element && element.scrollWidth > element.clientWidth + 1) {
      issues.push({
        id: "HARNESS-AUDIT-TEXT-OVERFLOW",
        severity: "error",
        summary: "Control text overflows its rendered bounds.",
        selector: control.selector,
        label: control.label
      });
    }
  }

  for (const surface of collectFloatingSurfaces()) {
    if (surface.bounds.x < -1 || surface.bounds.y < -1 || surface.bounds.right > snapshot.viewport.width + 1 || surface.bounds.bottom > snapshot.viewport.height + 1) {
      issues.push({
        id: "HARNESS-AUDIT-SURFACE-VIEWPORT",
        severity: "error",
        summary: `${surface.selector} extends outside the viewport.`,
        selector: surface.selector
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    issues,
    errorCount: issues.filter((issue) => issue.severity === "error").length,
    warningCount: issues.filter((issue) => issue.severity === "warning").length,
    snapshot
  };
}

function collectControls(): HarnessControl[] {
  const elements = Array.from(
    document.querySelectorAll<HTMLElement>("button, [role='button'], input, textarea, select, [contenteditable='true'], [role='menuitem'], [role='tab']")
  );

  return elements
    .filter(isVisible)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        selector: selectorFor(element),
        role: roleFor(element),
        label: labelFor(element),
        text: compactText(element.textContent ?? ""),
        tag: element.tagName.toLowerCase(),
        className: typeof element.className === "string" ? element.className : "",
        disabled: isDisabled(element),
        disabledReason: disabledReasonFor(element),
        title: element.getAttribute("title") ?? "",
        ariaExpanded: element.getAttribute("aria-expanded") ?? undefined,
        bounds: {
          x: round(rect.x),
          y: round(rect.y),
          width: round(rect.width),
          height: round(rect.height),
          right: round(rect.right),
          bottom: round(rect.bottom)
        }
      };
    });
}

function collectFloatingSurfaces() {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      ".model-menu, .skill-menu, .side-menu, .message-menu, .settings-panel, .search-backdrop, .command-panel, .context-panel, .trace-panel, .memory-panel, .activity-panel, .confirm-dialog, .memory-dialog-backdrop, .image-lightbox, .model-dialog"
    )
  )
    .filter(isVisible)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        selector: selectorFor(element),
        bounds: {
          x: round(rect.x),
          y: round(rect.y),
          width: round(rect.width),
          height: round(rect.height),
          right: round(rect.right),
          bottom: round(rect.bottom)
        }
      };
    });
}

function isVisible(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

function roleFor(element: HTMLElement) {
  return element.getAttribute("role") ?? element.tagName.toLowerCase();
}

function labelFor(element: HTMLElement) {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const label = document.getElementById(labelledBy);
    if (label) return compactText(label.textContent ?? "");
  }
  for (const candidate of [
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.placeholder : null,
    element.textContent
  ]) {
    const label = compactText(candidate ?? "");
    if (label) return label;
  }
  return "";
}

function isDisabled(element: HTMLElement) {
  if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return element.disabled;
  }
  return element.getAttribute("aria-disabled") === "true";
}

function disabledReasonFor(element: HTMLElement) {
  const describedBy = element.getAttribute("aria-describedby");
  const describedText = describedBy ? compactText(document.getElementById(describedBy)?.textContent ?? "") : "";
  if (describedText) return describedText;
  return compactText(element.getAttribute("title") ?? element.getAttribute("aria-label") ?? "");
}

function isIconOnly(control: HarnessControl) {
  return (
    control.className.split(/\s+/).some((className) => ["icon-button", "window-control", "tool", "send-button"].includes(className)) ||
    (control.text.length <= 2 && control.tag === "button")
  );
}

function selectorFor(element: HTMLElement) {
  if (element.id) return `#${escapeCss(element.id)}`;
  const dataHarness = element.getAttribute("data-harness-id");
  if (dataHarness) return `[data-harness-id="${escapeAttribute(dataHarness)}"]`;

  const path: string[] = [];
  let current: HTMLElement | null = element;
  while (current && current !== document.body && path.length < 5) {
    let segment = current.tagName.toLowerCase();
    const className = typeof current.className === "string" ? current.className.split(/\s+/).filter(Boolean)[0] : "";
    if (className) segment += `.${escapeCss(className)}`;
    const parent: HTMLElement | null = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((child) => child.tagName === current?.tagName);
      if (siblings.length > 1) segment += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }
    path.unshift(segment);
    current = parent;
  }
  return path.join(" > ");
}

function compactText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function escapeCss(value: string) {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function escapeAttribute(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
