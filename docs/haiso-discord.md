# Haiso Discord mode

Opt individual, existing terminal sessions into a private Discord workspace. One
category represents a canonical project directory (the peer group: sessions in it
can message each other); `#overview` lists the group in **Haiso sessions** and
**OMP sessions** sections, and each enrolled session has its own text channel,
marked 🟣 (Haiso) or 🔵 (OMP via `omp-bridge`), Haiso channels first. Names are
editable labels; the marker is added by Haiso and never becomes part of the label.
Routing uses persistent group/session and Discord resource IDs. Short-lived
subagents remain owned by their parent session rather than creating channels of
their own.

## Setup and enrollment

1. For native integration, run `haiso`. Use `haiso --resume` to continue an existing conversation after closing its old process. Official OMP users can use the [optional connector](#optional-official-omp-connector) instead.
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
   groups.

Sharing is remembered per conversation. Closing a terminal, switching, or starting
a new conversation only disconnects; the channel card shows *Disconnected · rejoins
when resumed*. Resuming a shared conversation (`haiso --resume`, the in-terminal
resume picker, or OMP with the connector) rejoins its channel automatically; resume
pickers mark shared conversations with a **Discord** badge. Only `/discord off` (or
`/bridge off`) makes a conversation private again, and that is sticky, including
when it is not currently open. Print, RPC, and ACP runs never join. Use
`/discord rename` to change a label. A new conversation gets its own channel.

The mode uses a shared supervised local service and the original session's model,
tools, conversation, and approval settings. It does not launch another coding
engine. This mode does not install a login service.

### Service and offline behavior

- **Stays online:** the Discord service keeps running after the last terminal
  closes, until logout or reboot. `/discord service off` (or the `/discord` menu)
  restores the old behavior of stopping with the last session.
- **Honest cards:** each session card is pinned in its channel (📌), so its buttons stay one tap away. A shared session shows `Online` while its terminal is attached and
  `Closed` otherwise. While working, the card shows a live line
  such as `Working · 4m · editing 3 files · last: bun test (pass)` (tool names and
  outcomes only; at most one edit per 10 seconds). `#overview` shows
  `Discord service: Online`, `Offline since …` after a clean stop, and a one-time
  note after an unexpected stop.
- **Messages to a closed session** are saved (up to 32 per session) with an instant
  reply and a [Discard] button; `!steer`/`!abort` are refused. When you resume the
  conversation, you are offered them (**Review / Send all / Discard**) in the terminal
  and in Discord; nothing runs on its own. `/discord saved` reopens the offer.
- **Messages sent while the service was offline** are picked up when it reconnects
  (owner messages only, up to 50 per channel from the last 7 days) and saved behind a
  card with **Send now / Discard**.
- **Updates:** after `haiso update`, the service switches to the new release once
  every session has been idle for 30 seconds (never mid-turn, dialog, or pending
  message); sessions reconnect automatically. `/discord status` shows the service
  version and `update ready · switches when idle` while one is waiting.
- **Pinned guide:** the service keeps one bot-pinned guide in `#general` current and
  posts a short *Haiso updated* note there when commands or guide sections change.
- **Keep awake (opt-in):** `/discord service awake on` keeps the Mac from idle-sleeping
  while a conversation is shared and connected or a background copy runs (closing the
  lid still sleeps it). Off by default.
- **Low overhead:** with a current service, idle sessions wait for work instead of
  polling every second.
- **Diagnostics:** `haiso discord doctor` (or `/discord doctor`) checks config and
  permissions, the bot token, guild permissions, command registration, the service,
  saved state, the release, and the OMP connector loader, with a one-line fix per
  problem.
- Keep the machine awake and online; sleep pauses everything until it wakes.

### Background conversations from Discord

- **Resume:** a closed Haiso session card has a **Resume** button; `/session resume`
  lists the project's closed shared conversations. The conversation runs in the
  background on your Mac (the normal Haiso UI in a hidden terminal) in its channel.
- **New:** `/session new` (in a project's `#overview` or session channel) opens a form:
  name, first message, optional model (`provider/model` a connected session already
  offers). Only folders that already have a project category are allowed.
- **Close:** `/session close` stops a background copy after its current turn; sharing
  and history stay. Permanent delete stays terminal-only.
- **One writer:** `haiso --resume` on a conversation running in the background asks it
  to step aside at its next idle point, then opens it (waits up to 10 minutes). When
  you exit a shared conversation's terminal, Haiso asks *Keep running in the
  background?*
- At most 4 background copies run at once. A copy that crashes shows `Closed`; nothing
  restarts it automatically.

## Optional official OMP connector

`packages/omp-bridge` is an opt-in extension for official OMP, tested against the
same OMP version Haiso is built on. It reuses this broker through private local IPC; it neither imports the
Haiso application runtime nor runs a second Discord bot.

Every Haiso release ships the connector and installs a one-line loader at
`~/.omp/agent/extensions/haiso-bridge.ts`, so official OMP loads it automatically; it
is inert inside Haiso and does nothing until `/bridge on`. Delete that file to opt
out; later updates respect the deletion. For development, load a local build with
`omp --extension <checkout>/packages/omp-bridge/dist/index.js` after
`bun packages/omp-bridge/scripts/build.ts`.

Use `/bridge on [channel label]` in OMP; the OMP conversation must already be saved
(resume one or complete a local turn first). If Haiso's Discord service is down, the
connector starts it with the installed `haiso`. Discord setup itself stays a one-time
Haiso operation. The connector never creates or rewrites OMP's native session file.

| OMP terminal command | Behavior |
| --- | --- |
| `/bridge on [label]` | Share this saved conversation and enable its small `bridge` tool; afterwards it rejoins automatically when resumed in OMP. |
| `/bridge off` | Make this conversation private (sticky), release the service lease, and remove only this extension's tool. |
| `/bridge status` | Inspect local connection, destination, and uncertain deliveries. |
| `/bridge reconcile` | Review unknown delivery outcomes without replaying them. |
| `/bridge repair` | Explicitly repair a binding or resume held work after inspection. |
| `/bridge` | Open a menu of the actions above for the current state (turn on when off). |

The tool exposes `peers`, `send`, and `report`. Peer input stays untrusted agent
data; only attributable owner-turn final text and explicit reports reach Discord.
Enabling the tool lets OMP refresh its own tool catalog; no Haiso persona or system
instructions are appended, and model/advisor/approval settings are unchanged.
Existing project rules and conversation contents still apply normally.

Use `--bridge-root /absolute/path/to/discord-mode` or `HAISO_BRIDGE_ROOT` for a
different broker profile. The default is `~/.omp/agent/discord-mode`. The extension
reads IPC credentials only, never `config.json` or the Discord bot token. It holds
the existing managed service alive while attached.

Approvals stay in OMP's terminal; the Discord settings panel offers model, effort,
and context/compact for OMP sessions (no advisor, plan mode, or "make default").
Its public extension API does not
provide this connector an authoritative permanent-deletion event: switching,
branching, navigating history, or exiting disconnects (sharing is kept), but does
not delete the Discord channel. Do not infer deletion from a missing file. Use Haiso's native retirement
workflow or explicitly clean up the Discord channel when needed.

## Conversation and control

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
**Queue**, **Session details**, and **Settings**.

| Discord command | Behavior |
| --- | --- |
| `/session status` | Show the channel's session connection, activity, pending input, queue counts, and notification mode. |
| `/session stop` | Request cancellation of the current turn, not rollback or process shutdown. |
| `/session queue` | Inspect waiting owner messages; select one to view its full text and available actions. |
| `/session notify mode:<all \| needs-you \| off>` | Choose when this session @mentions you (default `needs-you`); works while disconnected and persists. |
| `/session settings` | Open the settings panel (also the card's **Settings** button). |
| `/session rename` | Rename this session's channel (a form; the 🟣/🔵 marker is kept); works while closed. |
| `!steer <message>` | Send guidance to active work. |
| `!abort` | Request the same turn cancellation as `/session stop`. |

Mentions ping only the configured owner. `needs-you` pings when a session opens
an approval or question (once per exchange, not per re-render) and when a reply
arrives for a message that took 2 minutes or more. `all` also pings every reply;
`off` never pings. Reports, status cards, acknowledgments, and peer traffic never ping.

The settings panel shows the model, effort, and context use (%), plus advisor and
plan mode for Haiso sessions. Pick a model from a short list (current, roles,
recent) or **Search models…**; effort lists only levels the model supports;
**Compact** works when the session is idle. Changes apply to this session only
(Haiso's **Make default** is a separate button). A busy session answers *Pending —
applies after this turn*; the panel confirms only after the session applied the
change. Leaving plan mode goes through the normal plan approval. Approval rules,
credentials, and logins are never exposed.

Only queued, non-held owner messages in the current connection can be cancelled
or promoted to guidance. Dispatched work cannot be changed through queue controls;
held messages require explicit local repair/resumption. Buttons are bound to their
channel and connection generation, so old controls cannot affect a reconnected
session. All 32 pending messages remain accessible through the queue selector.

Startup replaces the bot's legacy `/omp`, `/team`, and `/tell` commands with the
guild-scoped `/session` commands; unrelated registrations are preserved. Terminal
commands such as `/discord on` remain local. Remote session creation/restart is
not included.

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

Only attributable remote-turn final text and explicit reports are published. A remote
turn that ends in a provider error (usage limit, outage) posts a short notice with
the first line of the error instead of staying silent; a stopped turn posts nothing.
Replies and reports contain the message itself, without delivery-ID headers or
tracking-hash footers. Delivery and status-card identity remain internal.
Thinking, tool output, and unrelated local conversation are not mirrored. A final
response longer than one Discord message (2,000 characters) is posted once as a
preview plus the full text in `haiso-reply.md`; replies over 96 KiB are marked as
truncated (12,000 bytes with a broker from an older build). Reports stay at 12,000
bytes. The original always remains in the native session. The `discord` tool lets enrolled agents list
same-project peers, send peer data, and publish deliberate reports. Local peer
messages do not round-trip through Discord and continue if a Discord resource
disappears. Peer input never grants owner approval.

## Lifecycle and recovery

| Command/event | Behavior |
| --- | --- |
| `/discord` | Open state-aware controls without enabling or disabling sharing automatically. |
| `/discord status` | Show remote-access state, destination, activity, peers, and uncertain work. |
| `/discord off` | Make this conversation private (sticky, also when not open); retain local work and Discord channels/history. |
| `/discord rename` | Rename the group category or this session's channel. |
| Manual Discord rename | Adopt the label without changing session identity. |
| Channel/category deletion | Suspend affected remote bindings; never recreate resources or kill sessions automatically. Discord category deletion leaves child channels uncategorized. |
| Moved channel or lost/private-permission changes | Suspend remote routing until explicitly repaired. Missing access is not proof of deletion. |
| `/discord repair` | Explicitly create a replacement, adopt a selected resource ID, or reconcile the retained binding. Group repair reuses surviving channels. Queued work stays held unless explicitly resumed. |
| `/discord reconcile` | Inspect an uncertain operation and explicitly clear its fence without replaying it or claiming success. |
| Exit/session switch/fork/branch/disposal | Disconnect the previous conversation without forgetting sharing; a shared conversation rejoins its channel when resumed. |
| Lost/expired broker lease (sleep, stall, broker restart) | Reconnects automatically with backoff (2s up to 60s) to the same channel. Held or uncertain messages stay fenced and are reported once; resume them with `/discord repair` / `/discord reconcile`. Auto-reconnect stops (use `/discord off`, then `/discord on`) if the enrollment is gone, the session was turned off or rebound elsewhere, or another process holds its connection. |
| Permanent native session deletion | Retire the binding and pending input; retain Discord history by default, or delete the exact bound channel after an explicit local choice. |

Transport reconnects do not replay uncertain prompts, approvals, publications, or
resource creation. If a creation response is lost, inspect Discord and adopt the
existing resource explicitly. Never delete private state to force a retry.

## Permanent session deletion

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
from `omp-discord-bridge`, copyright © 2026 treearc; see [LICENSE](../LICENSE).
