# @jasmine-ai/pi-context-capture

A standalone Pi coding-agent extension that captures the exact provider request payload at Pi's `before_provider_request` boundary, stores a sanitized raw payload plus hash, derives an ordered taxonomy for UI or audit tools, and enriches the capture with provider cache metrics after the assistant response ends.

The captured raw provider payload is the source of truth. `items`, `segments`, and `payloadShape` are derived for visualization and audit workflows. Item `order` is presentation order, not a cross-field wire order; message/tool sections follow the captured top-level payload order when both are present.

## Package Contract

- ESM only.
- Node.js `>=22.19.0`.
- Peer dependency: `@earendil-works/pi-coding-agent >=0.79.0 <1`.
- Stable schema version is exported as `CONTEXT_TAXONOMY_SCHEMA_VERSION` (currently v5).
- Assistant `text`, `reasoning_content`, `tool_calls`, tool results, and attachments are preserved as ordered parts instead of being collapsed through a single content fallback.
- Optional canonical-session input validates DeepSeek/Kimi reasoning retention without mutating `before_provider_request` payloads.
- Public exports: default Pi extension, `createContextCaptureExtension`, `writeContextCaptureFile`, schema types, classifier helpers, and reusable segment helpers.
- Secrets are redacted by key name and common bearer/API-key patterns before hashing or persistence.

## SDK Usage

```ts
import { createContextCaptureExtension } from "@jasmine-ai/pi-context-capture";

const extensionFactories = [
  createContextCaptureExtension({
    provider: "openai-compatible",
    model: "model-id",
    onCapture: (taxonomy) => persist(taxonomy)
  })
];
```

`provider` and `model` are optional. The extension infers `model` from the provider payload when possible and falls back to `unknown-model`.

## Pi Extension Usage

The default export can be loaded as a normal Pi extension. It writes taxonomy JSON files to `.pi/context-captures/` by default. File writes are atomic: the extension writes a temporary file and renames it into place.

```bash
PI_CONTEXT_CAPTURE_PROVIDER=deepseek PI_CONTEXT_CAPTURE_MODEL=deepseek-v4-flash pi -e @jasmine-ai/pi-context-capture
```

Environment variables:

- `PI_CONTEXT_CAPTURE_DIR`: output directory. Defaults to `.pi/context-captures/` under the current working directory.
- `PI_CONTEXT_CAPTURE_PROVIDER`: fallback provider label.
- `PI_CONTEXT_CAPTURE_MODEL`: fallback model label.

## Cache Evidence

Cache metrics come from Pi assistant usage parsing, not from raw JSON key order. For DeepSeek, Pi maps `prompt_cache_hit_tokens` to `cacheRead`; the extension maps `cacheRead` to `cacheHitTokens` and `input` to `cacheMissTokens`.

This means `payloadShape.topLevelOrder` can explain what was sent over the wire, while `cacheMetrics` is the evidence for provider-side prompt cache behavior.

## Build And Smoke Test

```bash
# From this package directory:
npm run build

# From the Jasmine repo root:
npm run test:context-capture
```
