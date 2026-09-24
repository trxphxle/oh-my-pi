import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { DISCORD_MODE_MAX_TEXT, type ModeSnapshot } from "@oh-my-pi/pi-wire/discord-mode";
import bridgePrompt from "../prompts/bridge.md" with { type: "text" };
import peerPrompt from "../prompts/peer.md" with { type: "text" };
import {
	BRIDGE_MESSAGE_SOURCE,
	BRIDGE_OWNER_MESSAGE_TYPE,
	BRIDGE_PEER_MESSAGE_TYPE,
	type BridgeConnection,
	type BridgeHost,
} from "./host";
import { BridgeSession } from "./session";

export interface BridgeExtensionOptions {
	connect?: (root: string) => Promise<BridgeConnection>;
	receiptRoot?: string;
	pollIntervalMs?: number;
}

const TOOL_NAME = "bridge";
const USAGE = "/bridge on [label] | off | status | reconcile | repair";

function identity(ctx: ExtensionContext): string {
	return JSON.stringify([ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile(), ctx.cwd]);
}

function describe(snapshot: ModeSnapshot): string {
	const uncertain = snapshot.deliveries.filter(delivery => delivery.state === "unknown").length;
	return [
		`Bridge: ${snapshot.session.enabled ? "on" : "off"}; gateway ${snapshot.gatewayConnected ? "connected" : "offline"}.`,
		`Session: ${snapshot.session.label} (${snapshot.session.state}); channel ${snapshot.session.channelId ?? "unbound"}.`,
		`Project: ${snapshot.group.name} (${snapshot.group.state}); category ${snapshot.group.categoryId ?? "unbound"}.`,
		...(uncertain ? [`${uncertain} uncertain delivery(s): use /bridge reconcile; no automatic replay.`] : []),
	].join("\n");
}

/** Dependencies are injectable for isolated transport fixtures; production uses the shared connector. */
export function installBridge(pi: ExtensionAPI, options: BridgeExtensionOptions = {}): void {
	let latest: ExtensionContext | undefined;
	let observedIdentity: string | undefined;
	let session: BridgeSession | undefined;
	let epoch = 0;
	let dialogs = 0;
	let desiredTool = false;
	let toolUpdates = Promise.resolve();
	const approvals = new Set<string>();
	const asks = new Set<string>();

	const host: BridgeHost = {
		getState() {
			if (!latest) throw new Error("Bridge has no active OMP session.");
			return {
				sessionId: latest.sessionManager.getSessionId(),
				sessionFile: latest.sessionManager.getSessionFile() ?? null,
				cwd: latest.cwd,
				label: latest.sessionManager.getSessionName(),
				local: latest.mode === "tui" && latest.hasUI,
				idle: latest.isIdle(),
				pendingMessages: latest.hasPendingMessages(),
				pendingInput: dialogs > 0 || approvals.size > 0 || asks.size > 0,
				draft: latest.ui.getEditorText().length > 0,
			};
		},
		deliver(delivery, behavior) {
			const details = { bridge: BRIDGE_MESSAGE_SOURCE, deliveryId: delivery.id, from: delivery.from };
			if (delivery.source === "owner") {
				pi.sendMessage(
					{
						customType: BRIDGE_OWNER_MESSAGE_TYPE,
						content: delivery.text,
						attribution: "user",
						display: true,
						details,
					},
					{ triggerTurn: true, deliverAs: behavior },
				);
			} else {
				pi.sendMessage(
					{
						customType: BRIDGE_PEER_MESSAGE_TYPE,
						content: [
							{ type: "text", text: peerPrompt.trim() },
							{ type: "text", text: JSON.stringify({ from: delivery.from, text: delivery.text }) },
						],
						attribution: "agent",
						display: true,
						details,
					},
					{ triggerTurn: true, deliverAs: behavior },
				);
			}
		},
		abort: () => latest?.abort(),
		setToolEnabled(enabled) {
			desiredTool = enabled;
			toolUpdates = toolUpdates
				.catch(() => {})
				.then(async () => {
					const current = pi.getActiveTools();
					if (current.includes(TOOL_NAME) === desiredTool) return;
					await pi.setActiveTools(
						desiredTool ? [...current, TOOL_NAME] : current.filter(name => name !== TOOL_NAME),
					);
				});
			return toolUpdates;
		},
		setStatus: text => latest?.ui.setStatus(TOOL_NAME, text),
		notify: (text, level) => latest?.ui.notify(text, level),
		schedule(callback, delayMs) {
			if (!latest) throw new Error("Bridge has no timer context.");
			const ctx = latest;
			const timer = ctx.setInterval(() => {
				ctx.clearTimer(timer);
				callback();
			}, delayMs);
			return () => ctx.clearTimer(timer);
		},
	};

	async function detach(): Promise<void> {
		epoch++;
		approvals.clear();
		asks.clear();
		if (session) await session.off();
		else await host.setToolEnabled(false);
	}

	async function useContext(ctx: ExtensionContext): Promise<void> {
		latest = ctx;
		const next = identity(ctx);
		if (observedIdentity !== undefined && observedIdentity !== next) {
			observedIdentity = next;
			await detach();
		} else {
			observedIdentity = next;
		}
	}

	function requireSession(): BridgeSession {
		if (!session?.enabled) throw new Error("Bridge is off. Attach locally with /bridge on first.");
		return session;
	}

	async function reconcile(ctx: ExtensionContext): Promise<void> {
		const attached = requireSession();
		const generation = epoch;
		const current = () => generation === epoch && observedIdentity === identity(ctx) && attached.enabled;
		const snapshot = await attached.status();
		if (!snapshot || !current()) return;
		const uncertain = snapshot.deliveries.filter(delivery => delivery.state === "unknown");
		if (!uncertain.length) {
			ctx.ui.notify(
				"No broker-marked uncertain deliveries to reconcile. If a local admission is held, detach and reattach, then reconcile; do not replay it.",
				"info",
			);
			return;
		}
		for (const delivery of uncertain) {
			const confirmed = await ctx.ui.confirm(
				`Resolve uncertain delivery ${delivery.id}?`,
				`From: ${delivery.from}\nSource: ${delivery.source}; kind: ${delivery.kind}\n\n${delivery.text}\n\nMark this exact delivery resolved WITHOUT replaying it? Its previous execution may have had effects.`,
			);
			if (!current()) return;
			if (confirmed) await attached.resolve(delivery.id);
		}
	}

	async function repair(ctx: ExtensionContext): Promise<void> {
		const attached = requireSession();
		const generation = epoch;
		const current = () => generation === epoch && observedIdentity === identity(ctx) && attached.enabled;
		const snapshot = await attached.status();
		if (!snapshot || !current()) return;
		const targetChoice = await ctx.ui.select("Repair bridge destination", ["Session channel", "Project group"]);
		if (!targetChoice || !current()) return;
		const target = targetChoice === "Session channel" ? "session" : "group";
		const action = await ctx.ui.select("Destination action", [
			"Recreate destination",
			"Adopt existing destination",
			"Resume held deliveries",
		]);
		if (!action || !current()) return;
		let destinationId: string | undefined;
		if (action === "Adopt existing destination") {
			destinationId = (await ctx.ui.input("Existing Discord destination ID"))?.trim();
			if (!destinationId || !current()) return;
			if (!/^\d{17,20}$/.test(destinationId))
				throw new Error("Enter a Discord channel or category ID (17–20 digits).");
		} else if (action === "Resume held deliveries") {
			destinationId = target === "session" ? snapshot.session.channelId : snapshot.group.categoryId;
			if (!destinationId) throw new Error("No bound destination exists. Recreate or adopt one first.");
		}
		const resumeQueued = action === "Resume held deliveries";
		const confirmed = await ctx.ui.confirm(
			`${action}: ${target}?`,
			`${destinationId ? `Destination: ${destinationId}.` : "Create a new Discord destination."}\n${target === "group" ? "This affects the shared project group.\n" : ""}${resumeQueued ? "Confirm that you inspected Discord and any uncertain effects. Acknowledge those effects WITHOUT replay, and release held messages; they may start new agent work." : "Keep held messages paused. Resume them separately with /bridge repair."}`,
		);
		if (!confirmed || !current()) return;
		ctx.ui.notify(describe(await attached.repair(target, destinationId, resumeQueued)), "info");
	}

	pi.registerFlag("bridge-root", {
		type: "string",
		description: "Existing Haiso Discord broker root (default: HAISO_BRIDGE_ROOT or ~/.omp/agent/discord-mode)",
	});
	pi.registerCommand(TOOL_NAME, {
		description: "Opt in to the existing Haiso Discord broker; approvals and settings remain local",
		async handler(args, ctx) {
			await useContext(ctx);
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify("/bridge requires the local interactive OMP terminal.", "error");
				return;
			}
			const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (action !== "on" && rest.length) {
				ctx.ui.notify(USAGE, "error");
				return;
			}
			try {
				switch (action) {
					case "on": {
						epoch++;
						if (!session) {
							const flag = pi.getFlag("bridge-root");
							const root = path.resolve(
								typeof flag === "string" && flag
									? flag
									: process.env.HAISO_BRIDGE_ROOT || path.join(os.homedir(), ".omp", "agent", "discord-mode"),
							);
							session = new BridgeSession(host, { root, ...options });
						}
						const generation = epoch;
						const snapshot = await session.on(rest.join(" ") || undefined);
						if (generation !== epoch) return;
						ctx.ui.notify(describe(snapshot), "info");
						break;
					}
					case "off":
						await detach();
						ctx.ui.notify("Bridge is off.", "info");
						break;
					case "status": {
						const snapshot = await session?.status();
						ctx.ui.notify(
							snapshot
								? `${session!.statusText}\n${describe(snapshot)}`
								: "Bridge is off. Use /bridge on in a saved session to attach.",
							"info",
						);
						break;
					}
					case "reconcile":
					case "repair":
						dialogs++;
						try {
							if (action === "reconcile") await reconcile(ctx);
							else await repair(ctx);
						} finally {
							dialogs--;
						}
						break;
					default:
						ctx.ui.notify(USAGE, "error");
				}
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : "Bridge operation failed. Inspect the local broker.",
					"error",
				);
			}
		},
	});

	const z = pi.zod;
	const parameters = z.object({
		action: z
			.enum(["peers", "send", "report"])
			.describe("List attached peers, send peer data, or publish an explicit report"),
		recipientId: z.string().optional().describe("Exact peer ID from peers; required for send"),
		text: z
			.string()
			.min(1)
			.max(DISCORD_MODE_MAX_TEXT)
			.optional()
			.describe("Message or report text; required for send/report (maximum 12000 UTF-8 bytes)"),
	});
	pi.registerTool({
		name: TOOL_NAME,
		label: "Bridge",
		description: bridgePrompt.trim(),
		defaultInactive: true,
		loadMode: "essential",
		approval: args =>
			args !== null && typeof args === "object" && "action" in args && args.action === "peers" ? "read" : "write",
		parameters,
		async execute(toolCallId, params: typeof parameters._output, signal, _onUpdate, ctx) {
			await useContext(ctx);
			if (!session?.enabled) throw new Error("Bridge is off. The local owner must use /bridge on.");
			if (signal?.aborted) throw new Error("Bridge action cancelled before dispatch.");
			if (params.action === "send" && !params.recipientId)
				throw new Error("send requires recipientId from bridge peers.");
			if (
				params.action !== "peers" &&
				(!params.text || Buffer.byteLength(params.text, "utf8") > DISCORD_MODE_MAX_TEXT)
			)
				throw new Error("send/report requires text of at most 12000 UTF-8 bytes.");
			const requestId = `omp-bridge:${createHash("sha256")
				.update(JSON.stringify([ctx.sessionManager.getSessionId(), toolCallId]))
				.digest("hex")}`;
			try {
				if (params.action === "peers") {
					const peers = await session.peers();
					return { content: [{ type: "text", text: JSON.stringify({ peers }) }], details: { action: "peers" } };
				}
				if (params.action === "send") await session.send(params.recipientId!, params.text!, requestId);
				else await session.report(params.text!, requestId);
				return {
					content: [
						{ type: "text", text: params.action === "send" ? "Peer message accepted." : "Report published." },
					],
					details: { action: params.action },
				};
			} catch {
				// Transport errors and snapshots can contain private local state. Keep tool failures bounded and credential-free.
				throw new Error(
					"Bridge action failed; it may have had effects. Do not repeat it automatically. Ask the local owner to inspect /bridge status and /bridge reconcile.",
				);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await useContext(ctx);
	});
	const onLifecycleChange = async (_event: unknown, ctx: ExtensionContext) => {
		latest = ctx;
		observedIdentity = identity(ctx);
		await detach();
	};
	pi.on("session_switch", onLifecycleChange);
	pi.on("session_branch", onLifecycleChange);
	pi.on("session_tree", onLifecycleChange);
	pi.on("session_shutdown", onLifecycleChange);
	pi.on("message_start", async (event, ctx) => {
		await useContext(ctx);
		session?.onMessageStart(event.message);
	});
	pi.on("agent_end", async (event, ctx) => {
		await useContext(ctx);
		await session?.onAgentEnd(event);
	});
	pi.on("input", async (event, ctx) => {
		await useContext(ctx);
		if (event.source === "interactive" || event.source === "rpc") session?.onLocalInput();
	});
	pi.on("tool_approval_requested", async (event, ctx) => {
		await useContext(ctx);
		if (event.sessionId === ctx.sessionManager.getSessionId()) approvals.add(event.toolCallId);
	});
	pi.on("tool_approval_resolved", async (event, ctx) => {
		await useContext(ctx);
		if (event.sessionId === ctx.sessionManager.getSessionId()) approvals.delete(event.toolCallId);
	});
	pi.on("tool_execution_start", async (event, ctx) => {
		await useContext(ctx);
		if (event.toolName === "ask") asks.add(event.toolCallId);
	});
	pi.on("tool_execution_end", async (event, ctx) => {
		await useContext(ctx);
		asks.delete(event.toolCallId);
		approvals.delete(event.toolCallId);
	});
}

export default function bridgeExtension(pi: ExtensionAPI): void {
	installBridge(pi);
}
