import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { DiscordProgressTracker } from "@oh-my-pi/pi-utils/discord-progress";
import {
	DISCORD_MODE_MAX_MODELS,
	DISCORD_MODE_MAX_SHORTLIST,
	DISCORD_MODE_MAX_TEXT,
	type ModeModelChoice,
	type ModeSnapshot,
} from "@oh-my-pi/pi-wire/discord-mode";
import bridgePrompt from "../prompts/bridge.md" with { type: "text" };
import peerPrompt from "../prompts/peer.md" with { type: "text" };
import {
	BRIDGE_MESSAGE_SOURCE,
	BRIDGE_OWNER_MESSAGE_TYPE,
	BRIDGE_PEER_MESSAGE_TYPE,
	type BridgeConnection,
	type BridgeHost,
	type BridgeSettingResult,
} from "./host";
import type { HaisoServiceStarter } from "./service";
import { BridgeSession } from "./session";

export interface BridgeExtensionOptions {
	connect?: (root: string) => Promise<BridgeConnection>;
	receiptRoot?: string;
	pollIntervalMs?: number;
	startService?: HaisoServiceStarter;
	/** Whether the host is Haiso itself; defaults to its process title. */
	inHaiso?: boolean;
}

const TOOL_NAME = "bridge";
const USAGE = "/bridge on [label] | off | status | reconcile | repair";
const SUBCOMMANDS = [
	{ value: "on", description: "Share this conversation to Discord (optional channel label)" },
	{ value: "off", description: "Stop sharing this conversation, also when resumed" },
	{ value: "status", description: "Show whether this conversation is shared" },
	{ value: "repair", description: "Create or adopt a Discord destination" },
	{ value: "reconcile", description: "Resolve uncertain deliveries without replaying them" },
] as const;
/** Bare `/bridge` menu labels → subcommand, like Haiso's bare `/discord`. */
const MENU_OFF: Record<string, string> = {
	"Turn on — share this conversation to Discord": "on",
	Status: "status",
};
const MENU_ON: Record<string, string> = {
	Status: "status",
	"Turn off — stop sharing this conversation": "off",
	"Repair Discord destination": "repair",
	"Reconcile uncertain deliveries": "reconcile",
};

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

type BridgeModel = NonNullable<ExtensionContext["model"]>;

const selectorOf = (model: BridgeModel) => `${model.provider}/${model.id}`;

/** OMP's public thinking API: off plus the model's own levels (no `auto`); empty without an effort control. */
function effortLadder(model: BridgeModel): string[] {
	const efforts = model.reasoning ? (model.thinking?.efforts ?? []) : [];
	return efforts.length ? ["off", ...efforts] : [];
}

/** Authenticated models; older OMP builds lack `ctx.models`, so fall back to the registry. */
function availableModels(ctx: ExtensionContext): BridgeModel[] {
	return ctx.models?.list?.() ?? ctx.modelRegistry.getAvailable();
}

/** Dependencies are injectable for isolated transport fixtures; production uses the shared connector. */
export function installBridge(pi: ExtensionAPI, options: BridgeExtensionOptions = {}): void {
	// Haiso shares ~/.omp, so it loads this bridge too; its built-in Discord mode owns its conversations.
	if (options.inHaiso ?? process.title === "haiso") return;
	let latest: ExtensionContext | undefined;
	let observedIdentity: string | undefined;
	let session: BridgeSession | undefined;
	let epoch = 0;
	let dialogs = 0;
	let desiredTool = false;
	let toolUpdates = Promise.resolve();
	const approvals = new Set<string>();
	const asks = new Set<string>();
	/** Live run summary for the session card; allowlisted event fields only. */
	const progress = new DiscordProgressTracker();

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
		select: async (title, options) => (latest?.hasUI ? latest.ui.select(title, options) : undefined),
		schedule(callback, delayMs) {
			if (!latest) throw new Error("Bridge has no timer context.");
			const ctx = latest;
			const timer = ctx.setInterval(() => {
				ctx.clearTimer(timer);
				callback();
			}, delayMs);
			return () => ctx.clearTimer(timer);
		},
		settings() {
			const ctx = latest;
			const model = ctx?.model;
			if (!ctx || !model) return undefined;
			const available = availableModels(ctx);
			const roles = new Map<string, string>();
			const roleModels: BridgeModel[] = [];
			for (const role of ["default", "smol", "slow"]) {
				const resolved = ctx.models?.resolve?.(`@${role}`);
				if (!resolved) continue;
				roleModels.push(resolved);
				if (!roles.has(selectorOf(resolved))) roles.set(selectorOf(resolved), role);
			}
			const unique = (models: BridgeModel[], limit: number) => {
				const seen = new Set<string>();
				const result: ModeModelChoice[] = [];
				for (const item of models) {
					if (result.length === limit) break;
					const selector = selectorOf(item);
					if (seen.has(selector)) continue;
					seen.add(selector);
					const role = roles.get(selector);
					result.push({
						selector,
						name: item.name.trim() || item.id,
						...(role ? { role } : {}),
						efforts: effortLadder(item),
					});
				}
				return result;
			};
			const level = pi.getThinkingLevel();
			return {
				model: unique([model], 1)[0],
				...(level && effortLadder(model).length ? { effort: level === "inherit" ? "off" : level } : {}),
				// OMP's extension API has no persistent model roles, advisor, or plan-mode entry.
				capabilities: { persist: false, compact: true, advisor: false, plan: false },
				shortlist: unique([model, ...roleModels, ...available], DISCORD_MODE_MAX_SHORTLIST),
				models: unique(available, DISCORD_MODE_MAX_MODELS),
			};
		},
		usage() {
			const usage = latest?.getContextUsage();
			return usage
				? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent }
				: undefined;
		},
		async applySetting(command): Promise<BridgeSettingResult> {
			const ctx = latest;
			if (!ctx) return { outcome: "rejected", text: "Not applied: this OMP window has no active session." };
			switch (command.kind) {
				case "model": {
					const model = availableModels(ctx).find(item => selectorOf(item) === command.value);
					if (!model)
						return {
							outcome: "rejected",
							text: `Not applied: ${String(command.value)} is no longer available here.`,
						};
					const name = model.name.trim() || model.id;
					// Like the TUI's session switch: compact first when the transcript exceeds the target's window.
					const tokens = ctx.getContextUsage()?.tokens ?? 0;
					const window = model.contextWindow ?? 0;
					const compacted = window > 0 && tokens > window;
					if (compacted) await ctx.compact();
					if (!(await pi.setModel(model)))
						return {
							outcome: "rejected",
							text: `Not applied: no API key is configured for ${selectorOf(model)}.`,
						};
					return {
						outcome: "applied",
						text: `Model → ${name} (this session only)${compacted ? "; compacted first to fit its context window" : ""}.`,
					};
				}
				case "effort": {
					const level = String(command.value);
					if (!ctx.model || !effortLadder(ctx.model).includes(level))
						return { outcome: "rejected", text: `Not applied: this model doesn't support effort ${level}.` };
					pi.setThinkingLevel(level as ThinkingLevel);
					return { outcome: "applied", text: `Effort → ${pi.getThinkingLevel() ?? level}.` };
				}
				case "compact":
					await ctx.compact();
					return { outcome: "applied", text: "Context compacted." };
				default:
					return { outcome: "rejected", text: "Not applied: OMP sessions don't offer this setting." };
			}
		},
		progress: () => progress.current(),
	};

	function ensureSession(): BridgeSession {
		if (!session) {
			const flag = pi.getFlag("bridge-root");
			const root = path.resolve(
				typeof flag === "string" && flag
					? flag
					: process.env.HAISO_BRIDGE_ROOT || path.join(os.homedir(), ".omp", "agent", "discord-mode"),
			);
			session = new BridgeSession(host, { root, ...options });
		}
		return session;
	}

	/** Local interactive TUI only; RPC and print hosts never attach automatically. */
	function autoAttach(ctx: ExtensionContext): void {
		if (ctx.mode === "tui" && ctx.hasUI) void ensureSession().rejoin();
	}

	/** Lifecycle detach keeps the conversation shared; resuming it reattaches. */
	async function detach(): Promise<void> {
		epoch++;
		approvals.clear();
		asks.clear();
		progress.reset();
		if (session) await session.detach();
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
		description: "Share this conversation to Discord through Haiso (/bridge on); approvals stay local",
		getArgumentCompletions(prefix) {
			if (prefix.includes(" ")) return null;
			const items = SUBCOMMANDS.filter(item => item.value.startsWith(prefix)).map(item => ({
				value: item.value,
				label: item.value,
				description: item.description,
			}));
			return items.length ? items : null;
		},
		async handler(args, ctx) {
			await useContext(ctx);
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify("/bridge requires the local interactive OMP terminal.", "error");
				return;
			}
			const [typed = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			let action = typed;
			if (!action) {
				const menu = session?.enabled ? MENU_ON : MENU_OFF;
				const picked = await ctx.ui.select("Discord bridge", Object.keys(menu));
				if (!picked) return;
				action = menu[picked]!;
			}
			if (action !== "on" && rest.length) {
				ctx.ui.notify(USAGE, "error");
				return;
			}
			try {
				switch (action) {
					case "on": {
						epoch++;
						const bridge = ensureSession();
						const generation = epoch;
						const snapshot = await bridge.on(rest.join(" ") || undefined);
						if (generation !== epoch) return;
						ctx.ui.notify(describe(snapshot), "info");
						break;
					}
					case "off": {
						epoch++;
						approvals.clear();
						asks.clear();
						const bridge = ensureSession();
						// Not attached here, or its lease was already lost: record the off by identity instead.
						if (!(await bridge.off())) await bridge.disable();
						ctx.ui.notify(
							"Bridge is off; this conversation stays private, also when resumed, until /bridge on.",
							"info",
						);
						break;
					}
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

	// Native omptype schema (like the in-app discord tool); zod-compat schemas trip an
	// order-dependent variance check against registerTool's TSchema constraint in tsgo.
	const type = pi.arktype;
	const parameters = type({
		action: type("'peers' | 'send' | 'report'").describe(
			"List attached peers, send peer data, or publish an explicit report",
		),
		"recipientId?": type("string").describe("Exact peer ID from peers; required for send"),
		"text?": type("string").describe("Message or report text; required for send/report (maximum 12000 UTF-8 bytes)"),
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
		async execute(toolCallId, params: typeof parameters.infer, signal, _onUpdate, ctx) {
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
		autoAttach(ctx);
	});
	const onLifecycleChange = async (_event: unknown, ctx: ExtensionContext) => {
		latest = ctx;
		observedIdentity = identity(ctx);
		await detach();
	};
	const onSessionChange = async (event: unknown, ctx: ExtensionContext) => {
		await onLifecycleChange(event, ctx);
		autoAttach(ctx);
	};
	pi.on("session_switch", onSessionChange);
	pi.on("session_branch", onSessionChange);
	pi.on("session_tree", onSessionChange);
	pi.on("session_shutdown", onLifecycleChange);
	pi.on("message_start", async (event, ctx) => {
		await useContext(ctx);
		session?.onMessageStart(event.message);
	});
	pi.on("agent_start", async (event, ctx) => {
		await useContext(ctx);
		progress.observe(event, ctx.cwd);
	});
	pi.on("agent_end", async (event, ctx) => {
		await useContext(ctx);
		progress.observe(event, ctx.cwd);
		await session?.onAgentEnd(event);
	});
	const observeProgress = async (event: { type: string }, ctx: ExtensionContext) => {
		await useContext(ctx);
		progress.observe(event, ctx.cwd);
	};
	pi.on("auto_compaction_start", observeProgress);
	pi.on("auto_compaction_end", observeProgress);
	pi.on("auto_retry_start", observeProgress);
	pi.on("auto_retry_end", observeProgress);
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
		progress.observe(event, ctx.cwd);
	});
	pi.on("tool_execution_end", async (event, ctx) => {
		await useContext(ctx);
		asks.delete(event.toolCallId);
		approvals.delete(event.toolCallId);
		progress.observe(event, ctx.cwd);
	});
}

export default function bridgeExtension(pi: ExtensionAPI): void {
	installBridge(pi);
}
