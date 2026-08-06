import type { ReactNode } from "react";

function Svg(props: { children: ReactNode }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      {props.children}
    </svg>
  );
}

export function PanelIcon() {
  return <Svg><path d="M4 5h16M9 5v14M4 19h16" /></Svg>;
}

export function MinimizeIcon() {
  return <Svg><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M15 5v14" /></Svg>;
}

export function SidebarIcon() {
  return <Svg><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M9 5v14M15 9l-3 3 3 3" /></Svg>;
}

export function SearchIcon() {
  return <Svg><circle cx="11" cy="11" r="7" /><path d="m16 16 4 4" /></Svg>;
}

export function KeyboardIcon() {
  return <Svg><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01M11 10h.01M15 10h.01M17 14h.01M7 14h6" /></Svg>;
}

export function EditIcon() {
  return <Svg><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></Svg>;
}

export function TrashIcon() {
  return <Svg><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M6 6l1 15h10l1-15" /><path d="M10 11v6M14 11v6" /></Svg>;
}

export function PlusIcon() {
  return <Svg><path d="M12 5v14M5 12h14" /></Svg>;
}

export function MoreIcon() {
  return <Svg><path d="M5 12h.01M12 12h.01M19 12h.01" /></Svg>;
}

export function PinIcon() {
  return <Svg><path d="M14 3l7 7-4 1-4 7-2-2-5 5-3-3 5-5-2-2 7-4Z" /></Svg>;
}

export function ExternalLinkIcon() {
  return <Svg><path d="M14 4h6v6" /><path d="m10 14 10-10" /><path d="M20 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4" /></Svg>;
}

export function FolderTinyIcon() {
  return <svg className="tiny-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 2h9v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>;
}

export function FolderIcon() {
  return <Svg><path d="M3 7h7l2 2h9v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></Svg>;
}

export function ImageIcon() {
  return <Svg><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="8.5" cy="10" r="1.5" /><path d="m21 15-4.5-4.5L9 18" /></Svg>;
}

export function PaperclipIcon() {
  return <Svg><path d="m21.4 11.6-8.5 8.5a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9.1 9.1a2 2 0 1 1-2.8-2.8l8.5-8.5" /></Svg>;
}

export function BrainIcon() {
  return <Svg><path d="M9 3a3 3 0 0 0-3 3v3a3 3 0 0 0 0 6v3a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM15 3a3 3 0 0 1 3 3v3a3 3 0 0 1 0 6v3a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z" /></Svg>;
}

export function SlidersIcon() {
  return <Svg><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4" /></Svg>;
}

export function WrenchIcon() {
  return <Svg><path d="M14.7 6.3a4 4 0 0 0-5 5l-5.9 5.9a2 2 0 0 0 2.8 2.8l5.9-5.9a4 4 0 0 0 5-5l-2.6 2.6-2.1-2.1Z" /></Svg>;
}

export function SkillIcon() {
  return <Svg><path d="M12 3l1.7 5.1L19 10l-5.3 1.9L12 17l-1.7-5.1L5 10l5.3-1.9Z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z" /></Svg>;
}

export function ChevronDownIcon() {
  return <Svg><path d="m6 9 6 6 6-6" /></Svg>;
}

export function ChevronRightIcon() {
  return <Svg><path d="m9 6 6 6-6 6" /></Svg>;
}

export function CheckIcon() {
  return <Svg><path d="m5 12 4 4L19 6" /></Svg>;
}

export function TodoIcon() {
  return <Svg><rect x="4" y="4" width="16" height="16" rx="2" /><path d="m8 9 2 2 4-4" /><path d="M8 15h8" /></Svg>;
}

export function EyeIcon() {
  return <Svg><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" /><circle cx="12" cy="12" r="3" /></Svg>;
}

export function EyeOffIcon() {
  return <Svg><path d="M3 3l18 18" /><path d="M10.6 10.6A2 2 0 0 0 13.4 13.4" /><path d="M9.9 5.3A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a18.4 18.4 0 0 1-3.4 4.4" /><path d="M6.4 6.8A18.6 18.6 0 0 0 2 12s3.5 7 10 7c1.5 0 2.9-.4 4.1-1" /></Svg>;
}

export function SendIcon() {
  return <Svg><path d="M22 2 11 13" /><path d="m22 2-7 20-4-9-9-4Z" /></Svg>;
}

export function StopIcon() {
  return <Svg><rect x="7" y="7" width="10" height="10" rx="2" /></Svg>;
}

export function TerminalIcon() {
  return <Svg><path d="m8 9 3 3-3 3M13 15h3" /><rect x="3" y="4" width="18" height="16" rx="2" /></Svg>;
}

export function PlugIcon() {
  return <Svg><path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V2" /><path d="M7 8h10v4a5 5 0 0 1-10 0Z" /></Svg>;
}

export function ActivityIcon() {
  return <Svg><path d="M3 12h4l2-6 4 12 2-6h6" /></Svg>;
}

export function InfoIcon() {
  return <Svg><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></Svg>;
}

export function CopyIcon() {
  return <Svg><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></Svg>;
}

export function CutIcon() {
  return <Svg><circle cx="6" cy="7" r="3" /><circle cx="6" cy="17" r="3" /><path d="M8.5 8.5 20 20M8.5 15.5 20 4" /></Svg>;
}

export function ClipboardIcon() {
  return <Svg><rect x="6" y="5" width="12" height="16" rx="2" /><path d="M9 5a3 3 0 0 1 6 0M9 5h6M9 11h6M9 15h4" /></Svg>;
}

export function SelectAllIcon() {
  return <Svg><rect x="5" y="5" width="14" height="14" rx="2" /><path d="M8 9h8M8 12h8M8 15h5" /></Svg>;
}

export function RefreshIcon() {
  return <Svg><path d="M21 12a9 9 0 0 1-15.4 6.4L3 16" /><path d="M3 21v-5h5" /><path d="M3 12A9 9 0 0 1 18.4 5.6L21 8" /><path d="M21 3v5h-5" /></Svg>;
}

export function SettingsIcon() {
  return <Svg><path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" /><path d="M19.4 15a1.8 1.8 0 0 0 .4 2l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.8 1.8 0 0 0-2-.4 1.8 1.8 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.8 1.8 0 0 0-1-1.6 1.8 1.8 0 0 0-2 .4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.8 1.8 0 0 0 .4-2 1.8 1.8 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.8 1.8 0 0 0 1.6-1 1.8 1.8 0 0 0-.4-2l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.8 1.8 0 0 0 2 .4 1.8 1.8 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.8 1.8 0 0 0 1 1.6 1.8 1.8 0 0 0 2-.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.8 1.8 0 0 0-.4 2 1.8 1.8 0 0 0 1.6 1h.1a2 2 0 1 1 0 4h-.1a1.8 1.8 0 0 0-1.6 1Z" /></Svg>;
}
