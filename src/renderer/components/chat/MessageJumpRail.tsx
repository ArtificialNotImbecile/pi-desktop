import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "../../../shared/ipc";
import { MenuSurface } from "../ui";

export function MessageJumpRail(props: { messages: ChatMessage[] }) {
  const railRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const userMessages = useMemo(
    () => props.messages.filter((message) => message.role === "user" && message.content.trim()),
    [props.messages]
  );
  const [marks, setMarks] = useState<Map<string, { y: number; current: boolean }>>(() => new Map());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (userMessages.length < 2) return;
    const scroll = document.querySelector(".message-scroll");
    if (!(scroll instanceof HTMLElement)) return;
    const scrollElement = scroll;
    let frame = 0;

    function updateMarks() {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const rail = railRef.current?.querySelector(".message-jump-marks");
        if (!(rail instanceof HTMLElement)) return;
        const railHeight = rail.getBoundingClientRect().height;
        const scrollRect = scrollElement.getBoundingClientRect();
        const center = scrollRect.top + scrollRect.height / 2;
        const entries = userMessages.flatMap((message) => {
          const target = document.querySelector(`[data-message-id="${cssEscape(message.id)}"]`);
          if (!(target instanceof HTMLElement)) return [];
          const rect = target.getBoundingClientRect();
          const topInContent = rect.top - scrollRect.top + scrollElement.scrollTop;
          return [{
            id: message.id,
            y: clamp((topInContent / Math.max(scrollElement.scrollHeight, 1)) * railHeight, 4, Math.max(4, railHeight - 4)),
            distance: Math.abs(rect.top + rect.height / 2 - center)
          }];
        });
        const activeId = entries.reduce<{ id: string; distance: number } | null>((best, entry) => {
          if (!best || entry.distance < best.distance) return { id: entry.id, distance: entry.distance };
          return best;
        }, null)?.id ?? userMessages.at(-1)?.id;
        const nextMarks = new Map<string, { y: number; current: boolean }>();
        for (const entry of entries) nextMarks.set(entry.id, { y: entry.y, current: entry.id === activeId });
        setMarks(nextMarks);
      });
    }

    updateMarks();
    scrollElement.addEventListener("scroll", updateMarks, { passive: true });
    window.addEventListener("resize", updateMarks);
    // Observe only the scroll container: its height changes when messages are added
    // or the streaming tail grows. Observing every user message node individually
    // scales poorly on long threads and adds no accuracy here.
    const observer = "ResizeObserver" in window ? new ResizeObserver(updateMarks) : null;
    observer?.observe(scrollElement);
    return () => {
      window.cancelAnimationFrame(frame);
      scrollElement.removeEventListener("scroll", updateMarks);
      window.removeEventListener("resize", updateMarks);
      observer?.disconnect();
    };
  }, [userMessages]);

  if (userMessages.length < 2) return null;

  return (
    <nav
      ref={railRef}
      className={`message-jump-rail ${open ? "open" : ""}`}
      aria-label="User message navigation"
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
        aria-label="Open user message navigation"
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
  target.scrollIntoView({ behavior: "smooth", block: "center" });
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
