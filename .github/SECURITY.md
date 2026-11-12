# Security policy

## Supported versions

Leadzy Studio is currently a pre-1.0 beta. Security fixes are made on the
latest release and the `main` branch; older beta builds may not receive a
backport.

| Version     | Supported               |
| ----------- | ----------------------- |
| Latest beta | Yes                     |
| Older betas | No guaranteed backports |

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
private vulnerability reporting for this repository:

<https://github.com/landimt/leadzy-studio/security/advisories/new>

Include the affected version or commit, impact, reproduction steps, and any
suggested mitigation. Avoid including real customer footage, API keys, or
other personal data; use a synthetic project whenever possible.

Leadzy will acknowledge a complete report as soon as practical, investigate
it privately, and coordinate disclosure after a fix or mitigation is ready.
Please allow a reasonable remediation window before publishing details.

## Scope notes

- The application server is intended to listen only on loopback.
- Existing source media must never be overwritten, moved, or deleted.
- Reports about unsafe path handling, local API access, Electron navigation or
  IPC, update integrity, media parsing, and dependency supply chain are in
  scope.
- General feature requests and support questions belong in the public issue
  templates instead.
