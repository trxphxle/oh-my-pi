import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { canonicalProjectDir } from "../launch/paths";
import { discordCategoryName, discordChannelName } from "./names";
import { ensurePrivateDirectory, readPrivateJson, writePrivateJson } from "@oh-my-pi/pi-utils/discord-private-files";
import {
	discardDiscordDeletionEvent,
	isDiscordDeletedSessionFile,
	readDiscordDeletionEvents,
	withDiscordDeletionLock,
} from "./retirement-events";
import {
	DISCORD_MODE_MAX_FRAME,
	DISCORD_MODE_MAX_PENDING,
	DISCORD_MODE_MAX_SESSIONS,
	DISCORD_MODE_MAX_TEXT,
	type BindingState,
	type ChannelInspection,
	type DiscordModeConfig,
	type DiscordPort,
	type DiscordPortHandlers,
	type ModeControlRequest,
	type ModeControlResult,
	type ModeDeletionEvent,
	type ModeDelivery,
	type ModeDialogAnswer,
	type ModeEnrollment,
	type ModeGroup,
	type ModeLease,
	type ModeRequest,
	type ModeSession,
	type ModeSnapshot,
	type RemoteChannel,
} from "@oh-my-pi/pi-wire/discord-mode";

export const DISCORD_MODE_LEASE_MS = 45_000;
export const DISCORD_MODE_RECONCILE_MS = 15_000;
export const DISCORD_MODE_MAX_JOURNAL_BYTES = 24 * 1024 * 1024;
export const DISCORD_MODE_MAX_OPERATIONS = 100_000;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_DELIVERIES = 2048;
const MAX_BACKLOG = 256;
const MAX_DIALOGS = 8;
const EFFECT_TIMEOUT_MS = 20_000;
const Id = type("string").matching(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const RemoteId = type("string").matching(/^\d{1,22}$/);
const RequestId = type("string")
	.atLeastLength(1)
	.atMostLength(128)
	.matching(/^[A-Za-z0-9_.:-]+$/);
const SafePath = type("string")
	.atLeastLength(1)
	.atMostLength(4096)
	.narrow(value => path.isAbsolute(value) && !/[\x00-\x1f]/.test(value));
const Text = type("string")
	.atLeastLength(1)
	.atMostLength(DISCORD_MODE_MAX_TEXT)
	.matching(/^[^\x00-\x08\x0b\x0c\x0e-\x1f]*$/)
	.narrow(value => Buffer.byteLength(value) <= DISCORD_MODE_MAX_TEXT);
const Label = type("string")
	.atLeastLength(1)
	.atMostLength(100)
	.matching(/^[^\x00-\x1f\x7f]*$/)
	.narrow(value => value.trim().length > 0);
const Token = type("string").matching(/^[a-f0-9]{64}$/);
const Timestamp = type("number").nonNegative().narrow(Number.isSafeInteger);
const OptionalText = type("string")
	.atMostLength(DISCORD_MODE_MAX_TEXT)
	.matching(/^[^\x00-\x08\x0b\x0c\x0e-\x1f]*$/)
	.narrow(value => Buffer.byteLength(value) <= DISCORD_MODE_MAX_TEXT);
const LeaseShape = type({ sessionId: Id, connectionId: Id, token: Token, "+": "reject" });
const DialogShape = type({
	id: RequestId,
	kind: "'select' | 'confirm' | 'input' | 'editor'",
	title: Text,
	"message?": Text,
	"options?": Text.array().atLeastLength(1).atMostLength(25),
	"prefill?": OptionalText,
	"+": "reject",
});
const RequestShape = type.or(
	{
		op: "'register'",
		requestId: RequestId,
		sessionId: Id,
		sessionFile: SafePath,
		projectDir: SafePath,
		connectionId: Id,
		label: Label,
		groupName: Label,
		"+": "reject",
	},
	{ op: "'retire'", eventId: Id, "+": "reject" },
	{ op: "'poll'", lease: LeaseShape, busy: "boolean", pendingInput: "boolean", "+": "reject" },
	{ op: "'status'", lease: LeaseShape, "+": "reject" },
	{ op: "'off'", lease: LeaseShape, "+": "reject" },
	{
		op: "'receipt'",
		lease: LeaseShape,
		deliveryId: Id,
		state: "'accepted' | 'completed' | 'rejected'",
		"text?": Text,
		"+": "reject",
	},
	{ op: "'resolve-delivery'", lease: LeaseShape, requestId: RequestId, deliveryId: Id, "+": "reject" },
	{ op: "'send'", lease: LeaseShape, requestId: RequestId, recipientId: Id, text: Text, "+": "reject" },
	{ op: "'report'", lease: LeaseShape, requestId: RequestId, text: Text, "+": "reject" },
	{ op: "'dialog'", lease: LeaseShape, dialog: DialogShape, "+": "reject" },
	{ op: "'dialog-end'", lease: LeaseShape, dialogId: RequestId, "+": "reject" },
	{
		op: "'rename'",
		lease: LeaseShape,
		requestId: RequestId,
		target: "'session' | 'group'",
		name: Label,
		"+": "reject",
	},
	{
		op: "'repair'",
		lease: LeaseShape,
		requestId: RequestId,
		target: "'session' | 'group'",
		"destinationId?": RemoteId,
		resumeQueued: type("boolean").default(false),
		"+": "reject",
	},
);
const Binding = type("'ready' | 'missing' | 'inaccessible' | 'moved' | 'offline' | 'unbound' | 'uncertain'");
const GroupShape = type({
	id: Id,
	projectDir: SafePath,
	name: Label,
	"categoryId?": RemoteId,
	"overviewId?": RemoteId,
	state: Binding,
	uncertain: "boolean",
	overviewUncertain: "boolean",
	"+": "reject",
});
const RetirementShape = type({
	eventId: Id,
	policy: "'retain' | 'delete'",
	deletedAt: Timestamp,
	state: "'pending' | 'done' | 'attention'",
	"channelId?": RemoteId,
	"error?": type("string").atMostLength(500),
	"+": "reject",
});
const SessionShape = type({
	id: Id,
	groupId: Id,
	sessionFile: SafePath,
	projectDir: SafePath,
	label: Label,
	"channelId?": RemoteId,
	connectionId: Id,
	enabled: "boolean",
	connected: "boolean",
	busy: "boolean",
	pendingInput: "boolean",
	state: Binding,
	token: Token,
	seenAt: Timestamp,
	uncertain: "boolean",
	"retirement?": RetirementShape,
	"+": "reject",
});
const DeliveryShape = type({
	id: Id,
	sessionId: Id,
	from: type("string").atMostLength(128),
	source: "'owner' | 'peer'",
	kind: "'message' | 'steer' | 'abort'",
	text: OptionalText,
	state: "'queued' | 'dispatched' | 'accepted' | 'completed' | 'rejected' | 'unknown' | 'resolved'",
	createdAt: Timestamp,
	connectionId: Id,
	held: "boolean",
	"channelId?": RemoteId,
	"sourceMessageId?": RemoteId,
	"+": "reject",
});
const OperationShape = type({
	fingerprint: Token,
	state: "'working' | 'done' | 'unknown' | 'failed'",
	"error?": type("string").atMostLength(500),
	"+": "reject",
});
const AnswerShape = type({ id: RequestId, "value?": OptionalText.or("boolean"), cancelled: "boolean", "+": "reject" });
const PendingDialogShape = type({
	sessionId: Id,
	connectionId: Id,
	dialog: DialogShape,
	state: "'pending' | 'answered'",
	"answer?": AnswerShape,
	"+": "reject",
});
const CardShape = type({
	channelId: RemoteId,
	fingerprint: Token,
	state: "'working' | 'done' | 'unknown'",
	"messageId?": RemoteId,
	"+": "reject",
});
const OperationsShape = type({ "[string]": OperationShape }).narrow(operations =>
	Object.keys(operations).every(key => /^[a-f0-9]{64}$/.test(key)),
);
const JournalShape = type({
	version: "1",
	guildId: RemoteId,
	ownerId: RemoteId,
	groups: GroupShape.array().atMostLength(DISCORD_MODE_MAX_SESSIONS),
	sessions: SessionShape.array().atMostLength(DISCORD_MODE_MAX_SESSIONS),
	deliveries: DeliveryShape.array().atMostLength(MAX_DELIVERIES),
	dialogs: PendingDialogShape.array().atMostLength(DISCORD_MODE_MAX_SESSIONS * MAX_DIALOGS),
	operations: OperationsShape,
	cards: CardShape.array().atMostLength(DISCORD_MODE_MAX_SESSIONS * 2),
	"+": "reject",
});
const OwnerMessageShape = type({
	id: RemoteId,
	channelId: RemoteId,
	ownerId: RemoteId,
	text: OptionalText,
	kind: "'message' | 'steer' | 'abort'",
	"rejected?": type("string").atMostLength(1000),
	"+": "reject",
});
const ControlShape = type({
	id: RequestId,
	channelId: RemoteId,
	ownerId: RemoteId,
	action: "'status' | 'stop' | 'queue' | 'cancel' | 'steer'",
	"connectionId?": Id,
	"deliveryId?": Id,
	"+": "reject",
});
const RemoteAnswerShape = type({
	channelId: RemoteId,
	ownerId: RemoteId,
	dialogId: RequestId,
	"value?": OptionalText.or("boolean"),
	cancelled: "boolean",
	"+": "reject",
});
type Journal = typeof JournalShape.infer;
type Session = typeof SessionShape.infer;
type Group = typeof GroupShape.infer;
type Delivery = typeof DeliveryShape.infer;
type Operation = typeof OperationShape.infer;
/** Only broker-authored, credential-free messages may cross the authenticated IPC error boundary. */
export class DiscordModeError extends Error {}
class UnknownEffect extends DiscordModeError {}

/** Serialized durable routing for existing sessions; never owns or stops their engines. */
export class DiscordModeBroker {
	readonly #config: DiscordModeConfig;
	readonly #storePath: string;
	readonly #port: DiscordPort;
	#journal: Journal;
	#serial: Promise<void> = Promise.resolve();
	#backlog = 0;
	#operationCount = 0;
	#running = false;
	#failed = false;
	#gateway = false;
	#timer: NodeJS.Timeout | undefined;
	#reconcilePending = false;
	#cursor = 0;

	constructor(options: { config: DiscordModeConfig; storePath: string; port: DiscordPort }) {
		RemoteId.assert(options.config.guildId);
		RemoteId.assert(options.config.ownerId);
		this.#config = options.config;
		this.#storePath = options.storePath;
		this.#port = options.port;
		this.#journal = {
			version: 1,
			guildId: options.config.guildId,
			ownerId: options.config.ownerId,
			groups: [],
			sessions: [],
			deliveries: [],
			dialogs: [],
			operations: {},
			cards: [],
		};
	}

	async start(): Promise<void> {
		if (this.#running) return;
		await ensurePrivateDirectory(path.dirname(this.#storePath));
		const saved = await readPrivateJson(this.#storePath, DISCORD_MODE_MAX_JOURNAL_BYTES);
		if (saved !== undefined) this.#journal = JournalShape.assert(saved);
		if (this.#journal.guildId !== this.#config.guildId || this.#journal.ownerId !== this.#config.ownerId)
			throw new DiscordModeError(
				"Discord state belongs to another guild/owner; use a separate profile instead of rebinding retained history.",
			);
		this.#checkJournal();
		this.#operationCount = Object.keys(this.#journal.operations).length;
		if (this.#operationCount > DISCORD_MODE_MAX_OPERATIONS)
			throw new DiscordModeError(
				"Discord operation journal exceeds capacity; archive the private profile explicitly.",
			);
		for (const session of this.#journal.sessions) this.#revoke(session);
		for (const operation of Object.values(this.#journal.operations))
			if (operation.state === "working") operation.state = "unknown";
		for (const card of this.#journal.cards) if (card.state === "working") card.state = "unknown";
		this.#journal.dialogs = [];
		await this.#persist();
		this.#running = true;
		try {
			await this.#mutate(() => this.#consumeRetirements());
			await this.#port.start({
				ownerMessage: input => this.#mutate(() => this.#ownerMessage(input)),
				control: input => this.#mutate(() => this.#control(input)),
				answer: input => this.#mutate(() => this.#answer(input)),
				changed: () => this.#scheduleReconcile(),
				connection: connected => {
					this.#gateway = connected;
					if (connected) void this.#scheduleReconcile();
				},
			});
			await this.#mutate(() => this.#reconcile(true));
			this.#timer = setInterval(() => {
				void this.#scheduleReconcile();
			}, DISCORD_MODE_RECONCILE_MS);
			this.#timer.unref();
		} catch (error) {
			this.#running = false;
			await this.#port.close();
			throw error;
		}
	}

	async close(): Promise<void> {
		clearInterval(this.#timer);
		this.#timer = undefined;
		this.#running = false;
		await this.#serial;
		if (!this.#failed) {
			for (const session of this.#journal.sessions) this.#revoke(session);
			await this.#persist();
		}
		this.#gateway = false;
		await this.#port.close();
	}

	async lookup(projectDir: string, sessionId: string): Promise<ModeEnrollment | undefined> {
		SafePath.assert(projectDir);
		Id.assert(sessionId);
		const canonical = await canonicalProjectDir(projectDir);
		return this.#mutate(async () => {
			await this.#consumeRetirements();
			const group = this.#journal.groups.find(item => item.projectDir === canonical);
			if (!group) return undefined;
			const session = this.#journal.sessions.find(item => item.id === sessionId && item.groupId === group.id);
			return { group: publicGroup(group), ...(session ? { session: publicSession(session) } : {}) };
		});
	}

	request(input: ModeRequest): Promise<ModeSnapshot> {
		let parsed: ModeRequest;
		try {
			if (Buffer.byteLength(JSON.stringify(input)) > DISCORD_MODE_MAX_FRAME)
				throw new DiscordModeError("Discord request exceeds frame limit.");
			parsed = RequestShape.assert(input);
		} catch {
			return Promise.reject(
				new DiscordModeError(
					"Invalid Discord request: check operation, UUIDs, absolute paths, text/byte limits, and allowed fields.",
				),
			);
		}
		// Heartbeats are ephemeral liveness, not queued effects. An authenticated poll arriving
		// during a slow Discord mutation must not expire behind that same mutation.
		if (parsed.op === "poll") {
			const live = this.#journal.sessions.find(item => item.id === parsed.lease.sessionId);
			if (
				live?.enabled &&
				live.connected &&
				live.connectionId === parsed.lease.connectionId &&
				equalTokens(live.token, parsed.lease.token) &&
				Date.now() - live.seenAt < DISCORD_MODE_LEASE_MS
			)
				live.seenAt = Date.now();
		}
		return this.#mutate(async () => {
			await this.#expire();
			await this.#consumeRetirements(parsed.op === "retire" ? parsed.eventId : undefined);
			if (parsed.op === "retire") {
				const retired = this.#journal.sessions.find(item => item.retirement?.eventId === parsed.eventId);
				if (!retired)
					throw new DiscordModeError("Deletion intent is not committed or does not match an enrolled session.");
				await this.#reconcileRetirement(retired);
				await this.#reconcileGroup(this.#group(retired.groupId));
				await this.#cards(this.#group(retired.groupId));
				return this.#snapshot(retired);
			}
			if (parsed.op === "register") return this.#register(parsed);
			const session = this.#authorize(parsed.lease);
			switch (parsed.op) {
				case "poll":
					return this.#poll(session, parsed.busy, parsed.pendingInput);
				case "status":
					await this.#reconcileSession(session);
					await this.#persist();
					await this.#cards(this.#group(session.groupId));
					return {
						...this.#snapshot(session),
						deliveries: this.#journal.deliveries
							.filter(item => item.sessionId === session.id)
							.map(publicDelivery),
					};
				case "off":
					this.#revoke(session);
					session.enabled = false;
					await this.#persist();
					await this.#cards(this.#group(session.groupId));
					break;
				case "receipt":
					await this.#receipt(session, parsed);
					break;
				case "resolve-delivery": {
					let resolved: ModeDelivery | undefined;
					await this.#perform(`request:${session.id}:${parsed.requestId}`, parsed, async () => {
						const delivery = this.#journal.deliveries.find(
							item => item.id === parsed.deliveryId && item.sessionId === session.id,
						);
						if (!delivery || delivery.state !== "unknown")
							throw new DiscordModeError(
								"Only an unknown delivery in this session can be explicitly resolved. Resolution does not claim execution, publish success, or replay work.",
							);
						delivery.state = "resolved";
						resolved = publicDelivery(delivery);
						this.#journal.deliveries = this.#journal.deliveries.filter(item => item.id !== delivery.id);
					});
					await this.#cards(this.#group(session.groupId));
					return { ...this.#snapshot(session), deliveries: resolved ? [resolved] : [] };
				}
				case "send": {
					const recipient = this.#session(parsed.recipientId);
					if (recipient.id === session.id || recipient.groupId !== session.groupId)
						throw new DiscordModeError(
							"Peer messages require another enrolled session in the exact same project directory.",
						);
					this.#requireLive(recipient);
					await this.#perform(`request:${session.id}:${parsed.requestId}`, parsed, async () => {
						this.#enqueue(recipient, session.id, "peer", "message", parsed.text);
					});
					await this.#cards(this.#group(recipient.groupId));
					break;
				}
				case "report": {
					await this.#reconcileSession(session);
					this.#requireRemote(session);
					await this.#perform(`request:${session.id}:${parsed.requestId}`, parsed, async () => {
						await this.#external(
							() =>
								this.#port.publish(session.channelId!, parsed.text, `report:${session.id}:${parsed.requestId}`),
							session,
						);
					});
					break;
				}
				case "dialog":
					await this.#dialog(session, parsed);
					break;
				case "dialog-end":
					await this.#endDialog(session, parsed.dialogId);
					break;
				case "rename":
					await this.#rename(session, parsed);
					break;
				case "repair":
					await this.#repair(session, parsed);
					break;
			}
			return this.#snapshot(session);
		});
	}

	#mutate<T>(run: () => Promise<T>): Promise<T> {
		if (!this.#running || this.#failed)
			return Promise.reject(
				new DiscordModeError("Discord broker is offline or private persistence failed; reconnect after repair."),
			);
		if (this.#backlog >= MAX_BACKLOG)
			return Promise.reject(
				new DiscordModeError("Discord broker backlog is full; wait for pending requests before retrying."),
			);
		this.#backlog++;
		const result = this.#serial
			.then(() => {
				if (!this.#running || this.#failed)
					throw new DiscordModeError("Discord broker stopped; no request was executed.");
				return run();
			})
			.finally(() => {
				this.#backlog--;
			});
		this.#serial = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async #persist(): Promise<void> {
		try {
			if (Buffer.byteLength(JSON.stringify(this.#journal)) > DISCORD_MODE_MAX_JOURNAL_BYTES)
				throw new DiscordModeError(
					"Discord private journal is full. Stop mode and explicitly archive its profile; retained request fences must not be discarded while sessions are active.",
				);
			await writePrivateJson(this.#storePath, this.#journal);
		} catch (error) {
			this.#failed = true;
			throw error;
		}
	}

	#operation(key: string, input: unknown): { operation: Operation; exists: boolean } {
		const id = digest(key);
		const fingerprint = digest(input);
		const existing = this.#journal.operations[id];
		if (existing) {
			if (existing.fingerprint !== fingerprint)
				throw new DiscordModeError("Request identifier was already used with different input.");
			if (existing.state !== "done")
				throw new DiscordModeError(
					existing.error ??
						"Prior effect is uncertain. Inspect Discord and use explicit repair with a selected destination; never replay the request.",
				);
			return { operation: existing, exists: true };
		}
		if (this.#operationCount >= DISCORD_MODE_MAX_OPERATIONS)
			throw new DiscordModeError(
				"Discord dedup journal is full (100,000 retained intents). Stop mode and explicitly archive this private profile before starting a new one; old requests must not be replayed.",
			);
		const operation: Operation = { fingerprint, state: "working" };
		this.#journal.operations[id] = operation;
		this.#operationCount++;
		return { operation, exists: false };
	}

	async #perform(key: string, input: unknown, run: () => Promise<void>): Promise<void> {
		const { operation, exists } = this.#operation(key, input);
		if (exists) return;
		await this.#persist();
		try {
			await run();
			operation.state = "done";
			await this.#persist();
		} catch (error) {
			operation.state = error instanceof UnknownEffect ? "unknown" : "failed";
			operation.error =
				error instanceof DiscordModeError
					? error.message.slice(0, 500)
					: "Discord operation failed; inspect the binding before retrying.";
			if (!this.#failed) await this.#persist();
			throw error;
		}
	}

	async #external<T>(run: () => Promise<T>, binding?: Session | Group): Promise<T> {
		let timer: NodeJS.Timeout | undefined;
		try {
			if (!this.#gateway) throw new DiscordModeError("Discord gateway is offline");
			const deadline = Promise.withResolvers<never>();
			timer = setTimeout(
				() => deadline.reject(new DiscordModeError("Discord effect deadline elapsed")),
				EFFECT_TIMEOUT_MS,
			);
			return await Promise.race([run(), deadline.promise]);
		} catch {
			if (binding) {
				binding.uncertain = true;
				binding.state = "uncertain";
				this.#hold(binding);
			}
			throw new UnknownEffect(
				"Discord effect outcome is unknown. Inspect the resource; use explicit repair/adoption, not a repeated effect.",
			);
		} finally {
			clearTimeout(timer);
		}
	}

	async #register(input: Extract<ModeRequest, { op: "register" }>): Promise<ModeSnapshot> {
		try {
			discordChannelName(input.label);
			discordCategoryName(input.groupName);
		} catch {
			throw new DiscordModeError(
				"Choose a nonempty Discord project/session name containing usable letters, numbers, underscores, or hyphens.",
			);
		}
		const projectDir = await canonicalProjectDir(input.projectDir);
		const sessionFile = path.join(
			await canonicalProjectDir(path.dirname(input.sessionFile)),
			path.basename(input.sessionFile),
		);
		let session = this.#journal.sessions.find(item => item.id === input.sessionId);
		if (session?.retirement)
			throw new DiscordModeError(
				"This conversation was permanently deleted; its identity cannot be enrolled again.",
			);
		const registration = { ...input, projectDir, sessionFile };
		const prior = this.#journal.operations[digest(`register:${input.sessionId}:${input.requestId}`)];
		if (prior) {
			this.#operation(`register:${input.sessionId}:${input.requestId}`, registration);
			if (!session || !session.enabled || !session.connected || session.connectionId !== input.connectionId)
				throw new DiscordModeError(
					"Registration belongs to a revoked connection; reconnect with fresh connection and request identifiers.",
				);
			session.seenAt = Date.now();
			return this.#snapshot(session, true);
		}
		if (session && (session.projectDir !== projectDir || session.sessionFile !== sessionFile))
			throw new DiscordModeError(
				"Persistent session UUID cannot be rebound to a different project directory or session file.",
			);
		if (session?.connected)
			throw new DiscordModeError(
				"Session already has a live lease; wait for expiry or turn mode off in the original session.",
			);
		if (
			session?.connectionId === input.connectionId ||
			this.#journal.operations[digest(`connection:${input.sessionId}:${input.connectionId}`)]
		)
			throw new DiscordModeError("A revoked connection generation cannot be reused.");
		if (this.#journal.sessions.some(item => item.id !== input.sessionId && item.sessionFile === sessionFile))
			throw new DiscordModeError("Session file already belongs to another persistent session UUID.");
		if (!session && this.#journal.sessions.length >= DISCORD_MODE_MAX_SESSIONS)
			throw new DiscordModeError(
				"Discord session capacity reached (128 retained identities); explicitly archive an inactive profile rather than evicting identity/replay fences.",
			);
		if (this.#operationCount + 2 > DISCORD_MODE_MAX_OPERATIONS)
			throw new DiscordModeError(
				"Discord dedup journal is full; explicitly archive the inactive private profile before enrolling more sessions.",
			);
		let peerBytes = Buffer.byteLength(JSON.stringify({ ...input, projectDir, sessionFile })) + 2048;
		for (const peer of this.#journal.sessions)
			if (peer.projectDir === projectDir && peer.id !== input.sessionId && !peer.retirement)
				peerBytes += Buffer.byteLength(JSON.stringify(publicSession(peer))) + 256;
		if (peerBytes > DISCORD_MODE_MAX_FRAME / 2)
			throw new DiscordModeError(
				"Project membership metadata exceeds its bounded IPC budget; use shorter absolute session paths or another explicit project directory.",
			);
		let group = this.#journal.groups.find(item => item.projectDir === projectDir);
		if (group && !session) this.#requireCategoryCapacity(group);
		const newGroup = !group;
		if (!group) {
			group = {
				id: randomUUID(),
				projectDir,
				name: input.groupName,
				state: "unbound",
				uncertain: false,
				overviewUncertain: false,
			};
			this.#journal.groups.push(group);
		}
		const newSession = !session;
		if (!session) {
			session = {
				id: input.sessionId,
				groupId: group.id,
				sessionFile,
				projectDir,
				label: input.label,
				connectionId: input.connectionId,
				enabled: true,
				connected: true,
				busy: false,
				pendingInput: false,
				state: "unbound",
				token: randomBytes(32).toString("hex"),
				seenAt: Date.now(),
				uncertain: false,
			};
			this.#journal.sessions.push(session);
		} else {
			this.#revoke(session);
			session.connectionId = input.connectionId;
			session.token = randomBytes(32).toString("hex");
			session.enabled = true;
			session.connected = true;
			session.seenAt = Date.now();
		}
		const registered = session;
		const selectedGroup = group;
		await this.#perform(`register:${input.sessionId}:${input.requestId}`, registration, async () => {
			const connection = this.#operation(`connection:${input.sessionId}:${input.connectionId}`, {
				sessionId: input.sessionId,
				connectionId: input.connectionId,
			});
			connection.operation.state = "done";
			// Resource intent is durable before the first API call. A failed creation is never repeated.
			try {
				if (newGroup) await this.#createGroup(selectedGroup);
				else await this.#reconcileGroup(selectedGroup);
				if (newSession && selectedGroup.state === "ready") await this.#createSession(registered, selectedGroup);
				else await this.#reconcileSession(registered, false);
			} catch (error) {
				if (!(error instanceof UnknownEffect)) throw error;
			}
		});
		await this.#cards(selectedGroup);
		registered.seenAt = Date.now();
		return this.#snapshot(registered, true);
	}

	async #createGroup(group: Group): Promise<void> {
		group.state = "uncertain";
		group.uncertain = true;
		await this.#persist();
		const category = await this.#external(() => this.#port.createCategory(group.name), group);
		this.#validateRemote(category, "category");
		this.#assertUnbound(category.id, group.id);
		group.categoryId = category.id;
		group.name = category.name;
		group.overviewUncertain = true;
		await this.#persist();
		const overview = await this.#external(
			() => this.#port.createChannel(category.id, "overview", `haiso:group:${group.id}`),
			group,
		);
		this.#validateRemote(overview, "text", category.id);
		this.#assertUnbound(overview.id);
		group.overviewId = overview.id;
		group.overviewUncertain = false;
		group.uncertain = false;
		group.state = "ready";
		await this.#persist();
	}

	#requireCategoryCapacity(group: Group, replacingSessionId?: string): void {
		const retained = this.#journal.sessions.filter(
			session =>
				session.groupId === group.id &&
				session.id !== replacingSessionId &&
				session.channelId !== undefined &&
				!(session.retirement?.policy === "delete" && session.retirement.state === "done"),
		).length;
		if (retained >= 49)
			throw new DiscordModeError(
				"This project already retains 49 session channels plus its overview, reaching Discord's 50-channel category limit. No resource was created. Use another explicit project/profile or reconcile existing bindings; categories are never split automatically.",
			);
	}

	async #createSession(session: Session, group: Group): Promise<void> {
		if (!group.categoryId || group.state !== "ready")
			throw new DiscordModeError("Repair the project category before creating a session channel.");
		this.#requireCategoryCapacity(group, session.id);
		const baseName = discordChannelName(session.label);
		const occupied = new Set<string>(["overview"]);
		for (const peer of this.#journal.sessions)
			if (peer.groupId === group.id && peer.id !== session.id && peer.channelId) {
				try {
					occupied.add(discordChannelName(peer.label));
				} catch {
					/* A manual name with no usable slug cannot collide with a generated slug. */
				}
			}
		let channelName = baseName;
		for (let suffix = 0; occupied.has(channelName); suffix++) {
			const discriminator = `${session.id.slice(0, 8)}${suffix ? `-${suffix}` : ""}`;
			channelName = `${baseName.slice(0, 99 - discriminator.length)}-${discriminator}`;
		}
		session.state = "uncertain";
		session.uncertain = true;
		await this.#persist();
		const channel = await this.#external(
			() => this.#port.createChannel(group.categoryId!, channelName, `haiso:session:${session.id}`),
			session,
		);
		this.#validateRemote(channel, "text", group.categoryId);
		this.#assertUnbound(channel.id);
		session.channelId = channel.id;
		session.label = channel.name;
		session.uncertain = false;
		session.state = "ready";
		await this.#persist();
	}

	#authorize(lease: ModeLease): Session {
		const session = this.#session(lease.sessionId);
		if (session.retirement)
			throw new DiscordModeError("This conversation was permanently deleted; its lease is revoked.");
		if (
			!session.enabled ||
			!session.connected ||
			session.connectionId !== lease.connectionId ||
			!equalTokens(session.token, lease.token)
		)
			throw new DiscordModeError("Session lease is invalid, expired, or revoked; reconnect explicitly.");
		return session;
	}

	#requireLive(session: Session): void {
		if (session.retirement)
			throw new DiscordModeError("This conversation was permanently deleted; delivery is disabled.");
		if (!session.enabled || !session.connected || Date.now() - session.seenAt >= DISCORD_MODE_LEASE_MS)
			throw new DiscordModeError("Session is off or its connection lease expired; delivery is disabled.");
	}

	#requireRemote(session: Session, requireLive = true): void {
		if (requireLive) this.#requireLive(session);
		if (
			!this.#gateway ||
			session.state !== "ready" ||
			this.#group(session.groupId).state !== "ready" ||
			!session.channelId
		)
			throw new DiscordModeError(
				"Remote session binding is paused. Inspect /discord status and use explicit /discord repair; history is preserved.",
			);
	}

	#revoke(session: Session): void {
		session.connected = false;
		session.token = randomBytes(32).toString("hex");
		for (const delivery of this.#journal.deliveries)
			if (delivery.sessionId === session.id) {
				if (delivery.state === "queued") delivery.held = true;
				else if (delivery.state === "dispatched" || delivery.state === "accepted") delivery.state = "unknown";
			}
		this.#journal.dialogs = this.#journal.dialogs.filter(item => item.sessionId !== session.id);
	}

	async #expire(): Promise<void> {
		let changed = false;
		for (const session of this.#journal.sessions)
			if (session.connected && Date.now() - session.seenAt >= DISCORD_MODE_LEASE_MS) {
				this.#revoke(session);
				changed = true;
			}
		if (changed) await this.#persist();
	}

	#enqueue(
		session: Session,
		from: string,
		source: "owner" | "peer",
		kind: ModeDelivery["kind"],
		text: string,
		sourceMessageId?: string,
	): void {
		this.#requireLive(session);
		let sessionBytes = Buffer.byteLength(text);
		for (const delivery of this.#journal.deliveries)
			if (delivery.sessionId === session.id) {
				sessionBytes += Buffer.byteLength(JSON.stringify(publicDelivery(delivery)));
				if (kind === "message" && delivery.state === "unknown")
					throw new DiscordModeError(
						"A previous delivery has an unknown execution outcome. Inspect its original text in status and reconcile explicitly before ordinary work resumes.",
					);
			}
		if (sessionBytes > 96 * 1024)
			throw new DiscordModeError(
				"Session pending payload budget is full (96 KiB); resolve pending/uncertain work before sending more.",
			);
		if (
			this.#journal.deliveries.length >= MAX_DELIVERIES ||
			this.#journal.deliveries.filter(item => item.sessionId === session.id).length >= DISCORD_MODE_MAX_PENDING
		)
			throw new DiscordModeError(
				"Session delivery queue is full (32 per session, 2048 total). Complete pending work or explicitly resume held queued work; uncertain work will not be replayed.",
			);
		this.#checkPayload(Buffer.byteLength(text));
		this.#journal.deliveries.push({
			id: randomUUID(),
			sessionId: session.id,
			connectionId: session.connectionId,
			channelId: source === "owner" ? session.channelId : undefined,
			sourceMessageId,
			from,
			source,
			kind,
			text,
			state: "queued",
			createdAt: Date.now(),
			held: false,
		});
	}

	async #poll(session: Session, busy: boolean, pendingInput: boolean): Promise<ModeSnapshot> {
		if (
			this.#journal.deliveries.some(
				item => item.sessionId === session.id && item.source === "owner" && item.state === "queued",
			) ||
			this.#journal.dialogs.some(item => item.sessionId === session.id && item.answer)
		)
			await this.#reconcileSession(session);
		const changed = session.busy !== busy || session.pendingInput !== pendingInput;
		session.seenAt = Date.now();
		session.busy = busy;
		session.pendingInput = pendingInput;
		let responseBytes = Buffer.byteLength(JSON.stringify(this.#snapshot(session))) + 1024;
		const deliveries: ModeDelivery[] = [];
		const active = this.#journal.deliveries.some(
			item =>
				item.sessionId === session.id &&
				(item.state === "unknown" ||
					(item.kind === "message" && (item.state === "dispatched" || item.state === "accepted"))),
		);
		let dispatchedMessage = active;
		for (const delivery of this.#journal.deliveries) {
			if (
				delivery.sessionId !== session.id ||
				delivery.connectionId !== session.connectionId ||
				delivery.state !== "queued" ||
				delivery.held
			)
				continue;
			if (
				delivery.source === "owner" &&
				(!this.#gateway || session.state !== "ready" || this.#group(session.groupId).state !== "ready")
			)
				continue;
			if (delivery.kind === "message" && (busy || pendingInput || dispatchedMessage)) continue;
			const bytes = Buffer.byteLength(JSON.stringify(publicDelivery(delivery))) + 1;
			if (responseBytes + bytes > DISCORD_MODE_MAX_FRAME - 2048) break;
			responseBytes += bytes;
			delivery.state = "dispatched";
			if (delivery.kind === "message") dispatchedMessage = true;
			deliveries.push(publicDelivery(delivery));
			// Bounded response even when controls bypass a busy engine.
			if (deliveries.length === 4) break;
		}
		const answers: ModeDialogAnswer[] = [];
		for (const dialog of this.#journal.dialogs)
			if (
				dialog.sessionId === session.id &&
				dialog.connectionId === session.connectionId &&
				dialog.answer &&
				this.#gateway &&
				session.state === "ready" &&
				this.#group(session.groupId).state === "ready"
			) {
				const bytes = Buffer.byteLength(JSON.stringify(dialog.answer)) + 1;
				if (responseBytes + bytes > DISCORD_MODE_MAX_FRAME - 2048) break;
				responseBytes += bytes;
				answers.push({ ...dialog.answer });
				delete dialog.answer;
			}
		if (changed || deliveries.length || answers.length) await this.#persist();
		if (changed || deliveries.length) await this.#cards(this.#group(session.groupId));
		return { ...this.#snapshot(session), deliveries, answers };
	}

	async #receipt(session: Session, input: Extract<ModeRequest, { op: "receipt" }>): Promise<void> {
		const key = `receipt:${input.deliveryId}:${input.state}`;
		const existing = this.#journal.operations[digest(key)];
		if (existing) {
			this.#operation(key, input);
			return;
		}
		const delivery = this.#journal.deliveries.find(item => item.id === input.deliveryId);
		if (!delivery || delivery.sessionId !== session.id || delivery.connectionId !== session.connectionId)
			throw new DiscordModeError("Receipt does not belong to this session connection and exact delivery.");
		if (delivery.state !== "dispatched" && delivery.state !== "accepted")
			throw new DiscordModeError(
				"Receipt requires a dispatched delivery in the current generation; queued/unknown work cannot be completed or replayed.",
			);
		if (input.state === "accepted" && input.text !== undefined)
			throw new DiscordModeError(
				"Accepted receipts cannot publish results; send a completed/rejected receipt after execution.",
			);
		if (input.text !== undefined) {
			await this.#reconcileSession(session);
			this.#requireRemote(session);
			if (delivery.source === "owner" && delivery.channelId !== session.channelId)
				throw new DiscordModeError(
					"Delivery belonged to an earlier channel binding; its result cannot be posted into the replacement channel.",
				);
		}
		await this.#perform(key, input, async () => {
			delivery.state = input.state;
			try {
				if (input.text !== undefined)
					await this.#external(() => this.#port.publish(session.channelId!, input.text!, key), session);
				if (input.state !== "accepted")
					this.#journal.deliveries = this.#journal.deliveries.filter(item => item.id !== delivery.id);
			} catch (error) {
				delivery.state = "unknown";
				throw error;
			}
		});
		await this.#cards(this.#group(session.groupId));
	}

	async #ownerMessage(raw: Parameters<DiscordPortHandlers["ownerMessage"]>[0]): Promise<ModeControlResult> {
		await this.#expire();
		if (raw.ownerId !== this.#config.ownerId) return { text: "" };
		await this.#consumeRetirements();
		const session = this.#journal.sessions.find(item => item.channelId === raw.channelId);
		if (!session) return { text: "" };
		if (session.retirement) return { text: "This conversation was permanently deleted; nothing was forwarded." };
		let input: typeof OwnerMessageShape.infer;
		try {
			input = OwnerMessageShape.assert(raw);
			if (!input.rejected && input.kind !== "abort") Text.assert(input.text);
		} catch {
			throw new DiscordModeError("Invalid owner message: check identifiers, text limits, and allowed fields.");
		}
		await this.#reconcileSession(session);
		await this.#expire();
		await this.#persist();
		this.#requireRemote(session);
		if (input.rejected) return { text: input.rejected };
		await this.#perform(`owner:${input.id}`, input, async () => {
			this.#enqueue(session, input.ownerId, "owner", input.kind, input.text, input.id);
		});
		await this.#cards(this.#group(session.groupId));
		const delivery = this.#journal.deliveries.find(
			item => item.sessionId === session.id && item.source === "owner" && item.sourceMessageId === input.id,
		);
		if (!delivery)
			return { text: "Previously received; no actionable queued copy was identified. Nothing was replayed." };
		if (delivery.state !== "queued")
			return { text: `Previously received; delivery is ${delivery.state}. Nothing was replayed.` };
		if (this.#actionable(session, delivery))
			return {
				text: "Queued for the next idle turn. You can send it as guidance or cancel it before dispatch.",
				deliveryId: delivery.id,
				connectionId: session.connectionId,
			};
		return {
			text: delivery.held
				? "Retained in the held queue; explicit repair and resumption are required before dispatch."
				: delivery.kind === "message"
					? "The message remains queued but is not currently actionable; check session status."
					: `Queued ${delivery.kind} control; dispatch has not been confirmed.`,
		};
	}

	#controlConnection(session: Session): string | undefined {
		return this.#gateway &&
			session.enabled &&
			session.connected &&
			Date.now() - session.seenAt < DISCORD_MODE_LEASE_MS &&
			session.state === "ready" &&
			this.#group(session.groupId).state === "ready"
			? session.connectionId
			: undefined;
	}

	#actionable(session: Session, delivery: Delivery): boolean {
		return (
			this.#controlConnection(session) !== undefined &&
			delivery.sessionId === session.id &&
			delivery.source === "owner" &&
			delivery.from === this.#config.ownerId &&
			delivery.kind === "message" &&
			delivery.state === "queued" &&
			!delivery.held &&
			delivery.connectionId === session.connectionId &&
			delivery.channelId === session.channelId
		);
	}

	async #control(raw: ModeControlRequest): Promise<ModeControlResult> {
		let input: ModeControlRequest;
		try {
			input = ControlShape.assert(raw);
			if (
				((input.action === "cancel" || input.action === "steer") && (!input.connectionId || !input.deliveryId)) ||
				(input.deliveryId !== undefined &&
					input.action !== "queue" &&
					input.action !== "cancel" &&
					input.action !== "steer")
			)
				throw new Error("Invalid control fields");
		} catch {
			throw new DiscordModeError("Invalid session control: check identifiers, action, and allowed fields.");
		}
		if (input.ownerId !== this.#config.ownerId)
			throw new DiscordModeError("Only the configured owner can use session controls.");
		await this.#expire();
		await this.#consumeRetirements();
		const session = this.#journal.sessions.find(item => item.channelId === input.channelId);
		if (!session) throw new DiscordModeError("This channel is not bound to a session.");
		if (session.retirement) {
			if (input.action === "status") return { text: this.#sessionStatus(session) };
			if (input.action === "queue")
				return {
					text: "This conversation was permanently deleted. No messages are queued; nothing can be forwarded.",
					queued: [],
				};
			throw new DiscordModeError("This conversation was permanently deleted; old controls are disabled.");
		}
		await this.#reconcileSession(session);
		await this.#expire();
		await this.#persist();
		this.#requireRemote(session, false);
		if (
			input.connectionId !== undefined &&
			(input.connectionId !== session.connectionId || !session.enabled || !session.connected)
		)
			throw new DiscordModeError("Session control belongs to a stale connection; use the current session controls.");
		const readOnly = input.action === "status" || input.action === "queue";
		if (readOnly) await this.#cards(this.#group(session.groupId));
		if (input.action === "status")
			return { text: this.#sessionStatus(session), connectionId: this.#controlConnection(session) };
		if (input.action === "queue") {
			const queued = this.#journal.deliveries
				.filter(
					item =>
						item.sessionId === session.id &&
						item.source === "owner" &&
						item.from === this.#config.ownerId &&
						item.kind === "message" &&
						item.state === "queued" &&
						(input.deliveryId === undefined || item.id === input.deliveryId),
				)
				.map(item => ({
					id: item.id,
					text: item.text,
					createdAt: item.createdAt,
					held: item.held,
					actionable: this.#actionable(session, item),
				}));
			if (input.deliveryId !== undefined && !queued.length)
				throw new DiscordModeError("That owner message is no longer queued in this session.");
			return {
				text:
					input.deliveryId !== undefined
						? `${queued[0]!.held ? "Held owner message (read-only)" : "Queued owner message"}\n${queued[0]!.text}`
						: queued.length
							? `${queued.length} owner message${queued.length === 1 ? "" : "s"} queued. Held messages require explicit repair and resumption.`
							: "No owner messages are queued.",
				connectionId: this.#controlConnection(session),
				deliveryId: input.deliveryId,
				queued,
			};
		}
		this.#requireLive(session);
		let changed = false;
		await this.#perform(`control:${input.id}`, input, async () => {
			this.#requireLive(session);
			if (input.action === "stop") {
				this.#enqueue(session, input.ownerId, "owner", "abort", "");
			} else {
				const delivery = this.#journal.deliveries.find(item => item.id === input.deliveryId);
				if (!delivery || !this.#actionable(session, delivery))
					throw new DiscordModeError(
						"Only a queued, non-held owner message in this channel's current connection can be cancelled or sent as guidance. Dispatched work cannot be changed.",
					);
				if (input.action === "cancel")
					this.#journal.deliveries = this.#journal.deliveries.filter(item => item.id !== delivery.id);
				else delivery.kind = "steer";
			}
			changed = true;
		});
		await this.#cards(this.#group(session.groupId));
		if (!changed) return { text: "This control was already processed. No new change was made." };
		return {
			text:
				input.action === "cancel"
					? "Cancelled the queued message before dispatch."
					: input.action === "steer"
						? "Queued the existing message as guidance for the current connection; dispatch is not yet confirmed."
						: "Queued Stop turn. This requests cancellation of the current turn, not the process.",
		};
	}

	async #dialog(session: Session, input: Extract<ModeRequest, { op: "dialog" }>): Promise<void> {
		await this.#reconcileSession(session);
		this.#requireRemote(session);
		if (input.dialog.kind === "select" && !input.dialog.options?.length)
			throw new DiscordModeError("Select dialog requires current options.");
		const key = `dialog:${session.id}:${session.connectionId}:${input.dialog.id}`;
		if (
			!this.#journal.operations[digest(key)] &&
			this.#journal.dialogs.filter(item => item.sessionId === session.id).length >= MAX_DIALOGS
		)
			throw new DiscordModeError("Session has eight pending dialogs; resolve existing local dialogs first.");
		this.#checkPayload(Buffer.byteLength(JSON.stringify(input.dialog)));
		await this.#perform(key, input, async () => {
			this.#journal.dialogs.push({
				sessionId: session.id,
				connectionId: session.connectionId,
				dialog: input.dialog,
				state: "pending",
			});
			await this.#persist();
			await this.#external(
				() =>
					this.#port.showDialog(session.channelId!, {
						...input.dialog,
						id: digest([session.id, session.connectionId, input.dialog.id]),
					}),
				session,
			);
		});
	}

	async #answer(raw: Parameters<DiscordPortHandlers["answer"]>[0]): Promise<string> {
		await this.#expire();
		const input = RemoteAnswerShape.assert(raw);
		if (input.ownerId !== this.#config.ownerId)
			throw new DiscordModeError("Only the configured owner can answer native dialogs.");
		await this.#consumeRetirements();
		const session = this.#journal.sessions.find(item => item.channelId === input.channelId);
		if (!session) throw new DiscordModeError("Dialog channel is no longer bound.");
		if (session.retirement)
			throw new DiscordModeError("This conversation was permanently deleted; old dialog answers are rejected.");
		await this.#reconcileSession(session);
		this.#requireRemote(session);
		const pending = this.#journal.dialogs.find(
			item =>
				item.sessionId === session.id &&
				item.connectionId === session.connectionId &&
				digest([session.id, session.connectionId, item.dialog.id]) === input.dialogId,
		);
		if (!pending || pending.state !== "pending")
			throw new DiscordModeError("Dialog is stale, ended, or already answered; use the current native dialog.");
		if (!input.cancelled) {
			if (pending.dialog.kind === "confirm" ? typeof input.value !== "boolean" : typeof input.value !== "string")
				throw new DiscordModeError("Answer type does not match the current native dialog.");
			if (
				pending.dialog.kind === "select" &&
				(typeof input.value !== "string" || !pending.dialog.options?.includes(input.value))
			)
				throw new DiscordModeError("Choose an exact current dialog option.");
		}
		pending.state = "answered";
		pending.answer = { id: pending.dialog.id, value: input.value, cancelled: input.cancelled };
		await this.#persist();
		return "Answer queued for this session connection only; the first local or remote answer wins.";
	}

	async #endDialog(session: Session, dialogId: string): Promise<void> {
		this.#journal.dialogs = this.#journal.dialogs.filter(
			item =>
				!(
					item.sessionId === session.id &&
					item.connectionId === session.connectionId &&
					item.dialog.id === dialogId
				),
		);
		await this.#persist();
		if (!session.channelId || !this.#gateway || session.state !== "ready") return;
		await this.#perform(
			`dialog-end:${session.id}:${session.connectionId}:${dialogId}`,
			{ sessionId: session.id, connectionId: session.connectionId, dialogId },
			async () => {
				await this.#external(() =>
					this.#port.endDialog(session.channelId!, digest([session.id, session.connectionId, dialogId])),
				);
			},
		);
	}

	async #rename(session: Session, input: Extract<ModeRequest, { op: "rename" }>): Promise<void> {
		await this.#reconcileSession(session);
		this.#requireRemote(session);
		const binding = input.target === "session" ? session : this.#group(session.groupId);
		const channelId = input.target === "session" ? session.channelId : this.#group(session.groupId).categoryId;
		if (!channelId) throw new DiscordModeError("Cannot rename an unbound resource; repair explicitly.");
		await this.#perform(`request:${session.id}:${input.requestId}`, input, async () => {
			await this.#external(() => this.#port.rename(channelId, input.name), binding);
			if (input.target === "session") await this.#reconcileSession(session);
			else await this.#reconcileGroup(this.#group(session.groupId));
		});
		await this.#cards(this.#group(session.groupId));
	}

	async #repair(session: Session, input: Extract<ModeRequest, { op: "repair" }>): Promise<void> {
		if (!this.#gateway)
			throw new DiscordModeError("Discord is offline; reconnect before inspecting or repairing bindings.");
		const group = this.#group(session.groupId);
		const binding = input.target === "session" ? session : group;
		await this.#reconcileGroup(group);
		await this.#reconcileSession(session, false);
		let destination: RemoteChannel | undefined;
		if (input.destinationId) {
			const inspected = await this.#inspect(input.destinationId);
			if (inspected.state !== "found")
				throw new DiscordModeError(
					"Repair destination is missing or inaccessible; choose an inspectable private resource.",
				);
			destination = inspected.channel;
			this.#validateRemote(
				destination,
				input.target === "group" ? "category" : "text",
				input.target === "session" ? group.categoryId : undefined,
			);
			this.#assertUnbound(destination.id, binding.id);
		} else if (binding.uncertain)
			throw new DiscordModeError(
				"Prior mutation has an unknown outcome. Inspect Discord and explicitly adopt its resource by destination ID; blind replacement is forbidden.",
			);
		else if (binding.state === "inaccessible" || binding.state === "moved")
			throw new DiscordModeError(
				"Existing resource still exists or is inaccessible; restore its privacy/location or explicitly select a valid private destination.",
			);
		if (input.target === "session" && group.state !== "ready")
			throw new DiscordModeError("Repair the project category/overview before the session channel.");
		if (input.target === "session" && !destination && session.state !== "ready")
			this.#requireCategoryCapacity(group, session.id);
		const selected = destination;
		await this.#perform(`request:${session.id}:${input.requestId}`, input, async () => {
			this.#hold(binding);
			if (input.target === "session") {
				if (selected) {
					session.channelId = selected.id;
					session.label = selected.name;
					session.uncertain = false;
					session.state = "ready";
				} else if (session.state !== "ready") await this.#createSession(session, group);
				this.#resumeQueue(session, input.resumeQueued);
				this.#journal.dialogs = this.#journal.dialogs.filter(item => item.sessionId !== session.id);
			} else {
				await this.#repairGroup(group, selected);
				for (const member of this.#journal.sessions)
					if (member.groupId === group.id && !member.retirement) this.#resumeQueue(member, input.resumeQueued);
				this.#journal.dialogs = this.#journal.dialogs.filter(
					item => this.#session(item.sessionId).groupId !== group.id,
				);
			}
			this.#journal.cards = this.#journal.cards.filter(
				card => card.channelId !== (input.target === "session" ? session.channelId : group.overviewId),
			);
		});
		await this.#cards(group);
	}

	async #repairGroup(group: Group, destination: RemoteChannel | undefined): Promise<void> {
		const previousCategory = group.categoryId;
		if (destination) {
			group.categoryId = destination.id;
			group.name = destination.name;
		} else if (!group.categoryId || (await this.#inspect(group.categoryId)).state === "missing") {
			group.uncertain = true;
			group.state = "uncertain";
			await this.#persist();
			const category = await this.#external(() => this.#port.createCategory(group.name), group);
			this.#validateRemote(category, "category");
			this.#assertUnbound(category.id, group.id);
			group.categoryId = category.id;
			group.name = category.name;
		}
		if (!group.categoryId) throw new DiscordModeError("Choose a private category to repair the project binding.");
		await this.#persist();
		// Only known surviving children move. Never touch unrelated channels or delete history.
		const childIds = [
			group.overviewId,
			...this.#journal.sessions
				.filter(item => item.groupId === group.id && !item.retirement)
				.map(item => item.channelId),
		];
		for (const childId of childIds)
			if (childId) {
				const child = await this.#inspect(childId);
				if (
					child.state === "found" &&
					child.channel.private &&
					child.channel.kind === "text" &&
					child.channel.parentId !== group.categoryId
				) {
					if (child.channel.parentId !== undefined && child.channel.parentId !== previousCategory) continue;
					await this.#external(() => this.#port.move(childId, group.categoryId!), group);
				}
			}
		const overview = group.overviewId ? await this.#inspect(group.overviewId) : undefined;
		if (!overview || overview.state === "missing") {
			// An unknown creation cannot be searched/adopted through the category-only API.
			// A new explicitly selected category establishes a fresh overview namespace.
			if (group.overviewUncertain && (!destination || destination.id === previousCategory))
				throw new DiscordModeError(
					"Overview creation outcome is unknown. Select a different private category explicitly; the old category/history will remain untouched.",
				);
			group.overviewUncertain = true;
			await this.#persist();
			const created = await this.#external(
				() => this.#port.createChannel(group.categoryId!, "overview", `haiso:group:${group.id}`),
				group,
			);
			this.#validateRemote(created, "text", group.categoryId);
			this.#assertUnbound(created.id);
			group.overviewId = created.id;
			group.overviewUncertain = false;
		}
		group.uncertain = false;
		await this.#reconcileGroup(group);
		for (const member of this.#journal.sessions)
			if (member.groupId === group.id && !member.retirement) await this.#reconcileSession(member, false);
	}

	#resumeQueue(session: Session, resume: boolean): void {
		if (!resume) return;
		for (const delivery of this.#journal.deliveries) {
			if (delivery.sessionId !== session.id || delivery.state !== "queued" || !delivery.held) continue;
			delivery.connectionId = session.connectionId;
			delivery.channelId = delivery.source === "owner" ? session.channelId : undefined;
			delivery.held = false;
		}
	}

	#hold(binding: Session | Group): void {
		for (const delivery of this.#journal.deliveries)
			if (
				delivery.source === "owner" &&
				delivery.state === "queued" &&
				(delivery.sessionId === binding.id || this.#session(delivery.sessionId).groupId === binding.id)
			)
				delivery.held = true;
	}

	async #inspect(id: string): Promise<ChannelInspection> {
		const deadline = Promise.withResolvers<ChannelInspection>();
		const timer = setTimeout(() => deadline.resolve({ state: "inaccessible" }), EFFECT_TIMEOUT_MS);
		try {
			return await Promise.race([this.#port.inspect(id), deadline.promise]);
		} catch {
			return { state: "inaccessible" };
		} finally {
			clearTimeout(timer);
		}
	}

	async #reconcileGroup(group: Group): Promise<void> {
		if (!this.#gateway) {
			group.state = "offline";
			this.#hold(group);
			return;
		}
		let state: BindingState = "unbound";
		if (group.categoryId) {
			const category = await this.#inspect(group.categoryId);
			state = inspectionState(category, "category");
			if (category.state === "found") group.name = category.channel.name;
			if (state === "ready")
				state = group.overviewId
					? inspectionState(await this.#inspect(group.overviewId), "text", group.categoryId)
					: "unbound";
		}
		group.state = group.uncertain ? "uncertain" : state;
		if (group.state !== "ready") this.#hold(group);
	}

	async #reconcileSession(session: Session, includeGroup = true): Promise<void> {
		if (session.retirement) return;
		const group = this.#group(session.groupId);
		if (includeGroup) await this.#reconcileGroup(group);
		if (!this.#gateway) {
			session.state = "offline";
			this.#hold(session);
			return;
		}
		let state: BindingState = "unbound";
		if (session.channelId) {
			const channel = await this.#inspect(session.channelId);
			state = inspectionState(channel, "text", group.categoryId);
			if (channel.state === "found") session.label = channel.channel.name;
		}
		session.state = session.uncertain ? "uncertain" : state;
		if (session.state !== "ready" || group.state !== "ready") this.#hold(session);
	}

	#scheduleReconcile(): Promise<void> {
		if (this.#reconcilePending || !this.#running) return Promise.resolve();
		this.#reconcilePending = true;
		return this.#mutate(() => this.#reconcile(false))
			.catch(() => undefined)
			.finally(() => {
				this.#reconcilePending = false;
			});
	}
	/** Adopt every matching local intent before any Discord effect or native routing. */
	async #consumeRetirements(requestedId?: string): Promise<void> {
		const root = path.dirname(this.#storePath);
		return withDiscordDeletionLock(root, () => this.#adoptRetirements(root, requestedId));
	}

	async #adoptRetirements(root: string, requestedId?: string): Promise<void> {
		const events = await readDiscordDeletionEvents(root);
		const adopted: ModeDeletionEvent[] = [];
		let rejected = false;
		for (const event of events) {
			const binding = event.binding;
			const session = this.#journal.sessions.find(item => item.id === binding.sessionId);
			const projectDir = await canonicalProjectDir(binding.projectDir);
			const sessionFile = path.join(
				await canonicalProjectDir(path.dirname(binding.sessionFile)),
				path.basename(binding.sessionFile),
			);
			if (
				!session ||
				binding.guildId !== this.#config.guildId ||
				binding.ownerId !== this.#config.ownerId ||
				projectDir !== session.projectDir ||
				sessionFile !== session.sessionFile ||
				binding.channelId !== session.channelId ||
				this.#journal.sessions.some(item => item.id !== session.id && item.retirement?.eventId === event.id)
			) {
				if (event.id === requestedId) rejected = true;
				continue;
			}
			if (session.retirement) {
				const retirement = session.retirement;
				if (
					retirement.eventId !== event.id ||
					retirement.policy !== event.policy ||
					retirement.deletedAt !== event.createdAt ||
					retirement.channelId !== binding.channelId
				) {
					if (event.id === requestedId) rejected = true;
					continue;
				}
			} else {
				// A prepared intent is authoritative only after an accessible parent proves
				// the exact native file absent. No sweep ever manufactures deletion intent.
				if (event.phase === "prepared" && !(await isDiscordDeletedSessionFile(session.sessionFile))) continue;
				session.retirement = {
					eventId: event.id,
					policy: event.policy,
					deletedAt: event.createdAt,
					state: "pending",
					channelId: binding.channelId,
				};
				this.#revoke(session);
				session.enabled = false;
				session.busy = false;
				session.pendingInput = false;
				this.#journal.deliveries = this.#journal.deliveries.filter(
					item => item.sessionId !== session.id && !(item.source === "peer" && item.from === session.id),
				);
				// Persist before the next fallible event read/check; an unrelated bad
				// intent must never leave an adopted in-memory fence without durability.
				await this.#persist();
			}
			adopted.push(event);
		}
		// The tombstone contains the complete immutable authority after adoption.
		// Never remove the outbox entry until these routing fences are durable.
		for (const event of adopted) {
			try {
				await discardDiscordDeletionEvent(event, root);
			} catch {
				// A replacement or temporarily inaccessible outbox entry remains fenced.
			}
		}
		if (rejected)
			throw new DiscordModeError("Deletion event conflicts with its exact saved binding or adopted retirement.");
	}

	async #reconcileRetirement(session: Session): Promise<void> {
		const retirement = session.retirement!;
		if (retirement.state === "done") return;
		const channelId = retirement.channelId;
		const attention = async (error: string): Promise<void> => {
			retirement.state = "attention";
			retirement.error = error;
			await this.#persist();
		};
		if (channelId !== session.channelId) {
			await attention("Saved retirement target changed; no Discord channel was touched.");
			return;
		}
		if (!channelId) {
			if (session.uncertain) {
				await attention(
					"Prior channel creation is unconfirmed; no exact target is known and no Discord resource was touched.",
				);
				return;
			}
			retirement.state = "done";
			delete retirement.error;
			await this.#persist();
			return;
		}
		if (!this.#gateway) {
			session.state = "offline";
			retirement.state = "pending";
			retirement.error = "Discord is offline; permanent local closure is effective and remote cleanup is pending.";
			await this.#persist();
			return;
		}
		// Reinspect the immutable target on every recovery attempt. The port additionally
		// verifies guild and original ownership before any PATCH/DELETE.
		const inspected = await this.#inspect(channelId);
		if (inspected.state === "missing") {
			session.state = "missing";
			retirement.state = "done";
			delete retirement.error;
			await this.#persist();
			return;
		}
		const marker = `haiso:session:${session.id}`;
		if (
			inspected.state !== "found" ||
			inspected.channel.id !== channelId ||
			!inspected.channel.private ||
			inspected.channel.kind !== "text" ||
			(inspected.channel.topic !== marker &&
				inspected.channel.topic !== `${marker} — Closed: native conversation permanently deleted.`)
		) {
			session.state = "inaccessible";
			await attention("Exact private channel ownership could not be verified; remote cleanup is pending.");
			return;
		}
		session.state = "ready";
		const card = this.#journal.cards.find(item => item.channelId === channelId);
		if (retirement.policy === "retain" && card?.messageId)
			await this.#card(channelId, this.#sessionStatus(session), undefined, true);
		try {
			await this.#external(() => this.#port.retire(channelId, session.id, retirement.policy));
		} catch {
			await attention(
				"Discord retirement outcome is unconfirmed; the exact target will be inspected before recovery.",
			);
			return;
		}
		session.state = retirement.policy === "delete" ? "missing" : "ready";
		if (retirement.policy === "retain") {
			if (card?.messageId && card.state === "done") {
				await this.#card(channelId, this.#sessionStatus(session, true), undefined, true);
			}
			if (!card?.messageId || card.state !== "done") {
				await attention(
					"Channel archived; final status-card confirmation is pending. Only the saved message may be updated; no replacement notice will be created.",
				);
				return;
			}
		}
		retirement.state = "done";
		delete retirement.error;
		await this.#persist();
	}

	async #reconcile(all: boolean): Promise<void> {
		await this.#expire();
		await this.#consumeRetirements();
		const groups = this.#journal.groups;
		const sessions = this.#journal.sessions;
		const total = groups.length + sessions.length;
		const count = all ? total : Math.min(16, total);
		const touched = new Set<string>();
		for (let index = 0; index < count; index++) {
			const selected = this.#cursor++ % total;
			if (selected < groups.length) {
				const group = groups[selected]!;
				await this.#reconcileGroup(group);
				touched.add(group.id);
			} else {
				const session = sessions[selected - groups.length]!;
				if (session.retirement) await this.#reconcileRetirement(session);
				else await this.#reconcileSession(session);
				touched.add(session.groupId);
			}
		}
		await this.#persist();
		for (const groupId of touched) await this.#cards(this.#group(groupId));
	}

	#sessionActivity(session: Session): string {
		if (session.retirement) return "Permanently deleted";
		if (!session.enabled) return "Off";
		if (!session.connected || Date.now() - session.seenAt >= DISCORD_MODE_LEASE_MS) return "Disconnected";
		if (session.pendingInput) return "Waiting for input";
		return session.busy ? "Working" : "Idle";
	}

	#sessionStatus(session: Session, retirementComplete = false): string {
		if (session.retirement) {
			const retirement = session.retirement;
			return `Haiso · ${session.label}\nSession ${session.id}\nConversation permanently deleted. Nothing is forwarded; all controls and pending input are revoked.\nDiscord ${retirement.policy === "retain" ? "history retained" : "history deletion"} · ${retirementComplete ? "done" : retirement.state}${!retirementComplete && retirement.error ? `\n${retirement.error}` : ""}`;
		}
		let queued = 0;
		let active = 0;
		let uncertain = 0;
		for (const delivery of this.#journal.deliveries) {
			if (delivery.sessionId !== session.id) continue;
			if (delivery.state === "queued") queued++;
			else if (delivery.state === "accepted" || delivery.state === "dispatched") active++;
			else if (delivery.state === "unknown") uncertain++;
		}
		return `Haiso · ${session.label}\nSession ${session.id}\nProject ${this.#group(session.groupId).name}\n${this.#sessionActivity(session)} · ${session.state}\nQueued ${queued} · active ${active} · uncertain ${uncertain}`;
	}

	async #cards(group: Group): Promise<void> {
		if (!this.#gateway || group.state !== "ready") return;
		const members = this.#journal.sessions.filter(session => session.groupId === group.id && !session.retirement);
		if (group.overviewId)
			await this.#card(
				group.overviewId,
				`Haiso · ${group.name}\n${group.projectDir}\n${members.map(session => `${session.channelId ? `<#${session.channelId}>` : session.label} · ${session.id} · ${this.#sessionActivity(session)} · ${session.state}`).join("\n")}`,
			);
		for (const session of members)
			if (session.state === "ready" && session.channelId) {
				await this.#card(
					session.channelId,
					`${this.#sessionStatus(session)}\nNormal messages wait for idle; queued messages can become guidance or be cancelled before dispatch. !steer sends guidance; !abort and Stop turn cancel the current turn, not the process.`,
					this.#controlConnection(session),
				);
			}
	}

	async #card(channelId: string, text: string, connectionId?: string, existingOnly = false): Promise<void> {
		const fingerprint = digest([text, connectionId]);
		let card = this.#journal.cards.find(item => item.channelId === channelId);
		// Only exact saved-message replacement is retryable. This mode cannot create
		// a notice when inspection fails or the saved message has disappeared.
		if (existingOnly && !card?.messageId) return;
		if (
			card &&
			((!existingOnly && card.state !== "done") ||
				(card.state === "done" && card.messageId && card.fingerprint === fingerprint))
		)
			return;
		if (!card) {
			// Replaced bindings retain history; permanent retirement keeps its card fence.
			this.#journal.cards = this.#journal.cards.filter(
				item =>
					this.#journal.groups.some(group => group.overviewId === item.channelId) ||
					this.#journal.sessions.some(session => session.channelId === item.channelId),
			);
			card = { channelId, fingerprint, state: "working" };
			this.#journal.cards.push(card);
		} else {
			card.fingerprint = fingerprint;
			card.state = "working";
		}
		await this.#persist();
		const previousMessageId = card.messageId;
		try {
			const messageId = await this.#external(() =>
				this.#port.status(channelId, text, `status:${channelId}`, connectionId, previousMessageId, existingOnly),
			);
			if (existingOnly && messageId !== previousMessageId)
				throw new DiscordModeError("Saved status-card identity changed; no replacement was adopted.");
			card.messageId = RemoteId.assert(messageId);
			card.state = "done";
		} catch {
			card.state = "unknown";
		}
		await this.#persist();
	}

	#snapshot(session: Session, lease = false): ModeSnapshot {
		return {
			group: publicGroup(this.#group(session.groupId)),
			session: publicSession(session),
			peers: this.#journal.sessions
				.filter(item => item.groupId === session.groupId && item.id !== session.id && !item.retirement)
				.map(publicSession),
			...(lease
				? { lease: { sessionId: session.id, connectionId: session.connectionId, token: session.token } }
				: {}),
			deliveries: [],
			answers: [],
			gatewayConnected: this.#gateway,
		};
	}

	#session(id: string): Session {
		const session = this.#journal.sessions.find(item => item.id === id);
		if (!session) throw new DiscordModeError("Unknown enrolled session UUID.");
		return session;
	}

	#group(id: string): Group {
		const group = this.#journal.groups.find(item => item.id === id);
		if (!group) throw new DiscordModeError("Unknown project group.");
		return group;
	}

	#validateRemote(channel: RemoteChannel, kind: RemoteChannel["kind"], parentId?: string): void {
		RemoteId.assert(channel.id);
		Label.assert(channel.name);
		if (channel.kind !== kind || !channel.private || (parentId !== undefined && channel.parentId !== parentId))
			throw new UnknownEffect(
				"Discord returned an incorrectly typed, insecure, or moved resource; inspect and explicitly repair the binding.",
			);
	}

	#assertUnbound(id: string, ownId?: string): void {
		if (
			this.#journal.groups.some(
				group => group.id !== ownId && (group.categoryId === id || group.overviewId === id),
			) ||
			this.#journal.sessions.some(session => session.id !== ownId && session.channelId === id)
		)
			throw new DiscordModeError(
				"Destination is already bound to another group or session; competing bindings are forbidden.",
			);
	}

	#checkPayload(extra: number): void {
		let used = extra;
		for (const delivery of this.#journal.deliveries) used += Buffer.byteLength(delivery.text);
		for (const dialog of this.#journal.dialogs) used += Buffer.byteLength(JSON.stringify(dialog));
		if (used > MAX_PAYLOAD_BYTES)
			throw new DiscordModeError(
				"Discord pending payload budget is full (8 MiB). Resolve pending work before sending more; no accepted payload was discarded.",
			);
	}

	#checkJournal(): void {
		const unique = (values: string[]) => new Set(values).size === values.length;
		if (
			!unique(this.#journal.groups.map(item => item.id)) ||
			!unique(this.#journal.groups.map(item => item.projectDir)) ||
			!unique(this.#journal.sessions.map(item => item.id)) ||
			!unique(this.#journal.sessions.map(item => item.sessionFile)) ||
			!unique(this.#journal.deliveries.map(item => item.id)) ||
			!unique(this.#journal.sessions.flatMap(item => (item.retirement ? [item.retirement.eventId] : [])))
		)
			throw new DiscordModeError("Discord journal contains duplicate persistent identities.");
		const channels = [
			...this.#journal.groups.flatMap(group => [group.categoryId, group.overviewId]),
			...this.#journal.sessions.map(session => session.channelId),
		].filter((id): id is string => id !== undefined);
		if (!unique(channels)) throw new DiscordModeError("Discord journal has competing resource bindings.");
		for (const session of this.#journal.sessions) {
			if (this.#group(session.groupId).projectDir !== session.projectDir)
				throw new DiscordModeError("Session project is inconsistent with its canonical group.");
			if (
				session.retirement &&
				(session.retirement.channelId !== session.channelId ||
					session.enabled ||
					session.connected ||
					session.busy ||
					session.pendingInput ||
					this.#journal.deliveries.some(
						item => item.sessionId === session.id || (item.source === "peer" && item.from === session.id),
					) ||
					this.#journal.dialogs.some(item => item.sessionId === session.id))
			)
				throw new DiscordModeError("Retired session journal contains a changed target or active routing state.");
		}
		for (const delivery of this.#journal.deliveries) {
			const recipient = this.#session(delivery.sessionId);
			if (delivery.source === "peer" && this.#session(delivery.from).groupId !== recipient.groupId)
				throw new DiscordModeError("Retained peer delivery crosses project boundaries.");
			if (delivery.source === "owner" && delivery.from !== this.#config.ownerId)
				throw new DiscordModeError("Retained delivery does not belong to configured owner.");
		}
		for (const dialog of this.#journal.dialogs) this.#session(dialog.sessionId);
		this.#checkPayload(0);
	}
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function equalTokens(left: string, right: string): boolean {
	return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
function publicGroup(group: Group): ModeGroup {
	const { uncertain: _uncertain, overviewUncertain: _overviewUncertain, ...result } = group;
	return result;
}
function publicSession(session: Session): ModeSession {
	const { token: _token, seenAt: _seenAt, uncertain: _uncertain, ...result } = session;
	return result;
}
function publicDelivery(delivery: Delivery): ModeDelivery {
	const {
		connectionId: _connectionId,
		held: _held,
		channelId: _channelId,
		sourceMessageId: _sourceMessageId,
		...result
	} = delivery;
	return result;
}
function inspectionState(inspection: ChannelInspection, kind: RemoteChannel["kind"], parentId?: string): BindingState {
	if (inspection.state !== "found") return inspection.state;
	if (inspection.channel.kind !== kind || !inspection.channel.private) return "inaccessible";
	if (parentId !== undefined && inspection.channel.parentId !== parentId) return "moved";
	return "ready";
}
