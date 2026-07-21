# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email: **security@sepia** (replace with maintainer contact before first public release)

Please include:

- Description of the vulnerability
- Steps to reproduce
- Impact assessment
- Any suggested fix

You will receive an acknowledgement within 48 hours and a resolution timeline within 7 days.

## Threat model summary

See the full threat model in [`docs/phase1-spec.md §4`](docs/phase1-spec.md).

**Assets:** User credentials and session tokens, page content (may contain PII), model API keys, host filesystem.

**Adversaries:**

- Malicious page content attempting prompt injection
- Malicious page content using `file://` / `data://` URLs to reach the host filesystem
- Anti-bot detection systems fingerprinting the automation layer
- Supply-chain attacks via compromised npm packages
- Cross-profile data bleed between concurrent sessions

**Key controls:**

- All model output validated against a typed action enum before dispatch — no `eval`
- `open()` rejects all non-`http(s)` URL schemes
- Per-session process isolation; no shared storage between profiles
- All dependencies pinned to exact versions; `pnpm audit --audit-level=critical` gates CI
- Credentials redacted from all logs and replay traces (automated test in CI)
- Pre-session fingerprint coherence check — session does not start if check fails

## Supported versions

| Version              | Supported |
| -------------------- | --------- |
| `main` (pre-release) | Yes       |

Once the project reaches `1.0.0`, a version support matrix will be added here.

## Dependency policy

Every dependency is pinned to an exact version (`"package": "1.2.3"`) with no floating ranges. The lockfile (`pnpm-lock.yaml`) is committed and `pnpm install --frozen-lockfile` is enforced in CI. Renovate opens automated upgrade PRs; each must pass the full CI gate before merge.

CVE tracking: `make security` runs `pnpm audit --audit-level=critical` and fails the build on known-critical findings. The Chromium patch set is tracked against the Chromium CVE feed.
