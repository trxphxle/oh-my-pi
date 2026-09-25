// Routing, durable publication, and native-dialog presentation adapted from
// omp-discord-bridge (Copyright (c) 2026 treearc, MIT License).
import { createHash } from "node:crypto";
import {
	type APIEmbed,
	ActionRowBuilder,
	ApplicationCommandOptionType,
	ApplicationCommandType,
	AttachmentBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	type ChatInputCommandInteraction,
	Client,
	type ClientEvents,
	Colors,
	Events,
	GatewayIntentBits,
	type Guild,
	type GuildBasedChannel,
	type GuildChannel,
	type Interaction,
	Options,
	type Message,
	type MessageCreateOptions,
	MessageFlags,
	ModalBuilder,
	type OverwriteResolvable,
	OverwriteType,
	Partials,
	PermissionFlagsBits,
	SlashCommandBuilder,
	StringSelectMenuBuilder,
	TextInputBuilder,
	TextInputStyle,
	type TextChannel,
} from "discord.js";
import { formatNumber } from "@oh-my-pi/pi-utils/format";
import { DiscordModeError } from "./broker";
import type { DiscordGuideCommand } from "./guide";
import { discordCategoryName, discordChannelName, sessionLabel } from "./names";
import { describeSettingCommand, settingsChoiceToken } from "./settings-view";
import {
	DISCORD_MODE_MAX_REPLY,
	DISCORD_MODE_MAX_TEXT,
	type ChannelInspection,
	type DiscordModeConfig,
	type DiscordPort,
	type DiscordPortHandlers,
	type ModeApp,
	type ModeControlRequest,
	type ModeControlResult,
	type ModeDialog,
	type ModeGuidePlacement,
	type ModeNoticeAction,
	type ModeNotify,
	type ModeOwnerMessage,
	type ModeRetirementPolicy,
	type ModeSettingsPanel,
	type RemoteChannel,
} from "@oh-my-pi/pi-wire/discord-mode";

const MENTIONS = { parse: [] as never[], repliedUser: false };
const PREFIX = "haiso:";
const SESSION_PREFIX = `${PREFIX}s:`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HISTORY_LIMIT = 1_000;
/** Missed-message catch-up scans at most this many 100-message pages per channel. */
const CATCH_UP_PAGES = 5;
/** Guide lookup reads the pins of at most this many text channels (`general` first). */
const GUIDE_SCAN_LIMIT = 25;
const EFFECT_LIMIT = 4_096;
const CARD_LIMIT = 256;
const DIALOG_LIMIT = 256;
const PENDING_SEND_LIMIT = 32;
const SEND_CONFIRMATION_MS = 1_500;
const REPLY_PREVIEW = 1_800;
/** Interaction tokens last 15 minutes; follow-ups stop a minute early and fall back to a channel note. */
const SETTINGS_TOKEN_MS = 14 * 60_000;
const PENDING_SETTINGS_LIMIT = 64;
/** Settings panel controls; the card's own `settings` button opens the panel like any other session control. */
const SETTINGS_ACTIONS: Record<string, true> = {
	refresh: true,
	search: true,
	"search-q": true,
	"set-model": true,
	"set-effort": true,
	"set-advisor": true,
	"advisor-on": true,
	"advisor-off": true,
	plan: true,
	compact: true,
	default: true,
};
const SESSION_CONTROL = new RegExp(
	`^haiso:s:(\\d{1,22}):([a-f0-9-]{36}):([A-Za-z0-9_-]{22})?:(status|stop|queue|steer|cancel|queue0|queue1|settings|discard|release|send-held|discard-held|review|review0|review1|${Object.keys(SETTINGS_ACTIONS).join("|")})$`,
	"i",
);
/**
 * Channel forms and launches: [Resume] on a closed card (`r:…:resume`), the resume picker (`r:…:pick`), the new form
 * (`n:…:new`), and the rename form (`m:…:rename`).
 */
const LAUNCH_CONTROL = /^haiso:([rnm]):(\d{1,22}):(resume|pick|new|rename)$/;
const READ_PERMISSIONS = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory;
const WRITE_PERMISSIONS = READ_PERMISSIONS | PermissionFlagsBits.SendMessages;
const BOT_PERMISSIONS = WRITE_PERMISSIONS | PermissionFlagsBits.AttachFiles | PermissionFlagsBits.EmbedLinks;
/** Small colored session-card embed; overview cards carry none. */
const APP_EMBEDS: Record<ModeApp, APIEmbed> = {
	haiso: { color: Colors.Purple, description: "🟣 Haiso session" },
	omp: { color: Colors.Blue, description: "🔵 OMP session" },
};

type ManagedChannel = Extract<GuildBasedChannel, { type: ChannelType.GuildText | ChannelType.GuildCategory }>;
type ReplyInteraction = Extract<Interaction, { reply: unknown }>;
type ControlRows = Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>>;
type ControlPayload = Pick<MessageCreateOptions, "content" | "files" | "allowedMentions"> & {
	components: ControlRows;
	attachments: [];
};
/** What a launch control asks the broker for: resume one conversation, or start a new one. */
type LaunchRequest = Pick<ModeControlRequest, "action" | "sessionId" | "name" | "message" | "model">;

interface Card {
	id?: string;
	/** A send was attempted without authoritative confirmation. */
	uncertain: boolean;
	legacy: boolean;
	chain: Promise<string | undefined>;
	queued: number;
}

interface Dialog {
	channelId: string;
	request: ModeDialog;
	message?: Message;
	consumed: boolean;
}

interface PendingSend {
	channelId: string;
	botId: string;
	confirmation: Promise<Message | undefined>;
	resolve: (message: Message | undefined) => void;
	timer?: Timer;
}

/** A queued settings change whose confirmation goes back to the panel interaction that queued it. */
interface PendingSettingReply {
	interaction: ReplyInteraction;
	channelId: string;
	connectionId: string;
	at: number;
}

/** Constructor-only seam: never read endpoint overrides from mode configuration. */
export interface DiscordAdapterDependencies {
	client?: Client;
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function apiCode(error: unknown): number | undefined {
	return error !== null && typeof error === "object" && "code" in error && typeof error.code === "number"
		? error.code
		: undefined;
}

function chunks(text: string): string[] {
	const result: string[] = [];
	for (let offset = 0; offset < text.length;) {
		let end = Math.min(offset + 2_000, text.length);
		if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
		result.push(text.slice(offset, end));
		offset = end;
	}
	return result;
}

/** One-message reply: short text inline; long text as a line-aligned preview plus the full attachment. `reserve` leaves room for a mention prefix. */
function replyPayload(text: string, reserve = 0): Pick<MessageCreateOptions, "content" | "files"> {
	if (text.length <= 2_000 - reserve) return { content: text };
	const lineEnd = text.lastIndexOf("\n", REPLY_PREVIEW);
	const aligned = lineEnd >= REPLY_PREVIEW / 2;
	let end = aligned ? lineEnd : REPLY_PREVIEW;
	if (/[\uDC00-\uDFFF]/.test(text[end]!)) end--;
	let preview = text.slice(0, end).trimEnd();
	if (!aligned) preview += "…";
	// An unbalanced fence would swallow the attachment note into a code block.
	if ((preview.match(/```/g)?.length ?? 0) % 2 === 1) preview += "\n```";
	const size = Math.ceil(Buffer.byteLength(text) / 1024);
	return {
		content: `${preview}\n\n… full reply attached (${size} KB)`,
		files: [new AttachmentBuilder(Buffer.from(text, "utf8"), { name: "haiso-reply.md" })],
	};
}

/** The guild `/session` command; also the source of the pinned guide's command list. */
export function sessionCommandDefinition() {
	return new SlashCommandBuilder()
		.setName("session")
		.setDescription("Inspect and control Haiso sessions in this project")
		.setDefaultMemberPermissions(null)
		.setNSFW(false)
		.addSubcommand(command => command.setName("status").setDescription("Show the bound session's current state"))
		.addSubcommand(command => command.setName("stop").setDescription("Request a stop of the current turn"))
		.addSubcommand(command => command.setName("queue").setDescription("Inspect queued owner messages"))
		.addSubcommand(command =>
			command
				.setName("notify")
				.setDescription("Choose when Haiso mentions you in this session's channel")
				.addStringOption(option =>
					option
						.setName("mode")
						.setDescription("When to mention you")
						.setRequired(true)
						.addChoices(
							{ name: "all — input requests and every final reply", value: "all" },
							{ name: "needs-you — input requests and replies after long turns", value: "needs-you" },
							{ name: "off — never mention", value: "off" },
						),
				),
		)
		.addSubcommand(command =>
			command.setName("settings").setDescription("View and change the session's model, effort, and context"),
		)
		.addSubcommand(command =>
			command.setName("resume").setDescription("Resume a closed conversation of this project in the background"),
		)
		.addSubcommand(command =>
			command.setName("new").setDescription("Start a new conversation in this project, in the background"),
		)
		.addSubcommand(command =>
			command.setName("close").setDescription("Close this session's background copy after its current turn"),
		)
		.addSubcommand(command => command.setName("rename").setDescription("Rename this channel"))
		.toJSON();
}

/** `/session` subcommands as the guide lists them: name, choice values, description. */
export function sessionCommandGuide(): DiscordGuideCommand[] {
	return (sessionCommandDefinition().options ?? []).flatMap(option =>
		option.type === ApplicationCommandOptionType.Subcommand
			? [
					{
						name: option.name,
						description: option.description,
						choices: (option.options ?? []).flatMap(argument =>
							argument.type === ApplicationCommandOptionType.String && argument.choices
								? argument.choices.map(choice => String(choice.value))
								: [],
						),
					},
				]
			: [],
	);
}

/** A single gateway client; native sessions and durable routing remain in the broker. */
export class DiscordAdapter implements DiscordPort {
	readonly #config: DiscordModeConfig;
	readonly #client: Client;
	readonly #removeListeners: Array<() => void> = [];
	readonly #effects = new Map<string, Promise<void>>();
	readonly #completed: string[] = [];
	readonly #cards = new Map<string, Card>();
	readonly #dialogs = new Map<string, Dialog>();
	readonly #pendingSends = new Map<string, PendingSend>();
	readonly #pendingSettings = new Map<string, PendingSettingReply>();
	#handlers?: DiscordPortHandlers;
	#guild?: Guild;
	#sessionCommandId?: string;
	#starting?: Promise<void>;
	#closed = false;
	#connected = false;
	#connectionVersion = 0;
	#changeTimer?: Timer;
	#changing = false;
	#dirty = false;
	#inbound = 0;
	#refreshing?: Promise<void>;
	#refreshAgain = false;

	constructor(config: DiscordModeConfig, dependencies: DiscordAdapterDependencies = {}) {
		this.#config = { ...config };
		this.#client =
			dependencies.client ??
			new Client({
				intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
				allowedMentions: MENTIONS,
				enforceNonce: true,
				// discord.js otherwise retries timeouts and 5xx, including non-idempotent POSTs.
				rest: { retries: 0, timeout: 15_000 },
				makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 0 }),
			});
		// Managed messages are deliberately uncached; deletion must still reach reconciliation.
		if (!this.#client.options.partials?.includes(Partials.Message)) {
			this.#client.options.partials = [...(this.#client.options.partials ?? []), Partials.Message];
		}
		if (this.#client.rest.options.retries !== 0) {
			throw new Error("Discord transport requires REST retries=0 to fence uncertain mutations.");
		}
	}

	start(handlers: DiscordPortHandlers): Promise<void> {
		if (this.#closed) return Promise.reject(new Error("Discord transport is closed."));
		if (this.#starting) return this.#starting;
		this.#handlers = handlers;
		this.#listen(Events.MessageCreate, message => {
			this.#confirmSend(message);
			this.#dispatch(() => this.#ownerMessage(message));
		});
		this.#listen(Events.InteractionCreate, interaction => this.#dispatch(() => this.#interaction(interaction)));
		this.#listen(Events.ChannelCreate, channel => this.#channelChanged(channel));
		this.#listen(Events.ChannelDelete, channel => this.#channelChanged(channel));
		this.#listen(Events.ChannelUpdate, (_old, channel) => this.#channelChanged(channel));
		this.#listen(Events.GuildRoleCreate, role => this.#guildChanged(role.guild.id));
		this.#listen(Events.GuildRoleDelete, role => this.#guildChanged(role.guild.id));
		this.#listen(Events.GuildRoleUpdate, (_old, role) => this.#guildChanged(role.guild.id));
		this.#listen(Events.GuildMemberUpdate, (_old, member) => {
			if (member.id === this.#client.user?.id || member.id === this.#config.ownerId)
				this.#guildChanged(member.guild.id);
		});
		this.#listen(Events.GuildUpdate, (_old, guild) => this.#guildChanged(guild.id));
		this.#listen(Events.GuildUnavailable, guild => this.#unavailable(guild.id));
		this.#listen(Events.GuildDelete, guild => this.#unavailable(guild.id));
		this.#listen(Events.GuildAvailable, guild => this.#guildChanged(guild.id));
		this.#listen(Events.ShardDisconnect, () => this.#setConnected(false));
		this.#listen(Events.ShardReconnecting, () => this.#setConnected(false));
		this.#listen(Events.ShardResume, () => this.#refresh());
		this.#listen(Events.ClientReady, () => this.#refresh());
		// Never log gateway errors: SDK errors can retain authenticated request details.
		this.#listen(Events.Error, () => this.#setConnected(false));
		this.#listen(Events.ShardError, () => this.#setConnected(false));
		this.#listen(Events.MessageDelete, message => {
			for (const card of this.#cards.values()) {
				if (card.id === message.id) {
					card.id = undefined;
					card.uncertain = false;
					this.#scheduleChanged();
				}
			}
		});
		this.#starting = this.#start();
		return this.#starting;
	}

	async #start(): Promise<void> {
		const readiness = Promise.withResolvers<void>();
		const ready = readiness.promise;
		const listener = () => readiness.resolve();
		this.#client.once(Events.ClientReady, listener);
		const removeReady = () => this.#client.off(Events.ClientReady, listener);
		const readyTimer = setTimeout(() => readiness.reject(new Error("Discord gateway readiness timed out.")), 30_000);
		// Observe readiness rejection even when login rejects before the ready event.
		void ready.catch(() => {});
		try {
			if (!this.#client.isReady()) {
				await Promise.all([this.#client.login(this.#config.botToken), ready]);
			}
			await this.#verifyGuild();
			await this.#reconcileCommands();
			this.#setConnected(true);
			this.#scheduleChanged();
		} catch {
			await this.close();
			throw new Error(
				"Discord startup failed: verify bot credentials, privileged Message Content intent, guild access, and owner membership.",
			);
		} finally {
			clearTimeout(readyTimer);
			removeReady();
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		clearTimeout(this.#changeTimer);
		this.#changeTimer = undefined;
		for (const remove of this.#removeListeners) remove();
		this.#removeListeners.length = 0;
		for (const pending of this.#pendingSends.values()) {
			clearTimeout(pending.timer);
			pending.resolve(undefined);
		}
		this.#pendingSends.clear();
		this.#setConnected(false);
		await this.#client.destroy();
		this.#guild = undefined;
		this.#dialogs.clear();
		this.#cards.clear();
		this.#effects.clear();
		this.#completed.length = 0;
		this.#handlers = undefined;
	}

	#listen<K extends keyof ClientEvents>(event: K, listener: (...args: ClientEvents[K]) => void): void {
		this.#client.on(event, listener);
		this.#removeListeners.push(() => this.#client.off(event, listener));
	}

	#setConnected(connected: boolean): void {
		if (!connected) {
			this.#connectionVersion++;
			this.#refreshAgain = false;
		}
		if (this.#closed && connected) return;
		if (this.#connected === connected) return;
		this.#connected = connected;
		this.#handlers?.connection(connected);
	}

	async #verifyGuild(version = this.#connectionVersion): Promise<void> {
		if (!this.#client.user?.bot || !this.#client.isReady()) throw new Error("Discord bot is not ready.");
		const guild = await this.#client.guilds.fetch(this.#config.guildId);
		const [bot, owner] = await Promise.all([
			guild.members.fetchMe({ force: true }),
			guild.members.fetch({ user: this.#config.ownerId, force: true }),
		]);
		if (owner.user.bot || bot.id === owner.id || !guild.available)
			throw new Error("Discord owner or guild is unavailable.");
		await guild.roles.fetch();
		if (this.#closed || version !== this.#connectionVersion)
			throw new Error("Discord connection changed during verification.");
		this.#guild = guild;
	}

	async #reconcileCommands(): Promise<void> {
		const guild = this.#guild;
		const application = this.#client.application;
		if (!guild || !application) throw new Error("Discord command registry is unavailable.");
		// Inspect both scopes before any mutation. Managers are scoped to this application,
		// and explicit ownership/type checks preserve unrelated and context-menu commands.
		const [guildCommands, globalCommands] = await Promise.all([guild.commands.fetch(), application.commands.fetch()]);
		const owned = (command: { applicationId: string; type: ApplicationCommandType }) =>
			command.applicationId === application.id && command.type === ApplicationCommandType.ChatInput;
		for (const command of globalCommands.values()) {
			if (owned(command) && ["omp", "team", "tell", "session"].includes(command.name))
				await application.commands.delete(command.id);
		}
		for (const command of guildCommands.values()) {
			if (owned(command) && ["omp", "team", "tell"].includes(command.name)) await guild.commands.delete(command.id);
		}
		const definition = sessionCommandDefinition();
		const current = guildCommands.find(command => owned(command) && command.name === "session");
		const registered = current
			? current.equals({
					...definition,
					type: ApplicationCommandType.ChatInput,
					default_member_permissions: definition.default_member_permissions ?? null,
					id: current.id,
					application_id: application.id,
					version: current.version,
				})
				? current
				: await guild.commands.edit(current.id, definition)
			: await guild.commands.create(definition);
		this.#sessionCommandId = registered.id;
	}

	#refresh(): void {
		if (this.#closed) return;
		if (this.#refreshing) {
			this.#refreshAgain = true;
			return;
		}
		const version = this.#connectionVersion;
		this.#refreshing = this.#verifyGuild(version)
			.then(
				() => {
					if (version !== this.#connectionVersion) return;
					this.#setConnected(true);
					this.#scheduleChanged();
				},
				() => {
					if (version === this.#connectionVersion) this.#setConnected(false);
				},
			)
			.finally(() => {
				this.#refreshing = undefined;
				if (this.#refreshAgain) {
					this.#refreshAgain = false;
					this.#refresh();
				}
			});
	}

	#unavailable(id: string): void {
		if (id !== this.#config.guildId) return;
		this.#setConnected(false);
		this.#scheduleChanged();
	}

	#guildChanged(id: string): void {
		if (id === this.#config.guildId) this.#refresh();
	}

	#channelChanged(channel: { id: string; guildId?: string }): void {
		if (channel.guildId === this.#config.guildId) this.#scheduleChanged();
	}

	#scheduleChanged(): void {
		if (this.#closed) return;
		this.#dirty = true;
		if (this.#changeTimer || this.#changing) return;
		this.#changeTimer = setTimeout(() => {
			this.#changeTimer = undefined;
			this.#dirty = false;
			this.#changing = true;
			void this.#handlers
				?.changed()
				.catch(() => {})
				.finally(() => {
					this.#changing = false;
					if (this.#dirty) this.#scheduleChanged();
				});
		}, 150);
	}

	#dispatch(action: () => Promise<void>): void {
		if (this.#closed || this.#inbound >= 32) return;
		this.#inbound++;
		void action()
			.catch(() => {})
			.finally(() => {
				this.#inbound--;
			});
	}

	#requireGuild(): Guild {
		if (this.#closed || !this.#connected || !this.#guild)
			throw new Error("Discord is offline; no mutation was attempted.");
		return this.#guild;
	}

	#botId(): string {
		const id = this.#client.user?.id;
		if (!id) throw new Error("Discord bot is not ready.");
		return id;
	}

	#overwrites(): OverwriteResolvable[] {
		return [
			{ id: this.#config.guildId, type: OverwriteType.Role, deny: PermissionFlagsBits.ViewChannel },
			{
				id: this.#config.ownerId,
				type: OverwriteType.Member,
				allow: WRITE_PERMISSIONS | PermissionFlagsBits.AttachFiles,
			},
			{ id: this.#botId(), type: OverwriteType.Member, allow: BOT_PERMISSIONS | PermissionFlagsBits.ManageChannels },
		];
	}

	#private(channel: ManagedChannel): boolean {
		const overwrites = channel.permissionOverwrites.cache;
		const everyone = overwrites.get(this.#config.guildId);
		const owner = overwrites.get(this.#config.ownerId);
		const bot = overwrites.get(this.#botId());
		if (
			!everyone ||
			everyone.type !== OverwriteType.Role ||
			!everyone.deny.has(PermissionFlagsBits.ViewChannel, false) ||
			everyone.allow.has(PermissionFlagsBits.ViewChannel, false)
		)
			return false;
		if (
			!owner ||
			owner.type !== OverwriteType.Member ||
			!owner.allow.has(WRITE_PERMISSIONS, false) ||
			owner.deny.any(WRITE_PERMISSIONS, false)
		)
			return false;
		if (
			!bot ||
			bot.type !== OverwriteType.Member ||
			!bot.allow.has(BOT_PERMISSIONS, false) ||
			bot.deny.any(BOT_PERMISSIONS, false)
		)
			return false;
		for (const overwrite of overwrites.values()) {
			if (
				overwrite.id !== this.#config.ownerId &&
				overwrite.id !== this.#botId() &&
				overwrite.allow.has(PermissionFlagsBits.ViewChannel, false)
			)
				return false;
		}
		return Boolean(
			channel.permissionsFor(this.#botId())?.has(BOT_PERMISSIONS) &&
			channel.permissionsFor(this.#config.ownerId)?.has(WRITE_PERMISSIONS),
		);
	}

	#remote(channel: ManagedChannel): RemoteChannel {
		return {
			id: channel.id,
			name: channel.name.replace(/[\p{Cc}\p{Cf}]/gu, ""),
			kind: channel.type === ChannelType.GuildCategory ? "category" : "text",
			parentId: channel.parentId ?? undefined,
			topic:
				channel.type === ChannelType.GuildText ? (channel.topic ?? "").replace(/[\p{Cc}\p{Cf}]/gu, "") : undefined,
			private: this.#private(channel),
		};
	}

	async inspect(id: string): Promise<ChannelInspection> {
		const guild = this.#requireGuild();
		try {
			const channel = await guild.channels.fetch(id, { force: true });
			if (!channel) return { state: "missing" };
			if (
				channel.guildId !== this.#config.guildId ||
				(channel.type !== ChannelType.GuildCategory && channel.type !== ChannelType.GuildText)
			)
				return { state: "inaccessible" };
			if (!channel.permissionsFor(this.#botId())?.has(READ_PERMISSIONS)) return { state: "inaccessible" };
			return { state: "found", channel: this.#remote(channel) };
		} catch (error) {
			if (apiCode(error) === 10003) return { state: "missing" };
			if (apiCode(error) === 50001 || apiCode(error) === 50013) return { state: "inaccessible" };
			throw new Error("Discord channel inspection failed temporarily; deletion is not confirmed.");
		}
	}

	async #channel(id: string): Promise<ManagedChannel> {
		const channel = await this.#requireGuild().channels.fetch(id, { force: true });
		if (
			!channel ||
			channel.guildId !== this.#config.guildId ||
			(channel.type !== ChannelType.GuildCategory && channel.type !== ChannelType.GuildText)
		)
			throw new Error("Discord channel is unavailable in the configured guild.");
		if (!this.#private(channel))
			throw new Error(
				"Discord channel is not explicitly owner/bot-private; repair its permissions before continuing.",
			);
		return channel;
	}

	async #textChannel(id: string): Promise<TextChannel> {
		const channel = await this.#channel(id);
		if (channel.type !== ChannelType.GuildText)
			throw new Error("Discord destination must be a private text channel.");
		return channel;
	}

	#requireManage(channel: GuildChannel): void {
		this.#requireGuild();
		if (!channel.permissionsFor(this.#botId())?.has(PermissionFlagsBits.ManageChannels))
			throw new Error("Discord bot needs Manage Channels on this resource for this operation.");
	}

	async createCategory(name: string): Promise<RemoteChannel> {
		const guild = this.#requireGuild();
		const normalized = discordCategoryName(name);
		const bot = await guild.members.fetchMe({ force: true });
		if (!bot.permissions.has(PermissionFlagsBits.ManageChannels))
			throw new Error("Creating a project category requires guild Manage Channels permission.");
		const channel = await this.#requireGuild().channels.create({
			name: normalized,
			type: ChannelType.GuildCategory,
			permissionOverwrites: this.#overwrites(),
			reason: "Owner-enabled Haiso project",
		});
		return this.#remote(channel);
	}

	async createChannel(categoryId: string, name: string, marker: string): Promise<RemoteChannel> {
		const normalized = discordChannelName(name);
		if (!marker || marker.length > 1_024 || /[\p{Cc}\p{Cf}]/u.test(marker))
			throw new Error("Discord channel ownership marker is invalid.");
		const category = await this.#channel(categoryId);
		if (category.type !== ChannelType.GuildCategory)
			throw new Error("Discord parent must be a private project category.");
		this.#requireManage(category);
		const channel = await this.#requireGuild().channels.create({
			name: normalized,
			type: ChannelType.GuildText,
			parent: categoryId,
			topic: marker,
			permissionOverwrites: this.#overwrites(),
			reason: "Owner-enabled Haiso session",
		});
		return this.#remote(channel);
	}

	async rename(id: string, name: string): Promise<void> {
		const channel = await this.#channel(id);
		const normalized =
			channel.type === ChannelType.GuildCategory ? discordCategoryName(name) : discordChannelName(name);
		this.#requireManage(channel);
		await channel.setName(normalized, "Haiso owner rename");
	}

	async move(id: string, categoryId: string): Promise<void> {
		const channel = await this.#channel(id);
		const category = await this.#channel(categoryId);
		if (channel.type !== ChannelType.GuildText || category.type !== ChannelType.GuildCategory)
			throw new Error("Move requires a text channel and a private category.");
		this.#requireManage(channel);
		this.#requireManage(category);
		await channel.setParent(categoryId, { lockPermissions: false, reason: "Haiso explicit owner repair" });
	}

	async arrange(categoryId: string, channelIds: string[]): Promise<void> {
		const guild = this.#requireGuild();
		const category = guild.channels.cache.get(categoryId);
		if (category?.type !== ChannelType.GuildCategory)
			throw new Error("Discord arrangement requires a cached project category.");
		// Gateway-maintained cache: an already ordered category costs no request and emits no ChannelUpdate.
		const wanted = channelIds.flatMap(id => {
			const channel = guild.channels.cache.get(id);
			return channel?.type === ChannelType.GuildText && channel.parentId === categoryId ? [channel] : [];
		});
		const current = wanted.toSorted(
			(a, b) => a.rawPosition - b.rawPosition || (BigInt(a.id) < BigInt(b.id) ? -1 : 1),
		);
		if (current.every((channel, index) => channel === wanted[index])) return;
		this.#requireManage(category);
		// One bulk PATCH listing only owned channels; permissions are never synced with the category.
		await guild.channels.setPositions(wanted.map((channel, position) => ({ channel, position })));
	}

	/** Fetch afresh: null/access failures never authorize treating a channel as deleted. */
	async #retirementChannel(id: string, marker: string, closedTopic: string): Promise<TextChannel | undefined> {
		const guild = this.#requireGuild();
		let channel: GuildBasedChannel | null;
		try {
			channel = await guild.channels.fetch(id, { force: true });
		} catch (error) {
			if (apiCode(error) === 10003) return undefined;
			throw new Error("Discord retirement inspection failed; channel deletion is not confirmed.");
		}
		if (
			!channel ||
			channel.id !== id ||
			channel.guildId !== this.#config.guildId ||
			channel.type !== ChannelType.GuildText
		)
			throw new Error("Discord retirement requires the exact bound text channel in the configured guild.");
		if (!this.#private(channel))
			throw new Error("Discord retirement requires an explicitly owner/bot-private channel.");
		if (channel.topic !== marker && channel.topic !== closedTopic)
			throw new Error("Discord retirement refused: channel ownership does not match the deleted native session.");
		this.#requireManage(channel);
		return channel;
	}

	async retire(channelId: string, sessionId: string, policy: ModeRetirementPolicy): Promise<void> {
		if (!/^\d{1,22}$/.test(channelId) || !UUID.test(sessionId) || (policy !== "retain" && policy !== "delete"))
			throw new Error("Discord retirement identity or policy is invalid.");
		const marker = `haiso:session:${sessionId}`;
		const topic = `${marker} — Closed: native conversation permanently deleted.`;
		const channel = await this.#retirementChannel(channelId, marker, topic);
		if (!channel) return;
		const name = channel.name.startsWith("archived-") ? channel.name : `archived-${channel.name}`.slice(0, 100);
		if (policy === "retain" && channel.name === name && channel.topic === topic) return;
		try {
			if (policy === "delete") await channel.delete("Haiso owner-approved permanent conversation deletion");
			else
				await channel.edit({
					name,
					topic,
					reason: "Haiso native conversation permanently deleted; history retained",
				});
		} catch {
			// PATCH/DELETE may have succeeded before the response was lost. Inspect only
			// this identity; never replay an uncertain mutation in this attempt.
			const current = await this.#retirementChannel(channelId, marker, topic);
			if (!current || (policy === "retain" && current.name === name && current.topic === topic)) return;
			throw new Error("Discord retirement outcome is uncertain; the exact channel needs reconciliation.");
		}
	}

	/** Legacy migration only: new posts never carry ownership footers. */
	async #findMessages(channel: TextChannel, markers: Set<string>): Promise<Map<string, Message>> {
		const found = new Map<string, Message>();
		let before: string | undefined;
		for (let scanned = 0; scanned < HISTORY_LIMIT; scanned += 100) {
			const page = await channel.messages.fetch({ limit: 100, before, cache: false });
			for (const message of page.values()) {
				if (message.channelId !== channel.id || message.author.id !== this.#botId() || message.webhookId) continue;
				for (const embed of message.embeds) {
					const marker = embed.footer?.text;
					if (marker && markers.has(marker)) {
						if (found.has(marker))
							throw new Error("Duplicate Discord ownership markers require owner inspection.");
						found.set(marker, message);
					}
				}
			}
			if (found.size === markers.size || page.size < 100) return found;
			before = page.last()?.id;
		}
		throw new Error("Discord history exceeds the safe reconciliation window; no duplicate post was attempted.");
	}

	#once(key: string, action: () => Promise<void>): Promise<void> {
		const previous = this.#effects.get(key);
		if (previous) return previous;
		if (this.#effects.size >= EFFECT_LIMIT)
			return Promise.reject(
				new Error("Discord uncertain-effect capacity reached; inspect outcomes before restarting."),
			);
		const pending = action();
		this.#effects.set(key, pending);
		void pending.then(
			() => {
				this.#completed.push(key);
				if (this.#completed.length > 256) this.#effects.delete(this.#completed.shift()!);
			},
			() => {},
		);
		return pending;
	}

	#confirmSend(message: Message): void {
		if (typeof message.nonce !== "string") return;
		const pending = this.#pendingSends.get(message.nonce);
		if (
			pending &&
			message.channelId === pending.channelId &&
			message.author.id === pending.botId &&
			!message.webhookId
		) {
			pending.resolve(message);
		}
	}

	/** `mention` prefixes the owner ping and allows exactly that one user mention; everything else never pings. */
	async #send(channel: TextChannel, key: string, payload: MessageCreateOptions, mention = false): Promise<Message> {
		this.#requireGuild();
		const nonce = digest(key).slice(0, 24);
		if (this.#pendingSends.size >= PENDING_SEND_LIMIT || this.#pendingSends.has(nonce))
			throw new Error("Discord pending publication capacity reached; no additional post was attempted.");
		const confirmation = Promise.withResolvers<Message | undefined>();
		const pending: PendingSend = {
			channelId: channel.id,
			botId: this.#botId(),
			confirmation: confirmation.promise,
			resolve: confirmation.resolve,
		};
		this.#pendingSends.set(nonce, pending);
		// Nonce enforcement supplements the broker's durable journal, never replaces it.
		try {
			return await channel.send({
				...payload,
				...(mention ? { content: `${this.#mentionPrefix()}${payload.content ?? ""}` } : {}),
				nonce,
				enforceNonce: true,
				allowedMentions: mention ? { parse: [], users: [this.#config.ownerId], repliedUser: false } : MENTIONS,
			});
		} catch {
			// A matching live gateway event can prove a POST succeeded despite a lost REST response.
			// History omits nonce: never infer success from content or resend an uncertain POST.
			if (!this.#closed) pending.timer = setTimeout(() => pending.resolve(undefined), SEND_CONFIRMATION_MS);
			const recovered = await pending.confirmation;
			if (recovered) return recovered;
			throw new Error("Discord publication outcome is uncertain; it will not be resent automatically.");
		} finally {
			clearTimeout(pending.timer);
			pending.resolve(undefined);
			this.#pendingSends.delete(nonce);
		}
	}

	#mentionPrefix(): string {
		return `<@${this.#config.ownerId}> `;
	}

	publish(channelId: string, text: string, key: string): Promise<void> {
		if (!text.trim() || text.length > DISCORD_MODE_MAX_TEXT)
			return Promise.reject(new Error("Discord report exceeds its text limit."));
		const operation = `${PREFIX}report:${digest(`${channelId}:${key}`)}`;
		return this.#once(operation, async () => {
			const channel = await this.#textChannel(channelId);
			const parts = chunks(text);
			for (const [index, content] of parts.entries())
				await this.#send(channel, `${operation}:${index + 1}/${parts.length}`, { content });
		});
	}

	reply(channelId: string, text: string, key: string, options?: { mention?: boolean }): Promise<void> {
		if (!text.trim() || Buffer.byteLength(text) > DISCORD_MODE_MAX_REPLY)
			return Promise.reject(new Error("Discord reply exceeds its text limit."));
		const operation = `${PREFIX}reply:${digest(`${channelId}:${key}`)}`;
		const mention = options?.mention === true;
		return this.#once(operation, async () => {
			const channel = await this.#textChannel(channelId);
			await this.#send(channel, operation, replyPayload(text, mention ? this.#mentionPrefix().length : 0), mention);
		});
	}

	status(
		channelId: string,
		text: string,
		key: string,
		connectionId?: string,
		messageId?: string,
		existingOnly = false,
		app?: ModeApp,
		resumable = false,
	): Promise<string> {
		if (!text || text.length > 64_000)
			return Promise.reject(new Error("Discord status exceeds its 64000-character limit."));
		if (existingOnly && (!messageId || !/^\d{1,22}$/.test(messageId)))
			return Promise.reject(new Error("Closing a Discord status requires its exact saved message ID."));
		const marker = `${PREFIX}status:${digest(`${channelId}:${key}`)}`;
		let card = this.#cards.get(marker);
		if (!card) {
			if (this.#cards.size >= CARD_LIMIT) return Promise.reject(new Error("Discord status capacity reached."));
			card = { id: messageId, uncertain: false, legacy: !messageId, chain: Promise.resolve(undefined), queued: 0 };
			this.#cards.set(marker, card);
		}
		const state = card;
		if (state.queued >= 4) return Promise.reject(new Error("Discord status update queue is full."));
		state.queued++;
		const next = state.chain
			.catch(() => {})
			.then(async () => {
				const channel = await this.#textChannel(channelId);
				if (existingOnly && channel.id !== channelId) throw new Error("The saved Discord channel does not match.");
				let message: Message | undefined;
				const targetId = existingOnly ? messageId : state.id;
				if (targetId) {
					try {
						message = await channel.messages.fetch({ message: targetId, force: true, cache: false });
					} catch (error) {
						if (existingOnly) throw error;
						if (apiCode(error) !== 10008) throw error;
						state.id = undefined;
						state.uncertain = false;
					}
					if (
						message &&
						(message.id !== targetId ||
							message.channelId !== channelId ||
							message.author.id !== this.#botId() ||
							message.webhookId)
					)
						throw new Error("Discord status is not the saved bot-owned card.");
				}
				if (existingOnly && !message) throw new Error("The saved Discord status is unavailable.");
				if (!message && state.legacy) {
					message = (await this.#findMessages(channel, new Set([marker]))).get(marker);
					state.legacy = false;
				}
				const payload = {
					...this.#textPayload(text, "haiso-status.txt"),
					components: connectionId
						? this.#sessionComponents(channelId, connectionId)
						: resumable
							? this.#closedComponents(channelId)
							: [],
					...(app ? { embeds: [APP_EMBEDS[app]] } : {}),
				};
				if (message) {
					state.id = message.id;
					state.uncertain = false;
					this.#requireGuild();
					await message.edit({
						...payload,
						attachments: [],
						embeds: app ? [APP_EMBEDS[app]] : [],
						allowedMentions: MENTIONS,
					});
				} else {
					if (state.uncertain)
						throw new Error("Discord status creation remains uncertain; no second card was posted.");
					state.uncertain = true;
					message = await this.#send(channel, marker, payload);
					state.id = message.id;
					state.uncertain = false;
				}
				return message.id;
			})
			.catch(error => {
				if (existingOnly)
					throw new Error(
						"The saved Discord status could not be confirmed or updated; no replacement was posted.",
					);
				throw error;
			})
			.finally(() => {
				state.queued--;
			});
		state.chain = next;
		return next;
	}

	/** The configured owner's text message in a private text channel, parsed for the broker; undefined otherwise. */
	#parseOwnerMessage(message: Message): ModeOwnerMessage | undefined {
		if (
			message.guildId !== this.#config.guildId ||
			message.author.id !== this.#config.ownerId ||
			message.author.bot ||
			message.webhookId ||
			message.system ||
			message.channel.type !== ChannelType.GuildText
		)
			return undefined;
		// Check current permissions even before the broker's next reconciliation turn.
		if (!this.#private(message.channel)) return undefined;
		let text = message.content;
		let kind: "message" | "steer" | "abort" = "message";
		let rejected: string | undefined;
		if (message.attachments.size || message.stickers.size || message.poll || message.messageSnapshots.size) {
			rejected =
				"Attachments, stickers, polls, and forwarded messages are unsupported. Nothing was forwarded; send a text-only request.";
		} else if (/^!abort(?:\s|$)/i.test(text)) {
			if (text.trim().toLowerCase() !== "!abort")
				rejected = "Use exactly !abort to stop the current turn; nothing was forwarded.";
			else {
				kind = "abort";
				text = "";
			}
		} else if (/^!steer(?:\s|$)/i.test(text)) {
			kind = "steer";
			text = text.slice(6).trim();
			if (!text) rejected = "Use !steer followed by the steering text; nothing was forwarded.";
		}
		if (!rejected && kind !== "abort" && (!text.trim() || text.length > DISCORD_MODE_MAX_TEXT))
			rejected = `Send 1–${DISCORD_MODE_MAX_TEXT} text characters; nothing was forwarded.`;
		return {
			id: message.id,
			channelId: message.channelId,
			ownerId: message.author.id,
			text: rejected ? "" : text,
			kind,
			...(rejected === undefined ? {} : { rejected }),
		};
	}

	async #ownerMessage(message: Message): Promise<void> {
		if (!this.#handlers || message.channel.type !== ChannelType.GuildText) return;
		const input = this.#parseOwnerMessage(message);
		if (!input) return;
		let acknowledgement: ModeControlResult;
		try {
			acknowledgement = await this.#handlers.ownerMessage(input);
		} catch (error) {
			if (!(error instanceof DiscordModeError)) throw error;
			acknowledgement = { text: error.message };
		}
		// An empty response means this is not a bound Haiso channel. Do not speak there.
		if (!acknowledgement.text) return;
		const key = `${PREFIX}ack:${message.id}`;
		const channel = message.channel;
		const { deliveryId, connectionId } = acknowledgement;
		await this.#once(key, async () => {
			await this.#send(channel, key, {
				...this.#textPayload(acknowledgement.text),
				components:
					deliveryId && connectionId
						? acknowledgement.saved
							? this.#savedComponents(message.channelId, connectionId, deliveryId)
							: this.#queuedComponents(message.channelId, connectionId, deliveryId)
						: [],
			});
		});
	}

	/** Owner messages after `afterId`, oldest first, at most `limit`; bounded pages, parsed like live messages. */
	async history(channelId: string, afterId: string, limit: number): Promise<ModeOwnerMessage[]> {
		if (!/^\d{1,22}$/.test(channelId) || !/^\d{1,22}$/.test(afterId) || !Number.isSafeInteger(limit))
			throw new Error("Discord history request is invalid.");
		const channel = await this.#textChannel(channelId);
		const found: ModeOwnerMessage[] = [];
		let after = afterId;
		for (let page = 0; page < CATCH_UP_PAGES && found.length < limit; page++) {
			const batch = await channel.messages.fetch({ after, limit: 100, cache: false });
			// Discord returns the page newest first.
			const ordered = [...batch.values()].sort((left, right) => (BigInt(left.id) < BigInt(right.id) ? -1 : 1));
			for (const message of ordered) {
				const parsed = this.#parseOwnerMessage(message);
				if (parsed) found.push(parsed);
				if (found.length >= limit) break;
			}
			if (batch.size < 100 || !ordered.length) break;
			after = ordered.at(-1)!.id;
		}
		return found;
	}

	notice(
		channelId: string,
		text: string,
		key: string,
		connectionId: string,
		actions: ModeNoticeAction[],
	): Promise<void> {
		if (
			!text.trim() ||
			text.length > 2_000 ||
			!actions.length ||
			actions.length > 5 ||
			actions.some(
				item =>
					(item.action !== "review" && item.action !== "send-held" && item.action !== "discard-held") ||
					!item.label.trim() ||
					item.label.length > 80,
			)
		)
			return Promise.reject(new Error("Discord notice is invalid."));
		const operation = `${PREFIX}notice:${digest(`${channelId}:${key}`)}`;
		return this.#once(operation, async () => {
			const channel = await this.#textChannel(channelId);
			await this.#send(channel, operation, {
				content: text,
				components: [
					new ActionRowBuilder<ButtonBuilder>().addComponents(
						actions.map(item =>
							new ButtonBuilder()
								.setCustomId(this.#controlId(channelId, connectionId, item.action))
								.setLabel(item.label)
								.setStyle(item.action === "send-held" ? ButtonStyle.Primary : ButtonStyle.Secondary),
						),
					),
				],
			});
		});
	}

	busy(): boolean {
		return this.#inbound > 0;
	}

	/** See `DiscordPort.guide`. The only non-private channel this bot writes to; it never carries session data. */
	async guide(input: {
		text: string;
		saved?: ModeGuidePlacement;
		exclude: string[];
		note?: { text: string; key: string };
	}): Promise<ModeGuidePlacement | undefined> {
		const header = input.text.split("\n", 1)[0]!;
		if (
			!header.trim() ||
			input.text.length > 2_000 ||
			(input.note && (!input.note.text.trim() || input.note.text.length > 2_000))
		)
			throw new Error("Discord guide is invalid.");
		const guild = this.#requireGuild();
		const botId = this.#botId();
		const excluded = new Set(input.exclude);
		const usable = (channel: GuildBasedChannel | null | undefined): channel is TextChannel =>
			channel?.type === ChannelType.GuildText &&
			channel.guildId === this.#config.guildId &&
			!(channel.parentId && excluded.has(channel.parentId)) &&
			!!channel.permissionsFor(botId)?.has(WRITE_PERMISSIONS);
		const ours = (message: Message) =>
			message.author.id === botId && !message.webhookId && message.content.split("\n", 1)[0] === header;
		let channel: TextChannel | undefined;
		let found: Message | undefined;
		if (input.saved) {
			try {
				const saved = await guild.channels.fetch(input.saved.channelId, { force: true });
				if (usable(saved)) {
					const message = await saved.messages.fetch({ message: input.saved.messageId, force: true });
					if (ours(message)) [channel, found] = [saved, message];
				}
			} catch (error) {
				// A deleted channel or message is looked for again below; other failures are not guessed around.
				if (apiCode(error) !== 10003 && apiCode(error) !== 10008) throw error;
			}
		}
		let candidates: TextChannel[] = [];
		if (!found) {
			candidates = [...(await guild.channels.fetch()).values()]
				.filter(usable)
				.sort(
					(left, right) =>
						Number(right.name === "general") - Number(left.name === "general") ||
						left.rawPosition - right.rawPosition,
				);
			for (const candidate of candidates.slice(0, GUIDE_SCAN_LIMIT)) {
				const pins = await candidate.messages.fetchPins({ limit: 50, cache: false }).catch(() => undefined);
				found = pins?.items.map(pin => pin.message).find(ours);
				if (found) {
					channel = candidate;
					break;
				}
			}
		}
		if (!found || !channel) {
			channel = candidates.find(candidate => candidate.name === "general");
			if (!channel) return undefined;
			found = await this.#send(channel, `${PREFIX}guide:${digest(input.text)}`, { content: input.text });
		} else if (found.content !== input.text) {
			await found.edit({ content: input.text, allowedMentions: MENTIONS });
		}
		// Pinning needs Pin Messages; without it the guide stays in place for the owner to pin.
		if (!found.pinned) await found.pin().catch(() => {});
		const note = input.note;
		const target = channel;
		if (note) {
			const key = `${PREFIX}guide-note:${digest(note.key)}`;
			await this.#once(key, async () => {
				await this.#send(target, key, { content: note.text });
			}).catch(() => {});
		}
		return { channelId: target.id, messageId: found.id };
	}

	async showDialog(channelId: string, dialog: ModeDialog, options?: { mention?: boolean }): Promise<void> {
		const token = digest(`${channelId}:${dialog.id}`).slice(0, 32);
		const existing = this.#dialogs.get(token);
		if (existing) {
			if (JSON.stringify(existing.request) !== JSON.stringify(dialog))
				throw new Error("Discord dialog ID cannot be reused with changed content.");
			await this.#effects.get(`${PREFIX}dialog:${token}`);
			return;
		}
		const reason =
			dialog.kind === "select" && (!dialog.options?.length || dialog.options.length > 25)
				? "Discord selections require 1–25 options; answer this dialog in the original session."
				: (dialog.kind === "input" || dialog.kind === "editor") && (dialog.prefill?.length ?? 0) > 4_000
					? "Discord input supports at most 4000 characters; answer this dialog in the original session."
					: undefined;
		if (reason) {
			await this.publish(channelId, reason, `dialog-unavailable:${dialog.id}`);
			throw new Error(reason);
		}
		if (this.#dialogs.size >= DIALOG_LIMIT)
			throw new Error("Discord dialog capacity reached; use the original session.");
		const full = `Native ${dialog.kind} dialog\n\nTITLE (verbatim):\n${dialog.title}\n\nMESSAGE (verbatim):\n${dialog.message ?? ""}\n\n${dialog.kind === "select" ? dialog.options!.map((option, index) => `OPTION ${index + 1} (${option.length} characters, verbatim):\n${option}\nEND OPTION ${index + 1}`).join("\n\n") : `INITIAL VALUE (verbatim):\n${dialog.prefill ?? ""}`}`;
		if (full.length > 64_000) {
			const unavailable =
				"Full Discord dialog exceeds 64000 characters; use the original session. No approval controls were displayed.";
			await this.publish(channelId, unavailable, `dialog-unavailable:${dialog.id}`);
			throw new Error(unavailable);
		}
		const state: Dialog = { channelId, request: structuredClone(dialog), consumed: false };
		this.#dialogs.set(token, state);
		const marker = `${PREFIX}dialog:${token}`;
		await this.#once(marker, async () => {
			const channel = await this.#textChannel(channelId);
			let message = (await this.#findMessages(channel, new Set([marker]))).get(marker);
			if (!message) {
				message = await this.#send(
					channel,
					marker,
					{
						content:
							"Native session input. Read the attached FULL prompt before answering. Controls answer the original session; a local answer may win first. Input/editor limit: 4000 characters.",
						files: [new AttachmentBuilder(Buffer.from(full, "utf8"), { name: "native-input.txt" })],
						components: this.#dialogComponents(token, dialog),
					},
					options?.mention === true,
				);
			} else {
				await message.edit({ embeds: [], allowedMentions: MENTIONS });
			}
			state.message = message;
			if (state.consumed) await message.edit({ components: [], allowedMentions: MENTIONS });
		});
	}

	#dialogComponents(
		token: string,
		dialog: ModeDialog,
	): Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> {
		const rows: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> = [];
		const buttons: ButtonBuilder[] = [];
		if (dialog.kind === "select") {
			rows.push(
				new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
					new StringSelectMenuBuilder()
						.setCustomId(`${PREFIX}${token}:choose`)
						.setPlaceholder("Read full options in native-input.txt")
						.addOptions(
							dialog.options!.map((_option, index) => ({
								label: `Option ${index + 1} — see full attached text`,
								value: String(index),
							})),
						),
				),
			);
		} else if (dialog.kind === "confirm") {
			buttons.push(
				new ButtonBuilder().setCustomId(`${PREFIX}${token}:yes`).setLabel("Yes").setStyle(ButtonStyle.Primary),
			);
			buttons.push(
				new ButtonBuilder().setCustomId(`${PREFIX}${token}:no`).setLabel("No").setStyle(ButtonStyle.Secondary),
			);
		} else {
			buttons.push(
				new ButtonBuilder()
					.setCustomId(`${PREFIX}${token}:edit`)
					.setLabel("Enter text (max 4000)")
					.setStyle(ButtonStyle.Primary),
			);
		}
		buttons.push(
			new ButtonBuilder().setCustomId(`${PREFIX}${token}:cancel`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
		);
		rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));
		return rows;
	}

	async endDialog(channelId: string, dialogId: string): Promise<void> {
		const token = digest(`${channelId}:${dialogId}`).slice(0, 32);
		const dialog = this.#dialogs.get(token);
		if (!dialog || dialog.channelId !== channelId || dialog.request.id !== dialogId) return;
		dialog.consumed = true;
		try {
			if (dialog.message) await dialog.message.edit({ components: [], allowedMentions: MENTIONS });
		} catch (error) {
			if (apiCode(error) !== 10008) throw error;
		} finally {
			this.#dialogs.delete(token);
		}
	}

	async settingsResult(channelId: string, commandId: string, text: string, panel?: ModeSettingsPanel): Promise<void> {
		const pending = this.#pendingSettings.get(commandId);
		this.#pendingSettings.delete(commandId);
		if (pending?.channelId === channelId && Date.now() - pending.at < SETTINGS_TOKEN_MS) {
			try {
				await pending.interaction.followUp({
					content: text,
					flags: MessageFlags.Ephemeral,
					allowedMentions: MENTIONS,
				});
				if (panel)
					await pending.interaction
						.editReply(this.#settingsPayload(channelId, pending.connectionId, panel, text))
						.catch(() => {});
				return;
			} catch {
				// The panel was dismissed or its token lapsed; the channel note below still reaches the owner.
			}
		}
		const key = `${PREFIX}settings:${digest(`${channelId}:${commandId}`)}`;
		await this.#once(key, async () => {
			await this.#send(await this.#textChannel(channelId), key, { content: `Session settings: ${text}` });
		});
	}

	#rememberSetting(commandId: string, interaction: ReplyInteraction, channelId: string, connectionId: string): void {
		this.#pendingSettings.delete(commandId);
		this.#pendingSettings.set(commandId, { interaction, channelId, connectionId, at: Date.now() });
		for (const [id, pending] of this.#pendingSettings)
			if (this.#pendingSettings.size > PENDING_SETTINGS_LIMIT || Date.now() - pending.at >= SETTINGS_TOKEN_MS)
				this.#pendingSettings.delete(id);
	}

	#controlId(channelId: string, connectionId: string, action: string, deliveryId?: string): string {
		if (!/^\d{1,22}$/.test(channelId) || !UUID.test(connectionId) || (deliveryId && !UUID.test(deliveryId)))
			throw new Error("Discord session control identity is invalid.");
		// Only broker-generated delivery UUIDs are compacted; preserve connection IDs verbatim.
		const delivery = deliveryId ? Buffer.from(deliveryId.replaceAll("-", ""), "hex").toString("base64url") : "";
		return `${SESSION_PREFIX}${channelId}:${connectionId}:${delivery}:${action}`;
	}

	#sessionComponents(channelId: string, connectionId: string): ControlRows {
		return [
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId(this.#controlId(channelId, connectionId, "stop"))
					.setLabel("Stop turn")
					.setStyle(ButtonStyle.Danger),
				new ButtonBuilder()
					.setCustomId(this.#controlId(channelId, connectionId, "queue"))
					.setLabel("Queue")
					.setStyle(ButtonStyle.Secondary),
				new ButtonBuilder()
					.setCustomId(this.#controlId(channelId, connectionId, "status"))
					.setLabel("Session details")
					.setStyle(ButtonStyle.Secondary),
				new ButtonBuilder()
					.setCustomId(this.#controlId(channelId, connectionId, "settings"))
					.setLabel("Settings")
					.setStyle(ButtonStyle.Secondary),
			),
		];
	}

	/** A closed card's control: start the conversation again in the background. */
	#closedComponents(channelId: string): ControlRows {
		if (!/^\d{1,22}$/.test(channelId)) throw new Error("Discord session control identity is invalid.");
		return [
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId(`${PREFIX}r:${channelId}:resume`)
					.setLabel("Resume")
					.setStyle(ButtonStyle.Primary),
			),
		];
	}

	/** Closed conversations of this project, one pick starts it in the background. */
	#resumePicker(channelId: string, resumable: NonNullable<ModeControlResult["resumable"]>): ControlRows {
		if (!/^\d{1,22}$/.test(channelId)) throw new Error("Discord session control identity is invalid.");
		return [
			new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
				new StringSelectMenuBuilder()
					.setCustomId(`${PREFIX}r:${channelId}:pick`)
					.setPlaceholder("Conversation to resume")
					.addOptions(
						resumable.slice(0, 25).map(item => ({
							label: item.label.slice(0, 100),
							description: `Session ${item.id.slice(0, 8)}`,
							value: item.id,
						})),
					),
			),
		];
	}

	#queuedComponents(channelId: string, connectionId: string, deliveryId: string): ControlRows {
		return [
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId(this.#controlId(channelId, connectionId, "steer", deliveryId))
					.setLabel("Send as guidance")
					.setStyle(ButtonStyle.Primary),
				new ButtonBuilder()
					.setCustomId(this.#controlId(channelId, connectionId, "cancel", deliveryId))
					.setLabel("Cancel queued message")
					.setStyle(ButtonStyle.Secondary),
			),
		];
	}

	/** One saved message: send it (session open) or discard it. `send` is offered only while reviewing. */
	#savedComponents(channelId: string, connectionId: string, deliveryId: string, send = false): ControlRows {
		const discard = new ButtonBuilder()
			.setCustomId(this.#controlId(channelId, connectionId, "discard", deliveryId))
			.setLabel("Discard")
			.setStyle(ButtonStyle.Secondary);
		return [
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				send
					? [
							new ButtonBuilder()
								.setCustomId(this.#controlId(channelId, connectionId, "release", deliveryId))
								.setLabel("Send")
								.setStyle(ButtonStyle.Primary),
							discard,
						]
					: [discard],
			),
		];
	}

	/** Saved messages: one picked message with Send/Discard, or a picker plus Send all/Discard all. */
	#reviewRows(channelId: string, connectionId: string, result: ModeControlResult): ControlRows {
		if (result.deliveryId) return this.#savedComponents(channelId, connectionId, result.deliveryId, true);
		const saved = result.queued ?? [];
		if (!saved.length) return [];
		const rows: ControlRows = [];
		for (let offset = 0; offset < Math.min(saved.length, 50); offset += 25) {
			const entries = saved.slice(offset, offset + 25);
			rows.push(
				new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
					new StringSelectMenuBuilder()
						.setCustomId(this.#controlId(channelId, connectionId, `review${offset / 25}`))
						.setPlaceholder(`Saved messages ${offset + 1}–${offset + entries.length}`)
						.addOptions(
							entries.map((entry, index) => ({
								label: `Saved message ${offset + index + 1}`,
								description: entry.text.replace(/\s+/g, " ").slice(0, 100) || "Empty message",
								value: entry.id,
							})),
						),
				),
			);
		}
		rows.push(
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId(this.#controlId(channelId, connectionId, "send-held"))
					.setLabel("Send all")
					.setStyle(ButtonStyle.Primary),
				new ButtonBuilder()
					.setCustomId(this.#controlId(channelId, connectionId, "discard-held"))
					.setLabel("Discard all")
					.setStyle(ButtonStyle.Secondary),
			),
		);
		return rows;
	}

	#controlPayload(channelId: string, result: ModeControlResult): ControlPayload {
		if (result.settings && result.connectionId)
			return this.#settingsPayload(channelId, result.connectionId, result.settings, result.text);
		if (result.review && result.connectionId)
			return {
				...this.#textPayload(result.text),
				components: this.#reviewRows(channelId, result.connectionId, result),
				attachments: [],
				allowedMentions: MENTIONS,
			};
		if (result.resumable?.length)
			return {
				...this.#textPayload(result.text),
				components: this.#resumePicker(channelId, result.resumable),
				attachments: [],
				allowedMentions: MENTIONS,
			};
		const rows: ControlRows = [];
		if (result.connectionId) {
			if (result.deliveryId) {
				const selected = result.queued?.find(item => item.id === result.deliveryId);
				if (selected?.actionable)
					rows.push(...this.#queuedComponents(channelId, result.connectionId, result.deliveryId));
			} else if (result.queued?.length) {
				for (let offset = 0; offset < result.queued.length; offset += 25) {
					const entries = result.queued.slice(offset, offset + 25);
					rows.push(
						new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
							new StringSelectMenuBuilder()
								.setCustomId(this.#controlId(channelId, result.connectionId, `queue${offset / 25}`))
								.setPlaceholder(`Queued messages ${offset + 1}–${offset + entries.length}`)
								.addOptions(
									entries.map((entry, index) => ({
										label: `Message ${offset + index + 1}${entry.held ? " (held)" : ""}`,
										description: entry.text.replace(/\s+/g, " ").slice(0, 100) || "Empty control message",
										value: entry.id,
									})),
								),
						),
					);
				}
			}
		}
		// Disconnected sessions cannot offer generation-bound interactions; retain every
		// queued message verbatim in the read-only reply rather than hide the queue.
		const text =
			!result.connectionId && !result.deliveryId && result.queued?.length
				? `${result.text}\n\n${result.queued.map((entry, index) => `Owner message ${index + 1}${entry.held ? " (held)" : ""} — read-only\n${entry.text}`).join("\n\n")}`
				: result.text;
		return {
			...this.#textPayload(text || "No Haiso session is bound to this channel."),
			components: rows,
			attachments: [],
			allowedMentions: MENTIONS,
		};
	}

	/** Ephemeral owner panel. Controls follow the session's reported capabilities and bind to its connection. */
	#settingsPayload(channelId: string, connectionId: string, panel: ModeSettingsPanel, note?: string): ControlPayload {
		const { view, usage, pending } = panel;
		const control = (action: string) => this.#controlId(channelId, connectionId, action);
		// Efforts follow the model the session will run: a pending model change, else the current one.
		const pendingModel = pending.findLast(item => item.kind === "model")?.value;
		const target =
			(typeof pendingModel === "string"
				? [...view.shortlist, ...view.models].find(choice => choice.selector === pendingModel)
				: undefined) ?? view.model;
		const lines = [
			"**Session settings**",
			`Model: ${view.model ? `${view.model.name} (${view.model.selector})` : "none"}`,
			`Effort: ${view.model?.efforts.length ? (view.effort ?? "default") : "not adjustable for this model"}`,
			`Context: ${
				usage && usage.contextWindow > 0
					? `${Math.round(usage.percent)}% (${formatNumber(usage.tokens)} / ${formatNumber(usage.contextWindow)} tokens)`
					: "unknown"
			}`,
		];
		if (view.capabilities.advisor)
			lines.push(
				`Advisor: ${view.advisor?.enabled ? "on" : "off"}${view.advisor?.model ? ` · ${view.advisor.model}` : ""}${
					view.advisor?.enabled && !view.advisor.active ? " (no advisor model assigned)" : ""
				}`,
			);
		if (view.capabilities.plan) lines.push(`Plan mode: ${view.plan?.enabled ? "on" : "off"}`);
		if (pending.length)
			lines.push(
				`Pending: ${pending.map(item => describeSettingCommand(item, view)).join("; ")}${panel.busy ? " — applies after this turn" : ""}`,
			);
		lines.push("Model and effort changes last for this session only.");
		if (note) lines.push("", note);
		const modelOptions = (choices: ModeSettingsPanel["view"]["shortlist"], current: string | undefined) => {
			const seen = new Set<string>();
			return choices.flatMap(choice => {
				const value = settingsChoiceToken(choice.selector);
				if (seen.has(value)) return [];
				seen.add(value);
				return [
					{
						label: choice.name.slice(0, 100),
						description: `${choice.selector}${choice.role ? ` · ${choice.role}` : ""}`.slice(0, 100),
						value,
						default: choice.selector === current,
					},
				];
			});
		};
		const rows: ControlRows = [];
		const searched = Boolean(panel.matches?.length);
		const models = searched ? panel.matches! : view.shortlist;
		if (models.length)
			rows.push(
				new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
					new StringSelectMenuBuilder()
						.setCustomId(control("set-model"))
						.setPlaceholder(searched ? `Search results (${models.length})` : "Model for this session")
						.addOptions(modelOptions(models, searched ? undefined : view.model?.selector)),
				),
			);
		if (target?.efforts.length)
			rows.push(
				new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
					new StringSelectMenuBuilder()
						.setCustomId(control("set-effort"))
						.setPlaceholder(target === view.model ? "Effort" : `Effort for ${target.name}`.slice(0, 150))
						.addOptions(
							target.efforts.map(effort => ({
								label: effort,
								value: effort,
								default: target === view.model && effort === view.effort,
							})),
						),
				),
			);
		const buttons = [
			new ButtonBuilder().setCustomId(control("search")).setLabel("Search models…").setStyle(ButtonStyle.Primary),
		];
		if (view.capabilities.compact)
			buttons.push(
				new ButtonBuilder()
					.setCustomId(control("compact"))
					.setLabel(panel.busy ? "Compact (when idle)" : "Compact")
					.setStyle(ButtonStyle.Secondary)
					.setDisabled(panel.busy),
			);
		if (view.capabilities.persist)
			buttons.push(
				new ButtonBuilder()
					.setCustomId(control("default"))
					.setLabel("Make default")
					.setStyle(ButtonStyle.Secondary),
			);
		buttons.push(
			new ButtonBuilder().setCustomId(control("refresh")).setLabel("Refresh").setStyle(ButtonStyle.Secondary),
		);
		rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));
		const extras: ButtonBuilder[] = [];
		if (view.capabilities.advisor)
			extras.push(
				new ButtonBuilder()
					.setCustomId(control(view.advisor?.enabled ? "advisor-off" : "advisor-on"))
					.setLabel(view.advisor?.enabled ? "Turn advisor off" : "Turn advisor on")
					.setStyle(ButtonStyle.Secondary),
			);
		if (view.capabilities.plan)
			extras.push(
				new ButtonBuilder()
					.setCustomId(control("plan"))
					.setLabel(view.plan?.enabled ? "Plan mode is on" : "Enter plan mode")
					.setStyle(ButtonStyle.Secondary)
					.setDisabled(Boolean(view.plan?.enabled)),
			);
		if (extras.length) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(extras));
		if (view.capabilities.advisor && view.shortlist.length)
			rows.push(
				new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
					new StringSelectMenuBuilder()
						.setCustomId(control("set-advisor"))
						.setPlaceholder("Advisor model for this session")
						.addOptions(modelOptions(view.shortlist, view.advisor?.model)),
				),
			);
		return {
			...this.#textPayload(lines.join("\n")),
			components: rows,
			attachments: [],
			allowedMentions: MENTIONS,
		};
	}

	/** The new-conversation form: name, first message, and an optional model the service validates. */
	async #newConversationForm(interaction: ChatInputCommandInteraction): Promise<void> {
		if (!/^\d{1,22}$/.test(interaction.channelId)) return;
		const field = (id: string, label: string, style: TextInputStyle, max: number, required: boolean) =>
			new ActionRowBuilder<TextInputBuilder>().addComponents(
				new TextInputBuilder()
					.setCustomId(id)
					.setLabel(label)
					.setStyle(style)
					.setRequired(required)
					.setMaxLength(max),
			);
		await interaction
			.showModal(
				new ModalBuilder()
					.setCustomId(`${PREFIX}n:${interaction.channelId}:new`)
					.setTitle("New conversation")
					.addComponents(
						field("name", "Name", TextInputStyle.Short, 100, true),
						field("message", "First message", TextInputStyle.Paragraph, 4_000, true),
						field("model", "Model (optional, provider/model)", TextInputStyle.Short, 200, false),
					),
			)
			.catch(() => {});
	}

	/** The rename form, prefilled with the channel's current name (without its app marker) when cached. */
	async #renameForm(interaction: ChatInputCommandInteraction): Promise<void> {
		if (!/^\d{1,22}$/.test(interaction.channelId)) return;
		const input = new TextInputBuilder()
			.setCustomId("name")
			.setLabel("New name")
			.setStyle(TextInputStyle.Short)
			.setRequired(true)
			.setMaxLength(100);
		const current = interaction.channel && "name" in interaction.channel ? interaction.channel.name : undefined;
		const label = current ? sessionLabel(current) : undefined;
		if (label) input.setValue(label.slice(0, 100));
		await interaction
			.showModal(
				new ModalBuilder()
					.setCustomId(`${PREFIX}m:${interaction.channelId}:rename`)
					.setTitle("Rename session")
					.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)),
			)
			.catch(() => {});
	}

	/** [Resume] on a closed card, a pick from the resume list, or a submitted form; undefined when malformed. */
	#launchRequest(interaction: ReplyInteraction): LaunchRequest | undefined {
		const match = "customId" in interaction ? LAUNCH_CONTROL.exec(interaction.customId) : null;
		if (
			!match ||
			match[2] !== interaction.channelId ||
			(match[1] === "n") !== (match[3] === "new") ||
			(match[1] === "m") !== (match[3] === "rename")
		)
			return undefined;
		if (match[3] === "resume") return interaction.isButton() ? { action: "resume" } : undefined;
		if (match[3] === "pick")
			return interaction.isStringSelectMenu() && interaction.values.length === 1 && UUID.test(interaction.values[0]!)
				? { action: "resume", sessionId: interaction.values[0]! }
				: undefined;
		if (!interaction.isModalSubmit()) return undefined;
		const name = interaction.fields
			.getTextInputValue("name")
			.replace(/[\x00-\x1f\x7f]/g, " ")
			.trim();
		if (match[3] === "rename") return name ? { action: "rename", name } : undefined;
		const message = interaction.fields.getTextInputValue("message");
		const model = interaction.fields.getTextInputValue("model").trim();
		if (!name || !message.trim()) return undefined;
		return { action: "new", name, message, ...(model ? { model } : {}) };
	}

	async #sessionInteraction(interaction: ReplyInteraction): Promise<void> {
		let action: ModeControlRequest["action"];
		let connectionId: string | undefined;
		let deliveryId: string | undefined;
		let notify: ModeNotify | undefined;
		let launch: LaunchRequest | undefined;
		if (interaction.isChatInputCommand()) {
			const subcommand = interaction.options.getSubcommand(false);
			const mode = subcommand === "notify" ? interaction.options.getString("mode", false) : null;
			if (mode === "all" || mode === "needs-you" || mode === "off") notify = mode;
			if (
				interaction.commandId !== this.#sessionCommandId ||
				interaction.commandGuildId !== this.#config.guildId ||
				(subcommand !== "status" &&
					subcommand !== "stop" &&
					subcommand !== "queue" &&
					subcommand !== "notify" &&
					subcommand !== "settings" &&
					subcommand !== "resume" &&
					subcommand !== "new" &&
					subcommand !== "close" &&
					subcommand !== "rename") ||
				(subcommand === "notify" && !notify)
			) {
				await this.#reply(
					interaction,
					"This session command is outdated or unavailable. Use this guild's /session command.",
				);
				return;
			}
			// A form must be Discord's first response to the command, so it opens before any deferral.
			if (subcommand === "new") {
				await this.#newConversationForm(interaction);
				return;
			}
			if (subcommand === "rename") {
				await this.#renameForm(interaction);
				return;
			}
			action = subcommand === "resume" ? "sessions" : subcommand;
		} else if ("customId" in interaction && LAUNCH_CONTROL.test(interaction.customId)) {
			launch = this.#launchRequest(interaction);
			if (!launch) {
				await this.#reply(
					interaction,
					"This control is invalid or belongs to another channel; nothing was started.",
				);
				return;
			}
			action = launch.action;
		} else {
			const match = "customId" in interaction ? SESSION_CONTROL.exec(interaction.customId) : null;
			if (!match || match[1] !== interaction.channelId || !UUID.test(match[2]!)) {
				await this.#reply(interaction, "This session control is invalid or belongs to another channel.");
				return;
			}
			connectionId = match[2]!;
			if (SETTINGS_ACTIONS[match[4]!]) {
				if (match[3]) await this.#reply(interaction, "Invalid settings control; nothing was changed.");
				else await this.#settingsInteraction(interaction, match[4]!, connectionId);
				return;
			}
			const selected = match[4] === "queue0" || match[4] === "queue1";
			const reviewed = match[4] === "review0" || match[4] === "review1";
			if (
				(selected || reviewed) &&
				interaction.isStringSelectMenu() &&
				interaction.values.length === 1 &&
				UUID.test(interaction.values[0]!)
			) {
				action = selected ? "queue" : "review";
				deliveryId = interaction.values[0]!;
			} else if (!selected && !reviewed && interaction.isButton()) {
				action = match[4] as ModeControlRequest["action"];
				if (match[3]) {
					const hex = Buffer.from(match[3], "base64url").toString("hex");
					deliveryId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
				}
				const needsDelivery =
					action === "steer" || action === "cancel" || action === "discard" || action === "release";
				if (needsDelivery !== Boolean(deliveryId) && !(action === "review" && deliveryId)) {
					await this.#reply(interaction, "Invalid queued-message control; no action was submitted.");
					return;
				}
			} else {
				await this.#reply(interaction, "Invalid session control; no action was submitted.");
				return;
			}
		}
		try {
			await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		} catch {
			await this.#reply(interaction, "Discord could not acknowledge this control. No action was submitted.").catch(
				() => {},
			);
			return;
		}
		try {
			if (!interaction.channelId || !this.#handlers) throw new Error("Unavailable session control.");
			await this.#textChannel(interaction.channelId);
		} catch {
			await this.#reply(
				interaction,
				"Session controls require an available, owner/bot-private text channel. No action was submitted.",
			);
			return;
		}
		try {
			const result = await this.#handlers!.control({
				id: interaction.id,
				channelId: interaction.channelId!,
				ownerId: interaction.user.id,
				action,
				...(connectionId ? { connectionId } : {}),
				...(deliveryId ? { deliveryId } : {}),
				...(notify ? { notify } : {}),
				...launch,
			});
			await this.#reply(interaction, result, interaction.channelId!);
		} catch (error) {
			await this.#reply(
				interaction,
				error instanceof DiscordModeError
					? error.message
					: "Session control outcome is unavailable or uncertain. It will not be retried automatically; inspect /session status or /session queue.",
			);
		}
	}

	/** Panel controls update the ephemeral panel in place; each change's outcome arrives later as a follow-up. */
	async #settingsInteraction(interaction: ReplyInteraction, action: string, connectionId: string): Promise<void> {
		const channelId = interaction.channelId!;
		if (action === "search" && interaction.isButton()) {
			await interaction.showModal(
				new ModalBuilder()
					.setCustomId(this.#controlId(channelId, connectionId, "search-q"))
					.setTitle("Search models")
					.addComponents(
						new ActionRowBuilder<TextInputBuilder>().addComponents(
							new TextInputBuilder()
								.setCustomId("query")
								.setLabel("Model name or provider/id")
								.setStyle(TextInputStyle.Short)
								.setRequired(true)
								.setMaxLength(100),
						),
					),
			);
			return;
		}
		const value =
			interaction.isStringSelectMenu() && interaction.values.length === 1 ? interaction.values[0] : undefined;
		const button = interaction.isButton();
		let request: Pick<ModeControlRequest, "action" | "setting" | "query"> | undefined;
		if (action === "refresh" && button) request = { action: "settings" };
		else if (action === "search-q" && interaction.isModalSubmit()) {
			const query = interaction.fields
				.getTextInputValue("query")
				.replace(/[\x00-\x1f\x7f]/g, " ")
				.trim();
			if (query && query.length <= 100) request = { action: "settings", query };
		} else if ((action === "set-model" || action === "set-advisor") && value && /^[a-f0-9]{16}$/.test(value))
			request = { action: "setting", setting: { kind: action === "set-model" ? "model" : "advisor-model", value } };
		else if (action === "set-effort" && value && /^[a-z0-9-]{1,16}$/.test(value))
			request = { action: "setting", setting: { kind: "effort", value } };
		else if ((action === "advisor-on" || action === "advisor-off") && button)
			request = { action: "setting", setting: { kind: "advisor", value: action === "advisor-on" } };
		else if ((action === "plan" || action === "compact" || action === "default") && button)
			request = { action: "setting", setting: { kind: action } };
		if (!request) {
			await this.#reply(interaction, "Invalid settings control; nothing was changed.");
			return;
		}
		try {
			if (interaction.isMessageComponent() || (interaction.isModalSubmit() && interaction.isFromMessage()))
				await interaction.deferUpdate();
			else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		} catch {
			await this.#reply(interaction, "Discord could not acknowledge this control. Nothing was changed.").catch(
				() => {},
			);
			return;
		}
		let failure = "Session controls require an available, owner/bot-private text channel. Nothing was changed.";
		try {
			if (!this.#handlers) throw new Error("Unavailable session control.");
			await this.#textChannel(channelId);
			failure = "The settings change outcome is unavailable or uncertain; reopen /session settings before retrying.";
			const result = await this.#handlers.control({
				id: interaction.id,
				channelId,
				ownerId: interaction.user.id,
				connectionId,
				...request,
			});
			if (result.commandId) this.#rememberSetting(result.commandId, interaction, channelId, connectionId);
			await interaction.editReply(this.#controlPayload(channelId, result));
			return;
		} catch (error) {
			if (error instanceof DiscordModeError) failure = error.message;
		}
		// The panel stays as it was; the refusal arrives beside it.
		await interaction
			.followUp({ content: failure, flags: MessageFlags.Ephemeral, allowedMentions: MENTIONS })
			.catch(() => {});
	}

	async #interaction(interaction: Interaction): Promise<void> {
		const sessionCommand = interaction.isChatInputCommand() && interaction.commandName === "session";
		const managedComponent = "customId" in interaction && interaction.customId.startsWith(PREFIX);
		if ((!sessionCommand && !managedComponent) || !interaction.isRepliable()) return;
		if (
			interaction.guildId !== this.#config.guildId ||
			interaction.user.id !== this.#config.ownerId ||
			interaction.user.bot
		) {
			await this.#reply(interaction, "This control is restricted to the configured Haiso owner and guild.");
			return;
		}
		if (
			sessionCommand ||
			("customId" in interaction &&
				(interaction.customId.startsWith(SESSION_PREFIX) || LAUNCH_CONTROL.test(interaction.customId)))
		) {
			await this.#sessionInteraction(interaction);
			return;
		}
		if (!("customId" in interaction)) return;
		const match = /^haiso:([a-f0-9]{32}):(choose|yes|no|edit|submit|cancel)$/.exec(interaction.customId);
		const state = match ? this.#dialogs.get(match[1]!) : undefined;
		if (
			!match ||
			!state ||
			state.channelId !== interaction.channelId ||
			state.consumed ||
			!this.#handlers ||
			(interaction.isMessageComponent() && interaction.message.id !== state.message?.id)
		) {
			await this.#reply(
				interaction,
				"This dialog is resolved, unavailable, or belongs to another channel. Use the original session.",
			);
			return;
		}
		const token = match[1]!;
		const action = match[2]!;
		const request = state.request;
		if (action === "edit" && interaction.isButton() && (request.kind === "input" || request.kind === "editor")) {
			const input = new TextInputBuilder()
				.setCustomId("value")
				.setLabel("Session input (maximum 4000 characters)")
				.setStyle(TextInputStyle.Paragraph)
				.setRequired(false)
				.setMaxLength(4_000);
			if (request.prefill) input.setValue(request.prefill);
			await interaction.showModal(
				new ModalBuilder()
					.setCustomId(`${PREFIX}${token}:submit`)
					.setTitle("Native session input")
					.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)),
			);
			return;
		}
		let value: string | boolean | undefined;
		let cancelled = false;
		if (action === "cancel" && interaction.isButton()) cancelled = true;
		else if ((action === "yes" || action === "no") && interaction.isButton() && request.kind === "confirm")
			value = action === "yes";
		else if (
			action === "choose" &&
			interaction.isStringSelectMenu() &&
			request.kind === "select" &&
			interaction.values.length === 1 &&
			/^(0|[1-9]\d*)$/.test(interaction.values[0]!)
		)
			value = request.options?.[Number(interaction.values[0])];
		else if (
			action === "submit" &&
			interaction.isModalSubmit() &&
			(request.kind === "input" || request.kind === "editor")
		) {
			const text = interaction.fields.getTextInputValue("value");
			if (text.length <= 4_000) value = text;
		}
		if (value === undefined && !cancelled) {
			await this.#reply(interaction, "Invalid dialog answer; no response was submitted.");
			return;
		}
		try {
			await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		} catch {
			await this.#reply(
				interaction,
				"Discord could not acknowledge this click. No answer was submitted; the dialog remains available.",
			).catch(() => {});
			return;
		}
		// Deferring is not answer dispatch: a local answer or another click can win meanwhile.
		if (state.consumed || this.#dialogs.get(token) !== state || !this.#handlers) {
			await this.#reply(interaction, "This dialog has already resolved; no additional answer was submitted.");
			return;
		}
		state.consumed = true;
		try {
			const result = await this.#handlers.answer({
				channelId: state.channelId,
				ownerId: interaction.user.id,
				dialogId: request.id,
				value,
				cancelled,
			});
			await this.#reply(
				interaction,
				result ||
					"Answer submitted. The original session decides the first answer; completion is not yet confirmed.",
			);
		} catch (error) {
			await this.#reply(
				interaction,
				error instanceof DiscordModeError
					? error.message
					: "Answer outcome is uncertain; it will not be submitted again automatically. Inspect the original session.",
			);
		} finally {
			await this.endDialog(state.channelId, request.id);
		}
	}

	#textPayload(text: string, name = "haiso-session.txt"): Pick<MessageCreateOptions, "content" | "files"> {
		return text.length <= 2_000
			? { content: text }
			: {
					content: "Haiso — full details are attached without truncation.",
					files: [new AttachmentBuilder(Buffer.from(text, "utf8"), { name })],
				};
	}

	async #reply(interaction: ReplyInteraction, result: string | ModeControlResult, channelId?: string): Promise<void> {
		const payload =
			typeof result === "string"
				? { ...this.#textPayload(result), components: [], attachments: [], allowedMentions: MENTIONS }
				: this.#controlPayload(channelId!, result);
		if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
		else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
	}
}
