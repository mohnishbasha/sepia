# Chromium patch set

> **Status: not implemented. This directory contains no `.patch` files.**
>
> The stack below is a design, not something you can apply. `make patch` and
> `make chromium-build` refuse to run rather than silently producing stock
> Chromium and calling it patched (issue #17).
>
> **What this means in practice:** Sepia does not alter TLS. Its ClientHello is
> whatever Playwright's Chromium sends, so JA3/JA4 fingerprints identify it as
> ordinary headless Chrome and AC-F1/AC-F2 cannot pass from this repository.
> They are blocked on missing source, not on build capacity.
>
> What _is_ implemented and tested is the JS and header layer: user-agent and
> Client Hints coherence, `navigator.webdriver`, locale/timezone/viewport
> agreement, and the probe suite in `tests/fingerprint/`. That defeats
> script-level detection and does not defeat a TLS fingerprint. Anyone relying
> on this against TLS-aware anti-bot systems should know that before they start.

## Patch stack (design, unimplemented)

| File                           | Purpose                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `001-ungoogled-chromium.patch` | Strip Google integrations (sourced from ungoogled-chromium project)                        |
| `002-rebrowser.patch`          | Remove CDP/WebDriver automation detection artifacts                                        |
| `003-boring-ssl-ja3.patch`     | BoringSSL ClientHello construction — cipher suite order matches Chrome 130 on Linux x86_64 |
| `004-profile-coherence.patch`  | UA string, Client Hints, canvas noise removal, WebGL renderer string, font enumeration     |

Apply order would be strict: 001 → 002 → 003 → 004. Patch 003 is the one that
matters for JA3/JA4; the others address detection surfaces that the JS-level
work already covers in part.

## Prerequisites

- Chromium build environment (depot_tools, Python 3, clang, ninja)
- ~100 GB disk space for the Chromium source tree
- ~4–8 hours for the first full build

Full Chromium build instructions: https://chromium.googlesource.com/chromium/src/+/main/docs/linux/build_instructions.md

## Applying patches

```bash
# Fetch ungoogled-chromium at the pinned version
cd patches/
git clone https://github.com/ungoogled-software/ungoogled-chromium.git chromium
cd chromium
git checkout <pinned-tag>   # see patches/VERSION

# Apply the stack
make patch   # from the repo root — runs patches/*.patch in order

# Build
make chromium-build   # output: bin/chromium
```

## Updating the patch set

When a new Chromium major version is adopted:

1. Create a new branch: `git checkout -b patches/chromium-131`
2. Rebase each `.patch` file against the new ungoogled-chromium tag.
3. Run `make patch-check` to verify clean application.
4. Update `patches/VERSION` with the new tag.
5. Run `make test-fingerprint` — all AC-F\* tests must pass with the new build.
6. Open a PR with the rebased patches and updated VERSION.

## Maintenance policy

The pinned Chromium version is updated with each Sepia minor release (approximately every 8–10 weeks, aligned with Chromium's major release cadence). The nightly CI job `patch-check` alerts on rebase failures.

## CVE tracking

`make security` checks the pinned Chromium version against the Chromium CVE feed. Open critical CVEs block the build until the version is updated.
