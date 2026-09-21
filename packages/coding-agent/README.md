# Haiso coding agent

Core implementation of Haiso, based on OMP 18.2.6. The internal package name remains `@oh-my-pi/pi-coding-agent` for source compatibility; the installed command is `haiso`.

For installation, setup, provider configuration, model roles, slash commands, and full CLI reference, see:
- [Monorepo README (local)](../../README.md)
- [Fork source (GitHub)](https://github.com/trxphxle/oh-my-pi#readme)

Package-specific references:
- [CHANGELOG](./CHANGELOG.md)
- [MCP configuration guide](../../docs/mcp-config.md)
- [MCP runtime lifecycle](../../docs/mcp-runtime-lifecycle.md)
- [MCP server/tool authoring](../../docs/mcp-server-tool-authoring.md)
- [DEVELOPMENT](./DEVELOPMENT.md)

## Haiso Discord mode (personal fork)

Opt individual, existing terminal sessions into a private Discord workspace. One
category represents a canonical project directory; `#overview` lists the group,
and each enrolled independent session has its own named text channel. Names are
editable labels; routing uses persistent group/session and Discord resource IDs.
Short-lived subagents remain owned by their parent session rather than creating
channels of their own.

### Setup and enrollment

1. Run `haiso`, not the separate official `omp` installation. Use `haiso --resume` to continue an existing conversation after closing its old process.
2. Create a dedicated bot in the [Discord Developer Portal](https://discord.com/developers/applications).
   Enable **Message Content Intent**, invite it to your private server, and grant
   **View Channels, Send Messages, Read Message History, Attach Files, Embed Links,
   and Manage Channels**. Administrator is unnecessary. Do not run the old bridge
   and this mode with the same bot account at the same time.
3. In the local terminal, run `/discord setup`. Enter the numeric server and owner
   user IDs, then the bot token in the masked input. Credentials are stored in the
   active profile's `agent/discord-mode/config.json` (directory `0700`, file `0600`),
   not model context or ordinary settings. Never put the token in chat or command
   arguments.
4. Run `/discord on`. On first enrollment, name the project group and this session's channel. Other
   explicitly enrolled sessions in the same canonical directory join that group.
   Symlink aliases converge; separate worktrees/subdirectories remain separate
   groups. Enrollment is session-local, not a persistent auto-enrollment setting.

Re-enabling the same saved conversation reconnects its retained channel without
asking for a new name, including after `haiso --resume`. Use `/discord rename` to
change its label. Starting a new conversation creates a separate session identity
and channel; resume the original conversation to reuse its channel.

The mode uses a shared supervised local service and the original session's model,
tools, conversation, and approval settings. It does not launch another coding
engine. Keep the office machine awake, logged in, and online; ordinary terminal
sessions still end when their host exits. This mode does not install a login
service or automatically create persistent Builder processes.

### Conversation and control

Run `/discord` in the terminal to open a control panel, not to toggle sharing.
It shows **OFF** or **ON** explicitly and offers setup/enable, connection details,
repair, rename, or disable actions appropriate to the current state. After opening
the controls, a persistent indicator remains visible, including when mode is off.
**ON · CONNECTED**, **ON · DISCONNECTED**, and **ON · NEEDS REPAIR** distinguish
enabled sharing from a usable remote connection; no icon or color interpretation
is required.

In a session channel, ordinary owner text queues for an idle boundary; no ask
command is needed. Queued-message acknowledgments offer **Send as guidance** and
**Cancel queued message** until dispatch. Session cards expose **Stop turn**,
**Queue**, and **Session details**.

| Discord command | Behavior |
| --- | --- |
| `/session status` | Show the channel's session connection, activity, pending input, and queue counts. |
| `/session stop` | Request cancellation of the current turn, not rollback or process shutdown. |
| `/session queue` | Inspect waiting owner messages; select one to view its full text and available actions. |
| `!steer <message>` | Send guidance to active work. |
| `!abort` | Request the same turn cancellation as `/session stop`. |

Only queued, non-held owner messages in the current connection can be cancelled
or promoted to guidance. Dispatched work cannot be changed through queue controls;
held messages require explicit local repair/resumption. Buttons are bound to their
channel and connection generation, so old controls cannot affect a reconnected
session. All 32 pending messages remain accessible through the queue selector.

Startup replaces the bot's legacy `/omp`, `/team`, and `/tell` commands with the
guild-scoped `/session` commands; unrelated registrations are preserved. Terminal
commands such as `/discord on` remain local. Model/context controls and remote
session creation/restart are not included.

Attachments, stickers, polls, and forwarded messages are rejected rather than
partially sent. The overview links enrolled session channels and shows their
activity; it is not an implicit broadcast command.

Only the configured owner in the configured server may issue remote commands or
answer native dialogs. Select, confirmation, text/editor, and structured ask
interactions retain their native local answer path: the first local or remote
answer wins. Stale controls cannot answer another request. Unsupported or
oversized dialogs remain available locally rather than being auto-approved.
Remote select menus support up to 25 complete options; text/editor responses up
to 4,000 characters. Full dialog details are attached rather than silently
truncated; a remote structured ask with too many projected options remains local.

Only attributable remote-turn final text and explicit reports are published.
Replies and reports contain the message itself, without delivery-ID headers or
tracking-hash footers. Delivery and status-card identity remain internal.
Thinking, tool output, and unrelated local conversation are not mirrored. Final
responses over 12,000 UTF-8 bytes are explicitly marked as truncated; the original
remains in the native session. The `discord` tool lets enrolled agents list
same-project peers, send peer data, and publish deliberate reports. Local peer
messages do not round-trip through Discord and continue if a Discord resource
disappears. Peer input never grants owner approval.

### Lifecycle and recovery

| Command/event | Behavior |
| --- | --- |
| `/discord` | Open state-aware controls without enabling or disabling sharing automatically. |
| `/discord status` | Show remote-access state, destination, activity, peers, and uncertain work. |
| `/discord off` | Revoke this session's remote routing; retain local work and Discord channels/history. |
| `/discord rename` | Rename the group category or this session's channel. |
| Manual Discord rename | Adopt the label without changing session identity. |
| Channel/category deletion | Suspend affected remote bindings; never recreate resources or kill sessions automatically. Discord category deletion leaves child channels uncategorized. |
| Moved channel or lost/private-permission changes | Suspend remote routing until explicitly repaired. Missing access is not proof of deletion. |
| `/discord repair` | Explicitly create a replacement, adopt a selected resource ID, or reconcile the retained binding. Group repair reuses surviving channels. Queued work stays held unless explicitly resumed. |
| `/discord reconcile` | Inspect an uncertain operation and explicitly clear its fence without replaying it or claiming success. |
| Session switch/fork/branch/disposal | Revoke the previous connection before identity changes. Re-enroll explicitly; the same saved session can reuse its channel. |
| Lost/expired broker lease | Inspect status; use `/discord off`, then `/discord on` to establish a fresh connection. Unknown work remains fenced. |
| Permanent native session deletion | Retire the binding and pending input; retain Discord history by default, or delete the exact bound channel after an explicit local choice. |

Transport reconnects do not replay uncertain prompts, approvals, publications, or
resource creation. If a creation response is lost, inspect Discord and adopt the
existing resource explicitly. Never delete private state to force a retry.

### Permanent session deletion

In the terminal, `/session delete`, `/delete`, and session-picker deletion offer
two choices for an enrolled conversation: **retain Discord history** (the default)
or **delete the local session and Discord channel**. The latter permanently erases
the channel's history; Cancel/Escape changes neither side. Headless `/session delete`
defaults to retaining Discord history.

Retained channels are renamed `archived-…` and show a closed-session notice.
This is logical archiving, not Discord's thread archive feature: history remains
readable, but messages and old controls cannot reach an agent. A new message gets
a clear “conversation permanently deleted; nothing forwarded” response. Retired
sessions disappear from active discovery and the project overview; their saved
identities cannot be re-enrolled or silently resurrected.

Deletion intent is stored privately before removing the native file. Offline
Discord cleanup resumes on broker reconnection or the next normal Haiso launch,
without enrolling that launch. Closing a terminal, turning Discord off, moving a
session, or finding a missing file alone never triggers channel deletion. If file
removal succeeds but artifact cleanup fails, retirement still proceeds and the
local cleanup error remains visible. Unverifiable channel ownership or an unknown
new-notice outcome stays marked for attention rather than guessing or duplicating
effects.

This is same-user remote access, **not a filesystem or hostile-agent sandbox**.
Channel permissions explicitly allow the bot and owner, but Discord server owners
and Administrator roles inherently bypass channel restrictions. Keep the server
trusted. All sessions retain the local account's ordinary filesystem/network
authority and configured tool approvals.

Resource bounds are deliberate: 49 retained session channels plus overview per
category, 128 retained sessions overall, 32 pending deliveries per session, 96 KiB
pending payload per session, and 8 MiB aggregate pending payload. Completed
payloads retire while replay-prevention fingerprints remain, bounded by 100,000
intents / a 24 MiB journal. Exhaustion refuses new work rather than losing
uncertainty or replay fences; archive only an inactive, reconciled private profile.

The transport and private-storage implementation include MIT-licensed adaptations
from `omp-discord-bridge`, copyright © 2026 treearc; see [LICENSE](./LICENSE).

## Memory backends

The agent supports three mutually-exclusive memory backends, selected via the `memory.backend` setting (Settings → Memory tab, or `~/.omp/config.yml`):

- `off` (default) — no memory subsystem runs.
- `local` — existing rollout-summarisation pipeline; writes `memory_summary.md` and consolidated artifacts under the agent dir.
- `hindsight` — talks to a [Hindsight](https://hindsight.vectorize.io) server (Cloud or self-hosted Docker), retains transcripts every Nth user turn, recalls memories on the first turn of a session, and exposes `retain`, `recall`, and `reflect`.

### Hindsight quickstart

1. Run a Hindsight server (Cloud or `docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest`).
2. Set `memory.backend = "hindsight"` and `hindsight.apiUrl = "http://localhost:8888"` (or your Cloud URL).
3. Optional environment overrides (env wins over settings):
   - `HINDSIGHT_API_URL`, `HINDSIGHT_API_TOKEN` — connection
   - `HINDSIGHT_BANK_ID`, `HINDSIGHT_DYNAMIC_BANK_ID`, `HINDSIGHT_AGENT_NAME` — bank addressing
   - `HINDSIGHT_AUTO_RECALL`, `HINDSIGHT_AUTO_RETAIN`, `HINDSIGHT_RETAIN_MODE` — lifecycle
   - `HINDSIGHT_RECALL_BUDGET`, `HINDSIGHT_RECALL_MAX_TOKENS` — recall sizing
   - `HINDSIGHT_BANK_MISSION`, `HINDSIGHT_DEBUG`

Switching backends mid-session immediately replaces the live backend, memory tools, listeners, and system-prompt context. Existing users with `memories.enabled = true|false` are migrated to `memory.backend = "local"|"off"` exactly once on first launch; afterward, `memory.backend` is the sole runtime selector.
