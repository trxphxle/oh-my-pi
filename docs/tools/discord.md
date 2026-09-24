# discord

> Haiso only. Lists Discord-enrolled peer sessions in the same project, sends them peer data, or publishes an explicit report to this session's channel.

## Source
- Entry: `packages/coding-agent/src/tools/discord.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/discord.md`
- Key collaborators:
  - `packages/coding-agent/src/discord-mode/session.ts` — per-session broker connection (`discordModeSessionForFile`)
  - `packages/wire/src/discord-mode.ts` — `DISCORD_MODE_MAX_TEXT` and broker contracts
- User guide: [`docs/haiso-discord.md`](../haiso-discord.md)

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `"peers" \| "send" \| "report"` | Yes | List connected peers, send peer data, or publish a report. |
| `recipientId` | `string` | For `send` | Peer ID from `peers`. Rejected for `peers` and `report`. |
| `text` | `string` | For `send`/`report` | 1–12000 UTF-8 bytes. Rejected for `peers`. |

## Outputs
- `peers`: JSON array of `{ id, label, busy, pendingInput }` for enabled, connected peers; `details: { action: "peers", peers }`.
- `send` / `report`: a one-line confirmation; `details: { action, delivered: true }`. Peer messages are data, never owner approval.
- Throws when the session is not enrolled (`/discord on` is local-owner-only) or inputs are invalid.
- The request ID is derived from session ID + tool call ID, so a repeated call addresses the same broker operation instead of sending twice.
