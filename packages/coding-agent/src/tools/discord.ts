import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { discordModeSessionForFile } from "../discord-mode/session";
import { DISCORD_MODE_MAX_TEXT } from "../discord-mode/protocol";
import discordDescription from "../prompts/tools/discord.md" with { type: "text" };
import type { ToolSession } from "./index";

const discordSchema = type({
	action: type("'peers' | 'send' | 'report'").describe(
		"List connected project peers, send peer data, or explicitly publish a report",
	),
	"recipientId?": type("string").describe("Connected same-project native session ID; required for send"),
	"text?": type("string").describe(
		"Explicit message/report text, maximum 12000 UTF-8 bytes; required for send/report",
	),
	"+": "reject",
});

type DiscordParams = typeof discordSchema.infer;
interface DiscordToolDetails {
	action: DiscordParams["action"];
	peers?: Array<{ id: string; label: string; busy: boolean; pendingInput: boolean }>;
	delivered?: true;
}

export class DiscordTool implements AgentTool<typeof discordSchema, DiscordToolDetails> {
	readonly name = "discord";
	readonly label = "Discord";
	readonly summary = "List project peers, send peer messages, or publish an explicit report";
	readonly description = discordDescription;
	readonly parameters = discordSchema;
	readonly strict = true;
	readonly approval = (args: unknown): "read" | "write" =>
		args !== null && typeof args === "object" && "action" in args && args.action === "peers" ? "read" : "write";

	constructor(private session: ToolSession) {}

	async execute(
		toolCallId: string,
		params: DiscordParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<DiscordToolDetails>> {
		if (signal?.aborted) throw new Error("Discord request cancelled before dispatch.");
		const mode = discordModeSessionForFile(this.session.getSessionFile(), this.session.getSessionId?.() ?? null);
		if (!mode)
			throw new Error("Discord mode is off for this session. Only the local owner can enroll it with /discord on.");
		if (params.action === "peers") {
			if (params.recipientId !== undefined || params.text !== undefined)
				throw new Error("peers does not accept recipientId or text.");
			const snapshot = await mode.status();
			const peers = snapshot.peers
				.filter(peer => peer.enabled && peer.connected)
				.map(peer => ({ id: peer.id, label: peer.label, busy: peer.busy, pendingInput: peer.pendingInput }));
			return { content: [{ type: "text", text: JSON.stringify(peers) }], details: { action: "peers", peers } };
		}
		if (!params.text?.trim() || Buffer.byteLength(params.text) > DISCORD_MODE_MAX_TEXT)
			throw new Error("Discord text must contain 1–12000 UTF-8 bytes.");
		// A repeated tool invocation ID addresses the same broker operation, never a second side effect.
		const requestId = `tool:${new Bun.CryptoHasher("sha256").update(JSON.stringify([this.session.getSessionId?.(), toolCallId])).digest("hex")}`;
		if (params.action === "send") {
			if (!params.recipientId) throw new Error("send requires a connected same-project recipientId from peers.");
			await mode.send(params.recipientId, params.text, requestId);
		} else {
			if (params.recipientId !== undefined)
				throw new Error("report publishes to this session's channel; it does not accept recipientId.");
			await mode.report(params.text, requestId);
		}
		return {
			content: [
				{
					type: "text",
					text:
						params.action === "send"
							? "Peer message queued; this is data, not owner approval."
							: "Explicit report published.",
				},
			],
			details: { action: params.action, delivered: true },
		};
	}
}
