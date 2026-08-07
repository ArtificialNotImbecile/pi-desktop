# Conversation storage

Jasmine separates the model conversation record from application projections.

## Canonical record: Pi JSONL

Every generated conversation is assigned one persistent Pi `SessionManager` file below `<userData>/pi-agent/sessions/`. Pi owns message ordering, reasoning blocks and signatures, tool calls/results, compaction, metadata, and the append-only branch tree. Continuing a chat reopens that file directly; Jasmine no longer reconstructs routine model history from SQLite.

Retry and edit branch before the selected user entry and append a new path. Superseded turns remain in JSONL for Pi-compatible history and recovery, while the Jasmine UI displays only the selected projection. Queue and steer turns append to the same session. Stopped responses retain Pi's aborted assistant record. Rename appends `session_info`. Deleting a thread deletes its JSONL file only after verifying that the path is inside Jasmine-owned session storage.

## SQLite projection

SQLite remains appropriate for transactional application state: thread/project lists, active UI messages, pagination, search, drafts, settings, provider configuration, memories, traces, and usage metadata. A thread stores its Pi session ID/file/version; each projected chat message stores the corresponding Pi entry ID.

This boundary keeps the React UI unchanged and makes future Pi upgrades or external-session imports operate on Pi's native format. SQLite migrations can evolve UI indexes independently without rewriting the canonical conversation tree.

## Provider compatibility

Jasmine uses the model metadata bundled with `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` before external catalog fallback. DeepSeek and Kimi OpenAI-compatible streams retain `reasoning_content` in Pi thinking signatures and replay it with assistant tool calls. DeepSeek V4 uses its thinking toggle and high/max reasoning effort. Kimi K2.5/K2.6 use their thinking toggle, K2.7 Code emits no unsupported toggle, and Kimi K3 uses low/high/max reasoning effort. Sampling controls are omitted for these reasoning models.
