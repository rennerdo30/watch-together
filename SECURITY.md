# Security Policy

## Supported Versions

This project is actively maintained on the `main` branch. Security fixes are
applied there first.

## Reporting a Vulnerability

Please do not open public issues for security vulnerabilities.

Use GitHub's private vulnerability reporting:
[report a vulnerability](https://github.com/rennerdo30/watch-together/security/advisories/new).
It opens a private advisory visible only to the maintainer, and it needs no
separate mailbox to be monitored.

Include the following details when possible:

- Affected component(s) and version/commit
- Reproduction steps or proof of concept
- Impact and potential abuse scenario
- Suggested mitigation (if known)

## Response Targets

This is a personal project maintained by one person in their spare time, so no
response time is promised. Reports are read and triaged as time allows, most
severe first.

If a report is accepted, disclosure is coordinated through the same advisory,
with credit where appropriate.

## Scope

Security reports are especially helpful for:

- Authentication and authorization bypasses
- WebSocket room isolation issues
- SSRF/proxy abuse in `/api/proxy`
- Sensitive data exposure (cookies, tokens, identities)
- Dependency vulnerabilities with practical exploit paths
