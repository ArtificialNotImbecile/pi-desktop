---
name: chrome
description: Use the Chrome package tools to inspect and operate Chrome tabs through Chrome DevTools Protocol with real input events and stable element refs.
---

# Chrome

Use the Chrome tools only when the user explicitly asks to inspect or operate Chrome, a browser tab, a webpage, or a local web app in Chrome.

This package connects through Chrome DevTools Protocol. If `CHROME_CDP_URL` is set, it uses that endpoint. Otherwise it auto-launches Chrome, Chromium, or Edge with remote debugging enabled and an isolated profile. It does not install or require a Chrome extension for this managed-profile mode.

If `chrome_status` reports that Chrome is unavailable, explain that Chrome could not be found or launched.

## Core loop: snapshot, act, wait

Do not guess CSS selectors. Prefer this loop:

1. `chrome_snapshot` returns an indexed list of interactive and notable elements, each with a stable ref such as `e12`. The ref stays valid until the page reloads.
2. Act with the ref: `chrome_click`, `chrome_type`, `chrome_hover`, `chrome_scroll`, `chrome_select_option`, `chrome_screenshot`. `chrome_click` and `chrome_type` dispatch real mouse and keyboard events, so they work on sites that ignore synthetic clicks.
3. After actions that change the page, use `chrome_wait_for` (selector appears/disappears, text present, or `state: load`) before the next snapshot, then re-snapshot to get fresh refs.

Other tools: `chrome_open_url` / `chrome_open_path` / `chrome_new_tab` open tabs; `chrome_navigate` goes to a URL or back/forward/reload and waits for load; `chrome_list_tabs` / `chrome_activate_tab` / `chrome_close_tab` manage tabs; `chrome_press_key` sends keys (Enter, Tab, Escape, Arrow keys, shortcuts); `chrome_read_page` reads visible text; `chrome_evaluate` reads page state that no other tool exposes.

Use `chrome_open_path` for static local HTML files created during the current task. Do not start an ad hoc `npx serve` server just to preview a plain local HTML file. Use `chrome_open_url` for HTTP/HTTPS pages, including local dev servers that are already running. For visual preview tasks, open the page and take a screenshot instead of relying on `curl`.

## Safety

Do not type secrets or submit forms unless the user's request clearly authorizes that exact action on that exact site. Set `submit` on `chrome_type` and click submit-like buttons only when the user wants to submit. Ask before purchases, account changes, permission changes, uploads, destructive actions, or final form submissions that affect external systems.

## Controlling your real Chrome

The managed CDP mode uses an isolated profile that does not share your normal login state. To operate your already-running normal Chrome with its real session (Chrome 136+ blocks remote debugging on the default profile), enable the Jasmine Chrome takeover in Settings, which registers a native messaging host and links a browser extension that bridges commands to your real tabs. That takeover route is separate from this managed CDP package.
