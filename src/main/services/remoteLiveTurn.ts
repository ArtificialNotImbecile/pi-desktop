import type { RemoteLiveEntry, RemoteLiveTurn } from "../../shared/ipc.js";

/** Bounds one live entry so a chatty tool cannot make every snapshot enormous. */
const LIVE_TEXT_LIMIT = 16_000;
const TOOL_ARGS_LIMIT = 200;

type Raw = Record<string, unknown>;

/**
 * Assembles what a running remote turn has produced so far from Pi's RPC
 * events. `message_update` carries deltas without a cumulative message, so text
 * is accumulated per content block and replaced by the authoritative
 * `message_end` when it arrives; tool calls are keyed by their call id so the
 * execution events land on the block that announced them.
 */
export class RemoteLiveTurnAggregator {
  private readonly turn: RemoteLiveTurn;
  /** Entries of the assistant message currently streaming, by content index. */
  private currentBlocks = new Map<number, RemoteLiveEntry>();
  private readonly toolEntriesByCallId = new Map<string, RemoteLiveEntry>();
  private messageCount = 0;
  private sequence = 0;

  constructor(seed: { profileId: string; sessionId: string | null; cwd: string; prompt: string; startedAt?: string }) {
    this.turn = {
      profileId: seed.profileId,
      sessionId: seed.sessionId,
      cwd: seed.cwd,
      prompt: seed.prompt,
      startedAt: seed.startedAt ?? new Date().toISOString(),
      state: "running",
      error: null,
      entries: [],
      version: 0
    };
  }

  setSessionId(sessionId: string): boolean {
    if (this.turn.sessionId === sessionId) return false;
    this.turn.sessionId = sessionId;
    return this.bump();
  }

  /** Applies one `rpc.message` payload; returns whether the snapshot changed. */
  handle(raw: unknown): boolean {
    if (!raw || typeof raw !== "object") return false;
    const message = raw as Raw;
    switch (message.type) {
      case "message_start":
        return this.startMessage(message);
      case "message_update":
        return this.applyDelta(message);
      case "message_end":
        return this.endMessage(message);
      case "tool_execution_start":
        return this.toolStarted(message);
      case "tool_execution_update":
        return this.toolUpdated(message);
      case "tool_execution_end":
        return this.toolEnded(message);
      case "agent_settled":
        return this.settle();
      default:
        return false;
    }
  }

  settle(): boolean {
    if (this.turn.state !== "running") return false;
    this.turn.state = "settled";
    for (const entry of this.turn.entries) {
      if (entry.toolState === "running") entry.toolState = "done";
    }
    return this.bump();
  }

  fail(message: string): boolean {
    this.turn.state = "failed";
    this.turn.error = message;
    return this.bump();
  }

  snapshot(): RemoteLiveTurn {
    return { ...this.turn, entries: this.turn.entries.map((entry) => ({ ...entry })) };
  }

  private startMessage(message: Raw): boolean {
    const body = record(message.message);
    if (body?.role !== "assistant") return false;
    this.messageCount += 1;
    this.currentBlocks = new Map();
    return false;
  }

  private applyDelta(message: Raw): boolean {
    const event = record(message.assistantMessageEvent);
    if (!event) return false;
    const index = typeof event.contentIndex === "number" ? event.contentIndex : 0;
    switch (event.type) {
      case "text_start":
        this.block(index, "assistant");
        return this.bump();
      case "thinking_start":
        this.block(index, "thinking");
        return this.bump();
      case "text_delta":
      case "thinking_delta": {
        const entry = this.block(index, event.type === "text_delta" ? "assistant" : "thinking");
        entry.text = clip(entry.text + String(event.delta ?? ""));
        return this.bump();
      }
      case "text_end":
      case "thinking_end": {
        const entry = this.block(index, event.type === "text_end" ? "assistant" : "thinking");
        if (typeof event.content === "string") entry.text = clip(event.content);
        return this.bump();
      }
      case "toolcall_start": {
        this.block(index, "tool");
        return this.bump();
      }
      case "toolcall_end": {
        const call = record(event.toolCall);
        const entry = this.block(index, "tool");
        if (call) this.describeCall(entry, call);
        return this.bump();
      }
      default:
        return false;
    }
  }

  private endMessage(message: Raw): boolean {
    const body = record(message.message);
    if (!body) return false;
    if (body.role !== "assistant") return false;
    // The completed message is authoritative: rebuild this message's blocks
    // from it so a dropped delta cannot leave a truncated answer on screen.
    const content = Array.isArray(body.content) ? body.content : [];
    const rebuilt: RemoteLiveEntry[] = [];
    content.forEach((part, index) => {
      const block = record(part);
      if (!block) return;
      if (block.type === "text" && typeof block.text === "string") {
        rebuilt.push(this.reuse(index, "assistant", clip(block.text)));
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        rebuilt.push(this.reuse(index, "thinking", clip(block.thinking)));
      } else if (block.type === "toolCall") {
        const entry = this.reuse(index, "tool", null);
        this.describeCall(entry, block);
        rebuilt.push(entry);
      }
    });
    const previous = new Set(this.currentBlocks.values());
    this.turn.entries = [
      ...this.turn.entries.filter((entry) => !previous.has(entry)),
      ...rebuilt.filter((entry) => entry.kind === "tool" || entry.text.length > 0)
    ];
    this.currentBlocks = new Map();
    if (body.stopReason === "error") {
      this.turn.error = typeof body.errorMessage === "string" && body.errorMessage.trim()
        ? body.errorMessage.trim()
        : "The model returned an error.";
    }
    return this.bump();
  }

  private toolStarted(message: Raw): boolean {
    const entry = this.toolEntry(message);
    if (!entry) return false;
    entry.toolState = "running";
    if (typeof message.toolName === "string") entry.toolName = message.toolName;
    if (!entry.toolArgs) entry.toolArgs = summarizeToolArgs(entry.toolName, message.args);
    return this.bump();
  }

  private toolUpdated(message: Raw): boolean {
    const entry = this.toolEntry(message);
    if (!entry) return false;
    const partial = record(message.partialResult);
    const text = partial ? contentText(partial.content) : "";
    if (text) entry.text = clip(text);
    return this.bump();
  }

  private toolEnded(message: Raw): boolean {
    const entry = this.toolEntry(message);
    if (!entry) return false;
    const result = record(message.result);
    entry.text = clip(result ? contentText(result.content) : "");
    entry.toolState = message.isError === true ? "error" : "done";
    return this.bump();
  }

  /**
   * Execution events refer to a call the streamed message announced. When the
   * announcement was not seen -- a replayed buffer, a call made before this
   * client subscribed -- the execution still gets a row of its own.
   */
  private toolEntry(message: Raw): RemoteLiveEntry | null {
    const callId = typeof message.toolCallId === "string" ? message.toolCallId : null;
    if (!callId) return null;
    const existing = this.toolEntriesByCallId.get(callId);
    if (existing) return existing;
    const entry: RemoteLiveEntry = {
      id: `tool:${callId}`,
      kind: "tool",
      text: "",
      toolName: typeof message.toolName === "string" ? message.toolName : null,
      toolArgs: summarizeToolArgs(typeof message.toolName === "string" ? message.toolName : null, message.args),
      toolState: "running"
    };
    this.toolEntriesByCallId.set(callId, entry);
    this.turn.entries.push(entry);
    return entry;
  }

  private describeCall(entry: RemoteLiveEntry, call: Raw): void {
    if (typeof call.name === "string") entry.toolName = call.name;
    entry.toolArgs = summarizeToolArgs(entry.toolName, call.arguments) ?? entry.toolArgs;
    if (typeof call.id === "string") {
      const known = this.toolEntriesByCallId.get(call.id);
      if (known && known !== entry) {
        // The execution started before the streamed call finished describing
        // itself; fold the two rows into the one the execution events target.
        known.toolName = entry.toolName;
        known.toolArgs = entry.toolArgs ?? known.toolArgs;
        this.turn.entries = this.turn.entries.filter((candidate) => candidate !== entry);
        for (const [index, block] of this.currentBlocks) {
          if (block === entry) this.currentBlocks.set(index, known);
        }
        return;
      }
      this.toolEntriesByCallId.set(call.id, entry);
      entry.id = `tool:${call.id}`;
    }
  }

  private block(index: number, kind: RemoteLiveEntry["kind"]): RemoteLiveEntry {
    const existing = this.currentBlocks.get(index);
    if (existing && existing.kind === kind) return existing;
    const entry: RemoteLiveEntry = {
      id: `m${this.messageCount}:${index}:${++this.sequence}`,
      kind,
      text: "",
      toolName: null,
      toolArgs: null,
      toolState: kind === "tool" ? "running" : null
    };
    this.currentBlocks.set(index, entry);
    this.turn.entries.push(entry);
    return entry;
  }

  private reuse(index: number, kind: RemoteLiveEntry["kind"], text: string | null): RemoteLiveEntry {
    const existing = this.currentBlocks.get(index);
    if (existing && existing.kind === kind) {
      if (text !== null) existing.text = text;
      return existing;
    }
    return {
      id: `m${this.messageCount}:${index}:${++this.sequence}`,
      kind,
      text: text ?? "",
      toolName: null,
      toolArgs: null,
      toolState: kind === "tool" ? "running" : null
    };
  }

  private bump(): boolean {
    this.turn.version += 1;
    return true;
  }
}

/**
 * The one line that says what a tool call did, in the terms the tool itself
 * uses: a command for the shell, a path for file tools, a pattern for search.
 * Anything else is compacted JSON, so an unknown tool still reads as something.
 */
export function summarizeToolArgs(toolName: string | null, args: unknown): string | null {
  const record_ = record(args);
  if (!record_) return null;
  const name = (toolName ?? "").toLowerCase();
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = record_[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  };
  let summary: string | null = null;
  if (name === "bash" || name === "shell") summary = pick("command", "cmd");
  else if (name === "read" || name === "write" || name === "edit" || name === "ls" || name === "list") summary = pick("path", "file_path", "filePath");
  else if (name === "grep" || name === "find" || name === "glob" || name === "search") {
    const pattern = pick("pattern", "query");
    const where = pick("path");
    summary = pattern ? where ? `${pattern} · ${where}` : pattern : where;
  }
  if (!summary) {
    try {
      summary = JSON.stringify(record_);
    } catch {
      summary = null;
    }
  }
  if (!summary) return null;
  const oneLine = summary.replace(/\s+/gu, " ").trim();
  return oneLine.length > TOOL_ARGS_LIMIT ? `${oneLine.slice(0, TOOL_ARGS_LIMIT - 1)}…` : oneLine;
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const block = record(part);
      return block && block.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function clip(text: string): string {
  if (text.length <= LIVE_TEXT_LIMIT) return text;
  return `${text.slice(0, LIVE_TEXT_LIMIT)}\n…`;
}

function record(value: unknown): Raw | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Raw : null;
}
