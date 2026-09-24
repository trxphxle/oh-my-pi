import { afterEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	type APIApplicationCommand,
	ApplicationCommandManager,
	ApplicationCommandType,
	AttachmentBuilder,
	ChannelType,
	Client,
	type ClientEvents,
	Collection,
	Events,
	GatewayIntentBits,
	type Guild,
	GuildApplicationCommandManager,
	type GuildChannelCreateOptions,
	type GuildChannelEditOptions,
	type Interaction,
	type Message,
	type InteractionEditReplyOptions,
	type MessageCreateOptions,
	type MessageEditOptions,
	MessageFlags,
	OverwriteType,
	PermissionFlagsBits,
	PermissionsBitField,
	type TextChannel,
} from "discord.js";
import { DiscordModeBroker, DiscordModeError } from "../../src/discord-mode/broker";
import { DiscordAdapter } from "../../src/discord-mode/discord";
import type { DiscordPortHandlers } from "@oh-my-pi/pi-wire/discord-mode";

const GUILD = "100000000000000001";
const OWNER = "100000000000000002";
const BOT = "100000000000000003";
const CHANNEL = "100000000000000004";
const ALL = PermissionsBitField.All;
const CONNECTION = "12345678-1234-4123-8123-123456789abc";
const DELIVERY = "87654321-4321-4321-8321-cba987654321";
const READ_WRITE =
	PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory | PermissionFlagsBits.SendMessages;
const adapters: DiscordAdapter[] = [];

afterEach(async () => {
	await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
	vi.restoreAllMocks();
});

async function settleEvents(): Promise<void> {
	const settled = Promise.withResolvers<void>();
	setImmediate(settled.resolve);
	await settled.promise;
}

function fixture() {
	const client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { retries: 0 } });
	Object.defineProperty(client, "user", { value: { id: BOT, bot: true }, configurable: true });
	vi.spyOn(client, "isReady").mockReturnValue(true);
	const login = vi.spyOn(client, "login").mockRejectedValue(new Error("Offline fixture must never log in"));
	const history = new Collection<string, Message>();
	const sent: MessageCreateOptions[] = [];
	const edited: MessageEditOptions[] = [];
	const created: GuildChannelCreateOptions[] = [];
	let nextId = 100;
	let fetchError: unknown;
	let sendError: "before" | "after" | undefined;
	let channelError: "before" | "after" | undefined;
	let channelDeleted = false;
	let gatewayEvents: Record<string, unknown>[] = [{}];
	let effective = ALL;
	let rolesGate: Promise<void> | undefined;
	const overwrites = new Collection<
		string,
		{ id: string; type: OverwriteType; allow: PermissionsBitField; deny: PermissionsBitField }
	>();
	overwrites.set(GUILD, {
		id: GUILD,
		type: OverwriteType.Role,
		allow: new PermissionsBitField(0n),
		deny: new PermissionsBitField(PermissionFlagsBits.ViewChannel),
	});
	overwrites.set(OWNER, {
		id: OWNER,
		type: OverwriteType.Member,
		allow: new PermissionsBitField(READ_WRITE),
		deny: new PermissionsBitField(0n),
	});
	overwrites.set(BOT, {
		id: BOT,
		type: OverwriteType.Member,
		allow: new PermissionsBitField(ALL),
		deny: new PermissionsBitField(0n),
	});

	function makeMessage(payload: MessageCreateOptions, channelId = CHANNEL): Message {
		const id = String(nextId++);
		const message = {
			id,
			channelId,
			guildId: GUILD,
			nonce: payload.nonce,
			author: { id: BOT, bot: true },
			webhookId: null,
			embeds: payload.embeds ?? [],
			content: payload.content ?? "",
			edit: async (update: MessageEditOptions) => {
				edited.push(update);
				if (!history.has(id)) throw { code: 10008 };
				Object.assign(message, update);
				return message as unknown as Message;
			},
		} as const;
		return message as unknown as Message;
	}

	const channel = {
		id: CHANNEL,
		guildId: GUILD,
		name: "session",
		type: ChannelType.GuildText,
		parentId: "category",
		topic: `haiso:session:${CONNECTION}`,
		permissionOverwrites: { cache: overwrites },
		permissionsFor: () => new PermissionsBitField(effective),
		messages: {
			fetch: async (options: { message?: string; before?: string; limit?: number }) => {
				if (options.message) {
					const message = history.get(options.message);
					if (!message) throw { code: 10008 };
					return message;
				}
				const page = new Collection<string, Message>();
				for (const [id, message] of [...history].reverse()) {
					if (options.before && Number(id) >= Number(options.before)) continue;
					page.set(id, message);
					if (page.size === (options.limit ?? 100)) break;
				}
				return page;
			},
		},
		async send(this: { id: string }, payload: MessageCreateOptions) {
			sent.push(payload);
			const failure = sendError;
			sendError = undefined;
			if (failure === "before") throw new Error("timeout");
			const message = makeMessage(payload, this.id);
			history.set(message.id, message);
			const events = gatewayEvents;
			setImmediate(() => {
				for (const overrides of events)
					client.emit(Events.MessageCreate, { ...message, ...overrides } as ClientEvents["messageCreate"][0]);
			});
			if (failure === "after") throw new Error("lost response");
			return message;
		},
		setName: vi.fn(async (name: string) => {
			channel.name = name;
		}),
		setParent: vi.fn(async (id: string) => {
			channel.parentId = id;
		}),
		edit: vi.fn(async function (this: { name: string; topic: string }, options: GuildChannelEditOptions) {
			const failure = channelError;
			channelError = undefined;
			if (failure === "before") throw new Error("Authorization: private-token");
			if (options.name !== undefined) this.name = options.name;
			if (options.topic !== undefined) this.topic = options.topic ?? "";
			if (failure === "after") throw new Error("Authorization: private-token");
			return this;
		}),
		delete: vi.fn(async function (this: { id: string }) {
			const failure = channelError;
			channelError = undefined;
			if (failure === "before") throw new Error("Authorization: private-token");
			if (this.id === CHANNEL) channelDeleted = true;
			else channels.delete(this.id);
			for (const [id, message] of history) {
				if (message.channelId === this.id) history.delete(id);
			}
			if (failure === "after") throw new Error("Authorization: private-token");
			return this;
		}),
	};
	const category = { ...channel, id: "category", type: ChannelType.GuildCategory, parentId: null };
	const channels = new Map<string, typeof channel | typeof category>();
	const guild = {
		id: GUILD,
		available: true,
		members: {
			fetchMe: async () => ({ id: BOT, permissions: new PermissionsBitField(effective) }),
			fetch: async () => ({ id: OWNER, user: { bot: false } }),
		},
		roles: {
			fetch: async () => {
				await rolesGate;
				return new Collection();
			},
		},
		channels: {
			fetch: async (id: string) => {
				if (fetchError) throw fetchError;
				if (id === CHANNEL) {
					if (channelDeleted) throw { code: 10003 };
					return channel;
				}
				if (id === "category" || id === "destination") return { ...category, id };
				return channels.get(id) ?? null;
			},
			create: async (options: GuildChannelCreateOptions) => {
				created.push(options);
				const createdChannel = {
					...channel,
					id: String(nextId++),
					name: options.name,
					type: options.type ?? ChannelType.GuildText,
					parentId: typeof options.parent === "string" ? options.parent : (options.parent?.id ?? null),
					topic: options.topic ?? "",
				};
				channels.set(createdChannel.id, createdChannel);
				return createdChannel;
			},
		},
	};
	const guildCommands = new Map<string, APIApplicationCommand>();
	const globalCommands = new Map<string, APIApplicationCommand>();
	const commandRequests: Array<{ method: string; route: string }> = [];
	let commandError: Error | undefined;
	function addCommand(
		scope: "guild" | "global",
		name: string,
		type = ApplicationCommandType.ChatInput,
		applicationId = BOT,
	) {
		const command: APIApplicationCommand = {
			id: String(nextId++),
			application_id: applicationId,
			...(scope === "guild" ? { guild_id: GUILD } : {}),
			name,
			type,
			description: type === ApplicationCommandType.ChatInput ? "Old command" : "",
			options: [],
			default_member_permissions: null,
			version: "1",
		};
		(scope === "guild" ? guildCommands : globalCommands).set(command.id, command);
		return command;
	}
	const commandManager = Reflect.construct(ApplicationCommandManager, [client]) as ApplicationCommandManager;
	Object.defineProperty(client, "application", { value: { id: BOT, commands: commandManager }, configurable: true });
	Object.assign(guild, {
		client,
		commands: Reflect.construct(GuildApplicationCommandManager, [{ ...guild, client }]),
	});
	// Exercise real SDK command managers and ApplicationCommand.equals; fake only REST.
	vi.spyOn(client.rest, "get").mockImplementation(async route => {
		commandRequests.push({ method: "GET", route });
		return [...(route.includes(`/guilds/${GUILD}/`) ? guildCommands : globalCommands).values()];
	});
	vi.spyOn(client.rest, "delete").mockImplementation(async route => {
		commandRequests.push({ method: "DELETE", route });
		const commands = route.includes(`/guilds/${GUILD}/`) ? guildCommands : globalCommands;
		commands.delete(route.split("/").at(-1)!);
		if (commandError) throw commandError;
		return undefined;
	});
	vi.spyOn(client.rest, "post").mockImplementation(async (route, options) => {
		commandRequests.push({ method: "POST", route });
		const command = addCommand(route.includes(`/guilds/${GUILD}/`) ? "guild" : "global", "session");
		Object.assign(command, options?.body);
		if (commandError) throw commandError;
		return command;
	});
	vi.spyOn(client.rest, "patch").mockImplementation(async (route, options) => {
		commandRequests.push({ method: "PATCH", route });
		const command = (route.includes(`/guilds/${GUILD}/`) ? guildCommands : globalCommands).get(
			route.split("/").at(-1)!,
		)!;
		Object.assign(command, options?.body);
		if (commandError) throw commandError;
		return command;
	});
	vi.spyOn(client.rest, "put").mockRejectedValue(new Error("Bulk command overwrite is forbidden"));
	vi.spyOn(client.guilds, "fetch").mockImplementation(
		(async () => guild as unknown as Guild) as unknown as typeof client.guilds.fetch,
	);
	const inputs: Array<Parameters<DiscordPortHandlers["ownerMessage"]>[0]> = [];
	const answers: Array<Parameters<DiscordPortHandlers["answer"]>[0]> = [];
	const controls: Array<Parameters<DiscordPortHandlers["control"]>[0]> = [];
	const connections: boolean[] = [];
	const handlers: DiscordPortHandlers = {
		ownerMessage: async input => {
			inputs.push(input);
			return {
				text: input.channelId === CHANNEL ? (input.rejected ?? "Queued, not yet accepted.") : "",
				...(!input.rejected && input.kind === "message" && input.channelId === CHANNEL
					? { connectionId: CONNECTION, deliveryId: DELIVERY }
					: {}),
			};
		},
		control: async input => {
			controls.push(input);
			return { text: "No session is bound to this channel." };
		},
		answer: async input => {
			answers.push(input);
			return "Local answer already won.";
		},
		changed: vi.fn(async () => {}),
		connection: connected => {
			connections.push(connected);
		},
	};
	function newAdapter() {
		const adapter = new DiscordAdapter(
			{ botToken: "offline-not-a-token", guildId: GUILD, ownerId: OWNER },
			{ client },
		);
		adapters.push(adapter);
		return adapter;
	}
	const adapter = newAdapter();

	function ownerMessage(content: string, overrides: Record<string, unknown> = {}): ClientEvents["messageCreate"][0] {
		return {
			id: String(nextId++),
			guildId: GUILD,
			channelId: CHANNEL,
			channel,
			author: { id: OWNER, bot: false },
			webhookId: null,
			system: false,
			content,
			attachments: new Collection(),
			stickers: new Collection(),
			messageSnapshots: new Collection(),
			...overrides,
		} as unknown as ClientEvents["messageCreate"][0];
	}

	function interaction(customId: string, overrides: Record<string, unknown> = {}) {
		const responses: string[] = [];
		const payloads: InteractionEditReplyOptions[] = [];
		const acknowledgements: unknown[] = [];
		const modals: unknown[] = [];
		const event = {
			id: String(nextId++),
			customId,
			guildId: GUILD,
			channelId: CHANNEL,
			user: { id: OWNER, bot: false },
			message: history.last(),
			values: ["0"],
			deferred: false,
			replied: false,
			isRepliable: () => true,
			isChatInputCommand: () => false,
			isButton: () => !/:choose$|:submit$|:queue[01]$/.test(customId),
			isStringSelectMenu: () => /:choose$|:queue[01]$/.test(customId),
			isModalSubmit: () => customId.endsWith(":submit"),
			isMessageComponent: () => !customId.endsWith(":submit"),
			fields: { getTextInputValue: () => "edited text" },
			reply: async (payload: InteractionEditReplyOptions) => {
				payloads.push(payload);
				responses.push(payload.content ?? "");
				event.replied = true;
			},
			editReply: async (payload: InteractionEditReplyOptions) => {
				payloads.push(payload);
				responses.push(payload.content ?? "");
			},
			deferReply: async (payload: unknown) => {
				acknowledgements.push(payload);
				event.deferred = true;
			},
			showModal: async (modal: unknown) => {
				modals.push(modal);
			},
			...overrides,
		};
		return { event: event as unknown as Interaction, responses, modals, payloads, acknowledgements };
	}

	function slash(subcommand: string, overrides: Record<string, unknown> = {}) {
		return interaction("", {
			commandName: "session",
			commandId: [...guildCommands.values()].find(
				command => command.name === "session" && command.type === ApplicationCommandType.ChatInput,
			)?.id,
			commandGuildId: GUILD,
			options: { getSubcommand: () => subcommand },
			isChatInputCommand: () => true,
			isButton: () => false,
			isMessageComponent: () => false,
			...overrides,
		});
	}

	return {
		adapter,
		newAdapter,
		makeMessage,
		client,
		login,
		channel,
		channels,
		history,
		sent,
		edited,
		created,
		overwrites,
		inputs,
		answers,
		controls,
		slash,
		guildCommands,
		globalCommands,
		addCommand,
		commandRequests,
		setCommandError: (error: Error) => {
			commandError = error;
		},
		connections,
		handlers,
		ownerMessage,
		interaction,
		setFetchError: (error: unknown) => {
			fetchError = error;
		},
		setSendError: (error: "before" | "after") => {
			sendError = error;
		},
		setChannelError: (error: "before" | "after") => {
			channelError = error;
		},
		setGatewayEvents: (events: Record<string, unknown>[]) => {
			gatewayEvents = events;
		},
		setEffective: (permissions: bigint) => {
			effective = permissions;
		},
		setRolesGate: (gate: Promise<void> | undefined) => {
			rolesGate = gate;
		},
	};
}

function controlId(payload: MessageCreateOptions, action: string): string {
	for (const row of payload.components ?? []) {
		const data = "toJSON" in row ? row.toJSON() : row;
		if (!("components" in data)) continue;
		for (const component of data.components) {
			if ("custom_id" in component && component.custom_id?.endsWith(`:${action}`)) return component.custom_id;
		}
	}
	throw new Error(`Missing ${action} control`);
}

async function enroll(
	broker: DiscordModeBroker,
	root: string,
	sessionId: string = crypto.randomUUID(),
	connectionId: string = crypto.randomUUID(),
) {
	return broker.request({
		op: "register",
		requestId: crypto.randomUUID(),
		sessionId,
		sessionFile: path.join(root, `${sessionId}.jsonl`),
		projectDir: root,
		connectionId,
		label: "session",
		groupName: "project",
	});
}
describe("Discord mode gateway adapter (offline)", () => {
	it("migrates both command scopes without deleting unrelated commands or overwriting the registry", async () => {
		const f = fixture();
		for (const scope of ["guild", "global"] as const) {
			for (const name of ["omp", "team", "tell", "session"]) f.addCommand(scope, name);
			f.addCommand(scope, "unrelated");
			f.addCommand(scope, "omp", ApplicationCommandType.Message);
			f.addCommand(scope, "tell", ApplicationCommandType.ChatInput, "another-application");
		}
		const oldSession = [...f.guildCommands.values()].find(command => command.name === "session")!;
		oldSession.default_member_permissions = "0";
		await f.adapter.start(f.handlers);
		for (const registry of [f.guildCommands, f.globalCommands]) {
			expect([...registry.values()].filter(command => command.name === "unrelated")).toHaveLength(1);
			expect(
				[...registry.values()].filter(
					command => command.name === "omp" && command.type === ApplicationCommandType.Message,
				),
			).toHaveLength(1);
			expect(
				[...registry.values()].filter(command => command.application_id === "another-application"),
			).toHaveLength(1);
			expect(
				[...registry.values()].filter(
					command =>
						command.application_id === BOT &&
						command.type === ApplicationCommandType.ChatInput &&
						["omp", "team", "tell"].includes(command.name),
				),
			).toEqual([]);
		}
		expect([...f.globalCommands.values()].some(command => command.name === "session")).toBe(false);
		const session = [...f.guildCommands.values()].find(command => command.name === "session")!;
		expect(session.id).toBe(oldSession.id);
		expect(session.default_member_permissions).toBeNull();
		expect(session.options?.map(option => option.name)).toEqual(["status", "stop", "queue"]);
		expect(f.commandRequests.slice(0, 2).map(request => request.method)).toEqual(["GET", "GET"]);
		expect(f.client.rest.put).not.toHaveBeenCalled();

		await f.adapter.close();
		const mutations = f.commandRequests.filter(request => request.method !== "GET").length;
		const restarted = new DiscordAdapter(
			{ botToken: "offline-not-a-token", guildId: GUILD, ownerId: OWNER },
			{ client: f.client },
		);
		adapters.push(restarted);
		await restarted.start(f.handlers);
		expect(f.commandRequests.filter(request => request.method !== "GET")).toHaveLength(mutations);
	});

	it("does not retry a response-lost registration mutation or expose the SDK error", async () => {
		const f = fixture();
		f.addCommand("guild", "omp");
		f.setCommandError(new Error("Authorization: private-token"));
		await expect(f.adapter.start(f.handlers)).rejects.toThrow("Discord startup failed");
		expect(f.commandRequests.filter(request => request.method === "DELETE")).toHaveLength(1);
		expect(f.commandRequests.some(request => request.method === "POST")).toBe(false);
		expect([...f.guildCommands.values()].some(command => command.name === "omp")).toBe(false);
	});

	it("keeps generation-bound session controls on status updates and clears them when disconnected", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		await f.adapter.status(CHANNEL, "running", "session", CONNECTION);
		const initial = f.sent[0]!;
		for (const action of ["stop", "queue", "status"])
			expect(controlId(initial, action).length).toBeLessThanOrEqual(100);
		const oldStop = controlId(initial, "stop");
		const nextConnection = crypto.randomUUID();
		await f.adapter.status(CHANNEL, "running", "session", nextConnection);
		expect(controlId(f.edited.at(-1)! as MessageCreateOptions, "stop")).not.toBe(oldStop);
		await f.adapter.status(CHANNEL, "disconnected", "session");
		expect(f.edited.at(-1)?.components).toEqual([]);
	});

	it("rejects owner, guild, copied-channel, obsolete-command, and non-private control routing", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		await f.adapter.status(CHANNEL, "running", "session", CONNECTION);
		const stop = controlId(f.sent[0]!, "stop");
		for (const override of [
			{ user: { id: "outsider", bot: false } },
			{ user: { id: OWNER, bot: true } },
			{ guildId: "another-guild" },
			{ channelId: "100000000000000099" },
		])
			f.client.emit(Events.InteractionCreate, f.interaction(stop, override).event);
		for (const override of [
			{ commandGuildId: null },
			{ commandId: "old-command" },
			{ channelId: "category" },
			{ channelId: "100000000000000099" },
		])
			f.client.emit(Events.InteractionCreate, f.slash("stop", override).event);
		await settleEvents();
		expect(f.controls).toEqual([]);
		f.overwrites.set("public-role", {
			id: "public-role",
			type: OverwriteType.Role,
			allow: new PermissionsBitField(PermissionFlagsBits.ViewChannel),
			deny: new PermissionsBitField(0n),
		});
		const denied = f.slash("stop");
		f.client.emit(Events.InteractionCreate, denied.event);
		await settleEvents();
		expect(f.controls).toEqual([]);
		expect(denied.responses[0]).toContain("private");
	});

	it("defers before slow broker controls and safely reports failures without retrying", async () => {
		const f = fixture();
		const gate = Promise.withResolvers<void>();
		let entered = false;
		f.handlers.control = async () => {
			entered = true;
			await gate.promise;
			throw new Error("Authorization: private-token");
		};
		await f.adapter.start(f.handlers);
		const request = f.slash("stop");
		f.client.emit(Events.InteractionCreate, request.event);
		await settleEvents();
		expect(entered).toBe(true);
		expect(request.acknowledgements).toEqual([{ flags: MessageFlags.Ephemeral }]);
		expect(request.responses).toEqual([]);
		gate.resolve();
		await settleEvents();
		expect(request.responses[0]).toContain("uncertain");
		expect(request.responses[0]).not.toContain("private-token");
		expect(request.payloads[0]?.allowedMentions).toEqual({ parse: [], repliedUser: false });
	});

	it("preserves the full held queue without actionable controls when no generation is live", async () => {
		const f = fixture();
		const texts = Array.from({ length: 32 }, (_, index) => `Held request ${index + 1}: ${"verbatim ".repeat(40)}`);
		f.handlers.control = async () => ({
			text: "Disconnected; queued messages are held.",
			queued: texts.map(text => ({ id: crypto.randomUUID(), text, held: true, actionable: false, createdAt: 1 })),
		});
		await f.adapter.start(f.handlers);
		const view = f.slash("queue");
		f.client.emit(Events.InteractionCreate, view.event);
		await settleEvents();
		const payload = view.payloads[0]!;
		const attachment = payload.files?.[0] as AttachmentBuilder;
		const full = Buffer.from(attachment.attachment as Buffer).toString("utf8");
		for (const text of texts) expect(full).toContain(text);
		expect(payload.components).toEqual([]);
	});

	it("routes slash and button stops into the same broker action, rejecting failed acknowledgments and stale generations", async () => {
		using temporary = TempDir.createSync("@discord-session-controls-");
		const f = fixture();
		const broker = new DiscordModeBroker({
			config: { botToken: "offline-not-a-token", guildId: GUILD, ownerId: OWNER },
			storePath: path.join(temporary.path(), "private", "state.json"),
			port: f.adapter,
		});
		await broker.start();
		try {
			const registered = await enroll(broker, temporary.path());
			const lease = registered.lease!;
			const channelId = registered.session.channelId!;
			const sessionCard = f.sent.find(payload =>
				payload.components?.some(row => {
					const data = "toJSON" in row ? row.toJSON() : row;
					return (
						"components" in data &&
						data.components.some(
							component => "custom_id" in component && component.custom_id?.includes(channelId),
						)
					);
				}),
			)!;
			const stop = controlId(sessionCard, "stop");
			for (const failed of [
				f.interaction(stop, {
					channelId,
					deferReply: async () => {
						throw new Error("Expired interaction");
					},
				}),
				f.slash("stop", {
					channelId,
					deferReply: async () => {
						throw new Error("Expired interaction");
					},
				}),
			]) {
				f.client.emit(Events.InteractionCreate, failed.event);
				await settleEvents();
				expect((await broker.request({ op: "poll", lease, busy: true, pendingInput: false })).deliveries).toEqual(
					[],
				);
			}
			for (const request of [f.slash("stop", { channelId }), f.interaction(stop, { channelId })]) {
				f.client.emit(Events.InteractionCreate, request.event);
				await settleEvents();
				const polled = await broker.request({ op: "poll", lease, busy: true, pendingInput: false });
				expect(polled.deliveries).toMatchObject([{ kind: "abort", source: "owner", state: "dispatched" }]);
				await broker.request({ op: "receipt", lease, deliveryId: polled.deliveries[0]!.id, state: "completed" });
				expect(request.acknowledgements).toEqual([{ flags: MessageFlags.Ephemeral }]);
				// An identical gateway interaction may be delivered twice; never enqueue twice.
				f.client.emit(Events.InteractionCreate, request.event);
				await settleEvents();
				expect((await broker.request({ op: "poll", lease, busy: true, pendingInput: false })).deliveries).toEqual(
					[],
				);
			}
			await broker.request({ op: "off", lease });
			const replacement = await enroll(broker, temporary.path(), lease.sessionId);
			const stale = f.interaction(stop, { channelId });
			f.client.emit(Events.InteractionCreate, stale.event);
			await settleEvents();
			expect(
				(await broker.request({ op: "poll", lease: replacement.lease!, busy: true, pendingInput: false }))
					.deliveries,
			).toEqual([]);
			expect(stale.responses.join(" ")).toMatch(/stale|revoked|connection|generation/i);
		} finally {
			await broker.close();
		}
	});

	it("keeps all 32 owner queue entries selectable, shows full text, and mutates existing messages without replay", async () => {
		using temporary = TempDir.createSync("@discord-session-queue-");
		const f = fixture();
		const broker = new DiscordModeBroker({
			config: { botToken: "offline-not-a-token", guildId: GUILD, ownerId: OWNER },
			storePath: path.join(temporary.path(), "private", "state.json"),
			port: f.adapter,
		});
		await broker.start();
		try {
			const registered = await enroll(broker, temporary.path());
			const lease = registered.lease!;
			const channelId = registered.session.channelId!;
			const fullText = `Last queue item: ${"inspect carefully ".repeat(160)}`;
			for (let index = 0; index < 32; index++) {
				const message = f.ownerMessage(index === 31 ? fullText : `Queued ${index + 1}`, {
					channelId,
					channel: f.channels.get(channelId),
				});
				f.client.emit(Events.MessageCreate, message);
				await broker.request({ op: "status", lease });
			}
			await settleEvents();
			const view = f.slash("queue", { channelId });
			f.client.emit(Events.InteractionCreate, view.event);
			await settleEvents();
			await broker.request({ op: "status", lease });
			await settleEvents();
			const menus = (view.payloads[0]?.components ?? []).flatMap(row => {
				const data = "toJSON" in row ? row.toJSON() : row;
				return "components" in data ? data.components.filter(component => "options" in component) : [];
			});
			expect(menus.map(menu => ("options" in menu ? menu.options.length : 0))).toEqual([25, 7]);
			const ids = menus.flatMap(menu => ("options" in menu ? menu.options.map(option => option.value) : []));
			expect(new Set(ids).size).toBe(32);
			const lastMenu = menus[1]!;
			if (!("custom_id" in lastMenu)) throw new Error("Missing queue select menu");
			const selected = f.interaction(lastMenu.custom_id!, { channelId, values: [ids[31]] });
			f.client.emit(Events.InteractionCreate, selected.event);
			await settleEvents();
			await broker.request({ op: "status", lease });
			await settleEvents();
			const detail = selected.payloads[0]!;
			const attachment = detail.files?.[0] as AttachmentBuilder;
			expect(Buffer.from(attachment.attachment as Buffer).toString("utf8")).toContain(fullText);
			const guidance = controlId(detail as MessageCreateOptions, "steer");
			const cancel = controlId(detail as MessageCreateOptions, "cancel");
			expect(guidance.length).toBeLessThanOrEqual(100);
			const convert = f.interaction(guidance, { channelId });
			f.client.emit(Events.InteractionCreate, convert.event);
			await settleEvents();
			const steered = await broker.request({ op: "poll", lease, busy: true, pendingInput: false });
			expect(steered.deliveries).toMatchObject([
				{ id: ids[31], kind: "steer", text: fullText, state: "dispatched" },
			]);
			const tooLate = f.interaction(cancel, { channelId });
			f.client.emit(Events.InteractionCreate, tooLate.event);
			await settleEvents();
			expect((await broker.request({ op: "poll", lease, busy: true, pendingInput: false })).deliveries).toEqual([]);
			expect(tooLate.responses.join(" ")).toMatch(/dispatched|accepted|no longer|not.*queued/i);

			const firstMenu = menus[0]!;
			if (!("custom_id" in firstMenu)) throw new Error("Missing queue select menu");
			const first = f.interaction(firstMenu.custom_id!, { channelId, values: [ids[0]] });
			f.client.emit(Events.InteractionCreate, first.event);
			await settleEvents();
			await broker.request({ op: "status", lease });
			await settleEvents();
			const cancelFirst = controlId(first.payloads[0]! as MessageCreateOptions, "cancel");
			const firstAck = f.sent.find(payload => JSON.stringify(payload.components ?? []).includes(cancelFirst))!;
			f.client.emit(Events.InteractionCreate, f.interaction(controlId(firstAck, "cancel"), { channelId }).event);
			await settleEvents();
			await broker.request({ op: "status", lease });
			const duplicate = f.interaction(cancelFirst, { channelId });
			f.client.emit(Events.InteractionCreate, duplicate.event);
			await settleEvents();
			await broker.request({ op: "status", lease });
			await settleEvents();
			expect(duplicate.responses.join(" ")).toMatch(/cancelled|no longer|not.*queued/i);
			await broker.request({ op: "receipt", lease, deliveryId: ids[31]!, state: "completed" });
			const remaining = await broker.request({ op: "poll", lease, busy: false, pendingInput: false });
			expect(remaining.deliveries[0]).toMatchObject({ id: ids[1], text: "Queued 2" });
			expect(remaining.deliveries.some(delivery => delivery.id === ids[0] || delivery.id === ids[31])).toBe(false);
		} finally {
			await broker.close();
		}
	});

	it("delivers gateway owner text through the broker and publishes the completed reply", async () => {
		using temporary = TempDir.createSync("@discord-gateway-broker-");
		const f = fixture();
		const broker = new DiscordModeBroker({
			config: { botToken: "offline-not-a-token", guildId: GUILD, ownerId: OWNER },
			storePath: path.join(temporary.path(), "private", "state.json"),
			port: f.adapter,
		});
		await broker.start();
		try {
			const sessionId = crypto.randomUUID();
			const registered = await broker.request({
				op: "register",
				requestId: crypto.randomUUID(),
				sessionId,
				sessionFile: path.join(temporary.path(), `${sessionId}.jsonl`),
				projectDir: temporary.path(),
				connectionId: crypto.randomUUID(),
				label: "session",
				groupName: "project",
			});
			const lease = registered.lease!;
			const channelId = registered.session.channelId!;
			f.client.emit(
				Events.MessageCreate,
				f.ownerMessage("Hi there", { channelId, channel: f.channels.get(channelId) }),
			);
			const polled = await broker.request({ op: "poll", lease, busy: false, pendingInput: false });
			expect(polled.deliveries).toMatchObject([
				{ source: "owner", kind: "message", text: "Hi there", state: "dispatched" },
			]);
			await broker.request({
				op: "receipt",
				lease,
				deliveryId: polled.deliveries[0]!.id,
				state: "completed",
				text: "Hello from the native session",
			});
			expect(f.sent.some(message => message.content?.includes("Hello from the native session"))).toBe(true);
		} finally {
			await broker.close();
		}
	});

	it("routes only owner/guild human input, refuses whole attachment requests, and keeps unbound channels silent", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		for (const override of [
			{ author: { id: "outsider", bot: false } },
			{ guildId: "other" },
			{ author: { id: OWNER, bot: true } },
			{ webhookId: "webhook" },
			{ system: true },
		])
			f.client.emit(Events.MessageCreate, f.ownerMessage("secret", override));
		await settleEvents();
		expect(f.inputs).toEqual([]);
		expect(f.sent).toEqual([]);
		for (const message of [
			f.ownerMessage("plain prompt"),
			f.ownerMessage("!steer stop and inspect"),
			f.ownerMessage("!abort"),
			f.ownerMessage("partial prompt", { attachments: new Collection([["file", {}]]) }),
			f.ownerMessage("!abort extra"),
			f.ownerMessage("unbound", { channelId: "other" }),
		])
			f.client.emit(Events.MessageCreate, message);
		await settleEvents();
		expect(f.inputs.map(input => [input.kind, input.text])).toEqual([
			["message", "plain prompt"],
			["steer", "stop and inspect"],
			["abort", ""],
			["message", ""],
			["message", ""],
			["message", "unbound"],
		]);
		expect(f.inputs[3]?.rejected).toContain("Nothing was forwarded");
		expect(f.inputs[4]?.rejected).toContain("exactly !abort");
		expect(f.sent).toHaveLength(5);
		expect(controlId(f.sent[0]!, "steer")).toBeTruthy();
		expect(controlId(f.sent[0]!, "cancel")).toBeTruthy();
		expect(f.sent.slice(1).every(payload => !payload.components?.length)).toBe(true);
		for (const payload of f.sent) expect(payload.allowedMentions).toEqual({ parse: [], repliedUser: false });
		expect(f.login).not.toHaveBeenCalled();
	});

	it("requires explicit private overwrites on every resource and distinguishes missing/access/network failures", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		await f.adapter.createCategory("My Project");
		await f.adapter.createChannel("category", "Session One", "haiso:session:one");
		for (const created of f.created) {
			expect(created.permissionOverwrites).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: GUILD, deny: PermissionFlagsBits.ViewChannel }),
					expect.objectContaining({ id: OWNER, type: OverwriteType.Member }),
					expect.objectContaining({ id: BOT, type: OverwriteType.Member }),
				]),
			);
		}
		expect(await f.adapter.inspect(CHANNEL)).toMatchObject({ state: "found", channel: { private: true } });
		f.overwrites.set("public-role", {
			id: "public-role",
			type: OverwriteType.Role,
			allow: new PermissionsBitField(PermissionFlagsBits.ViewChannel),
			deny: new PermissionsBitField(0n),
		});
		expect(await f.adapter.inspect(CHANNEL)).toMatchObject({ state: "found", channel: { private: false } });
		await expect(f.adapter.publish(CHANNEL, "private secret", "private")).rejects.toThrow("not explicitly");
		expect(f.sent).toHaveLength(0);
		f.setFetchError({ code: 10003 });
		expect(await f.adapter.inspect(CHANNEL)).toEqual({ state: "missing" });
		f.setFetchError({ code: 50013 });
		expect(await f.adapter.inspect(CHANNEL)).toEqual({ state: "inaccessible" });
		f.setFetchError(new Error("network reset"));
		await expect(f.adapter.inspect(CHANNEL)).rejects.toThrow("deletion is not confirmed");
	});

	it("renames safely and moves without inheriting destination permissions", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		await f.adapter.rename(CHANNEL, "My Session");
		expect(await f.adapter.inspect(CHANNEL)).toMatchObject({ channel: { name: "my-session" } });
		await f.adapter.move(CHANNEL, "destination");
		expect(f.channel.setParent).toHaveBeenCalledWith(
			"destination",
			expect.objectContaining({ lockPermissions: false }),
		);
		expect(await f.adapter.inspect(CHANNEL)).toMatchObject({ channel: { parentId: "destination", private: true } });
		f.setEffective(READ_WRITE | PermissionFlagsBits.AttachFiles | PermissionFlagsBits.EmbedLinks);
		await expect(f.adapter.rename(CHANNEL, "denied")).rejects.toThrow("Manage Channels");
	});

	it("retains history and permissions, archives once, and still delivers closed-channel owner notices", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		await f.adapter.publish(CHANNEL, "Keep this conversation", "retained-history");
		const history = [...f.history.values()];
		const permissions = [...f.overwrites.entries()];
		await f.adapter.retire(CHANNEL, CONNECTION, "retain");
		await f.adapter.retire(CHANNEL, CONNECTION, "retain");
		expect(f.channel.name).toBe("archived-session");
		expect(f.channel.topic).toContain(`haiso:session:${CONNECTION}`);
		expect(f.channel.topic).toContain("permanently deleted");
		expect(f.channel.edit).toHaveBeenCalledTimes(1);
		expect(Object.keys(f.channel.edit.mock.calls[0]![0]).sort()).toEqual(["name", "reason", "topic"]);
		expect(f.channel.delete).not.toHaveBeenCalled();
		expect([...f.history.values()]).toEqual(history);
		expect([...f.overwrites.entries()]).toEqual(permissions);
		expect(f.channel.parentId).toBe("category");
		expect(f.channel.setParent).not.toHaveBeenCalled();
		expect(f.created).toEqual([]);
		f.handlers.ownerMessage = async () => ({ text: "Conversation permanently deleted; nothing forwarded." });
		f.client.emit(Events.MessageCreate, f.ownerMessage("Please continue"));
		await settleEvents();
		expect(f.sent.at(-1)?.content).toContain("nothing forwarded");
		expect(f.sent.at(-1)?.components).toEqual([]);
	});

	it("requires exact session ownership, guild, text-channel identity, and private permissions before either policy", async () => {
		for (const policy of ["retain", "delete"] as const) {
			const f = fixture();
			await f.adapter.start(f.handlers);
			const original = {
				id: f.channel.id,
				guildId: f.channel.guildId,
				type: f.channel.type,
				topic: f.channel.topic,
			};
			for (const override of [
				{ id: "100000000000000099" },
				{ guildId: "another-guild" },
				{ type: ChannelType.GuildCategory },
				{ topic: `haiso:session:${DELIVERY}` },
				{ topic: `haiso:session:${CONNECTION}-different` },
				{ topic: `unowned haiso:session:${CONNECTION}` },
				{ topic: `haiso:session:${CONNECTION}\nhaiso:session:${DELIVERY}` },
			]) {
				Object.assign(f.channel, override);
				await expect(f.adapter.retire(CHANNEL, CONNECTION, policy)).rejects.toThrow("Discord retirement");
				Object.assign(f.channel, original);
			}
			f.overwrites.set("outsider", {
				id: "outsider",
				type: OverwriteType.Member,
				allow: new PermissionsBitField(PermissionFlagsBits.ViewChannel),
				deny: new PermissionsBitField(0n),
			});
			await expect(f.adapter.retire(CHANNEL, CONNECTION, policy)).rejects.toThrow("private");
			f.overwrites.delete("outsider");
			f.setEffective(READ_WRITE | PermissionFlagsBits.AttachFiles | PermissionFlagsBits.EmbedLinks);
			await expect(f.adapter.retire(CHANNEL, CONNECTION, policy)).rejects.toThrow("Manage Channels");
			expect(f.channel.edit).not.toHaveBeenCalled();
			expect(f.channel.delete).not.toHaveBeenCalled();
			expect(f.created).toEqual([]);
		}
	});

	it("only treats authoritative unknown-channel errors as completed retirement", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		for (const policy of ["retain", "delete"] as const) {
			for (const error of [{ code: 50001 }, { code: 50013 }, new Error("Authorization: private-token")]) {
				f.setFetchError(error);
				await expect(f.adapter.retire(CHANNEL, CONNECTION, policy)).rejects.toThrow("deletion is not confirmed");
			}
			f.setFetchError(undefined);
			await expect(f.adapter.retire("100000000000000099", CONNECTION, policy)).rejects.toThrow("exact bound");
			f.setFetchError({ code: 10003 });
			await f.adapter.retire(CHANNEL, CONNECTION, policy);
		}
		expect(f.channel.edit).not.toHaveBeenCalled();
		expect(f.channel.delete).not.toHaveBeenCalled();
		expect(f.created).toEqual([]);
	});

	it("deletes only the approved channel and treats subsequent authoritative absence as complete", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		await f.adapter.publish(CHANNEL, "Delete this history", "delete-history");
		const unrelated = f.makeMessage({ content: "Keep another channel" }, "100000000000000099");
		f.history.set(unrelated.id, unrelated);
		await f.adapter.retire(CHANNEL, CONNECTION, "retain");
		await f.adapter.retire(CHANNEL, CONNECTION, "delete");
		await f.adapter.retire(CHANNEL, CONNECTION, "delete");
		expect(await f.adapter.inspect(CHANNEL)).toEqual({ state: "missing" });
		expect(f.channel.delete).toHaveBeenCalledTimes(1);
		expect([...f.history.values()]).toEqual([unrelated]);
		expect(f.created).toEqual([]);
		expect(f.channel.setParent).not.toHaveBeenCalled();
	});

	it("confirms response-lost archive and deletion by inspecting the exact channel without replay", async () => {
		for (const policy of ["retain", "delete"] as const) {
			const f = fixture();
			await f.adapter.start(f.handlers);
			f.setChannelError("after");
			await f.adapter.retire(CHANNEL, CONNECTION, policy);
			await f.adapter.retire(CHANNEL, CONNECTION, policy);
			expect(f.channel.edit).toHaveBeenCalledTimes(policy === "retain" ? 1 : 0);
			expect(f.channel.delete).toHaveBeenCalledTimes(policy === "delete" ? 1 : 0);
			expect(await f.adapter.inspect(CHANNEL)).toMatchObject(
				policy === "retain"
					? { state: "found", channel: { name: "archived-session", private: true } }
					: { state: "missing" },
			);
			expect(f.created).toEqual([]);
		}
	});

	it("leaves unconfirmed mutations pending and redacts SDK errors instead of retrying", async () => {
		for (const policy of ["retain", "delete"] as const) {
			const f = fixture();
			await f.adapter.start(f.handlers);
			f.setChannelError("before");
			await expect(f.adapter.retire(CHANNEL, CONNECTION, policy)).rejects.toThrow("outcome is uncertain");
			expect(f.channel.name).toBe("session");
			expect(await f.adapter.inspect(CHANNEL)).toMatchObject({ state: "found" });
			expect(f.channel.edit).toHaveBeenCalledTimes(policy === "retain" ? 1 : 0);
			expect(f.channel.delete).toHaveBeenCalledTimes(policy === "delete" ? 1 : 0);
			expect(f.created).toEqual([]);
		}
	});

	it("cannot confirm an uncertain retirement through lost access or a rebound ownership marker", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		f.channel.edit.mockImplementationOnce(async () => {
			f.setFetchError({ code: 50013 });
			throw new Error("Authorization: private-token");
		});
		await expect(f.adapter.retire(CHANNEL, CONNECTION, "retain")).rejects.toThrow("deletion is not confirmed");
		f.setFetchError(undefined);
		f.channel.delete.mockImplementationOnce(async () => {
			f.channel.topic = `haiso:session:${DELIVERY}`;
			throw new Error("Authorization: private-token");
		});
		await expect(f.adapter.retire(CHANNEL, CONNECTION, "delete")).rejects.toThrow("ownership does not match");
		expect(f.channel.edit).toHaveBeenCalledTimes(1);
		expect(f.channel.delete).toHaveBeenCalledTimes(1);
	});

	it("surfaces safe retirement rejections for owner messages, controls, and native dialog answers", async () => {
		const f = fixture();
		const rejection = "Conversation permanently deleted; nothing forwarded.";
		f.handlers.ownerMessage = async () => {
			throw new DiscordModeError(rejection);
		};
		f.handlers.control = async () => {
			throw new DiscordModeError(rejection);
		};
		f.handlers.answer = async () => {
			throw new DiscordModeError(rejection);
		};
		await f.adapter.start(f.handlers);
		f.client.emit(Events.MessageCreate, f.ownerMessage("Continue"));
		await settleEvents();
		expect(f.sent.at(-1)?.content).toBe(rejection);
		expect(f.sent.at(-1)?.components).toEqual([]);
		const control = f.slash("stop");
		f.client.emit(Events.InteractionCreate, control.event);
		await settleEvents();
		expect(control.responses).toEqual([rejection]);
		await f.adapter.showDialog(CHANNEL, { id: "retired-dialog", kind: "confirm", title: "Approve?" });
		const answer = f.interaction(controlId(f.sent.at(-1)!, "yes"));
		f.client.emit(Events.InteractionCreate, answer.event);
		await settleEvents();
		expect(answer.responses).toEqual([rejection]);
		expect(f.edited.at(-1)?.components).toEqual([]);
	});

	it("does not leak untrusted dialog errors when a broker answer fails", async () => {
		const f = fixture();
		f.handlers.answer = async () => {
			throw new Error("Authorization: private-token");
		};
		await f.adapter.start(f.handlers);
		await f.adapter.showDialog(CHANNEL, { id: "failed-dialog", kind: "confirm", title: "Approve?" });
		const answer = f.interaction(controlId(f.sent.at(-1)!, "yes"));
		f.client.emit(Events.InteractionCreate, answer.event);
		await settleEvents();
		expect(answer.responses[0]).toContain("uncertain");
		expect(answer.responses[0]).not.toContain("private-token");
	});

	it("recovers a lost response from the gateway and preserves complete unicode chunks without mention notifications", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		f.setSendError("after");
		const text = `${"x".repeat(1_999)}\u{1F680}@everyone${"z".repeat(2_010)}`;
		await f.adapter.publish(CHANNEL, text, "result-1");
		await f.adapter.publish(CHANNEL, text, "result-1");
		expect(f.sent.map(payload => payload.content).join("")).toBe(text);
		expect(f.sent.every(payload => (payload.content?.length ?? 0) <= 2_000)).toBe(true);
		expect(f.history.size).toBe(f.sent.length);
		for (const payload of f.sent) {
			expect(payload.allowedMentions).toEqual({ parse: [], repliedUser: false });
			expect(payload.enforceNonce).toBe(true);
			expect(payload.embeds).toBeUndefined();
		}
	});

	it("refuses nonce, channel, author, and webhook mismatches even when a matching post exists in history", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		f.setGatewayEvents([
			{ nonce: "unrelated" },
			{ channelId: "other" },
			{ author: { id: "other-bot", bot: true } },
			{ webhookId: "webhook" },
		]);
		f.setSendError("after");
		await expect(f.adapter.publish(CHANNEL, "result", "mismatched")).rejects.toThrow("uncertain");
		await expect(f.adapter.publish(CHANNEL, "result", "mismatched")).rejects.toThrow("uncertain");
		expect(f.history.size).toBe(1);
		expect(f.sent).toHaveLength(1);
	});

	it("does not recover an unconfirmed lost response from message content or resend it", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		f.setGatewayEvents([]);
		f.setSendError("after");
		await expect(f.adapter.publish(CHANNEL, "result", "no-confirmation")).rejects.toThrow("uncertain");
		await expect(f.adapter.publish(CHANNEL, "result", "no-confirmation")).rejects.toThrow("uncertain");
		expect(f.history.size).toBe(1);
		expect(f.sent).toHaveLength(1);
	});

	it("returns a confirmed status ID and reuses the clean card after adapter restart", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		f.setSendError("after");
		const messageId = await f.adapter.status(CHANNEL, "running", "saved-card", CONNECTION);
		expect(f.history.get(messageId)?.content).toBe("running");
		expect(f.sent[0]?.embeds).toBeUndefined();
		await f.adapter.close();
		const fresh = f.newAdapter();
		await fresh.start(f.handlers);
		expect(await fresh.status(CHANNEL, "idle", "saved-card", CONNECTION, messageId)).toBe(messageId);
		expect(f.history.get(messageId)?.content).toBe("idle");
		expect(f.history.get(messageId)?.embeds).toEqual([]);
		expect(f.sent).toHaveLength(1);
	});

	it("closes only the exact saved status even when the same key has a different cached card", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		const cached = await f.adapter.status(CHANNEL, "Keep cached card", "exact-card", CONNECTION);
		const saved = f.makeMessage({ content: "Close saved card" });
		f.history.set(saved.id, saved);
		expect(await f.adapter.status(CHANNEL, "Permanently deleted", "exact-card", undefined, saved.id, true)).toBe(
			saved.id,
		);
		expect(f.history.get(cached)?.content).toBe("Keep cached card");
		expect(saved.content).toBe("Permanently deleted");
		expect(f.edited.at(-1)?.components).toEqual([]);
		expect(f.sent).toHaveLength(1);
	});

	it("never replaces or adopts a missing saved status when closing existing-only", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		const cached = await f.adapter.status(CHANNEL, "Keep cached card", "missing-card");
		const marker = `haiso:status:${createHash("sha256").update(`${CHANNEL}:missing-card`).digest("hex")}`;
		const legacy = f.makeMessage({ content: "Keep legacy card", embeds: [{ footer: { text: marker } }] });
		f.history.set(legacy.id, legacy);
		await expect(f.adapter.status(CHANNEL, "Closed", "missing-card", undefined, undefined, true)).rejects.toThrow(
			"exact saved",
		);
		await expect(f.adapter.status(CHANNEL, "Closed", "missing-card", undefined, "999999", true)).rejects.toThrow(
			"no replacement",
		);
		expect(f.history.get(cached)?.content).toBe("Keep cached card");
		expect(legacy.content).toBe("Keep legacy card");
		expect(f.edited).toEqual([]);
		expect(f.sent).toHaveLength(1);
	});

	it("reconciles an exact saved status after transient inspection and response-lost edit failures", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		const savedId = await f.adapter.status(CHANNEL, "Running", "recover-close", CONNECTION);
		const saved = f.history.get(savedId)!;
		f.setFetchError(new Error("Authorization: private-token"));
		await expect(f.adapter.status(CHANNEL, "Closed", "recover-close", undefined, savedId, true)).rejects.toThrow(
			"no replacement",
		);
		f.setFetchError(undefined);
		const edit = saved.edit.bind(saved);
		vi.spyOn(saved, "edit").mockImplementationOnce(async options => {
			await edit(options);
			throw new Error("Authorization: private-token");
		});
		await expect(f.adapter.status(CHANNEL, "Closed", "recover-close", undefined, savedId, true)).rejects.toThrow(
			"no replacement",
		);
		expect(saved.content).toBe("Closed");
		expect(await f.adapter.status(CHANNEL, "Closed", "recover-close", undefined, savedId, true)).toBe(savedId);
		expect(f.edited.at(-1)?.components).toEqual([]);
		expect(f.sent).toHaveLength(1);
	});

	it("refuses mismatched or unavailable exact status resources without exposing SDK errors or creating cards", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		const saved = f.makeMessage({ content: "Keep this card" });
		f.history.set(saved.id, saved);
		for (const override of [
			{ id: "999999" },
			{ channelId: "other" },
			{ author: { id: "foreign", bot: true } },
			{ webhookId: "foreign-webhook" },
		]) {
			const original = {
				id: saved.id,
				channelId: saved.channelId,
				author: saved.author,
				webhookId: saved.webhookId,
			};
			Object.assign(saved, override);
			await expect(
				f.adapter.status(CHANNEL, "Closed", "refuse-close", undefined, original.id, true),
			).rejects.toThrow("no replacement");
			Object.assign(saved, original);
		}
		for (const error of [{ code: 10003 }, { code: 50013 }, new Error("Authorization: private-token")]) {
			f.setFetchError(error);
			await expect(f.adapter.status(CHANNEL, "Closed", "refuse-close", undefined, saved.id, true)).rejects.toThrow(
				"no replacement",
			);
		}
		f.setFetchError(undefined);
		f.overwrites.delete(OWNER);
		await expect(f.adapter.status(CHANNEL, "Closed", "refuse-close", undefined, saved.id, true)).rejects.toThrow(
			"no replacement",
		);
		expect(saved.content).toBe("Keep this card");
		expect(f.sent).toEqual([]);
		expect(f.edited).toEqual([]);
	});

	it("adopts a legacy footer-owned card once and strips the footer", async () => {
		const f = fixture();
		const marker = `haiso:status:${createHash("sha256").update(`${CHANNEL}:legacy-card`).digest("hex")}`;
		const legacy = f.makeMessage({ content: "old", embeds: [{ footer: { text: marker } }] });
		f.history.set(legacy.id, legacy);
		await f.adapter.start(f.handlers);
		expect(await f.adapter.status(CHANNEL, "updated", "legacy-card")).toBe(legacy.id);
		expect(legacy.content).toBe("updated");
		expect(legacy.embeds).toEqual([]);
		expect(await f.adapter.status(CHANNEL, "idle", "legacy-card")).toBe(legacy.id);
		expect(f.sent).toHaveLength(0);
	});

	it("keeps reports, acknowledgments, status cards, and dialogs free of tracking embeds", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		await f.adapter.publish(CHANNEL, "Plain reply", "clean-report");
		await f.adapter.status(CHANNEL, "Plain status", "clean-status");
		await f.adapter.showDialog(CHANNEL, { id: "clean-dialog", kind: "confirm", title: "Approve?" });
		await f.adapter.showDialog(CHANNEL, { id: "clean-dialog", kind: "confirm", title: "Approve?" });
		const owner = f.ownerMessage("hello");
		f.client.emit(Events.MessageCreate, owner);
		f.client.emit(Events.MessageCreate, owner);
		await settleEvents();
		expect(f.sent).toHaveLength(4);
		expect(f.sent[0]?.content).toBe("Plain reply");
		expect(f.sent[1]?.content).toBe("Plain status");
		expect(f.sent[3]?.content).toBe("Queued, not yet accepted.");
		for (const payload of f.sent) expect(payload.embeds).toBeUndefined();
		const attachment = f.sent[2]?.files?.[0] as AttachmentBuilder;
		expect(attachment.name).toBe("native-input.txt");
		expect(Buffer.from(attachment.attachment as Buffer).toString("utf8")).toContain("Approve?");
	});

	it("refuses saved status IDs owned by another author, channel, or webhook", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		for (const [index, override] of [
			{ author: { id: "foreign", bot: true } },
			{ channelId: "other" },
			{ webhookId: "webhook" },
		].entries()) {
			const foreign = f.makeMessage({ content: "Do not edit" });
			Object.assign(foreign, override);
			f.history.set(foreign.id, foreign);
			await expect(
				f.adapter.status(CHANNEL, "replacement", `foreign-${index}`, undefined, foreign.id),
			).rejects.toThrow("bot-owned");
			expect(foreign.content).toBe("Do not edit");
		}
		expect(f.sent).toHaveLength(0);
		expect(f.edited).toHaveLength(0);
	});

	it("never retries an unknown post or unknown status creation, but replaces a definitely deleted status card", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		f.setSendError("before");
		await expect(f.adapter.publish(CHANNEL, "result", "unknown")).rejects.toThrow("uncertain");
		await expect(f.adapter.publish(CHANNEL, "result", "unknown")).rejects.toThrow("uncertain");
		expect(f.sent).toHaveLength(1);
		f.setSendError("before");
		await expect(f.adapter.status(CHANNEL, "running", "unknown-card")).rejects.toThrow();
		await expect(f.adapter.status(CHANNEL, "idle", "unknown-card")).rejects.toThrow("uncertain");
		expect(f.sent).toHaveLength(2);
		await f.adapter.status(CHANNEL, "running", "known-card");
		const card = f.history.last()!;
		await f.adapter.status(CHANNEL, "idle", "known-card");
		expect(f.sent).toHaveLength(3);
		expect(f.history.get(card.id)?.content).toBe("idle");
		f.history.delete(card.id);
		await f.adapter.status(CHANNEL, "resumed", "known-card");
		expect(f.sent).toHaveLength(4);
		expect(f.history.last()?.content).toBe("resumed");
	});

	it("shows complete actionable select text, authenticates exact dialog/channel/owner, and lets broker first-answer outcome win", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		const option = `Approve only after reading this full option: ${"condition ".repeat(40)}`;
		await f.adapter.showDialog(CHANNEL, {
			id: "dialog-1",
			kind: "select",
			title: "Full title",
			message: "Full approval question",
			options: [option, "Reject"],
		});
		const payload = f.sent[0]!;
		const file = payload.files?.[0];
		expect(file).toBeInstanceOf(AttachmentBuilder);
		const attachment = file as AttachmentBuilder;
		expect(Buffer.from(attachment.attachment as Buffer).toString("utf8")).toContain(option);
		expect(Buffer.from(attachment.attachment as Buffer).toString("utf8")).toContain("Full approval question");
		const choose = controlId(payload, "choose");
		for (const override of [
			{ channelId: "other" },
			{ user: { id: "outsider", bot: false } },
			{ guildId: "other" },
			{ values: ["99"] },
		]) {
			f.client.emit(Events.InteractionCreate, f.interaction(choose, override).event);
		}
		await settleEvents();
		expect(f.answers).toEqual([]);
		const first = f.interaction(choose);
		f.client.emit(Events.InteractionCreate, first.event);
		f.client.emit(Events.InteractionCreate, f.interaction(choose).event);
		await settleEvents();
		expect(f.answers).toEqual([
			{ channelId: CHANNEL, ownerId: OWNER, dialogId: "dialog-1", value: option, cancelled: false },
		]);
		expect(first.responses).toEqual(["Local answer already won."]);
		expect(f.edited.at(-1)?.components).toEqual([]);
	});

	it("keeps a dialog answerable when Discord acknowledgement fails before broker dispatch", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		await f.adapter.showDialog(CHANNEL, { id: "ack-failure", kind: "confirm", title: "Approve?" });
		const yes = controlId(f.sent[0]!, "yes");
		const failed = f.interaction(yes, {
			deferReply: async () => {
				throw new Error("acknowledgement failed");
			},
		});
		f.client.emit(Events.InteractionCreate, failed.event);
		await settleEvents();
		expect(f.answers).toEqual([]);
		expect(f.edited).toEqual([]);
		const retry = f.interaction(yes);
		f.client.emit(Events.InteractionCreate, retry.event);
		await settleEvents();
		expect(f.answers).toEqual([
			{ channelId: CHANNEL, ownerId: OWNER, dialogId: "ack-failure", value: true, cancelled: false },
		]);
		expect(f.edited.at(-1)?.components).toEqual([]);
	});

	it("uses modals for long editor input and removes controls when the local session resolves first", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		await f.adapter.showDialog(CHANNEL, { id: "editor", kind: "editor", title: "Edit", prefill: "p".repeat(4_000) });
		const open = f.interaction(controlId(f.sent[0]!, "edit"));
		f.client.emit(Events.InteractionCreate, open.event);
		await settleEvents();
		expect(open.modals).toHaveLength(1);
		expect(f.answers).toHaveLength(0);
		const submitId = controlId(f.sent[0]!, "edit").replace(/:edit$/, ":submit");
		f.client.emit(Events.InteractionCreate, f.interaction(submitId).event);
		await settleEvents();
		expect(f.answers[0]).toMatchObject({ dialogId: "editor", value: "edited text", cancelled: false });
		await f.adapter.showDialog(CHANNEL, { id: "confirm", kind: "confirm", title: "Approve?" });
		const yes = controlId(f.sent.at(-1)!, "yes");
		await f.adapter.endDialog(CHANNEL, "confirm");
		f.client.emit(Events.InteractionCreate, f.interaction(yes).event);
		await settleEvents();
		expect(f.answers).toHaveLength(1);
		expect(f.edited.at(-1)?.components).toEqual([]);
	});

	it("rejects oversized remote dialogs explicitly instead of displaying incomplete approval controls", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		await expect(
			f.adapter.showDialog(CHANNEL, {
				id: "many",
				kind: "select",
				title: "Choose",
				options: Array.from({ length: 26 }, (_, i) => `Option ${i}`),
			}),
		).rejects.toThrow("1–25");
		await expect(
			f.adapter.showDialog(CHANNEL, { id: "long", kind: "editor", title: "Edit", prefill: "x".repeat(4_001) }),
		).rejects.toThrow("4000");
		expect(f.sent.every(payload => !payload.components?.length)).toBe(true);
		expect(f.answers).toEqual([]);
	});

	it("does not let stale access verification resurrect a disconnected gateway and retains a subsequent resume", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		const first = Promise.withResolvers<void>();
		f.setRolesGate(first.promise);
		f.client.emit(Events.ShardResume, 0, 0);
		await settleEvents();
		f.client.emit(Events.ShardReconnecting, 0);
		first.resolve();
		await settleEvents();
		expect(f.connections).toEqual([true, false]);
		await expect(f.adapter.inspect(CHANNEL)).rejects.toThrow("offline");

		const second = Promise.withResolvers<void>();
		f.setRolesGate(second.promise);
		f.client.emit(Events.ShardResume, 0, 0);
		await settleEvents();
		f.client.emit(Events.ShardReconnecting, 0);
		f.client.emit(Events.ShardResume, 0, 0);
		f.setRolesGate(undefined);
		second.resolve();
		await settleEvents();
		expect(f.connections).toEqual([true, false, true]);
		expect(await f.adapter.inspect(CHANNEL)).toMatchObject({ state: "found" });
	});

	it("receives uncached message deletion through the SDK dispatcher and reconciles the missing status card", async () => {
		const f = fixture();
		const initial = Promise.withResolvers<void>();
		f.handlers.changed = async () => {
			initial.resolve();
		};
		await f.adapter.start(f.handlers);
		await initial.promise;
		await f.adapter.status(CHANNEL, "running", "deleted-card");
		const card = f.history.last()!;
		const sdkChannel = {
			...f.channel,
			isTextBased: () => true,
			isThread: () => false,
			messages: {
				cache: new Collection<string, Message>(),
				_add: (data: { id: string }) => ({ id: data.id, channelId: CHANNEL, guildId: GUILD, partial: true }),
			},
		};
		f.client.channels.cache.set(CHANNEL, sdkChannel as unknown as TextChannel);
		const deleted: string[] = [];
		f.client.on(Events.MessageDelete, message => {
			deleted.push(message.id);
		});
		const reconciled = Promise.withResolvers<void>();
		f.handlers.changed = async () => {
			await f.adapter.status(CHANNEL, "recovered", "deleted-card");
			reconciled.resolve();
		};
		f.history.delete(card.id);
		// Exercise discord.js's real gateway action, including its partial/cache decision.
		const sdk = f.client as unknown as {
			actions: { MessageDelete: { handle(data: { id: string; channel_id: string; guild_id: string }): void } };
		};
		sdk.actions.MessageDelete.handle({ id: card.id, channel_id: CHANNEL, guild_id: GUILD });
		expect(deleted).toEqual([card.id]);
		await reconciled.promise;
		expect(f.history.last()?.content).toBe("recovered");
		expect(f.sent).toHaveLength(2);
	});

	it("reports disconnect/reconnect without cancelling work and removes its listeners on close", async () => {
		const f = fixture();
		await f.adapter.start(f.handlers);
		f.client.emit(Events.ShardReconnecting, 0);
		expect(f.connections).toEqual([true, false]);
		f.client.emit(Events.ShardResume, 0, 0);
		await settleEvents();
		expect(f.connections).toEqual([true, false, true]);
		expect(f.inputs).toEqual([]);
		await f.adapter.close();
		expect(f.client.listenerCount(Events.MessageCreate)).toBe(0);
		expect(f.client.listenerCount(Events.InteractionCreate)).toBe(0);
		expect(f.connections).toEqual([true, false, true, false]);
	});
});
