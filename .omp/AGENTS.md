# Haiso fork rules

This checkout is **Haiso**, a personal fork of upstream OMP. Root `AGENTS.md` still applies; these rules add fork policy. User guide: `HAISO.md`.

## Source of truth
- Branch `haiso` = upstream release merges + fork commits. Ship = commit to `haiso`, then `haiso update`.
- `haiso-next` = last built merge not yet on `haiso`; bring it in with `git merge --ff-only haiso-next`.
- `main` is stale (pre-18.3.0). Do not build from it.
- `git rerere` is on; recorded conflict resolutions live in `.git/rr-cache` (local only).

## Keep upstream merges clean
Every edit to an upstream file is a future conflict. Before touching one, prefer a fork-owned file.
- NEVER edit upstream docs or changelogs (`README.md`, `packages/*/README.md`, `packages/*/CHANGELOG.md`). Fork docs: `HAISO.md`, `docs/haiso-*.md`, `docs/tools/discord.md`, this file. Fork changes go in `HAISO.md` › Changes.
- NEVER replace literal `omp` strings for branding. The only brand switch is `APP_NAME` in `packages/utils/src/dirs.ts`.
- Storage stays OMP's (`.omp`, XDG `omp`) so `haiso` and `omp` share settings, logins and sessions.
- Known fork edits in upstream files (keep them small): Discord wiring in `main.ts`, `agent-session.ts`, `session-entries.ts`, `command-controller.ts`, `selector-controller.ts`, `extension-ui-controller.ts`, `builtin-registry.ts`, `builtin-session.ts`, `tools/index.ts`, `tools/builtin-names.ts`, `cli.ts`, `cli/worker-selectors.ts`, tui `session-selector.ts`/`session-picker.ts`; `APP_NAME`/daemon scope in `utils/src/dirs.ts`; Windows pipe key in `launch/paths.ts`; the self-update guard in `cli/update-cli.ts`; `APP_NAME`-aware upstream tests (`test/update-cli.test.ts`, `cli-max-time-flag.test.ts`, `cli/completions.test.ts`, `debug/report-bundle-logs.test.ts`); `HAISO_NATIVE_NAMESPACE` in `compile-binary.ts` + `natives/native/loader-state.js`; `discord.js` in root and coding-agent `package.json`. List them with `git diff --stat $(git describe --tags --abbrev=0 --match 'v*') haiso`.

## Updates
- Haiso follows the installed official `omp` version (`omp --version`), never GitHub latest.
- Updater: `scripts/haiso/update.ts` (merge in a temp worktree, checks, build, install); release install/activate/rollback: `scripts/haiso/release.ts`. The launcher `~/.local/bin/haiso` routes `haiso update …` to the script; the binary itself refuses to self-update.
- NEVER run upstream installers, `omp update` logic, `bun setup` or `bun link` against Haiso.
- A held update: finish the merge in the held worktree, or `git merge vX.Y.Z` on `haiso` yourself; commit; then `haiso update`.
- `bun.lock` merges go through `scripts/haiso/lockfile-merge.ts` (git merge driver the updater registers in `.git/info/attributes`); never hand-merge it.
