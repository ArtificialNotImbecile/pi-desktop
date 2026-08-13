import type { ChatMessage, ChatStreamSettlement } from "./ipc.js";

export function chatStreamRenderId(requestId: string, index: number): string {
  return `stream-${requestId}-${index}`;
}

// Runtime-generated messages are streamed in the same order in which they are
// persisted. Carry their live render identities into the settlement snapshot so
// React can patch the final database-backed objects without remounting the rows.
export function createChatStreamSettlement(
  requestId: string,
  replaceAfterMessageId: string | undefined,
  persistedPrefix: ChatMessage[],
  runtimeMessages: ChatMessage[],
  preserveOptimisticPrefix = false,
  replaceFromMessageId?: string
): ChatStreamSettlement {
  return {
    ...(replaceAfterMessageId ? { replaceAfterMessageId } : {}),
    ...(replaceFromMessageId ? { replaceFromMessageId } : {}),
    messages: [
      ...persistedPrefix.map((message, index) => preserveOptimisticPrefix ? ({
          ...message,
          renderId: chatStreamPrefixRenderId(requestId, index)
        }) : message),
      ...runtimeMessages.map((message, index) => ({
        ...message,
        renderId: chatStreamRenderId(requestId, index)
      }))
    ]
  };
}

export function chatStreamPrefixRenderId(requestId: string, index: number): string {
  return `pending-${requestId}-${index}`;
}

export function applyChatStreamSettlement(
  current: ChatMessage[],
  settlement: ChatStreamSettlement
): ChatMessage[] {
  // A later operation can settle a row that already inherited a render identity
  // from an earlier send. Preserve that identity whenever the persisted id is
  // unchanged so edit/abort snapshots patch the existing DOM node in place.
  const currentById = new Map(current.map((message) => [message.id, message] as const));
  const settledMessages = settlement.messages.map((message) => {
    const existing = currentById.get(message.id);
    return existing?.renderId && !message.renderId
      ? { ...message, renderId: existing.renderId }
      : message;
  });
  if (!settlement.replaceAfterMessageId) return settledMessages;
  const anchorIndex = current.findIndex((message) => message.id === settlement.replaceAfterMessageId);
  // The anchor normally remains in the latest-message page. If it is absent,
  // retain older authoritative rows and replace only the optimistic/live tail;
  // settlement.messages is a run tail, not a complete conversation snapshot.
  if (anchorIndex < 0) {
    const settlementIds = new Set(settledMessages.map((message) => message.id));
    const explicitTailStartIndex = settlement.replaceFromMessageId
      ? current.findIndex((message) => message.id === settlement.replaceFromMessageId)
      : -1;
    const firstSettlement = settledMessages[0];
    const identityTailStartIndex = firstSettlement
      ? current.findIndex((message) => (
          message.id === firstSettlement.id
          || Boolean(firstSettlement.renderId && message.renderId === firstSettlement.renderId)
          || message.id === firstSettlement.renderId
        ))
      : -1;
    const tailStartIndex = explicitTailStartIndex >= 0 ? explicitTailStartIndex : identityTailStartIndex;
    const candidates = tailStartIndex >= 0 ? current.slice(0, tailStartIndex) : current;
    const prefix = candidates.filter((message) => (
      !settlementIds.has(message.id)
      && !message.id.startsWith("pending-")
      && !message.id.startsWith("stream-")
    ));
    return [...prefix, ...settledMessages];
  }
  return [...current.slice(0, anchorIndex + 1), ...settledMessages];
}
