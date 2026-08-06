import type { RuntimeProviderConfig } from "../agent/runtime.js";

export type TitleGenerationResult = {
  title: string;
  rawTitle?: string;
  usedFallback: boolean;
  fallbackReason?: string;
  debugSummary?: string;
};

export function fallbackTitle(content: string): string {
  return content.trim() || "New chat";
}

export async function generateTitleWithProvider(
  provider: RuntimeProviderConfig,
  content: string,
  fallback: string
): Promise<string> {
  return (await generateTitleWithProviderResult(provider, content, fallback)).title;
}

export async function generateTitleWithProviderResult(
  provider: RuntimeProviderConfig,
  content: string,
  fallback: string
): Promise<TitleGenerationResult> {
  const first = await requestTitle(provider, content, "primary");
  const title = sanitizeTitle(first.text);
  if (title) {
    return {
      title,
      rawTitle: title,
      usedFallback: false,
      debugSummary: first.summary
    };
  }

  const retry = await requestTitle(provider, content, "retry");
  const retryTitle = sanitizeTitle(retry.text);
  if (retryTitle) {
    return {
      title: retryTitle,
      rawTitle: retryTitle,
      usedFallback: false,
      debugSummary: [first.summary, retry.summary].join("; ")
    };
  }

  return {
    title: fallback,
    usedFallback: true,
    fallbackReason: "empty title",
    debugSummary: [first.summary, retry.summary].join("; ")
  };
}

async function requestTitle(provider: RuntimeProviderConfig, content: string, variant: "primary" | "retry"): Promise<{ text: string; summary: string }> {
  const body: Record<string, unknown> = {
    model: provider.modelId,
    messages: titleMessages(content, variant),
    stream: false,
    temperature: titleTemperature(provider.providerOptionsJson),
    reasoning_effort: "low",
    max_tokens: 512
  };

  const response = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(12_000),
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Tool title request failed: ${response.status}${text ? ` ${text.slice(0, 180)}` : ""}`);
  }

  let parsed: {
    choices?: Array<{
      message?: {
        content?: unknown;
      };
      text?: unknown;
      finish_reason?: unknown;
    }>;
    usage?: unknown;
  };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new Error(`Tool title response was not JSON: ${text.slice(0, 180)}`);
  }

  const choice = parsed.choices?.[0];
  const output = contentToText(choice?.message?.content ?? choice?.text);
  return {
    text: output,
    summary: [
      `${variant}: status=${response.status}`,
      `finish=${typeof choice?.finish_reason === "string" ? choice.finish_reason : "unknown"}`,
      `chars=${output.trim().length}`,
      `body=${summarizeTitleResponse(text)}`
    ].join(" ")
  };
}

function titleMessages(content: string, variant: "primary" | "retry"): Array<{ role: "system" | "user"; content: string }> {
  if (variant === "retry") {
    return [
      { role: "system", content: "Name this chat for a sidebar. Write a short title phrase, not a reply. Do not copy the full user message; remove greeting and request wording. Do not answer, fulfill, solve, continue a game, or tell a joke. Output only the title. Use the user's language when possible." },
      { role: "user", content: content.trim() }
    ];
  }
  return [
    {
      role: "system",
      content: "Name this chat for a sidebar. Write a concise title phrase from the user's first message, not a reply. Do not copy the full user message; remove greeting and request wording. Do not answer, fulfill, solve, continue a game, or tell a joke. Output only the title. Use the user's language when possible."
    },
    { role: "user", content: content.trim() }
  ];
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return "";
    const value = item as Record<string, unknown>;
    return typeof value.text === "string" ? value.text : "";
  }).join("");
}

function titleTemperature(value?: string): number {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(value) as { temperature?: unknown };
    return typeof parsed.temperature === "number" ? Math.min(parsed.temperature, 0.2) : 0;
  } catch {
    return 0;
  }
}

function sanitizeTitle(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^["'`\u201c\u201d\u2018\u2019]+|["'`\u201c\u201d\u2018\u2019]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48) || "";
}

function summarizeTitleResponse(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
