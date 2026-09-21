// Routing, durable publication, and native-dialog presentation adapted from
// omp-discord-bridge (Copyright (c) 2026 treearc, MIT License).
import { createHash } from "node:crypto";
import {
	ActionRowBuilder,
	ApplicationCommandType,
	AttachmentBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	Client,
	type ClientEvents,
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
import { DiscordModeError } from "./broker";
import { discordCategoryName, discordChannelName } from "./names";
import {
	DISCORD_MODE_MAX_TEXT,
	type ChannelInspection,
	type DiscordModeConfig,
	type DiscordPort,
	type DiscordPortHandlers,
	type ModeControlRequest,
	type ModeControlResult,
	type ModeDialog,
	type ModeRetirementPolicy,
	type RemoteChannel,
} from "./protocol";

const MENTIONS = { parse: [] as never[], repliedUser: false };
const PREFIX = "haiso:";
const SESSION_PREFIX = `${PREFIX}s:`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HISTORY_LIMIT = 1_000;
const EFFECT_LIMIT = 4_096;
const CARD_LIMIT = 256;
const DIALOG_LIMIT = 256;
const PENDING_SEND_LIMIT = 32;
const SEND_CONFIRMATION_MS = 1_500;
const READ_PERMISSIONS = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory;
const WRITE_PERMISSIONS = READ_PERMISSIONS | PermissionFlagsBits.SendMessages;
const BOT_PERMISSIONS = WRITE_PERMISSIONS | PermissionFlagsBits.AttachFiles | PermissionFlagsBits.EmbedLinks;

type ManagedChannel = Extract<GuildBasedChannel, { type: ChannelType.GuildText | ChannelType.GuildCategory }>;
type ReplyInteraction = Extract<Interaction, { reply: unknown }>;
type ControlRows = Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>>;
type ControlPayload = Pick<MessageCreateOptions, "content" | "files" | "allowedMentions"> & {
	components: ControlRows;
	attachments: [];
};

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
		const definition = new SlashCommandBuilder()
			.setName("session")
			.setDescription("Inspect and control the Haiso session bound to this channel")
			.setDefaultMemberPermissions(null)
			.setNSFW(false)
			.addSubcommand(command => command.setName("status").setDescription("Show the bound session's current state"))
			.addSubcommand(command => command.setName("stop").setDescription("Request a stop of the current turn"))
			.addSubcommand(command => command.setName("queue").setDescription("Inspect queued owner messages"))
			.toJSON();
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

	async #send(channel: TextChannel, key: string, payload: MessageCreateOptions): Promise<Message> {
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
				nonce,
				enforceNonce: true,
				allowedMentions: MENTIONS,
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

	status(
		channelId: string,
		text: string,
		key: string,
		connectionId?: string,
		messageId?: string,
		existingOnly = false,
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
					components: connectionId ? this.#sessionComponents(channelId, connectionId) : [],
				};
				if (message) {
					state.id = message.id;
					state.uncertain = false;
					this.#requireGuild();
					await message.edit({
						...payload,
						attachments: [],
						embeds: [],
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

	async #ownerMessage(message: Message): Promise<void> {
		if (
			!this.#handlers ||
			message.guildId !== this.#config.guildId ||
			message.author.id !== this.#config.ownerId ||
			message.author.bot ||
			message.webhookId ||
			message.system ||
			message.channel.type !== ChannelType.GuildText
		)
			return;
		// Check current permissions even before the broker's next reconciliation turn.
		if (!this.#private(message.channel)) return;
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
		let acknowledgement: ModeControlResult;
		try {
			acknowledgement = await this.#handlers.ownerMessage({
				id: message.id,
				channelId: message.channelId,
				ownerId: message.author.id,
				text: rejected ? "" : text,
				kind,
				...(rejected === undefined ? {} : { rejected }),
			});
		} catch (error) {
			if (!(error instanceof DiscordModeError)) throw error;
			acknowledgement = { text: error.message };
		}
		// An empty response means this is not a bound Haiso channel. Do not speak there.
		if (!acknowledgement.text) return;
		const key = `${PREFIX}ack:${message.id}`;
		const channel = message.channel;
		await this.#once(key, async () => {
			await this.#send(channel, key, {
				...this.#textPayload(acknowledgement.text),
				components:
					acknowledgement.deliveryId && acknowledgement.connectionId
						? this.#queuedComponents(message.channelId, acknowledgement.connectionId, acknowledgement.deliveryId)
						: [],
			});
		});
	}

	async showDialog(channelId: string, dialog: ModeDialog): Promise<void> {
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
				message = await this.#send(channel, marker, {
					content:
						"Native session input. Read the attached FULL prompt before answering. Controls answer the original session; a local answer may win first. Input/editor limit: 4000 characters.",
					files: [new AttachmentBuilder(Buffer.from(full, "utf8"), { name: "native-input.txt" })],
					components: this.#dialogComponents(token, dialog),
				});
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

	#controlPayload(channelId: string, result: ModeControlResult): ControlPayload {
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

	async #sessionInteraction(interaction: ReplyInteraction): Promise<void> {
		let action: ModeControlRequest["action"];
		let connectionId: string | undefined;
		let deliveryId: string | undefined;
		if (interaction.isChatInputCommand()) {
			const subcommand = interaction.options.getSubcommand(false);
			if (
				interaction.commandId !== this.#sessionCommandId ||
				interaction.commandGuildId !== this.#config.guildId ||
				(subcommand !== "status" && subcommand !== "stop" && subcommand !== "queue")
			) {
				await this.#reply(
					interaction,
					"This session command is outdated or unavailable. Use this guild's /session command.",
				);
				return;
			}
			action = subcommand;
		} else {
			const match =
				"customId" in interaction
					? /^haiso:s:(\d{1,22}):([a-f0-9-]{36}):([A-Za-z0-9_-]{22})?:(status|stop|queue|steer|cancel|queue0|queue1)$/i.exec(
							interaction.customId,
						)
					: null;
			if (!match || match[1] !== interaction.channelId || !UUID.test(match[2]!)) {
				await this.#reply(interaction, "This session control is invalid or belongs to another channel.");
				return;
			}
			connectionId = match[2]!;
			const selected = match[4] === "queue0" || match[4] === "queue1";
			if (
				selected &&
				interaction.isStringSelectMenu() &&
				interaction.values.length === 1 &&
				UUID.test(interaction.values[0]!)
			) {
				action = "queue";
				deliveryId = interaction.values[0]!;
			} else if (!selected && interaction.isButton()) {
				action = match[4] as ModeControlRequest["action"];
				if (match[3]) {
					const hex = Buffer.from(match[3], "base64url").toString("hex");
					deliveryId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
				}
				if ((action === "steer" || action === "cancel") !== Boolean(deliveryId)) {
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
		if (sessionCommand || ("customId" in interaction && interaction.customId.startsWith(SESSION_PREFIX))) {
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
