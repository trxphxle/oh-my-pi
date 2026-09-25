# Haiso

Haiso is a personal fork of [Oh My Pi](https://github.com/can1357/oh-my-pi). It keeps OMP's engine, tools, providers and sessions and adds:

- [Discord session mode](docs/haiso-discord.md)
- `packages/omp-bridge`, an optional connector that lets official OMP sessions use the same Discord broker

`haiso` is its own command. The official `omp` install stays separate and untouched. Both share `~/.omp`, so settings, logins and sessions are shared. Haiso is not an official OMP release. License: [LICENSE](LICENSE).

## Updates

Haiso runs the **same upstream version as your installed `omp`**. Update OMP as usual (`omp update`), and Haiso follows.

`haiso update` does this:

1. Reads `omp --version` and fetches that upstream tag.
2. Merges the tag into the `haiso` branch in a temporary worktree. Git reuses conflict resolutions it has seen before, and `bun.lock` is regenerated rather than hand-merged.
3. Runs the checks below, builds a compiled binary, and installs it as a new read-only release.
4. Switches `~/.local/bin/haiso` to the new release. Only new launches use it; running sessions are not touched.

If anything fails, nothing is switched.

Automatic mode: when `haiso` starts, it runs the updater in the background at most once a day. It only updates when `omp`'s version has changed; it never ships new `haiso` commits on its own. If an update is held, the next launch prints one line telling you to run `haiso update --status`.

| Command | Effect |
| --- | --- |
| `haiso update` | Update now: follow `omp`'s version, or rebuild from new `haiso` commits. |
| `haiso update --check` | Show what would happen. Changes nothing. |
| `haiso update --status` | Current release, auto on/off, last result, log path. |
| `haiso update --auto on\|off` | Turn the daily background check on or off. |
| `haiso update --rollback` | Switch back to the previous release and turn auto off. Data is not rolled back. |
| `haiso update --force` | Rebuild even when up to date. |
| `haiso update --plugins` | Update plugins (unchanged from OMP). |

First install, from this checkout, with any Bun ≥ 1.4: `bun scripts/haiso/update.ts`.

### Checks before a release goes live

- Haiso tests (Discord mode, connector, release installer) and type checks.
- Upstream test suites of every package the fork touches. A failure blocks the update only if the same test passes on pure upstream.
- Compiled binary: `--version` and `--smoke-test` in an empty home.
- Your real data: a throwaway copy of `~/.omp` (without Discord credentials) opened by the new binary (`config list`, session listing, `gc --wal --apply`).

### When an update is held

- **Merge conflict:** either finish the merge in the held worktree (path in `haiso update --status`; `git add` the fixes, `git commit --no-edit`), or run `git merge vX.Y.Z` on `haiso` in this checkout and commit. Then run `haiso update`. Git records the fix, so the same conflict resolves itself next time.
- **Failed check:** see the log path in `haiso update --status`.

## Branches

- `haiso`: the fork. Commit here, then run `haiso update` to ship.
- `haiso-next`: the last built upstream merge that is not on `haiso` yet. Bring it in with `git merge --ff-only haiso-next`.
- `main`: stale (pre-18.3.0). Don't build from it.

## Changes vs OMP

- Discord session mode: project categories, one channel per session, remote replies/approvals, `/session status|stop|queue|notify|settings` (model, effort, context; advisor and plan mode for Haiso), owner pings when a session needs you, long replies attached as `.md`, automatic reconnect after sleep or broker restarts, sharing remembered per conversation (rejoins on resume), 🟣 Haiso / 🔵 OMP channel markers, an always-on service with saved and missed messages, live progress on cards, background conversations started or resumed from Discord, a self-updating pinned guide, OMP bridge auto-loaded, peer messaging, and a choice to keep or delete the Discord channel when a session is deleted.
- `omp-bridge` connector for official OMP.
- Separate `haiso` command, immutable releases, guarded updates that follow the installed `omp` version.
- Session pickers support custom delete choices.
