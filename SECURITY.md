# Security Policy

## Reporting a vulnerability

Use GitHub private vulnerability reporting for sensitive reports. Do not include exploitable details, credentials, private data, or access tokens in a public issue.

Include affected versions, reproduction steps, impact, and any suggested mitigation. Maintainers will acknowledge the report and coordinate disclosure through the private advisory.

## Credential storage

Environment-variable references such as `env:DEEPSEEK_API_KEY` are recommended. Provider keys entered directly in Settings are stored as plain text in Jasmine's local SQLite database. Renderer UI masks them, but the database is not an operating-system credential vault.

## Privileged integrations

Chrome automation is optional and uses broad browser permissions including `debugger`, `tabs`, `nativeMessaging`, `scripting`, and `<all_urls>`. Enable it only for a trusted local Jasmine installation. Disable the Chrome package and remove the extension/native host when it is not needed.

MCP servers, remote shells, local tools, provider calls, and web search may access files or transmit data according to their own configuration. Review an integration before enabling it and grant only the access it needs.
