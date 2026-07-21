# Contributing to Sepia

Thank you for contributing. Read this before opening a PR.

## Development setup

```bash
git clone https://github.com/mohinishbasha/sepia.git
cd sepia
make setup          # installs Node.js deps and Playwright Chromium
make build          # verify everything compiles
make ci             # verify CI gate passes
```

## Workflow

1. **Check the spec first.** Every change must trace to a numbered requirement (FR-*, NFR-*, AC-*) in [`docs/phase1-spec.md`](docs/phase1-spec.md). If your change falls outside the spec, propose a spec update first.

2. **Read CLAUDE.md.** The [CLAUDE.md](CLAUDE.md) operating guide lists hard invariants (no eval, fail closed, secrets never in logs). These are non-negotiable.

3. **Write the test first (or alongside the code).** No feature merges without tests traceable to an AC-* criterion.

4. **Keep the deterministic core LLM-free.** `types`, `config`, `serializer`, `resolver`, `fingerprint`, `privacy`, `telemetry`, and `engine` must never import from `agent` or make model API calls.

5. **Pin dependencies to exact versions.** If you add a package, pin it in `package.json` (`"package": "1.2.3"`, no `^` or `~`) and commit the updated `pnpm-lock.yaml`.

## Pull request checklist

- [ ] `make ci` passes locally (build + lint + typecheck + test + security)
- [ ] New/changed behavior has tests referencing FR-* or AC-* numbers
- [ ] `docs/phase1-spec.md` updated if behavior changed
- [ ] No new `@typescript-eslint/no-explicit-any` warnings without justification
- [ ] Secrets are not committed (check `.gitignore` covers your additions)
- [ ] `pnpm-lock.yaml` is committed if deps changed
- [ ] PR description explains what changed and why (not just what)

## Code style

- TypeScript strict mode — all rules in `tsconfig.json` apply.
- Prettier formats everything — run `make fmt` before committing.
- ESLint enforces no-eval, no-implied-eval, one-way imports, and consistent-type-imports.
- No `any` without a comment explaining why it's necessary.
- Comments only for non-obvious WHY — not what the code does.

## Security issues

Do **not** open a public issue for security vulnerabilities. See [SECURITY.md](SECURITY.md) for the private disclosure process.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
