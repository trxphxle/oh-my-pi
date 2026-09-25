import * as path from "node:path";
import { Container, Input, Spacer, Text } from "@oh-my-pi/pi-tui";
import { discordModePaths, loadDiscordModeConfig, saveDiscordModeConfig } from "../discord-mode/config";
import { ensureDiscordModeSession, getDiscordModeSession, type DiscordModeSession } from "../discord-mode/session";
import type { ModeSnapshot } from "@oh-my-pi/pi-wire/discord-mode";
import { describeDiscordMode, type DiscordModePresentation } from "../discord-mode/presentation";
import type { InteractiveModeContext } from "../modes/types";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { commandConsumed, errorMessage, parseSubcommand } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

function formatStatus(
	snapshot: ModeSnapshot,
	presentation: DiscordModePresentation = describeDiscordMode({ enabled: true, snapshot, transportAvailable: true }),
): string {
	return [
		presentation.title,
		presentation.destination ?? "",
		presentation.detail,
		`Session: ${snapshot.session.pendingInput ? "waiting for your answer" : snapshot.session.busy ? "working" : "idle"}`,
		`Peers: ${snapshot.peers.filter(peer => peer.connected && peer.enabled).length} connected in this project`,
		...snapshot.deliveries
			.filter(delivery => delivery.state === "unknown")
			.map(delivery => `Uncertain work: ${delivery.id} — inspect with /discord reconcile; do not resend.`),
	]
		.filter(Boolean)
		.join("\n");
}

/** Opening controls never enables sharing or waits on a network request. */
async function chooseDiscordAction(ctx: InteractiveModeContext, mode: DiscordModeSession): Promise<string | undefined> {
	const presentation = mode.presentation;
	const choices: Array<{ label: string; description: string; action: string }> = [];
	if (!mode.enabled) {
		let configured = false;
		try {
			await loadDiscordModeConfig();
			configured = true;
		} catch {}
		if (configured) {
			choices.push(
				{ label: "Turn on Discord", description: "Connect this session and choose its channel.", action: "on" },
				{
					label: "Bot settings",
					description: "Change the private credentials saved on this Mac.",
					action: "setup",
				},
			);
		} else {
			choices.push({
				label: "Set up Discord",
				description: "Add your bot and server. Sharing stays off until you turn it on.",
				action: "setup",
			});
		}
	} else {
		if (presentation.state === "repair") {
			choices.push({ label: "Repair Discord connection", description: presentation.detail, action: "repair" });
		} else if (presentation.state === "held") {
			choices.push({
				label: "Review uncertain work",
				description: "Inspect what happened before allowing more work.",
				action: "reconcile",
			});
		}
		choices.push({
			label: "Connection details",
			description: presentation.destination ?? presentation.detail,
			action: "status",
		});
		if (presentation.state === "connected") {
			choices.push({
				label: "Rename group or channel",
				description: "Change the names you see in Discord.",
				action: "rename",
			});
		}
		choices.push({
			label: "Turn off Discord",
			description:
				"Stop sharing this conversation, also when resumed later. Local work and channel history stay intact.",
			action: "off",
		});
	}
	const endDialog = mode.beginLocalDialog();
	try {
		const selected = await ctx.showHookSelector(presentation.title, choices);
		return choices.find(choice => choice.label === selected)?.action;
	} finally {
		endDialog();
	}
}

/** Suppress secret inspection as well as terminal rendering. Never mirror this local setup component. */
class SecretInput extends Input {
	override debugState(): Record<string, unknown> {
		return { masked: true };
	}
}

async function setup(ctx: InteractiveModeContext): Promise<void> {
	if (getDiscordModeSession(ctx.session)?.enabled) {
		ctx.showWarning(
			"Use /discord off before changing account settings. Other enrolled sessions must also opt out; setup never silently rebinds them.",
		);
		return;
	}
	const guildId = await ctx.showHookInput("Discord server (guild) ID");
	if (guildId === undefined) return;
	const ownerId = await ctx.showHookInput("Your Discord owner user ID");
	if (ownerId === undefined) return;
	if (!/^\d{17,20}$/.test(guildId.trim()) || !/^\d{17,20}$/.test(ownerId.trim()))
		throw new Error("Guild and owner IDs must be Discord snowflake IDs.");
	const botToken = await ctx.showHookCustom<string | undefined>((_tui, _theme, _keybindings, done) => {
		const input = new SecretInput();
		input.mask = true;
		input.onSubmit = value => {
			input.setValue("");
			done(value);
		};
		input.onEscape = () => {
			input.setValue("");
			done(undefined);
		};
		const container = new Container();
		container.addChild(new Text("Discord bot token — local masked input; never sent to the model", 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(input);
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => input.handleInput(data),
			get focused() {
				return input.focused;
			},
			set focused(value: boolean) {
				input.focused = value;
			},
			dispose: () => input.setValue(""),
		};
	});
	if (botToken === undefined) return;
	await saveDiscordModeConfig({ botToken: botToken.trim(), guildId: guildId.trim(), ownerId: ownerId.trim() });
	ctx.showStatus(
		"Discord OFF · SETUP SAVED\nCredentials are stored privately. Open /discord and choose Turn on Discord.",
		{ dim: false },
	);
}

export const BUILTIN_DISCORD_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "discord",
		icon: "broadcast",
		description: "Discord remote access and connection controls",
		getTuiAutocompleteDescription: ({ ctx }) =>
			getDiscordModeSession(ctx.session)?.presentation.title ?? "Discord OFF",
		allowArgs: true,
		inlineHint: "[status|on|off|setup|repair|reconcile|rename]",
		subcommands: [
			{ name: "on", description: "Turn on remote access for this session" },
			{ name: "status", description: "Show whether Discord is off, connected, or needs attention" },
			{
				name: "off",
				description: "Stop sharing this conversation, also when resumed; keep local work and channel history",
			},
			{ name: "repair", description: "Explicitly create or adopt a group/category or session channel" },
			{ name: "reconcile", description: "Inspect and explicitly resolve uncertain work without replaying it" },
			{ name: "rename", description: "Rename the group or session channel" },
			{ name: "setup", description: "Configure private bot credentials using local masked input" },
		],
		handle: async (_command, runtime) => {
			await runtime.output(
				"/discord enrollment and account setup require the current top-level interactive TUI. No session was enrolled.",
			);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			const parsed = parseSubcommand(command.args);
			let verb = parsed.verb;
			const rest = parsed.rest;
			ctx.editor.setText("");
			try {
				if (rest)
					throw new Error(
						"Discord settings and names are collected locally; do not pass tokens or other arguments in command text.",
					);
				if (ctx.collabGuest)
					throw new Error(
						"Discord enrollment is only available in the owning top-level TUI, not a collaboration guest.",
					);
				const mode = ensureDiscordModeSession(ctx);
				if (!verb) {
					verb = (await chooseDiscordAction(ctx, mode)) ?? "";
					if (!verb) return;
				}
				if (verb === "setup") {
					await setup(ctx);
					return;
				}
				if (verb === "status") {
					if (mode.enabled) {
						try {
							ctx.showStatus(formatStatus(await mode.status(), mode.presentation), { dim: false });
						} catch {
							ctx.showStatus(
								[mode.presentation.title, mode.presentation.destination, mode.presentation.detail]
									.filter(Boolean)
									.join("\n"),
								{ dim: false },
							);
						}
					} else {
						const { title, detail } = mode.presentation;
						ctx.showStatus(`${title}\n${detail}`, { dim: false });
					}
					return;
				}
				if (verb === "off") {
					await mode.off();
					ctx.showStatus(
						"Discord OFF\nThis conversation stays private, also when resumed, until /discord on. Local work and Discord history are unchanged.",
						{ dim: false },
					);
					return;
				}
				if (verb === "on") {
					if (mode?.enabled) {
						try {
							ctx.showStatus(formatStatus(await mode.status(), mode.presentation), { dim: false });
						} catch {
							throw new Error(
								"Discord connection may be unavailable or its lease revoked. Reconnect is automatic; if it stays disconnected, use /discord off, then /discord on. Unknown work is never replayed; inspect /discord reconcile after reconnecting.",
							);
						}
						return;
					}
					try {
						await loadDiscordModeConfig();
					} catch {
						throw new Error(
							`Discord is not configured. Use /discord setup for masked local entry, or create owner-only ${shortenPath(discordModePaths().configPath)} with botToken, guildId, ownerId (directory 0700, file 0600). Never paste the token into chat or command arguments.`,
						);
					}
					const session = ensureDiscordModeSession(ctx);
					const existing = await session.lookup();
					const defaultGroup = existing?.group.name ?? path.basename(ctx.sessionManager.getCwd());
					const groupName =
						existing?.group.name ?? (await ctx.showHookEditor("Name this Discord project group", defaultGroup));
					if (groupName === undefined) return;
					const label =
						existing?.session?.label ??
						(await ctx.showHookEditor(
							"Name this session's Discord channel",
							ctx.sessionName ||
								`${path.basename(ctx.sessionManager.getCwd())} ${ctx.sessionManager.getSessionId().slice(0, 8)}`,
						));
					if (label === undefined) return;
					const snapshot = await session.on(groupName.trim(), label.trim());
					ctx.showStatus(
						[
							formatStatus(snapshot, session.presentation),
							...(existing
								? [
										"Held messages stay held. /discord repair offers explicit resumption; uncertain work requires /discord reconcile.",
									]
								: []),
							...(snapshot.session.state !== "ready" || snapshot.group.state !== "ready"
								? [
										"Retained binding needs /discord repair. Deleted or moved resources are never silently recreated.",
									]
								: []),
						].join("\n"),
						{ dim: false },
					);
					return;
				}
				if (verb === "reconcile") {
					if (!mode?.enabled) throw new Error("Use /discord on before inspecting uncertain work.");
					const snapshot = await mode.status();
					const unknown = snapshot.deliveries.filter(delivery => delivery.state === "unknown");
					if (!unknown.length) {
						ctx.showStatus("No uncertain deliveries need owner reconciliation.");
						return;
					}
					const selected = await ctx.showHookSelector(
						"Inspect an uncertain Discord delivery",
						unknown.map(delivery => ({
							label: delivery.id,
							description: `${delivery.source}/${delivery.kind} from ${delivery.from} at ${new Date(delivery.createdAt).toISOString()}`,
						})),
					);
					const delivery = unknown.find(item => item.id === selected);
					if (!delivery) return;
					const inspected = await ctx.showHookEditor(
						"Inspect original uncertain delivery; submit to continue (edits are NOT sent)",
						`Original delivery ${delivery.id}\nTarget session: ${delivery.sessionId}\nFrom: ${delivery.from}\nCreated: ${new Date(delivery.createdAt).toISOString()}\n\n${delivery.text}`,
					);
					if (inspected === undefined) return;
					const answer = await ctx.showHookSelector("Reconciliation does NOT rerun work or mark it successful", [
						"Keep this uncertainty fence",
						"I inspected this operation; clear its uncertainty fence without rerunning it",
					]);
					if (answer !== "I inspected this operation; clear its uncertainty fence without rerunning it") return;
					await mode.resolveDelivery(delivery.id);
					ctx.showStatus(
						"Uncertainty fence resolved by owner; no operation replayed and no success claimed. Use /discord repair to explicitly resume remaining queued work.",
					);
					return;
				}
				if (verb !== "repair" && verb !== "rename")
					throw new Error("Usage: /discord [on|status|off|repair|reconcile|rename|setup]");
				if (!mode?.enabled) throw new Error("Use /discord on before managing this session's Discord binding.");
				const targetChoice = await ctx.showHookSelector(
					`${verb === "repair" ? "Repair" : "Rename"} which Discord resource?`,
					["Session channel", "Project group"],
				);
				if (!targetChoice) return;
				const target = targetChoice === "Project group" ? "group" : "session";
				if (verb === "rename") {
					const snapshot = await mode.status();
					const name = await ctx.showHookEditor(
						"New Discord name",
						target === "group" ? snapshot.group.name : snapshot.session.label,
					);
					if (name === undefined) return;
					ctx.showStatus(formatStatus(await mode.rename(target, name.trim())));
					return;
				}
				const action = await ctx.showHookSelector("Explicit Discord repair (history is retained)", [
					"Create a new resource",
					"Adopt an existing resource ID",
					"Reconcile retained binding only",
				]);
				if (!action) return;
				let destinationId: string | undefined;
				if (action === "Adopt an existing resource ID") {
					const value = await ctx.showHookInput(
						target === "group" ? "Existing category ID" : "Existing text channel ID",
					);
					if (value === undefined) return;
					destinationId = value.trim();
					if (!/^\d{17,20}$/.test(destinationId)) throw new Error("Invalid Discord resource ID.");
				} else if (action === "Reconcile retained binding only") {
					const snapshot = await mode.status();
					destinationId = target === "group" ? snapshot.group.categoryId : snapshot.session.channelId;
					if (!destinationId)
						throw new Error("No retained resource ID; explicitly create or adopt a resource instead.");
				}
				const queued = await ctx.showHookSelector("Held queued messages", [
					"Keep queued messages held",
					"Explicitly resume queued messages",
				]);
				if (!queued) return;
				ctx.showStatus(
					formatStatus(await mode.repair(target, destinationId, queued === "Explicitly resume queued messages")),
				);
			} catch (error) {
				ctx.showError(errorMessage(error));
			}
		},
	},
];
