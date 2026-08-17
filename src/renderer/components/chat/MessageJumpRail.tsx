import { memo, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../../shared/ipc";
import { useI18n } from "../../i18n";
import { MenuSurface } from "../ui";

export const MessageJumpRail = memo(function MessageJumpRail(props: { messages: ChatMessage[]; onNavigate(): void }) {
  const { t } = useI18n();
  const railRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const nextUserMessages = props.messages.filter(isNavigableUserMessage);
  const stableUserMessagesRef = useRef(nextUserMessages);
  if (!sameUserMessageSignature(stableUserMessagesRef.current, nextUserMessages)) {
    stableUserMessagesRef.current = nextUserMessages;
  }
  const userMessages = stableUserMessagesRef.current;
  const [marks, setMarks] = useState<Map<string, { y: number; current: boolean }>>(() => new Map());
  const marksRef = useRef(marks);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (userMessages.length < 2) return;
    const scroll = document.querySelector(".message-scroll");
    if (!(scroll instanceof HTMLElement)) return;
    const scrollElement = scroll;
    const rail = railRef.current?.querySelector(".message-jump-marks");
    if (!(rail instanceof HTMLElement)) return;
    const marksElement: HTMLElement = rail;
    const messageStack = scrollElement.querySelector(".message-stack");
    const observedElement = messageStack instanceof HTMLElement ? messageStack : scrollElement;
    const targets = userMessages.flatMap((message) => {
      const target = scrollElement.querySelector(`[data-message-id="${cssEscape(message.id)}"]`);
      return target instanceof HTMLElement ? [{ id: message.id, target }] : [];
    });
    let geometryFrame = 0;
    let scaleFrame = 0;
    let scrollFrame = 0;
    let viewportHeight = 0;
    let targetGeometry: Array<{ id: string; contentTop: number; height: number; y: number }> = [];

    function publishMarksFromCache() {
      const centerInContent = scrollElement.scrollTop + viewportHeight / 2;
      const activeId = targetGeometry.reduce<{ id: string; distance: number } | null>((best, entry) => {
        const distance = Math.abs(entry.contentTop + entry.height / 2 - centerInContent);
        if (!best || distance < best.distance) return { id: entry.id, distance };
        return best;
      }, null)?.id ?? userMessages.at(-1)?.id;
      const nextMarks = new Map<string, { y: number; current: boolean }>();
      for (const entry of targetGeometry) nextMarks.set(entry.id, { y: entry.y, current: entry.id === activeId });
      if (sameMarks(marksRef.current, nextMarks)) return;
      marksRef.current = nextMarks;
      setMarks(nextMarks);
    }

    function measureGeometry() {
      const railHeight = marksElement.clientHeight;
      const scrollRect = scrollElement.getBoundingClientRect();
      const scrollHeight = Math.max(scrollElement.scrollHeight, 1);
      viewportHeight = scrollRect.height;
      targetGeometry = targets.flatMap(({ id, target }) => {
        if (!target.isConnected) return [];
        const rect = target.getBoundingClientRect();
        const contentTop = rect.top - scrollRect.top + scrollElement.scrollTop;
        return [{
          id,
          contentTop,
          height: rect.height,
          y: clamp((contentTop / scrollHeight) * railHeight, 4, Math.max(4, railHeight - 4))
        }];
      });
      publishMarksFromCache();
    }

    function scaleCachedGeometry() {
      const railHeight = marksElement.clientHeight;
      const scrollHeight = Math.max(scrollElement.scrollHeight, 1);
      viewportHeight = scrollElement.clientHeight;
      targetGeometry = targetGeometry.map((entry) => ({
        ...entry,
        y: clamp((entry.contentTop / scrollHeight) * railHeight, 4, Math.max(4, railHeight - 4))
      }));
      publishMarksFromCache();
    }

    function scheduleGeometryMeasurement() {
      if (geometryFrame !== 0) return;
      if (scaleFrame !== 0) {
        window.cancelAnimationFrame(scaleFrame);
        scaleFrame = 0;
      }
      if (scrollFrame !== 0) {
        window.cancelAnimationFrame(scrollFrame);
        scrollFrame = 0;
      }
      geometryFrame = window.requestAnimationFrame(() => {
        geometryFrame = 0;
        measureGeometry();
      });
    }

    function scheduleCachedScale() {
      if (geometryFrame !== 0 || scaleFrame !== 0) return;
      if (scrollFrame !== 0) {
        window.cancelAnimationFrame(scrollFrame);
        scrollFrame = 0;
      }
      scaleFrame = window.requestAnimationFrame(() => {
        scaleFrame = 0;
        scaleCachedGeometry();
      });
    }

    function updateCurrentMarkFromScroll() {
      if (geometryFrame !== 0 || scaleFrame !== 0 || scrollFrame !== 0) return;
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = 0;
        publishMarksFromCache();
      });
    }

    scheduleGeometryMeasurement();
    scrollElement.addEventListener("scroll", updateCurrentMarkFromScroll, { passive: true });
    window.addEventListener("resize", scheduleGeometryMeasurement);
    // The user rows stay above the growing streaming tail. Cache their content
    // coordinates and, when only the stack height changes, rescale the marks
    // without reading every historical row's layout again.
    const stackObserver = "ResizeObserver" in window ? new ResizeObserver(scheduleCachedScale) : null;
    stackObserver?.observe(observedElement);

    // A cached contentTop is no longer valid when an earlier settled message
    // changes height (for example, a thought/tool row opens or historical code
    // block finishes laying out). Observe message rows separately so that such
    // a change coalesces into one full measurement. The live row is deliberately
    // ignored here: its high-frequency growth is already handled by the cheap
    // stack rescale above and must not re-read every historical user row.
    const awaitingInitialResize = new WeakSet<Element>();
    const rowObserver = "ResizeObserver" in window
      ? new ResizeObserver((entries) => {
          let settledLayoutChanged = false;
          for (const entry of entries) {
            if (awaitingInitialResize.delete(entry.target)) continue;
            if (entry.target instanceof HTMLElement
              && !entry.target.classList.contains("live-message")
            ) {
              settledLayoutChanged = true;
            }
          }
          if (settledLayoutChanged) scheduleGeometryMeasurement();
        })
      : null;

    function observeMessageRow(node: Node) {
      if (!(node instanceof HTMLElement) || !node.hasAttribute("data-message-id") || !rowObserver) return;
      awaitingInitialResize.add(node);
      rowObserver.observe(node);
    }

    if (messageStack instanceof HTMLElement) {
      for (const child of messageStack.children) observeMessageRow(child);
    }

    const mutationObserver = messageStack instanceof HTMLElement && "MutationObserver" in window
      ? new MutationObserver((records) => {
          let settledLayoutChanged = false;
          for (const record of records) {
            for (const node of record.addedNodes) {
              observeMessageRow(node);
              if (node instanceof HTMLElement
                && node.hasAttribute("data-message-id")
                && !node.classList.contains("live-message")) {
                settledLayoutChanged = true;
              }
            }
            for (const node of record.removedNodes) {
              if (node instanceof HTMLElement
                && node.hasAttribute("data-message-id")
                && !node.classList.contains("live-message")) {
                settledLayoutChanged = true;
              }
            }
          }
          if (settledLayoutChanged) scheduleGeometryMeasurement();
          else scheduleCachedScale();
        })
      : null;
    if (messageStack instanceof HTMLElement) {
      mutationObserver?.observe(messageStack, { childList: true });
    }
    return () => {
      window.cancelAnimationFrame(geometryFrame);
      window.cancelAnimationFrame(scaleFrame);
      window.cancelAnimationFrame(scrollFrame);
      scrollElement.removeEventListener("scroll", updateCurrentMarkFromScroll);
      window.removeEventListener("resize", scheduleGeometryMeasurement);
      stackObserver?.disconnect();
      rowObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [userMessages]);

  if (userMessages.length < 2) return null;

  return (
    <nav
      ref={railRef}
      className={`message-jump-rail ${open ? "open" : ""}`}
      aria-label={t("message.userNavigation")}
      onMouseEnter={() => setOpen(true)}
    >
      <div className="message-jump-marks" aria-hidden="true">
        {userMessages.map((message, index) => {
          const mark = marks.get(message.id);
          return (
            <span
              key={message.id}
              data-message-jump-id={message.id}
              className={mark?.current || (marks.size === 0 && index === userMessages.length - 1) ? "current" : ""}
              style={{ top: `${mark?.y ?? fallbackMarkY(index, userMessages.length)}px` }}
            />
          );
        })}
      </div>
      <button
        ref={triggerRef}
        className="message-jump-trigger"
        type="button"
        aria-label={t("message.openUserNavigation")}
        aria-expanded={open}
        onClick={() => setOpen(true)}
      />
      <MenuSurface anchorRef={triggerRef} open={open} onOpenChange={setOpen} placement="left" minWidth={258} maxWidth={320} maxHeight={360} className="message-jump-menu" role="listbox">
        {userMessages.map((message, index) => (
          <button
            key={message.id}
            type="button"
            className={marks.get(message.id)?.current ? "current" : ""}
            onClick={() => {
              jumpToMessage(message.id);
              // Lock after the synchronous jump so streaming restores preserve
              // the selected message's center, not the pre-navigation tail.
              props.onNavigate();
              setOpen(false);
            }}
            title={message.content}
          >
            <small>{index + 1}/{userMessages.length}</small>
            <span>{messagePreview(message.content)}</span>
            <i aria-hidden="true" />
          </button>
        ))}
      </MenuSurface>
    </nav>
  );
}, (previous, next) => sameUserMessageSignature(previous.messages, next.messages)
  && previous.onNavigate === next.onNavigate);

function isNavigableUserMessage(message: ChatMessage): boolean {
  return message.role === "user" && message.content.trim() !== "";
}

function sameUserMessageSignature(left: readonly ChatMessage[], right: readonly ChatMessage[]): boolean {
  let leftIndex = 0;
  let rightIndex = 0;
  while (true) {
    while (leftIndex < left.length && !isNavigableUserMessage(left[leftIndex])) leftIndex += 1;
    while (rightIndex < right.length && !isNavigableUserMessage(right[rightIndex])) rightIndex += 1;
    const leftMessage = left[leftIndex];
    const rightMessage = right[rightIndex];
    if (!leftMessage || !rightMessage) return leftMessage === rightMessage;
    if (leftMessage.id !== rightMessage.id || leftMessage.content !== rightMessage.content) return false;
    leftIndex += 1;
    rightIndex += 1;
  }
}

function sameMarks(
  left: ReadonlyMap<string, { y: number; current: boolean }>,
  right: ReadonlyMap<string, { y: number; current: boolean }>
): boolean {
  if (left.size !== right.size) return false;
  for (const [id, rightMark] of right) {
    const leftMark = left.get(id);
    if (!leftMark || leftMark.y !== rightMark.y || leftMark.current !== rightMark.current) return false;
  }
  return true;
}

function fallbackMarkY(index: number, count: number): number {
  return 10 + (index / Math.max(count - 1, 1)) * 280;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function jumpToMessage(messageId: string): void {
  const selector = `[data-message-id="${cssEscape(messageId)}"]`;
  const target = document.querySelector(selector);
  if (!(target instanceof HTMLElement)) return;
  const scroll = target.closest(".message-scroll");
  if (scroll instanceof HTMLElement) {
    const targetRect = target.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    const targetCenterInContent = targetRect.top - scrollRect.top + scroll.scrollTop + targetRect.height / 2;
    // Native smooth scrolling spans multiple tasks. During a live response, a
    // stream commit can restore the reader's locked coordinate in the middle of
    // that animation and leave the jump stranded between messages. Positioning
    // synchronously makes navigation + the following intent lock one atomic act.
    scroll.scrollTop = Math.round(targetCenterInContent - scroll.clientHeight / 2);
  } else {
    target.scrollIntoView({ behavior: "auto", block: "center" });
  }
  target.classList.add("message-jump-target");
  window.setTimeout(() => target.classList.remove("message-jump-target"), 900);
}

function messagePreview(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 34 ? `${normalized.slice(0, 33)}...` : normalized;
}

function cssEscape(value: string): string {
  if ("CSS" in window && typeof window.CSS.escape === "function") return window.CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}
