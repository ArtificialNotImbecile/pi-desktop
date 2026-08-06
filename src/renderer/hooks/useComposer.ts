import { type FormEvent, useState } from "react";
import type { ChatMessage, ChatQueueMode, ClipboardImagePasteRequest, PickedPath } from "../../shared/ipc";
import type { RunState } from "../types";
import { dedupeAttachments } from "../utils/attachments";

export function useComposer(options: {
  runState: RunState;
  canSendImages: boolean;
  onErrorReset(): void;
  onSubmit(content: string, attachments: PickedPath[]): Promise<boolean | void>;
  onQueueSubmit(content: string, attachments: PickedPath[], mode: ChatQueueMode): Promise<boolean | void>;
  onEditSubmit(messageId: string, content: string, attachments: PickedPath[]): Promise<boolean | void>;
  onToast(message: string): void;
}) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<PickedPath[]>([]);
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);

  function resetComposer() {
    setDraft("");
    setAttachments([]);
    setEditingMessage(null);
  }

  function focusComposer() {
    const focus = () => {
      document.querySelector<HTMLElement>(".composer [contenteditable='true']")?.focus();
    };
    window.setTimeout(focus, 0);
    window.setTimeout(focus, 80);
  }

  async function submit(event?: FormEvent, queueMode: ChatQueueMode = "followUp") {
    event?.preventDefault();
    const content = draft.trim();
    const isRunning = options.runState === "running";
    if ((!content && attachments.length === 0) || options.runState === "stopping") return;
    if (isRunning && editingMessage) return;

    if (attachments.some((item) => item.isImage) && !options.canSendImages) {
      options.onToast("Select a vision-capable model before sending images");
      return;
    }

    const editingId = editingMessage?.id;
    const submittedAttachments = attachments;
    setDraft("");
    setAttachments([]);
    setEditingMessage(null);
    const accepted = isRunning
      ? await options.onQueueSubmit(content, submittedAttachments, queueMode)
      : editingId
        ? await options.onEditSubmit(editingId, content, submittedAttachments)
        : await options.onSubmit(content, submittedAttachments);
    if (accepted === false) {
      setDraft(content);
      setAttachments(submittedAttachments);
      if (editingId) setEditingMessage(editingMessage);
    }
  }

  async function attachFile() {
    const picked = await window.jasmine?.pickFile();
    if (picked) setAttachments((current) => dedupeAttachments([...current, picked]));
  }

  async function attachClipboardImage(request?: ClipboardImagePasteRequest) {
    const picked = request
      ? await window.jasmine?.savePastedImage(request)
      : await window.jasmine?.pickClipboardImage();
    if (picked) setAttachments((current) => dedupeAttachments([...current, picked]));
  }

  async function attachFolder() {
    const picked = await window.jasmine?.pickFolder();
    if (picked) setAttachments((current) => dedupeAttachments([...current, picked]));
  }

  async function attachFileFromPath(filePath: string) {
    const picked = await window.jasmine?.pickFileFromPath(filePath);
    if (picked) setAttachments((current) => dedupeAttachments([...current, picked]));
  }

  function restoreDraft(content: string) {
    setDraft(content);
    options.onToast("Restored last prompt");
  }

  function startEdit(message: ChatMessage) {
    setEditingMessage(message);
    setDraft(message.content);
    setAttachments(message.attachments ?? []);
    options.onErrorReset();
    focusComposer();
  }

  return {
    draft,
    setDraft,
    attachments,
    setAttachments,
    editingMessage,
    resetComposer,
    submit,
    attachFile,
    attachClipboardImage,
    attachFileFromPath,
    attachFolder,
    restoreDraft,
    focusComposer,
    startEdit,
    cancelEdit: resetComposer
  };
}
