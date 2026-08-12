# Security Policy

## Reporting a vulnerability

Use GitHub private vulnerability reporting for sensitive reports. Do not include exploitable details, credentials, private data, or access tokens in a public issue.

Include affected versions, reproduction steps, impact, and any suggested mitigation. Maintainers will acknowledge the report and coordinate disclosure through the private advisory.

## Credential storage

Environment-variable references such as `env:DEEPSEEK_API_KEY` are recommended. Provider keys entered directly in Settings are stored as plain text in Jasmine's local SQLite database. Renderer UI masks them, but the database is not an operating-system credential vault.

## Privileged integrations

Pi packages, local tools, provider calls, and web access may read files or transmit data according to their own configuration. Review a package before enabling it and grant only the access it needs.

Turning on Web Search enables the `pi-web-access` package, which lets the agent fetch arbitrary URLs. Page content is untrusted input: treat anything it returns as data, never as instructions.
