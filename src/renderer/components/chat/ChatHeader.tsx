import { memo } from "react";
import type { ChatThread } from "../../../shared/ipc";
import { FolderTinyIcon } from "../icons/Icons";

// Memoized so stream ticks only reach this header when the count label or the
// thread object actually changes (thread refs are stable between list updates).
export const ChatHeader = memo(function ChatHeader(props: { activeThread: ChatThread | null; messageCountLabel: string }) {
  return (
    <header className="chat-header">
      <span>{props.messageCountLabel}</span>
      <span className="dot-separator">-</span>
      <FolderTinyIcon />
      <span>{props.activeThread?.title ?? "Temp Works..."}</span>
    </header>
  );
});
