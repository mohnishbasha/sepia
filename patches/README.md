# Chromium patch set

Sepia patches Chromium at the source level to achieve coherent, undetectable browser fingerprints. This directory contains ordered patch files applied to the ungoogled-chromium checkout.

## Patch stack

| File | Purpose |
|---|---|
| `001-ungoogled-chromium.patch` | Strip Google integrations (sourced from ungoogled-chromium project) |
| `002-rebrowser.patch` | Remove CDP/WebDriver automation detection artifacts |
| `003-boring-ssl-ja3.patch` | BoringSSL ClientHello construction — cipher suite order matches Chrome 130 on Linux x86_64 |
| `004-profile-coherence.patch` | UA string, Client Hints, canvas noise removal, WebGL renderer string, font enumeration |

Apply order is strict: 001 → 002 → 003 → 004.

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
5. Run `make test-fingerprint` — all AC-F* tests must pass with the new build.
6. Open a PR with the rebased patches and updated VERSION.

## Maintenance policy

The pinned Chromium version is updated with each Sepia minor release (approximately every 8–10 weeks, aligned with Chromium's major release cadence). The nightly CI job `patch-check` alerts on rebase failures.

## CVE tracking

`make security` checks the pinned Chromium version against the Chromium CVE feed. Open critical CVEs block the build until the version is updated.
