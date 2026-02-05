# Security Policy

## Supported Versions

This project is actively maintained on the `main` branch. Security fixes are
applied there first.

## Reporting a Vulnerability

Please do not open public issues for security vulnerabilities.

Report vulnerabilities by email: security+watch-together@proton.me

Include the following details when possible:

- Affected component(s) and version/commit
- Reproduction steps or proof of concept
- Impact and potential abuse scenario
- Suggested mitigation (if known)

## Response Targets

- Initial acknowledgment: within 72 hours
- Triage decision: within 7 days
- Fix timeline: based on severity and complexity

If the report is accepted, we will coordinate disclosure and credit where
appropriate.

## Scope

Security reports are especially helpful for:

- Authentication and authorization bypasses
- WebSocket room isolation issues
- SSRF/proxy abuse in `/api/proxy`
- Sensitive data exposure (cookies, tokens, identities)
- Dependency vulnerabilities with practical exploit paths
