import type { ChatMessage, ChatSendRequest, SkillReference } from "../../shared/ipc.js";
import type { JasmineDatabase } from "../db/database.js";
import { fallbackTitle } from "../services/threadTitles.js";
import { searchWeb } from "../services/webSearch.js";

export function buildRetryPlan(messages: ChatMessage[], messageId?: string) {
  if (messageId) {
    const targetIndex = messages.findIndex((message) => message.id === messageId);
    if (targetIndex < 0) throw new Error("Message to retry does not exist.");

    const target = messages[targetIndex];
    const searchStart = target.role === "user" ? targetIndex : targetIndex - 1;
    let lastUserIndex = -1;
    for (let index = searchStart; index >= 0; index -= 1) {
      if (messages[index].role === "user") {
        lastUserIndex = index;
        break;
      }
    }
    if (lastUserIndex < 0) throw new Error("No user message is available to retry.");

    const contextMessages = messages.slice(0, lastUserIndex + 1).map(toModelHistoryMessage);
    const deleteFromIndex = target.role === "user" ? targetIndex + 1 : targetIndex;
    return {
      lastUserMessage: messages[lastUserIndex],
      contextMessages,
      deleteMessageIds: messages.slice(deleteFromIndex).map((message) => message.id)
    };
  }

  const withoutTrailingAssistant = [...messages];
  while (withoutTrailingAssistant.at(-1)?.role === "assistant") {
    withoutTrailingAssistant.pop();
  }
  return {
    lastUserMessage: [...withoutTrailingAssistant].reverse().find((message) => message.role === "user"),
    contextMessages: withoutTrailingAssistant.map(toModelHistoryMessage),
    deleteMessageIds: messages.slice(withoutTrailingAssistant.length).map((message) => message.id)
  };
}

export function toModelHistoryMessage(message: ChatMessage): Pick<ChatMessage, "role" | "content" | "timeline" | "attachments"> {
  return {
    role: message.role,
    content: modelContentForMessage(message),
    timeline: message.timeline,
    attachments: message.attachments
  };
}

export function modelContentForMessage(message: Pick<ChatMessage, "role" | "content" | "skillsUsed">): string {
  if (message.role !== "user") return message.content;
  const explicitSkills = (message.skillsUsed ?? []).filter((skill) => skill.instructions?.trim());
  if (explicitSkills.length === 0) return message.content;
  return withExplicitSkillInstructions(message.content, explicitSkills);
}

function withExplicitSkillInstructions(content: string, skills: SkillReference[]): string {
  const blocks = skills.map((skill) => [
    `<skill name="${escapeAttribute(skill.name)}">`,
    `<description>${skill.description}</description>`,
    "<instructions>",
    skill.instructions?.trim() ?? "",
    "</instructions>",
    "</skill>"
  ].join("\n"));
  return [
    "<explicit_user_selected_skills>",
    "Explicit User Selected Skills",
    "These skills were explicitly selected with `$` for this user turn. Apply them to this user message only.",
    ...blocks,
    "</explicit_user_selected_skills>",
    "",
    "<user_message>",
    content,
    "</user_message>"
  ].join("\n");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function titleFromMessage(_content: string): string {
  return fallbackTitle(_content);
}

export function titleFromAttachments(attachments: ChatSendRequest["attachments"]): string {
  const first = attachments?.[0];
  if (!first) return "New chat";
  if (first.isImage) return first.name ? `Image: ${first.name}` : "Image chat";
  return first.name ? `Attachment: ${first.name}` : "Attachment chat";
}

export async function runWebSearchForChat(db: JasmineDatabase, threadId: string, content: string, enabled: boolean, signal?: AbortSignal) {
  if (!enabled || !content.trim()) return [];
  const startedAt = Date.now();
  const trace = db.createToolRun({
    threadId,
    title: "Web search",
    providerId: "web-search",
    inputSummary: summarizeOutput(content)
  });
  try {
    const results = await searchWeb(db, content, signal);
    db.finishToolRun({
      id: trace.id,
      status: "success",
      outputSummary: summarizeSearchResults(results),
      elapsedMs: Date.now() - startedAt
    });
    return results;
  } catch (error) {
    const message = nonSecretError(error);
    db.finishToolRun({
      id: trace.id,
      status: "error",
      error: message,
      elapsedMs: Date.now() - startedAt
    });
    return [];
  }
}

export function summarizeInput(messageCount: number, attachmentCount: number, memoryCount = 0, skillCount = 0, webSearchCount = 0): string {
  const parts = [`${messageCount} message${messageCount === 1 ? "" : "s"}`];
  if (attachmentCount > 0) parts.push(`${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`);
  if (memoryCount > 0) parts.push(`${memoryCount} memor${memoryCount === 1 ? "y" : "ies"}`);
  if (skillCount > 0) parts.push(`${skillCount} skill${skillCount === 1 ? "" : "s"}`);
  if (webSearchCount > 0) parts.push(`${webSearchCount} web result${webSearchCount === 1 ? "" : "s"}`);
  return parts.join(", ");
}

export function summarizeOutput(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

export function nonSecretError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/sk-[A-Za-z0-9_-]+/g, "sk-...");
}

function summarizeSearchResults(results: Array<{ title: string; url: string }>): string {
  if (results.length === 0) return "No web results";
  return results.map((result) => `${result.title} - ${result.url}`).join("; ").slice(0, 180);
}
