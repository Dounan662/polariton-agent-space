# Security policy

Polariton is a preview application for a single owner on a trusted local machine.
Security maintenance focuses on the current preview source. There is no guaranteed response
time or long-term support promise during preview.

## Report privately

On the GitHub repository, open **Security → Advisories → Report a vulnerability**.
Include the affected version, platform, reproduction steps, and likely impact.
Use synthetic data and redact credentials and research contents.

If private reporting is not available, open an issue asking the maintainer to
enable a private reporting channel, without disclosing the vulnerability itself.
Do not publish exploit details, tokens, or user data in a public issue.

## Operating boundary

- The browser/API is intended for local loopback access on the same computer.
  Public internet exposure and multi-user hosting are outside this preview.
- Agent tools can act with the user's granted access. Trusted host programs and
  same-user processes are not isolated from that user's files or credentials.
- Provider keys are stored locally as plaintext with owner-only POSIX permissions.
  These permissions do not protect keys from processes running as that owner.
- Managed containers and external MCP servers have distinct trust boundaries.
  Review [capability operations](docs/ENVIRONMENT.md) before granting access.
- Backups can contain keys, histories, attachments, and research data. Keep them
  private. A public issue attachment must never be a complete state backup.

See [storage and backups](docs/STORAGE.md) and
[known limitations](docs/LIMITATIONS.md). Multi-user hosting, untrusted
public exposure, and automatic upgrade safety are not supported claims.
