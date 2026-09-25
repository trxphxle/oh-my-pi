import { afterEach, describe, expect, it, vi } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	CLOSED_SAVED_TEXT,
	DISCORD_MODE_CATCH_UP_LIMIT,
	DISCORD_MODE_CATCH_UP_MS,
	DISCORD_MODE_LONG_TURN_MS,
	DISCORD_MODE_LAUNCH_GRACE_MS,
	DISCORD_MODE_LAUNCH_TTL_MS,
	DISCORD_MODE_MAX_BACKGROUND,
	DISCORD_MODE_PROGRESS_CARD_MS,
	DISCORD_MODE_STEP_ASIDE_STOP_MS,
	DISCORD_MODE_SWITCH_QUIET_MS,
	DiscordModeBroker,
	DiscordModeError,
	type DiscordHostPort,
	type DiscordHostSpec,
	SERVICE_UPDATING_TEXT,
} from "../../src/discord-mode/broker";
import { renderDiscordGuide } from "../../src/discord-mode/guide";
import { DiscordModeSession, type DiscordSessionEngine } from "../../src/discord-mode/session";
import { settingsChoiceToken } from "../../src/discord-mode/settings-view";
import { connectDiscordModeAt, sealModeSettingsView } from "@oh-my-pi/pi-utils/discord-client";
import { readPrivateJson, writePrivateJson } from "@oh-my-pi/pi-utils/discord-private-files";
import {
	commitDiscordDeletionEvent,
	discardDiscordDeletionEvent,
	prepareDiscordDeletionEvent,
	readDiscordDeletionEvents,
	withDiscordDeletionLock,
} from "../../src/discord-mode/retirement-events";
import { startDiscordModeServer } from "../../src/discord-mode/server";
import { DISCORD_MODE_MAX_REPLY, DISCORD_MODE_MAX_TEXT } from "@oh-my-pi/pi-wire/discord-mode";
import type {
	ChannelInspection,
	DiscordPort,
	DiscordPortHandlers,
	ModeControlRequest,
	ModeControlResult,
	ModeApp,
	ModeDialog,
	ModeDeletionBinding,
	ModeDeletionEvent,
	ModeRetirementPolicy,
	ModeLease,
	ModeNoticeAction,
	ModeOwnerMessage,
	ModeRequest,
	ModeSettingCommand,
	ModeSettingsPanel,
	ModeSettingsView,
	ModeSnapshot,
	ModeProgress,
	RemoteChannel,
} from "@oh-my-pi/pi-wire/discord-mode";

const config = { guildId: "100", ownerId: "200", botToken: "offline-fixture-only" };

/** Stateful offline Discord boundary: effects survive broker restarts, just like remote resources. */
class FixtureDiscord implements DiscordPort {
	handlers: DiscordPortHandlers | undefined;
	readonly channels = new Map<string, RemoteChannel>();
	readonly publications: Array<{
		kind: "publish" | "reply";
		channelId: string;
		text: string;
		key: string;
		mention: boolean;
	}> = [];
	readonly cards = new Map<
		string,
		{ id: string; text: string; connectionId?: string; app?: ModeApp; resumable?: true }
	>();
	readonly legacyCards = new Set<string>();
	readonly dialogs = new Map<string, ModeDialog>();
	readonly shownDialogs: Array<{ title: string; mention: boolean }> = [];
	readonly inaccessible = new Set<string>();
	creates = 0;
	statusCreates = 0;
	nextStatusConfirmation: "lost" | "invalid" | undefined;
	failNextStatusInspection = false;
	failNextCreate = false;
	failNextPublish = false;
	online = true;
	failNextRetire: "before" | "after" | undefined;
	beforeRetire: (() => Promise<void>) | undefined;
	readonly retirements: Array<{ channelId: string; policy: ModeRetirementPolicy }> = [];
	readonly renames: Array<{ id: string; name: string }> = [];
	failNextRename = false;
	/** Last requested top-to-bottom order per category. */
	readonly arrangements = new Map<string, string[]>();
	#next = 1000;

	async start(handlers: DiscordPortHandlers): Promise<void> {
		this.handlers = handlers;
		handlers.connection(this.online);
	}
	async close(): Promise<void> {
		this.handlers?.connection(false);
		this.handlers = undefined;
	}
	async inspect(id: string): Promise<ChannelInspection> {
		if (this.inaccessible.has(id)) return { state: "inaccessible" };
		const channel = this.channels.get(id);
		return channel ? { state: "found", channel: { ...channel } } : { state: "missing" };
	}
	async createCategory(name: string): Promise<RemoteChannel> {
		const channel: RemoteChannel = { id: String(this.#next++), name, kind: "category", private: true };
		this.channels.set(channel.id, channel);
		this.creates++;
		if (this.failNextCreate) {
			this.failNextCreate = false;
			throw new Error("response lost after remote creation");
		}
		return { ...channel };
	}
	async createChannel(categoryId: string, name: string, marker: string): Promise<RemoteChannel> {
		const channel: RemoteChannel = {
			id: String(this.#next++),
			name,
			kind: "text",
			private: true,
			parentId: categoryId,
			topic: marker,
		};
		this.channels.set(channel.id, channel);
		this.creates++;
		if (this.failNextCreate) {
			this.failNextCreate = false;
			throw new Error("response lost after remote creation");
		}
		return { ...channel };
	}
	async rename(id: string, name: string): Promise<void> {
		this.renames.push({ id, name });
		if (this.failNextRename) {
			this.failNextRename = false;
			throw new Error("rename rate limited");
		}
		this.channel(id).name = name;
	}
	async arrange(categoryId: string, channelIds: string[]): Promise<void> {
		this.arrangements.set(categoryId, [...channelIds]);
	}
	async move(id: string, categoryId: string): Promise<void> {
		this.channel(id).parentId = categoryId;
	}
	async retire(channelId: string, sessionId: string, policy: ModeRetirementPolicy): Promise<void> {
		await this.beforeRetire?.();
		const inspected = await this.inspect(channelId);
		if (inspected.state === "missing") return;
		const marker = `haiso:session:${sessionId}`;
		const closed = `${marker} — Closed: native conversation permanently deleted.`;
		if (
			inspected.state !== "found" ||
			inspected.channel.kind !== "text" ||
			!inspected.channel.private ||
			(inspected.channel.topic !== marker && inspected.channel.topic !== closed)
		)
			throw new Error("exact owned private channel unavailable");
		if (this.failNextRetire === "before") {
			this.failNextRetire = undefined;
			throw new Error("retirement unavailable before effect");
		}
		const channel = this.channel(channelId);
		if (policy === "retain") {
			if (channel.topic === closed && channel.name.startsWith("archived-")) return;
			channel.topic = closed;
			if (!channel.name.startsWith("archived-")) channel.name = `archived-${channel.name}`.slice(0, 100);
		} else {
			this.channels.delete(channelId);
			this.cards.delete(channelId);
			this.dialogs.delete(channelId);
		}
		this.retirements.push({ channelId, policy });
		if (this.failNextRetire === "after") {
			this.failNextRetire = undefined;
			throw new Error("retirement applied; response and immediate inspection unavailable");
		}
	}
	async publish(channelId: string, text: string, key: string): Promise<void> {
		this.publications.push({ kind: "publish", channelId, text, key, mention: false });
		if (this.failNextPublish) {
			this.failNextPublish = false;
			throw new Error("response lost after remote publication");
		}
	}
	async reply(channelId: string, text: string, key: string, options?: { mention?: boolean }): Promise<void> {
		this.publications.push({ kind: "reply", channelId, text, key, mention: options?.mention === true });
		if (this.failNextPublish) {
			this.failNextPublish = false;
			throw new Error("response lost after remote publication");
		}
	}
	async status(
		channelId: string,
		text: string,
		_key: string,
		connectionId?: string,
		messageId?: string,
		existingOnly = false,
		app?: ModeApp,
		resumable = false,
	): Promise<string> {
		if (this.failNextStatusInspection) {
			this.failNextStatusInspection = false;
			throw new Error("status inspection temporarily unavailable before mutation");
		}
		const existing = this.cards.get(channelId);
		if (existingOnly && (!messageId || existing?.id !== messageId))
			throw new Error("exact saved status message unavailable; replacement is forbidden");
		if (messageId && existing?.id !== messageId) messageId = undefined;
		const id = messageId ?? (this.legacyCards.has(channelId) ? existing?.id : undefined);
		const card = { id: id ?? String(this.#next++), text, connectionId, app, ...(resumable ? { resumable } : {}) };
		if (!id) this.statusCreates++;
		this.cards.set(channelId, card);
		this.legacyCards.delete(channelId);
		const confirmation = this.nextStatusConfirmation;
		this.nextStatusConfirmation = undefined;
		if (confirmation === "lost") throw new Error("response lost after remote status publication");
		return confirmation === "invalid" ? "not-a-message-id" : card.id;
	}
	async showDialog(channelId: string, dialog: ModeDialog, options?: { mention?: boolean }): Promise<void> {
		this.dialogs.set(channelId, structuredClone(dialog));
		this.shownDialogs.push({ title: dialog.title, mention: options?.mention === true });
	}
	async endDialog(channelId: string, dialogId: string): Promise<void> {
		if (this.dialogs.get(channelId)?.id === dialogId) this.dialogs.delete(channelId);
	}
	readonly settingsResults: Array<{ channelId: string; commandId: string; text: string; panel?: ModeSettingsPanel }> =
		[];
	#settingsWaiters: Array<{ count: number; resolve: () => void }> = [];
	async settingsResult(channelId: string, commandId: string, text: string, panel?: ModeSettingsPanel): Promise<void> {
		this.settingsResults.push({ channelId, commandId, text, ...(panel ? { panel } : {}) });
		for (const waiter of this.#settingsWaiters.filter(item => item.count <= this.settingsResults.length)) {
			this.#settingsWaiters.splice(this.#settingsWaiters.indexOf(waiter), 1);
			waiter.resolve();
		}
	}
	/** Settings outcomes arrive off the request path (detached apply, post-mutation notes); await the delivery itself. */
	settingsDelivered(count: number): Promise<void> {
		if (this.settingsResults.length >= count) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#settingsWaiters.push({ count, resolve });
		return promise;
	}
	/** Remote channel history, oldest first; `history` returns what follows the watermark like the adapter. */
	readonly remoteHistory = new Map<string, ModeOwnerMessage[]>();
	readonly historyRequests: Array<{ channelId: string; afterId: string; limit: number }> = [];
	async history(channelId: string, afterId: string, limit: number): Promise<ModeOwnerMessage[]> {
		this.historyRequests.push({ channelId, afterId, limit });
		return (this.remoteHistory.get(channelId) ?? [])
			.filter(message => BigInt(message.id) > BigInt(afterId))
			.slice(0, limit)
			.map(message => ({ ...message }));
	}
	readonly notices: Array<{
		channelId: string;
		text: string;
		key: string;
		connectionId: string;
		actions: ModeNoticeAction[];
	}> = [];
	async notice(
		channelId: string,
		text: string,
		key: string,
		connectionId: string,
		actions: ModeNoticeAction[],
	): Promise<void> {
		this.notices.push({ channelId, text, key, connectionId, actions });
	}
	channel(id: string): RemoteChannel {
		const channel = this.channels.get(id);
		if (!channel) throw new Error("fixture channel missing");
		return channel;
	}
	removeCategory(id: string): void {
		this.channels.delete(id);
		for (const channel of this.channels.values()) if (channel.parentId === id) delete channel.parentId;
	}
	owner(
		session: ModeSnapshot,
		text: string,
		kind: "message" | "steer" | "abort" = "message",
		id = String(this.#next++),
	): Promise<ModeControlResult> {
		if (!this.handlers || !session.session.channelId) throw new Error("fixture is not connected");
		return this.handlers.ownerMessage({
			id,
			ownerId: config.ownerId,
			channelId: session.session.channelId,
			text,
			kind,
		});
	}
	control(
		session: ModeSnapshot,
		action: ModeControlRequest["action"],
		fields: Partial<ModeControlRequest> = {},
	): Promise<ModeControlResult> {
		if (!this.handlers || !session.session.channelId) throw new Error("fixture is not connected");
		return this.handlers.control({
			id: String(this.#next++),
			channelId: session.session.channelId,
			ownerId: config.ownerId,
			action,
			...fields,
		});
	}
}

function registration(
	root: string,
	label: string,
	projectDir = path.join(root, "project"),
): Extract<ModeRequest, { op: "register" }> {
	const sessionId = randomUUID();
	return {
		op: "register",
		requestId: randomUUID(),
		sessionId,
		sessionFile: path.join(root, `${sessionId}.jsonl`),
		projectDir,
		connectionId: randomUUID(),
		label,
		groupName: "Named project",
	};
}
function lease(snapshot: ModeSnapshot): ModeLease {
	if (!snapshot.lease) throw new Error("registration lease missing");
	return snapshot.lease;
}
function poll(broker: DiscordModeBroker, snapshot: ModeSnapshot, busy = false): Promise<ModeSnapshot> {
	return broker.request({ op: "poll", lease: lease(snapshot), busy, pendingInput: false });
}
function resumed(input: Extract<ModeRequest, { op: "register" }>): Extract<ModeRequest, { op: "register" }> {
	return { ...input, requestId: randomUUID(), connectionId: randomUUID() };
}

function deletionBinding(snapshot: ModeSnapshot): ModeDeletionBinding {
	return {
		sessionId: snapshot.session.id,
		sessionFile: snapshot.session.sessionFile,
		projectDir: snapshot.session.projectDir,
		channelId: snapshot.session.channelId,
		label: snapshot.session.label,
		guildId: config.guildId,
		ownerId: config.ownerId,
	};
}

async function deleted(
	storePath: string,
	snapshot: ModeSnapshot,
	policy: ModeRetirementPolicy = "retain",
	commit = true,
): Promise<ModeDeletionEvent> {
	const root = path.dirname(storePath);
	const event = await prepareDiscordDeletionEvent(deletionBinding(snapshot), policy, root);
	await fs.rm(snapshot.session.sessionFile);
	if (commit) await commitDiscordDeletionEvent(event, root);
	return event;
}

describe("durable Discord mode broker", () => {
	it("durably closes retained conversations before effects, clears input, and rejects every stale route", async () => {
		using temporary = TempDir.createSync("@discord-retirement-retain-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const input = registration(root, "retained");
			await fs.writeFile(input.sessionFile, `${JSON.stringify({ type: "session", id: input.sessionId })}\n`);
			const retired = await broker.request(input);
			const peer = await broker.request(registration(root, "survivor"));
			await port.owner(retired, "private queued owner payload");
			await broker.request({
				op: "send",
				lease: lease(retired),
				requestId: randomUUID(),
				recipientId: peer.session.id,
				text: "private outgoing peer payload",
			});
			await broker.request({
				op: "dialog",
				lease: lease(retired),
				dialog: { id: "pending", kind: "input", title: "Private input" },
			});
			const dialogId = port.dialogs.get(retired.session.channelId!)!.id;
			await port.handlers!.answer({
				ownerId: config.ownerId,
				channelId: retired.session.channelId!,
				dialogId,
				value: "private queued answer",
				cancelled: false,
			});
			const statusId = port.cards.get(retired.session.channelId!)!.id;
			const creates = port.statusCreates;
			const event = await deleted(storePath, retired);
			expect((await port.owner(retired, "arrived after native deletion")).text).toContain("nothing was forwarded");
			await expect(poll(broker, retired)).rejects.toThrow("permanently deleted");
			port.beforeRetire = async () => {
				const journal = (await readPrivateJson(storePath)) as {
					sessions: Array<{ id: string; enabled: boolean; connected: boolean; retirement?: { eventId: string } }>;
					deliveries: unknown[];
					dialogs: unknown[];
				};
				const tombstone = journal.sessions.find(item => item.id === retired.session.id)!;
				expect(tombstone.retirement?.eventId).toBe(event.id);
				expect(tombstone.enabled).toBe(false);
				expect(tombstone.connected).toBe(false);
				expect(journal.deliveries).toEqual([]);
				expect(journal.dialogs).toEqual([]);
			};
			const result = await broker.request({ op: "retire", eventId: event.id });
			expect(result.session.retirement).toMatchObject({
				eventId: event.id,
				policy: "retain",
				state: "done",
				channelId: retired.session.channelId,
			});
			expect(result.lease).toBeUndefined();
			expect(port.channel(retired.session.channelId!).name).toMatch(/^archived-/);
			expect(port.cards.get(retired.session.channelId!)).toMatchObject({ id: statusId, connectionId: undefined });
			expect(port.cards.get(retired.session.channelId!)!.text).toContain("permanently deleted");
			expect(port.statusCreates).toBe(creates);
			expect((await poll(broker, peer)).peers).toEqual([]);
			expect((await poll(broker, peer)).deliveries).toEqual([]);
			expect(port.cards.get(retired.group.overviewId!)!.text).not.toContain(retired.session.id);
			expect((await port.owner(retired, "must not become a model prompt")).text).toContain("nothing was forwarded");
			expect((await port.control(retired, "status", { connectionId: retired.session.connectionId })).text).toContain(
				"permanently deleted",
			);
			expect((await port.control(retired, "queue")).queued).toEqual([]);
			await expect(port.control(retired, "stop", { connectionId: retired.session.connectionId })).rejects.toThrow(
				"permanently deleted",
			);
			await expect(
				port.control(retired, "cancel", { connectionId: retired.session.connectionId, deliveryId: randomUUID() }),
			).rejects.toThrow("permanently deleted");
			await expect(
				port.handlers!.answer({
					ownerId: config.ownerId,
					channelId: retired.session.channelId!,
					dialogId,
					value: "late",
					cancelled: false,
				}),
			).rejects.toThrow("permanently deleted");
			await expect(poll(broker, retired)).rejects.toThrow("permanently deleted");
			await expect(
				broker.request({
					op: "repair",
					lease: lease(retired),
					requestId: randomUUID(),
					target: "session",
					resumeQueued: true,
				}),
			).rejects.toThrow("permanently deleted");
			await expect(
				broker.request({
					op: "send",
					lease: lease(peer),
					requestId: randomUUID(),
					recipientId: retired.session.id,
					text: "late peer message",
				}),
			).rejects.toThrow("permanently deleted");
			await expect(broker.request(resumed(input))).rejects.toThrow("permanently deleted");
			expect(await readDiscordDeletionEvents(path.dirname(storePath))).toEqual([]);
			await broker.request({ op: "retire", eventId: event.id });
			expect(port.retirements).toEqual([{ channelId: retired.session.channelId!, policy: "retain" }]);
		} finally {
			await broker.close();
		}
	});

	it("deletes only the explicitly approved bound channel and recovers a lost deletion response", async () => {
		using temporary = TempDir.createSync("@discord-retirement-delete-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const input = registration(root, "erase");
			await fs.writeFile(input.sessionFile, `${JSON.stringify({ type: "session", id: input.sessionId })}\n`);
			const session = await broker.request(input);
			const other = await broker.request(registration(root, "untouched"));
			const otherChannel = structuredClone(port.channel(other.session.channelId!));
			const event = await deleted(storePath, session, "delete");
			port.failNextRetire = "after";
			expect((await broker.request({ op: "retire", eventId: event.id })).session.retirement?.state).toBe(
				"attention",
			);
			expect(port.channels.has(session.session.channelId!)).toBe(false);
			expect((await broker.request({ op: "retire", eventId: event.id })).session.retirement?.state).toBe("done");
			expect(port.retirements).toEqual([{ channelId: session.session.channelId!, policy: "delete" }]);
			expect(port.channel(other.session.channelId!)).toEqual(otherChannel);
			expect(port.channels.has(session.group.categoryId!)).toBe(true);
			expect(port.channels.has(session.group.overviewId!)).toBe(true);
		} finally {
			await broker.close();
		}
	});

	it("adopts offline deletion intent on startup and completes pending archival after reconnect", async () => {
		using temporary = TempDir.createSync("@discord-retirement-offline-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const port = new FixtureDiscord();
		let broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const input = registration(root, "offline");
			await fs.writeFile(input.sessionFile, `${JSON.stringify({ type: "session", id: input.sessionId })}\n`);
			const session = await broker.request(input);
			await broker.close();
			const event = await deleted(storePath, session);
			port.online = false;
			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			const offline = await broker.request({ op: "retire", eventId: event.id });
			expect(offline.session.retirement?.state).toBe("pending");
			expect(offline.session.enabled).toBe(false);
			expect(port.retirements).toEqual([]);
			await expect(broker.request(resumed(input))).rejects.toThrow("permanently deleted");
			port.handlers!.connection(true);
			await port.handlers!.changed();
			expect((await broker.request({ op: "retire", eventId: event.id })).session.retirement?.state).toBe("done");
			expect(port.retirements).toEqual([{ channelId: session.session.channelId!, policy: "retain" }]);
		} finally {
			await broker.close();
		}
	});

	it("recovers only prepared intent whose exact native file is proven absent", async () => {
		using temporary = TempDir.createSync("@discord-retirement-prepared-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const port = new FixtureDiscord();
		let broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const input = registration(root, "prepared");
			await fs.writeFile(input.sessionFile, `${JSON.stringify({ type: "session", id: input.sessionId })}\n`);
			const session = await broker.request(input);
			const event = await prepareDiscordDeletionEvent(deletionBinding(session), "retain", path.dirname(storePath));
			await expect(broker.request({ op: "retire", eventId: event.id })).rejects.toThrow("not committed");
			expect((await poll(broker, session)).session.enabled).toBe(true);
			await fs.rm(input.sessionFile);
			await broker.close();
			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			expect((await broker.request({ op: "retire", eventId: event.id })).session.retirement?.state).toBe("done");
			expect(port.retirements).toEqual([{ channelId: session.session.channelId!, policy: "retain" }]);
		} finally {
			await broker.close();
		}
	});

	it("serializes adoption with cancellation and replacement of an explicit deletion attempt", async () => {
		using temporary = TempDir.createSync("@discord-retirement-transaction-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const eventRoot = path.dirname(storePath);
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const input = registration(root, "replacement");
			await fs.writeFile(input.sessionFile, `${JSON.stringify({ type: "session", id: input.sessionId })}\n`);
			const session = await broker.request(input);
			const previous = await prepareDiscordDeletionEvent(deletionBinding(session), "retain", eventRoot);
			const held = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const replacement = withDiscordDeletionLock(eventRoot, async () => {
				held.resolve();
				await release.promise;
				await discardDiscordDeletionEvent(previous, eventRoot);
				const current = await prepareDiscordDeletionEvent(deletionBinding(session), "delete", eventRoot);
				await fs.rm(input.sessionFile);
				await commitDiscordDeletionEvent(current, eventRoot);
				return current;
			});
			await held.promise;
			const stale = broker.request({ op: "retire", eventId: previous.id }).catch(error => error);
			release.resolve();
			const current = await replacement;
			expect(await stale).toBeInstanceOf(DiscordModeError);
			const result = await broker.request({ op: "retire", eventId: current.id });
			expect(result.session.retirement).toMatchObject({ eventId: current.id, policy: "delete", state: "done" });
			expect(port.retirements).toEqual([{ channelId: session.session.channelId!, policy: "delete" }]);
		} finally {
			await broker.close();
		}
	});

	it("does not infer deletion from missing files, off, disconnection, or missing parent directories", async () => {
		using temporary = TempDir.createSync("@discord-retirement-no-inference-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const port = new FixtureDiscord();
		let broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const input = registration(root, "ordinary");
			await fs.writeFile(input.sessionFile, `${JSON.stringify({ type: "session", id: input.sessionId })}\n`);
			const ordinary = await broker.request(input);
			await fs.rm(input.sessionFile);
			await broker.request({ op: "off", lease: lease(ordinary) });
			const movedInput = registration(root, "moved");
			const nativeDir = path.join(root, "native-dir");
			await fs.mkdir(nativeDir);
			movedInput.sessionFile = path.join(nativeDir, `${movedInput.sessionId}.jsonl`);
			await fs.writeFile(
				movedInput.sessionFile,
				`${JSON.stringify({ type: "session", id: movedInput.sessionId })}\n`,
			);
			const moved = await broker.request(movedInput);
			const event = await prepareDiscordDeletionEvent(deletionBinding(moved), "retain", path.dirname(storePath));
			await fs.rename(nativeDir, `${nativeDir}-moved`);
			await expect(broker.request({ op: "retire", eventId: event.id })).rejects.toThrow();
			await fs.rename(`${nativeDir}-moved`, nativeDir);
			await broker.close();
			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			expect((await broker.lookup(input.projectDir, input.sessionId))?.session?.retirement).toBeUndefined();
			expect((await broker.request(resumed(input))).session.enabled).toBe(true);
			expect(
				(await broker.lookup(movedInput.projectDir, movedInput.sessionId))?.session?.retirement,
			).toBeUndefined();
			expect(port.retirements).toEqual([]);
			expect(port.channel(ordinary.session.channelId!).name).not.toMatch(/^archived-/);
		} finally {
			await broker.close();
		}
	});

	it("refuses wrong binding and ownership without touching either channel", async () => {
		using temporary = TempDir.createSync("@discord-retirement-binding-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const input = registration(root, "target");
			await fs.writeFile(input.sessionFile, `${JSON.stringify({ type: "session", id: input.sessionId })}\n`);
			const session = await broker.request(input);
			const otherInput = registration(root, "other");
			await fs.writeFile(
				otherInput.sessionFile,
				`${JSON.stringify({ type: "session", id: otherInput.sessionId })}\n`,
			);
			const other = await broker.request(otherInput);
			const forged = await prepareDiscordDeletionEvent(deletionBinding(session), "delete", path.dirname(storePath));
			forged.binding.channelId = other.session.channelId;
			await writePrivateJson(path.join(path.dirname(storePath), "deletions", `${session.session.id}.json`), forged);
			await fs.rm(input.sessionFile);
			await commitDiscordDeletionEvent(forged, path.dirname(storePath));
			await expect(broker.request({ op: "retire", eventId: forged.id })).rejects.toThrow("conflicts");
			expect((await poll(broker, session)).session.retirement).toBeUndefined();
			const otherEvent = await deleted(storePath, other, "delete");
			port.channel(other.session.channelId!).topic = `haiso:session:${randomUUID()}`;
			expect((await broker.request({ op: "retire", eventId: otherEvent.id })).session.retirement?.state).toBe(
				"attention",
			);
			expect(port.channels.has(session.session.channelId!)).toBe(true);
			expect(port.channels.has(other.session.channelId!)).toBe(true);
			expect(port.retirements).toEqual([]);
		} finally {
			await broker.close();
		}
	});

	it("reconciles lost archival responses after restart without duplicate archive effects or new notices", async () => {
		using temporary = TempDir.createSync("@discord-retirement-recovery-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const port = new FixtureDiscord();
		let broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const input = registration(root, "recover");
			await fs.writeFile(input.sessionFile, `${JSON.stringify({ type: "session", id: input.sessionId })}\n`);
			const session = await broker.request(input);
			const creates = port.statusCreates;
			const event = await deleted(storePath, session);
			port.failNextRetire = "after";
			expect((await broker.request({ op: "retire", eventId: event.id })).session.retirement?.state).toBe(
				"attention",
			);
			await broker.close();
			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			expect((await broker.request({ op: "retire", eventId: event.id })).session.retirement?.state).toBe("done");
			expect(port.channel(session.session.channelId!).name).toBe("archived-🟣-recover");
			expect(port.retirements).toEqual([{ channelId: session.session.channelId!, policy: "retain" }]);
			expect(port.statusCreates).toBe(creates);
			const conflicting: ModeDeletionEvent = {
				...event,
				id: randomUUID(),
				policy: "delete",
				phase: "committed",
				createdAt: event.createdAt + 1,
			};
			await writePrivateJson(
				path.join(path.dirname(storePath), "deletions", `${session.session.id}.json`),
				conflicting,
			);
			await expect(broker.request({ op: "retire", eventId: conflicting.id })).rejects.toThrow("conflicts");
			expect(port.channels.has(session.session.channelId!)).toBe(true);
		} finally {
			await broker.close();
		}
	});

	it("recovers an unconfirmed saved-card edit without creating a notice and exposes retirement over authenticated IPC", async () => {
		using temporary = TempDir.createSync("@discord-retirement-notice-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const port = new FixtureDiscord();
		let broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const input = registration(root, "notice");
			await fs.writeFile(input.sessionFile, `${JSON.stringify({ type: "session", id: input.sessionId })}\n`);
			const session = await broker.request(input);
			const event = await deleted(storePath, session);
			port.nextStatusConfirmation = "lost";
			const creates = port.statusCreates;
			expect((await broker.request({ op: "retire", eventId: event.id })).session.retirement?.state).toBe(
				"attention",
			);
			const closedCardId = port.cards.get(session.session.channelId!)!.id;
			await broker.close();
			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			const socketPath = path.join(root, "ipc.sock");
			const token = "offline-retirement-fixture-token-123456";
			const server = await startDiscordModeServer({ broker, socketPath, token });
			try {
				const client = await connectDiscordModeAt(socketPath, token);
				try {
					const result = await client.request({ op: "retire", eventId: event.id });
					expect(result.session.retirement).toMatchObject({ eventId: event.id, policy: "retain", state: "done" });
					expect((await client.lookup(input.projectDir, input.sessionId))?.session?.retirement).toEqual(
						result.session.retirement,
					);
					expect(result.deliveries).toEqual([]);
					expect(result.answers).toEqual([]);
				} finally {
					await client.close();
				}
			} finally {
				await server.close();
			}
			expect(port.cards.get(session.session.channelId!)).toMatchObject({
				id: closedCardId,
				connectionId: undefined,
			});
			expect(port.cards.get(session.session.channelId!)!.text).toContain("permanently deleted");
			expect(port.statusCreates).toBe(creates);
			expect(port.retirements).toEqual([{ channelId: session.session.channelId!, policy: "retain" }]);
		} finally {
			await broker.close();
		}
	});

	it("finishes archival despite transient saved-card inspection failure and repairs the notice on recovery", async () => {
		using temporary = TempDir.createSync("@discord-retirement-card-inspection-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const input = registration(root, "card-inspection");
			await fs.writeFile(input.sessionFile, `${JSON.stringify({ type: "session", id: input.sessionId })}\n`);
			const session = await broker.request(input);
			const channelId = session.session.channelId!;
			const savedCard = structuredClone(port.cards.get(channelId)!);
			const creates = port.statusCreates;
			const event = await deleted(storePath, session);
			port.failNextStatusInspection = true;
			expect((await broker.request({ op: "retire", eventId: event.id })).session.retirement?.state).toBe(
				"attention",
			);
			expect(port.channel(channelId).name).toBe("archived-🟣-card-inspection");
			expect(port.cards.get(channelId)).toEqual(savedCard);
			const recovered = await broker.request({ op: "retire", eventId: event.id });
			expect(recovered.session.retirement?.state).toBe("done");
			expect(port.cards.get(channelId)).toMatchObject({ id: savedCard.id, connectionId: undefined });
			expect(port.cards.get(channelId)!.text).toContain("permanently deleted");
			expect(port.statusCreates).toBe(creates);
			expect(port.retirements).toEqual([{ channelId, policy: "retain" }]);
		} finally {
			await broker.close();
		}
	});

	it("never replaces a missing saved retirement card or adopts a different cached card during recovery", async () => {
		using temporary = TempDir.createSync("@discord-retirement-card-missing-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const port = new FixtureDiscord();
		let broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const input = registration(root, "missing-card");
			await fs.writeFile(input.sessionFile, `${JSON.stringify({ type: "session", id: input.sessionId })}\n`);
			const session = await broker.request(input);
			const channelId = session.session.channelId!;
			const event = await deleted(storePath, session);
			const creates = port.statusCreates;
			const replacement = {
				id: "999999",
				text: "Unrelated cached card; must not be adopted.",
				connectionId: session.session.connectionId,
			};
			port.cards.set(channelId, replacement);
			port.legacyCards.add(channelId);
			expect((await broker.request({ op: "retire", eventId: event.id })).session.retirement?.state).toBe(
				"attention",
			);
			expect(port.channel(channelId).name).toBe("archived-🟣-missing-card");
			await broker.close();
			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			expect((await broker.request({ op: "retire", eventId: event.id })).session.retirement?.state).toBe(
				"attention",
			);
			expect(port.cards.get(channelId)).toEqual(replacement);
			expect(port.statusCreates).toBe(creates);
			expect(port.retirements).toEqual([{ channelId, policy: "retain" }]);
		} finally {
			await broker.close();
		}
	});

	it("groups three canonical-folder sessions, isolates other projects, and dispatches FIFO except controls", async () => {
		using temporary = TempDir.createSync("@discord-broker-membership-");
		const root = temporary.path();
		await fs.mkdir(path.join(root, "project"));
		await fs.symlink(path.join(root, "project"), path.join(root, "alias"));
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			const request = registration(root, "overview");
			const a = await broker.request(request);
			const retry = await broker.request(request);
			expect(retry.lease).toEqual(a.lease);
			const b = await broker.request(registration(root, "OVERVIEW", path.join(root, "alias")));
			const c = await broker.request(registration(root, "overview"));
			const other = await broker.request(registration(root, "other", path.join(root, "different")));
			expect(a.group.id).toBe(b.group.id);
			expect(c.peers.map(peer => peer.id).sort()).toEqual([a.session.id, b.session.id].sort());
			expect(other.group.id).not.toBe(a.group.id);
			expect(new Set([a.session.channelId, b.session.channelId, c.session.channelId]).size).toBe(3);
			expect(new Set([a.session.label, b.session.label, c.session.label]).size).toBe(3);
			expect([a.session.label, b.session.label, c.session.label]).not.toContain("overview");
			expect((await broker.lookup(path.join(root, "alias"), a.session.id))?.group.id).toBe(a.group.id);
			await expect(broker.request(resumed(request))).rejects.toThrow("live lease");
			await expect(broker.request({ op: "status", lease: { ...lease(a), token: "0".repeat(64) } })).rejects.toThrow(
				"lease",
			);
			await expect(
				broker.request({
					op: "send",
					lease: lease(a),
					requestId: randomUUID(),
					recipientId: other.session.id,
					text: "not allowed",
				}),
			).rejects.toThrow("same project");
			const send: ModeRequest = {
				op: "send",
				lease: lease(a),
				requestId: randomUUID(),
				recipientId: b.session.id,
				text: "first peer task",
			};
			await broker.request(send);
			await broker.request(send);
			await port.owner(b, "second owner task");
			expect((await poll(broker, b, true)).deliveries).toEqual([]);
			await port.owner(b, "stop current turn", "abort");
			const control = (await poll(broker, b, true)).deliveries[0]!;
			expect(control.kind).toBe("abort");
			await broker.request({ op: "receipt", lease: lease(b), deliveryId: control.id, state: "completed" });
			const first = (await poll(broker, b)).deliveries[0]!;
			expect({ source: first.source, from: first.from, text: first.text }).toEqual({
				source: "peer",
				from: a.session.id,
				text: "first peer task",
			});
			expect((await poll(broker, b)).deliveries).toEqual([]);
			await broker.request({ op: "receipt", lease: lease(b), deliveryId: first.id, state: "completed" });
			const second = (await poll(broker, b)).deliveries[0]!;
			expect(second.text).toBe("second owner task");
			expect(second.source).toBe("owner");
			expect((await broker.request({ op: "status", lease: lease(b) })).session.enabled).toBe(true);
		} finally {
			await broker.close();
		}
	});

	it("retains uncertain original input on restart and requires distinct resolution and queued resumption", async () => {
		using temporary = TempDir.createSync("@discord-broker-restart-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const port = new FixtureDiscord();
		const input = registration(root, "durable");
		let broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const before = await broker.request(input);
			await port.owner(before, "may already have changed files", "message", "8001");
			const dispatched = (await poll(broker, before)).deliveries[0]!;
			await broker.request({ op: "receipt", lease: lease(before), deliveryId: dispatched.id, state: "accepted" });
			await port.owner(before, "not dispatched yet", "message", "8002");
			const created = port.creates;
			await broker.close();
			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			const socketPath = path.join(root, "ipc.sock");
			const token = "offline-enrollment-lookup-token-123456";
			const server = await startDiscordModeServer({ broker, socketPath, token });
			try {
				const client = await connectDiscordModeAt(socketPath, token);
				try {
					const retained = await client.lookup(input.projectDir, input.sessionId);
					expect(retained?.session?.channelId).toBe(before.session.channelId);
					expect(retained?.session?.connected).toBe(false);
					expect(retained?.session).not.toHaveProperty("token");
					expect((await client.lookup(input.projectDir, randomUUID()))?.session).toBeUndefined();
					expect(await client.lookup(path.join(root, "other"), input.sessionId)).toBeUndefined();
				} finally {
					await client.close();
				}
			} finally {
				await server.close();
			}
			const after = await broker.request(resumed(input));
			expect(after.session.channelId).toBe(before.session.channelId);
			expect(port.creates).toBe(created);
			await expect(
				broker.request({ op: "receipt", lease: lease(before), deliveryId: dispatched.id, state: "completed" }),
			).rejects.toThrow("lease");
			const uncertain = (await broker.request({ op: "status", lease: lease(after) })).deliveries.find(
				item => item.id === dispatched.id,
			)!;
			expect(uncertain.state).toBe("unknown");
			expect(uncertain.text).toBe("may already have changed files");
			expect((await poll(broker, after)).deliveries).toEqual([]);
			await expect(port.owner(after, "new work blocked")).rejects.toThrow("unknown");
			for (const action of ["cancel", "steer"] as const)
				await expect(
					port.control(after, action, { deliveryId: dispatched.id, connectionId: after.session.connectionId }),
				).rejects.toBeInstanceOf(DiscordModeError);
			const remoteStatus = await port.control(after, "status");
			expect(remoteStatus.text).not.toContain(uncertain.text);
			expect(remoteStatus.text).not.toContain(lease(after).token);
			const resolved = await broker.request({
				op: "resolve-delivery",
				lease: lease(after),
				requestId: randomUUID(),
				deliveryId: dispatched.id,
			});
			expect(resolved.deliveries[0]?.state).toBe("resolved");
			expect(port.publications).toEqual([]);
			expect((await poll(broker, after)).deliveries).toEqual([]);
			await broker.request({
				op: "repair",
				lease: lease(after),
				requestId: randomUUID(),
				target: "session",
				resumeQueued: true,
			});
			expect((await poll(broker, after)).deliveries.map(item => item.text)).toEqual(["not dispatched yet"]);
			await port.owner(after, "may already have changed files", "message", "8001");
			expect(
				(await broker.request({ op: "status", lease: lease(after) })).deliveries.map(item => item.text),
			).toEqual(["not dispatched yet"]);
		} finally {
			await broker.close();
		}
	});

	it("observes rename/delete/orphans without recreating and explicitly repairs only known private resources", async () => {
		using temporary = TempDir.createSync("@discord-broker-repair-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			const a = await broker.request(registration(root, "first"));
			const b = await broker.request(registration(root, "second"));
			port.channel(a.session.channelId!).name = "manual-session-name";
			port.channel(a.group.categoryId!).name = "manual-project-name";
			const renamed = await broker.request({ op: "status", lease: lease(a) });
			expect(renamed.session.label).toBe("manual-session-name");
			expect(renamed.group.name).toBe("manual-project-name");
			await port.owner(a, "old queued work");
			port.channels.delete(a.session.channelId!);
			const created = port.creates;
			expect((await broker.request({ op: "status", lease: lease(a) })).session.state).toBe("missing");
			expect(port.creates).toBe(created);
			port.removeCategory(a.group.categoryId!);
			expect((await broker.request({ op: "status", lease: lease(b) })).group.state).toBe("missing");
			expect(port.channel(b.session.channelId!).parentId).toBeUndefined();
			const groupRepair = await broker.request({
				op: "repair",
				lease: lease(b),
				requestId: randomUUID(),
				target: "group",
				resumeQueued: false,
			});
			expect(groupRepair.group.categoryId).not.toBe(a.group.categoryId);
			expect(port.channel(b.session.channelId!).parentId).toBe(groupRepair.group.categoryId);
			expect(port.channels.has(a.session.channelId!)).toBe(false);
			const repaired = await broker.request({
				op: "repair",
				lease: lease(a),
				requestId: randomUUID(),
				target: "session",
				resumeQueued: false,
			});
			expect(repaired.session.channelId).not.toBe(a.session.channelId);
			expect((await poll(broker, a)).deliveries).toEqual([]);
			port.channel(repaired.session.channelId!).private = false;
			await expect(port.owner(repaired, "insecure destination")).rejects.toThrow("paused");
			expect((await broker.request({ op: "status", lease: lease(a) })).session.state).toBe("inaccessible");
			await expect(
				broker.request({
					op: "repair",
					lease: lease(a),
					requestId: randomUUID(),
					target: "session",
					destinationId: b.session.channelId!,
					resumeQueued: false,
				}),
			).rejects.toThrow("already bound");
			port.channel(repaired.session.channelId!).private = true;
			const elsewhere = await port.createCategory("different category");
			port.channel(repaired.session.channelId!).parentId = elsewhere.id;
			expect((await broker.request({ op: "status", lease: lease(a) })).session.state).toBe("moved");
			await expect(
				broker.request({
					op: "repair",
					lease: lease(a),
					requestId: randomUUID(),
					target: "session",
					destinationId: repaired.session.channelId,
					resumeQueued: false,
				}),
			).rejects.toThrow("moved");
		} finally {
			await broker.close();
		}
	});

	it("keeps queued owner work through repair until the owner explicitly resumes it", async () => {
		using temporary = TempDir.createSync("@discord-broker-held-repair-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			const session = await broker.request(registration(root, "frontend"));
			await port.owner(session, "Inspect the settings page");
			port.channels.delete(session.session.channelId!);
			await broker.request({ op: "status", lease: lease(session) });
			const repaired = await broker.request({
				op: "repair",
				lease: lease(session),
				requestId: randomUUID(),
				target: "session",
				resumeQueued: false,
			});
			expect((await poll(broker, session)).deliveries).toEqual([]);
			const held = await broker.request({ op: "status", lease: lease(session) });
			expect(held.deliveries.map(delivery => [delivery.state, delivery.text])).toEqual([
				["queued", "Inspect the settings page"],
			]);
			await broker.request({
				op: "repair",
				lease: lease(session),
				requestId: randomUUID(),
				target: "session",
				destinationId: repaired.session.channelId,
				resumeQueued: true,
			});
			expect((await poll(broker, session)).deliveries.map(delivery => delivery.text)).toEqual([
				"Inspect the settings page",
			]);
		} finally {
			await broker.close();
		}
	});

	it("binds answers to exact current generation and invalidates dialogs ended locally", async () => {
		using temporary = TempDir.createSync("@discord-broker-dialog-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			const input = registration(root, "dialog session");
			let current = await broker.request(input);
			const dialog: ModeDialog = {
				id: "reusable-native-id",
				kind: "select",
				title: "Choose exact option",
				options: ["one", "two"],
			};
			await broker.request({ op: "dialog", lease: lease(current), dialog });
			const oldWireId = port.dialogs.get(current.session.channelId!)!.id;
			await broker.request({ op: "off", lease: lease(current) });
			current = await broker.request(resumed(input));
			await broker.request({ op: "dialog", lease: lease(current), dialog });
			const wireId = port.dialogs.get(current.session.channelId!)!.id;
			expect(wireId).not.toBe(oldWireId);
			const answer = {
				channelId: current.session.channelId!,
				ownerId: config.ownerId,
				dialogId: wireId,
				value: "two",
				cancelled: false,
			};
			await expect(port.handlers!.answer({ ...answer, ownerId: "201" })).rejects.toThrow("configured owner");
			await expect(port.handlers!.answer({ ...answer, dialogId: oldWireId })).rejects.toThrow("stale");
			await expect(port.handlers!.answer({ ...answer, value: "not an option" })).rejects.toThrow("exact");
			await port.handlers!.answer(answer);
			await expect(port.handlers!.answer(answer)).rejects.toThrow("already answered");
			expect((await poll(broker, current)).answers).toEqual([{ id: dialog.id, value: "two", cancelled: false }]);
			expect((await poll(broker, current)).answers).toEqual([]);
			const local = { ...dialog, id: "local-wins" };
			await broker.request({ op: "dialog", lease: lease(current), dialog: local });
			const localWire = port.dialogs.get(current.session.channelId!)!.id;
			await broker.request({ op: "dialog-end", lease: lease(current), dialogId: local.id });
			await expect(port.handlers!.answer({ ...answer, dialogId: localWire })).rejects.toThrow("stale");
		} finally {
			await broker.close();
		}
	});

	it("publishes clean authorized results once and fences uncertain publication across restart", async () => {
		using temporary = TempDir.createSync("@discord-broker-receipt-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const storePath = path.join(root, "private", "state.json");
		let broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const input = registration(root, "author");
			const a = await broker.request(input);
			const b = await broker.request(registration(root, "other"));
			await port.owner(a, "write result");
			const delivery = (await poll(broker, a)).deliveries[0]!;
			await expect(
				broker.request({
					op: "receipt",
					lease: lease(b),
					deliveryId: delivery.id,
					state: "completed",
					text: "stolen result",
				}),
			).rejects.toThrow("exact delivery");
			const receipt: ModeRequest = {
				op: "receipt",
				lease: lease(a),
				deliveryId: delivery.id,
				state: "completed",
				text: "actual result",
			};
			await broker.request(receipt);
			await broker.request(receipt);
			expect(port.publications.length).toBe(1);
			expect(port.publications[0]?.text).toBe("actual result");
			expect(port.publications[0]?.channelId).toBe(a.session.channelId!);
			await expect(broker.request({ ...receipt, text: "changed result" })).rejects.toThrow("different input");
			await port.owner(a, "decline this request");
			const declined = (await poll(broker, a)).deliveries[0]!;
			const rejection: ModeRequest = {
				op: "receipt",
				lease: lease(a),
				deliveryId: declined.id,
				state: "rejected",
				text: "Cannot make that change.",
			};
			await broker.request(rejection);
			await broker.request(rejection);
			const completedReport: ModeRequest = {
				op: "report",
				lease: lease(a),
				requestId: "completed-report",
				text: "The requested review is complete.",
			};
			await broker.request(completedReport);
			await broker.request(completedReport);
			expect(port.publications.map(item => [item.kind, item.text])).toEqual([
				["reply", "actual result"],
				["reply", "Cannot make that change."],
				["publish", "The requested review is complete."],
			]);
			const report: ModeRequest = {
				op: "report",
				lease: lease(a),
				requestId: "uncertain-report",
				text: "may already be posted",
			};
			port.failNextPublish = true;
			await expect(broker.request(report)).rejects.toThrow("unknown");
			expect(port.publications.map(item => item.text)).toEqual([
				"actual result",
				"Cannot make that change.",
				"The requested review is complete.",
				"may already be posted",
			]);
			await broker.close();
			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			const resumedSession = await broker.request(resumed(input));
			await broker.request({
				op: "repair",
				lease: lease(resumedSession),
				requestId: randomUUID(),
				target: "session",
				destinationId: resumedSession.session.channelId,
				resumeQueued: false,
			});
			await expect(broker.request({ ...report, lease: lease(resumedSession) })).rejects.toThrow();
			expect(port.publications.length).toBe(4);
		} finally {
			await broker.close();
		}
	});

	it("accepts final replies beyond the report bound, routes them to one reply, and keeps reports bounded", async () => {
		using temporary = TempDir.createSync("@discord-broker-long-reply-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		const socketPath = path.join(root, "ipc.sock");
		const token = "offline-long-reply-fixture-token-123456";
		const server = await startDiscordModeServer({ broker, socketPath, token });
		const client = await connectDiscordModeAt(socketPath, token);
		try {
			const a = await client.request(registration(root, "long"));
			expect(a.maxReply).toBe(DISCORD_MODE_MAX_REPLY);
			const complete = async (text: string, via: { request(input: ModeRequest): Promise<ModeSnapshot> }) => {
				await port.owner(a, "write a long answer");
				const polled = await via.request({ op: "poll", lease: lease(a), busy: false, pendingInput: false });
				expect(polled.maxReply).toBe(DISCORD_MODE_MAX_REPLY);
				return via.request({
					op: "receipt",
					lease: lease(a),
					deliveryId: polled.deliveries[0]!.id,
					state: "completed",
					text,
				});
			};
			await complete("x".repeat(DISCORD_MODE_MAX_TEXT + 1), broker);
			// Worst-case JSON escaping doubles every byte; the whole receipt must still cross authenticated IPC.
			const longest = '"'.repeat(DISCORD_MODE_MAX_REPLY);
			await complete(longest, client);
			await expect(complete(`${longest}x`, broker)).rejects.toThrow("text/byte limits");
			await expect(
				broker.request({
					op: "report",
					lease: lease(a),
					requestId: "long-report",
					text: "x".repeat(DISCORD_MODE_MAX_TEXT + 1),
				}),
			).rejects.toThrow("text/byte limits");
			expect(port.publications.map(item => [item.kind, item.text.length])).toEqual([
				["reply", DISCORD_MODE_MAX_TEXT + 1],
				["reply", DISCORD_MODE_MAX_REPLY],
			]);
		} finally {
			await client.close();
			await server.close();
			await broker.close();
		}
	});

	it("never retries a lost resource-creation response during repeated registration or status", async () => {
		using temporary = TempDir.createSync("@discord-broker-create-unknown-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			port.failNextCreate = true;
			const input = registration(root, "uncertain");
			const first = await broker.request(input);
			expect(first.group.state).toBe("uncertain");
			await broker.request(input);
			await broker.request({ op: "status", lease: lease(first) });
			expect(port.creates).toBe(1);
			await expect(
				broker.request({
					op: "repair",
					lease: lease(first),
					requestId: randomUUID(),
					target: "group",
					resumeQueued: false,
				}),
			).rejects.toThrow("unknown");
			const createdCategory = [...port.channels.values()].find(channel => channel.kind === "category")!;
			const adopted = await broker.request({
				op: "repair",
				lease: lease(first),
				requestId: randomUUID(),
				target: "group",
				destinationId: createdCategory.id,
				resumeQueued: false,
			});
			expect(adopted.group.categoryId).toBe(createdCategory.id);
			expect([...port.channels.values()].filter(channel => channel.kind === "category").length).toBe(1);
			const ready = await broker.request({
				op: "repair",
				lease: lease(first),
				requestId: randomUUID(),
				target: "session",
				resumeQueued: false,
			});
			expect(ready.session.state).toBe("ready");
		} finally {
			await broker.close();
		}
	});

	it("rejects malformed/oversize input and capacity overflow without dropping accepted work", async () => {
		using temporary = TempDir.createSync("@discord-broker-bounds-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			const request = registration(root, "bounded");
			await expect(broker.request({ ...request, sessionId: "not-a-uuid" })).rejects.toThrow("Invalid");
			await expect(broker.request({ ...request, projectDir: "relative" })).rejects.toThrow("Invalid");
			const session = await broker.request(request);
			await expect(
				broker.request({ op: "report", lease: lease(session), requestId: randomUUID(), text: "x".repeat(12001) }),
			).rejects.toThrow("Invalid");
			const unknownOperation = { op: "unrecognized-operation", lease: lease(session) } as unknown as ModeRequest;
			await expect(broker.request(unknownOperation)).rejects.toThrow("Invalid");
			const coercedReceipt = {
				op: "receipt",
				lease: lease(session),
				deliveryId: randomUUID(),
				state: ["completed"],
			} as unknown as ModeRequest;
			await expect(broker.request(coercedReceipt)).rejects.toThrow("Invalid");
			const unknownDialogField = {
				op: "dialog",
				lease: lease(session),
				dialog: { id: "bad", kind: "input", title: "Prompt", untrustedExtra: "must not persist" },
			} as unknown as ModeRequest;
			await expect(broker.request(unknownDialogField)).rejects.toThrow("Invalid");
			await port.handlers!.ownerMessage({
				id: "9001",
				ownerId: config.ownerId,
				channelId: session.session.channelId!,
				text: "",
				kind: "message",
				rejected: "Attachments are not forwarded",
			});
			for (let index = 0; index < 32; index++) await port.owner(session, `queued ${index}`);
			await expect(port.owner(session, "overflow")).rejects.toThrow("queue is full");
			const pending = await broker.request({ op: "status", lease: lease(session) });
			expect(pending.deliveries.map(item => item.text)).toEqual(
				Array.from({ length: 32 }, (_item, index) => `queued ${index}`),
			);
			expect((await poll(broker, session)).deliveries[0]?.text).toBe("queued 0");
		} finally {
			await broker.close();
		}
	});

	it("continues local peer delivery while Discord channels and gateway are unavailable", async () => {
		using temporary = TempDir.createSync("@discord-broker-local-peers-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			const a = await broker.request(registration(root, "sender"));
			const b = await broker.request(registration(root, "recipient"));
			await broker.request({
				op: "send",
				lease: lease(a),
				requestId: randomUUID(),
				recipientId: b.session.id,
				text: "local queued before remote deletion",
			});
			port.channels.delete(b.session.channelId!);
			port.removeCategory(a.group.categoryId!);
			await broker.request({ op: "status", lease: lease(b) });
			port.handlers!.connection(false);
			await broker.request({ op: "status", lease: lease(b) });
			const delivered = (await poll(broker, b)).deliveries[0]!;
			expect(delivered.text).toBe("local queued before remote deletion");
			expect(delivered.source).toBe("peer");
			await broker.request({ op: "receipt", lease: lease(b), deliveryId: delivered.id, state: "completed" });
			await broker.request({
				op: "send",
				lease: lease(a),
				requestId: randomUUID(),
				recipientId: b.session.id,
				text: "local queued while gateway offline",
			});
			expect((await poll(broker, b)).deliveries[0]?.text).toBe("local queued while gateway offline");
			expect(port.publications).toEqual([]);
		} finally {
			await broker.close();
		}
	});

	it("cancels queued owner messages durably, frees capacity, and deduplicates gateway events and controls", async () => {
		using temporary = TempDir.createSync("@discord-broker-cancel-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			const session = await broker.request(registration(root, "queue"));
			const first = await port.owner(session, "cancel before execution", "message", "8100");
			expect(await port.owner(session, "cancel before execution", "message", "8100")).toEqual(first);
			for (let index = 1; index < 32; index++) await port.owner(session, `work ${index}`);
			await expect(port.owner(session, "overflow")).rejects.toBeInstanceOf(DiscordModeError);
			const cancel = { id: "cancel-first", connectionId: first.connectionId, deliveryId: first.deliveryId };
			await port.control(session, "cancel", cancel);
			await port.control(session, "cancel", cancel);
			const replay = await port.owner(session, "cancel before execution", "message", "8100");
			expect(replay.deliveryId).toBeUndefined();
			expect(replay.connectionId).toBeUndefined();
			await expect(port.control(session, "steer", cancel)).rejects.toBeInstanceOf(DiscordModeError);
			await port.owner(session, "replacement");
			expect((await port.control(session, "queue")).queued?.map(item => item.text)).toEqual([
				...Array.from({ length: 31 }, (_item, index) => `work ${index + 1}`),
				"replacement",
			]);
			const dispatched = (await poll(broker, session)).deliveries[0]!;
			expect(dispatched.text).toBe("work 1");
			for (const state of ["dispatched", "accepted"] as const) {
				if (state === "accepted")
					await broker.request({ op: "receipt", lease: lease(session), deliveryId: dispatched.id, state });
				for (const action of ["cancel", "steer"] as const)
					await expect(
						port.control(session, action, {
							deliveryId: dispatched.id,
							connectionId: session.session.connectionId,
						}),
					).rejects.toBeInstanceOf(DiscordModeError);
			}
			expect((await poll(broker, session)).deliveries).toEqual([]);
			await broker.request({ op: "receipt", lease: lease(session), deliveryId: dispatched.id, state: "completed" });
			expect((await poll(broker, session)).deliveries.map(item => item.text)).toEqual(["work 2"]);
			await expect(port.control(session, "queue", { deliveryId: first.deliveryId })).rejects.toBeInstanceOf(
				DiscordModeError,
			);
		} finally {
			await broker.close();
		}
	});

	it("promotes one queued message to guidance and dispatches it only once while busy", async () => {
		using temporary = TempDir.createSync("@discord-broker-guidance-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			const session = await broker.request(registration(root, "working"));
			await poll(broker, session, true);
			const queued = await port.owner(session, "use the existing helper", "message", "8200");
			if (!queued.deliveryId) throw new Error("Expected an actionable owner message.");
			const fields = { id: "promote-once", deliveryId: queued.deliveryId, connectionId: queued.connectionId };
			expect((await poll(broker, session, true)).deliveries).toEqual([]);
			await port.control(session, "steer", fields);
			await port.control(session, "steer", fields);
			const repeatedOwner = await port.owner(session, "use the existing helper", "message", "8200");
			expect(repeatedOwner.deliveryId).toBeUndefined();
			expect((await port.control(session, "queue")).queued).toEqual([]);
			await expect(port.control(session, "queue", { deliveryId: queued.deliveryId })).rejects.toBeInstanceOf(
				DiscordModeError,
			);
			const deliveries = (await poll(broker, session, true)).deliveries;
			expect(deliveries.map(item => [item.id, item.kind, item.text])).toEqual([
				[queued.deliveryId, "steer", "use the existing helper"],
			]);
			expect(deliveries[0]).not.toHaveProperty("sourceMessageId");
			await port.control(session, "steer", fields);
			expect((await poll(broker, session, true)).deliveries).toEqual([]);
			for (const action of ["cancel", "steer"] as const)
				await expect(
					port.control(session, action, { deliveryId: queued.deliveryId, connectionId: queued.connectionId }),
				).rejects.toBeInstanceOf(DiscordModeError);
			await broker.request({
				op: "receipt",
				lease: lease(session),
				deliveryId: queued.deliveryId!,
				state: "accepted",
			});
			for (const action of ["cancel", "steer"] as const)
				await expect(
					port.control(session, action, { deliveryId: queued.deliveryId, connectionId: queued.connectionId }),
				).rejects.toBeInstanceOf(DiscordModeError);
			await broker.request({
				op: "receipt",
				lease: lease(session),
				deliveryId: queued.deliveryId!,
				state: "completed",
			});
			await port.control(session, "steer", fields);
			expect((await poll(broker, session)).deliveries).toEqual([]);
		} finally {
			await broker.close();
		}
	});

	it("stops the turn through the existing abort dispatch without replaying duplicate interactions", async () => {
		using temporary = TempDir.createSync("@discord-broker-stop-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			const session = await broker.request(registration(root, "stop"));
			await poll(broker, session, true);
			await port.owner(session, "later ordinary work");
			const stop = { id: "stop-once", connectionId: session.session.connectionId };
			await port.control(session, "stop", stop);
			await port.control(session, "stop", stop);
			await port.owner(session, "!abort", "abort");
			const deliveries = (await poll(broker, session, true)).deliveries;
			expect(deliveries.map(item => item.kind)).toEqual(["abort", "abort"]);
			for (const delivery of deliveries)
				await broker.request({ op: "receipt", lease: lease(session), deliveryId: delivery.id, state: "completed" });
			await port.control(session, "stop", stop);
			expect((await poll(broker, session, true)).deliveries).toEqual([]);
			expect((await poll(broker, session)).deliveries.map(item => item.text)).toEqual(["later ordinary work"]);
		} finally {
			await broker.close();
		}
	});

	it("keeps queue controls private and bound to channel IDs even when channel names match", async () => {
		using temporary = TempDir.createSync("@discord-broker-control-privacy-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			const a = await broker.request(registration(root, "same"));
			const b = await broker.request(registration(root, "same"));
			port.channel(b.session.channelId!).name = port.channel(a.session.channelId!).name;
			await broker.request({
				op: "send",
				lease: lease(b),
				requestId: randomUUID(),
				recipientId: a.session.id,
				text: "private peer context",
			});
			const owner = await port.owner(a, "visible owner queue");
			if (!owner.deliveryId) throw new Error("Expected an actionable owner message.");
			await port.owner(b, "unrelated owner text");
			const queue = await port.control(a, "queue");
			expect(queue.queued?.map(item => [item.id, item.text, item.held, item.actionable])).toEqual([
				[owner.deliveryId, "visible owner queue", false, true],
			]);
			const status = await port.control(a, "status");
			for (const result of [queue, status]) {
				expect(JSON.stringify(result)).not.toContain("private peer context");
				expect(JSON.stringify(result)).not.toContain("unrelated owner text");
				expect(JSON.stringify(result)).not.toContain(lease(a).token);
			}
			const peer = (await broker.request({ op: "status", lease: lease(a) })).deliveries.find(
				item => item.source === "peer",
			)!;
			for (const deliveryId of [peer.id, randomUUID()]) {
				await expect(port.control(a, "queue", { deliveryId })).rejects.toBeInstanceOf(DiscordModeError);
				for (const action of ["cancel", "steer"] as const)
					await expect(
						port.control(a, action, { deliveryId, connectionId: a.session.connectionId }),
					).rejects.toBeInstanceOf(DiscordModeError);
			}
			for (const action of ["status", "queue", "stop", "cancel", "steer"] as const) {
				const fields = action === "cancel" || action === "steer" ? { deliveryId: owner.deliveryId } : {};
				await expect(
					port.control(a, action, { ...fields, connectionId: a.session.connectionId, ownerId: "201" }),
				).rejects.toBeInstanceOf(DiscordModeError);
				await expect(
					port.control(b, action, { ...fields, connectionId: a.session.connectionId }),
				).rejects.toBeInstanceOf(DiscordModeError);
			}
			expect(
				await port.handlers!.ownerMessage({
					id: "8300",
					channelId: a.session.channelId!,
					ownerId: "201",
					text: "outsider",
					kind: "message",
				}),
			).toEqual({ text: "" });
			expect(
				await port.handlers!.ownerMessage({
					id: "8301",
					channelId: "999999",
					ownerId: config.ownerId,
					text: "unbound",
					kind: "message",
				}),
			).toEqual({ text: "" });
			await expect(port.control(a, "status", { connectionId: "invalid" })).rejects.toBeInstanceOf(DiscordModeError);
			await expect(port.control(a, "cancel", { deliveryId: owner.deliveryId })).rejects.toBeInstanceOf(
				DiscordModeError,
			);
			expect(
				(await port.control(a, "queue", { deliveryId: owner.deliveryId })).queued?.map(item => item.text),
			).toEqual(["visible owner queue"]);
		} finally {
			await broker.close();
		}
	});

	it("holds owner queue after permission loss and never silently resumes it through controls", async () => {
		using temporary = TempDir.createSync("@discord-broker-control-held-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			const session = await broker.request(registration(root, "held"));
			const queued = await port.owner(session, "requires explicit resumption");
			if (!queued.deliveryId) throw new Error("Expected an actionable owner message.");
			port.channel(session.session.channelId!).private = false;
			await expect(port.control(session, "queue")).rejects.toBeInstanceOf(DiscordModeError);
			await expect(port.control(session, "status")).rejects.toBeInstanceOf(DiscordModeError);
			port.channel(session.session.channelId!).private = true;
			const fields = { deliveryId: queued.deliveryId, connectionId: queued.connectionId };
			expect(
				(await port.control(session, "queue", fields)).queued?.map(item => [item.held, item.actionable]),
			).toEqual([[true, false]]);
			for (const action of ["cancel", "steer"] as const)
				await expect(port.control(session, action, fields)).rejects.toBeInstanceOf(DiscordModeError);
			await port.control(session, "status");
			expect((await poll(broker, session)).deliveries).toEqual([]);
			await broker.request({
				op: "repair",
				lease: lease(session),
				requestId: randomUUID(),
				target: "session",
				resumeQueued: true,
			});
			expect((await poll(broker, session)).deliveries.map(item => [item.id, item.text])).toEqual([
				[queued.deliveryId, "requires explicit resumption"],
			]);
		} finally {
			await broker.close();
		}
	});

	it("reports live working and input-waiting states without exposing queued conversation in status cards", async () => {
		using temporary = TempDir.createSync("@discord-broker-control-status-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			const session = await broker.request(registration(root, "status"));
			const idle = await port.control(session, "status");
			expect(idle.text).toMatch(/\bIdle\b/);
			await poll(broker, session, true);
			const queued = await port.owner(session, "owner conversation stays out of status");
			const working = await port.control(session, "status");
			expect(working.text).toMatch(/\bWorking\b/);
			expect(working.text).toMatch(/Queued 1\b/);
			expect(working.text).not.toContain("owner conversation stays out of status");
			await broker.request({ op: "poll", lease: lease(session), busy: true, pendingInput: true });
			const waiting = await port.control(session, "status");
			expect(waiting.text).toMatch(/\bWaiting for input\b/);
			const overview = port.cards.get(session.group.overviewId!)!;
			expect(overview.text).toContain(`<#${session.session.channelId}>`);
			expect(overview.text).toMatch(/\bWaiting for input\b/);
			expect(overview.text).not.toContain("owner conversation stays out of status");
			const detail = await port.control(session, "queue", { deliveryId: queued.deliveryId });
			expect(detail.text).toContain("owner conversation stays out of status");
			expect((await poll(broker, session)).deliveries.map(item => item.id)).toEqual([queued.deliveryId!]);
			const active = await port.control(session, "status");
			expect(active.text).toMatch(/Queued 0\b/);
			expect(active.text).toMatch(/active 1\b/);
			await broker.request({ op: "off", lease: lease(session) });
			const off = await port.control(session, "status");
			expect(off.text).toMatch(/\bOff\b/);
			expect(off.text).toMatch(/uncertain 1\b/);
			expect(off.connectionId).toBeUndefined();
		} finally {
			await broker.close();
		}
	});

	it("adopts legacy status cards even when their visible text has not changed", async () => {
		using temporary = TempDir.createSync("@discord-broker-card-migration-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const port = new FixtureDiscord();
		let broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const input = registration(root, "migration");
			await broker.request(input);
			await broker.close();
			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			await broker.close();
			const cards = [...port.cards.entries()];
			const statusCreates = port.statusCreates;
			const saved = JSON.parse(await fs.readFile(storePath, "utf8")) as {
				cards: Array<{ channelId: string; messageId?: string }>;
			};
			for (const card of saved.cards) {
				delete card.messageId;
				port.legacyCards.add(card.channelId);
			}
			await fs.writeFile(storePath, JSON.stringify(saved));
			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			expect(port.legacyCards.size).toBe(0);
			// Only the overview's service line differs: stopped before, online again now.
			const serviceless = (entries: typeof cards) =>
				entries.map(([id, card]) => [id, { ...card, text: card.text.replace(/Discord service: .*/, "") }]);
			expect(serviceless([...port.cards.entries()])).toEqual(serviceless(cards));
			expect(cards.some(([, card]) => card.text.includes("Discord service: Offline since <t:"))).toBe(true);
			expect([...port.cards.values()].every(card => !card.text.includes("Offline since"))).toBe(true);
			expect(port.statusCreates).toBe(statusCreates);
			await broker.close();
			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			await broker.request(resumed(input));
			expect(port.statusCreates).toBe(statusCreates);
			expect([...port.cards.values()].map(card => card.id)).toEqual(cards.map(([, card]) => card.id));
		} finally {
			await broker.close();
		}
	});

	it.each(["lost", "invalid"] as const)(
		"never recreates a status card after %s confirmation, including after restart",
		async confirmation => {
			using temporary = TempDir.createSync("@discord-broker-card-unknown-");
			const root = temporary.path();
			const storePath = path.join(root, "private", "state.json");
			const port = new FixtureDiscord();
			let broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			try {
				port.nextStatusConfirmation = confirmation;
				const input = registration(root, "uncertain-card");
				const session = await broker.request(input);
				const overview = port.cards.get(session.group.overviewId!)!;
				const statusCreates = port.statusCreates;
				await poll(broker, session, true);
				expect(port.cards.get(session.group.overviewId!)).toEqual(overview);
				expect(port.statusCreates).toBe(statusCreates);
				await broker.close();
				broker = new DiscordModeBroker({ config, storePath, port });
				await broker.start();
				await broker.request(resumed(input));
				expect(port.cards.get(session.group.overviewId!)).toEqual(overview);
				expect(port.statusCreates).toBe(statusCreates);
			} finally {
				await broker.close();
			}
		},
	);

	it("retains cancellation and identity fences across restart and replaces revoked session-card controls", async () => {
		using temporary = TempDir.createSync("@discord-broker-control-restart-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const port = new FixtureDiscord();
		let broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const input = registration(root, "identity");
			const before = await broker.request(input);
			const cancelled = await port.owner(before, "never execute", "message", "8400");
			const held = await port.owner(before, "retained owner intent", "message", "8401");
			if (!held.deliveryId) throw new Error("Expected an actionable owner message.");
			const cancellation = {
				id: "durable-cancellation",
				deliveryId: cancelled.deliveryId,
				connectionId: cancelled.connectionId,
			};
			await port.control(before, "cancel", cancellation);
			expect(port.cards.get(before.session.channelId!)?.connectionId).toBe(before.session.connectionId);
			expect(port.cards.get(before.group.overviewId!)?.connectionId).toBeUndefined();
			const statusCreates = port.statusCreates;
			const cardIds = [...port.cards.values()].map(card => card.id);
			await broker.close();
			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			expect(port.cards.get(before.session.channelId!)?.connectionId).toBeUndefined();
			const disconnected = await port.control(before, "status");
			expect(disconnected.connectionId).toBeUndefined();
			expect(disconnected.text).toContain("Closed · resume at your desk");
			await expect(port.control(before, "stop")).rejects.toBeInstanceOf(DiscordModeError);
			const after = await broker.request(resumed(input));
			expect(after.session.channelId).toBe(before.session.channelId);
			expect(port.cards.get(after.session.channelId!)?.connectionId).toBe(after.session.connectionId);
			expect(port.statusCreates).toBe(statusCreates);
			expect([...port.cards.values()].map(card => card.id)).toEqual(cardIds);
			for (const action of ["status", "queue", "stop", "cancel", "steer"] as const) {
				const fields = action === "cancel" || action === "steer" ? { deliveryId: held.deliveryId } : {};
				await expect(
					port.control(after, action, { ...fields, connectionId: before.session.connectionId }),
				).rejects.toBeInstanceOf(DiscordModeError);
			}
			await expect(port.control(after, "cancel", cancellation)).rejects.toBeInstanceOf(DiscordModeError);
			const retained = await port.control(after, "queue");
			expect(retained.queued?.map(item => [item.id, item.text, item.held, item.actionable])).toEqual([
				[held.deliveryId, "retained owner intent", true, false],
			]);
			expect((await port.owner(after, "never execute", "message", "8400")).deliveryId).toBeUndefined();
			expect((await port.owner(after, "retained owner intent", "message", "8401")).deliveryId).toBeUndefined();
			expect((await poll(broker, after)).deliveries).toEqual([]);
			await broker.request({
				op: "repair",
				lease: lease(after),
				requestId: randomUUID(),
				target: "session",
				resumeQueued: true,
			});
			const resumedOwner = await port.owner(after, "retained owner intent", "message", "8401");
			expect([resumedOwner.deliveryId, resumedOwner.connectionId]).toEqual([
				held.deliveryId,
				after.session.connectionId,
			]);
			await port.control(after, "cancel", {
				deliveryId: resumedOwner.deliveryId,
				connectionId: resumedOwner.connectionId,
			});
			expect((await poll(broker, after)).deliveries).toEqual([]);
			await broker.request({ op: "off", lease: lease(after) });
			expect((await port.control(after, "status")).connectionId).toBeUndefined();
			expect(port.cards.get(after.session.channelId!)?.connectionId).toBeUndefined();
		} finally {
			await broker.close();
		}
	});

	it("rejects a fiftieth session binding before Discord creation or an uncertain intent", async () => {
		using temporary = TempDir.createSync("@discord-broker-category-capacity-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			for (let index = 0; index < 49; index++) await broker.request(registration(root, `session-${index}`));
			const before = port.creates;
			const overflow = registration(root, "no-room");
			await expect(broker.request(overflow)).rejects.toThrow("50-channel category limit");
			await expect(broker.request(overflow)).rejects.toThrow("50-channel category limit");
			expect(port.creates).toBe(before);
			expect([...port.channels.values()].filter(channel => channel.kind === "text").length).toBe(50);
		} finally {
			await broker.close();
		}
	}, 20_000);
});

describe("remembered sharing", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function identity(input: Extract<ModeRequest, { op: "register" }>) {
		return { sessionId: input.sessionId, sessionFile: input.sessionFile, projectDir: input.projectDir };
	}

	it("closing keeps sharing, holds queued work, and a rejoin reuses the channel without creating anything", async () => {
		using temporary = TempDir.createSync("@discord-rejoin-detach-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const port = new FixtureDiscord();
		let broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const input = registration(root, "remembered");
			const first = await broker.request(input);
			await port.owner(first, "arrived before closing", "message", "8600");
			const closed = await broker.request({ op: "detach", lease: lease(first) });
			expect(closed.session).toMatchObject({ enabled: true, connected: false });
			await expect(poll(broker, first)).rejects.toThrow("reconnect explicitly");
			// Shared-but-closed survives a broker restart without migration.
			await broker.close();
			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			expect((await broker.lookup(input.projectDir, input.sessionId))?.session).toMatchObject({
				enabled: true,
				connected: false,
			});
			const creates = port.creates;
			const rejoined = await broker.request({ ...resumed(input), label: first.session.label, rejoin: true });
			expect(rejoined.session.channelId).toBe(first.session.channelId);
			expect(rejoined.session).toMatchObject({ enabled: true, connected: true });
			expect(port.creates).toBe(creates);
			// Work that arrived for the closed conversation stays held; rejoining never dispatches it.
			expect((await poll(broker, rejoined)).deliveries).toEqual([]);
			const status = await broker.request({ op: "status", lease: lease(rejoined) });
			expect(status.deliveries.map(item => [item.text, item.state])).toEqual([["arrived before closing", "queued"]]);
		} finally {
			await broker.close();
		}
	});

	it("explicit off is sticky across restart, and so is a lease-free off while the conversation is closed", async () => {
		using temporary = TempDir.createSync("@discord-rejoin-off-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const port = new FixtureDiscord();
		let broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const input = registration(root, "private-later");
			const first = await broker.request(input);
			await broker.request({ op: "off", lease: lease(first) });
			await broker.close();
			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			await expect(broker.request({ ...resumed(input), rejoin: true })).rejects.toThrow("automatic rejoin skipped");
			// Only an explicit enable shares it again.
			const again = await broker.request(resumed(input));
			expect(again.session.channelId).toBe(first.session.channelId);
			await broker.request({ op: "detach", lease: lease(again) });
			const disabled = await broker.request({ op: "disable", ...identity(input) });
			expect(disabled.session).toMatchObject({ enabled: false, connected: false });
			expect(disabled.lease).toBeUndefined();
			await expect(broker.request({ ...resumed(input), rejoin: true })).rejects.toThrow("automatic rejoin skipped");
			expect((await broker.lookup(input.projectDir, input.sessionId))?.session?.enabled).toBe(false);
		} finally {
			await broker.close();
		}
	});

	it("a lease-free off never takes over a live connection or a rebound file", async () => {
		using temporary = TempDir.createSync("@discord-rejoin-disable-live-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const input = registration(root, "open-elsewhere");
			const live = await broker.request(input);
			await expect(broker.request({ op: "disable", ...identity(input) })).rejects.toThrow("live Discord connection");
			await expect(
				broker.request({ op: "disable", ...identity(input), sessionFile: path.join(root, "other.jsonl") }),
			).rejects.toThrow("different project directory or session file");
			await expect(
				broker.request({ op: "disable", ...identity(registration(root, "never-shared")) }),
			).rejects.toThrow("not shared");
			expect((await poll(broker, live)).session).toMatchObject({ enabled: true, connected: true });
		} finally {
			await broker.close();
		}
	});

	it("unknown and deleted conversations never rejoin, and a rejoin never enrolls", async () => {
		using temporary = TempDir.createSync("@discord-rejoin-unknown-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			await expect(broker.request({ ...registration(root, "never-shared"), rejoin: true })).rejects.toThrow(
				"automatic rejoin skipped",
			);
			expect(port.creates).toBe(0);
			const input = registration(root, "deleted-later");
			await fs.writeFile(input.sessionFile, `${JSON.stringify({ type: "session", id: input.sessionId })}\n`);
			const first = await broker.request(input);
			await broker.request({ op: "detach", lease: lease(first) });
			await deleted(storePath, first);
			await expect(broker.request({ ...resumed(input), rejoin: true })).rejects.toThrow("permanently deleted");
			expect((await broker.lookup(input.projectDir, input.sessionId))?.session).toMatchObject({
				enabled: false,
				retirement: expect.anything(),
			});
		} finally {
			await broker.close();
		}
	});

	it("lookup reports a crashed process's expired lease as closed, so its conversation can rejoin", async () => {
		using temporary = TempDir.createSync("@discord-rejoin-expire-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const input = registration(root, "crashed");
			await broker.request(input);
			expect((await broker.lookup(input.projectDir, input.sessionId))?.session?.connected).toBe(true);
			const now = Date.now();
			vi.spyOn(Date, "now").mockReturnValue(now + 46_000);
			expect((await broker.lookup(input.projectDir, input.sessionId))?.session).toMatchObject({
				enabled: true,
				connected: false,
			});
			const rejoined = await broker.request({ ...resumed(input), rejoin: true });
			expect(rejoined.session.connected).toBe(true);
		} finally {
			await broker.close();
		}
	});
});

describe("owner mention policy", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Mocks the clock forward by at least `ms`, polling so the lease stays live across the gap. */
	async function elapse(broker: DiscordModeBroker, session: ModeSnapshot, ms: number): Promise<void> {
		let now = Date.now();
		const until = now + ms;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		while (now < until) {
			now = Math.min(now + 30_000, until);
			await poll(broker, session, true);
		}
	}

	async function ownerTurn(
		broker: DiscordModeBroker,
		port: FixtureDiscord,
		session: ModeSnapshot,
		reply: string,
		duration = 0,
	): Promise<void> {
		await port.owner(session, `please: ${reply}`);
		const delivery = (await poll(broker, session)).deliveries[0]!;
		if (duration) await elapse(broker, session, duration);
		await broker.request({
			op: "receipt",
			lease: lease(session),
			deliveryId: delivery.id,
			state: "completed",
			text: reply,
		});
	}

	function showDialog(broker: DiscordModeBroker, session: ModeSnapshot, id: string): Promise<ModeSnapshot> {
		return broker.request({ op: "dialog", lease: lease(session), dialog: { id, kind: "confirm", title: id } });
	}

	it("pings once per needs-you exchange; concurrent and re-rendered dialogs stay silent", async () => {
		using temporary = TempDir.createSync("@discord-mention-dialogs-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			const session = await broker.request(registration(root, "dialogs"));
			await showDialog(broker, session, "first");
			await showDialog(broker, session, "concurrent");
			await broker.request({ op: "dialog-end", lease: lease(session), dialogId: "first" });
			await broker.request({ op: "dialog-end", lease: lease(session), dialogId: "concurrent" });
			// A structured ask re-renders its next select right after the previous one ends.
			await showDialog(broker, session, "rerender");
			await broker.request({ op: "dialog-end", lease: lease(session), dialogId: "rerender" });
			await elapse(broker, session, 30_000);
			await showDialog(broker, session, "later");
			expect(port.shownDialogs).toEqual([
				{ title: "first", mention: true },
				{ title: "concurrent", mention: false },
				{ title: "rerender", mention: false },
				{ title: "later", mention: true },
			]);
		} finally {
			await broker.close();
		}
	});

	it("pings needs-you final replies only after a long owner turn and never for reports", async () => {
		using temporary = TempDir.createSync("@discord-mention-replies-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			const session = await broker.request(registration(root, "replies"));
			await ownerTurn(broker, port, session, "quick answer");
			await ownerTurn(broker, port, session, "almost long answer", DISCORD_MODE_LONG_TURN_MS - 1_000);
			await ownerTurn(broker, port, session, "long answer", DISCORD_MODE_LONG_TURN_MS);
			await broker.request({ op: "report", lease: lease(session), requestId: "report", text: "progress report" });
			expect(port.publications.map(item => [item.kind, item.text, item.mention])).toEqual([
				["reply", "quick answer", false],
				["reply", "almost long answer", false],
				["reply", "long answer", true],
				["publish", "progress report", false],
			]);
		} finally {
			await broker.close();
		}
	});

	it("pings every final reply in all mode and nothing in off mode", async () => {
		using temporary = TempDir.createSync("@discord-mention-modes-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			const session = await broker.request(registration(root, "modes"));
			expect((await port.control(session, "notify", { notify: "all" })).text).toStartWith("Notifications: all.");
			await ownerTurn(broker, port, session, "quick answer in all");
			await port.control(session, "notify", { notify: "off" });
			await showDialog(broker, session, "silent-approval");
			await ownerTurn(broker, port, session, "long answer in off", DISCORD_MODE_LONG_TURN_MS);
			expect(port.publications.map(item => [item.text, item.mention])).toEqual([
				["quick answer in all", true],
				["long answer in off", false],
			]);
			expect(port.shownDialogs).toEqual([{ title: "silent-approval", mention: false }]);
		} finally {
			await broker.close();
		}
	});

	it("sets /session notify while disconnected and keeps it across restart and re-register", async () => {
		using temporary = TempDir.createSync("@discord-mention-persist-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const storePath = path.join(root, "private", "state.json");
		let broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const input = registration(root, "persisted");
			const session = await broker.request(input);
			expect(session.session.notify).toBeUndefined();
			expect((await port.control(session, "status")).text).toContain("Notifications: needs-you");
			await expect(port.control(session, "notify")).rejects.toThrow("Invalid session control");
			await expect(port.control(session, "status", { notify: "off" })).rejects.toThrow("Invalid session control");
			await broker.close();
			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			// Restart revoked the lease; the preference is still owner-controllable.
			await port.control(session, "notify", { notify: "off" });
			expect((await port.control(session, "status")).text).toContain("Notifications: off");
			await broker.close();
			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			const reconnected = await broker.request(resumed(input));
			expect(reconnected.session.notify).toBe("off");
			await showDialog(broker, reconnected, "after-reconnect");
			expect(port.shownDialogs).toEqual([{ title: "after-reconnect", mention: false }]);
		} finally {
			await broker.close();
		}
	});
});

describe("Haiso and OMP app split", () => {
	it("persists the OMP app, marks channels per app, and reads app-less records as Haiso", async () => {
		using temporary = TempDir.createSync("@discord-app-register-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const port = new FixtureDiscord();
		let broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const haiso = await broker.request(registration(root, "Backend Work"));
			const ompInput = { ...registration(root, "🔵 API dev"), app: "omp" as const };
			const omp = await broker.request(ompInput);
			const ompChannel = omp.session.channelId!;
			expect(port.channel(haiso.session.channelId!).name).toBe("🟣-backend-work");
			expect(port.channel(ompChannel).name).toBe("🔵-api-dev");
			expect(haiso.session.label).toBe("backend-work");
			expect(haiso.session.app).toBeUndefined();
			expect(omp.session).toMatchObject({ label: "api-dev", app: "omp" });
			expect(omp.peers.map(peer => [peer.id, peer.app])).toEqual([[haiso.session.id, undefined]]);
			expect(port.cards.get(ompChannel)).toMatchObject({ app: "omp" });
			expect(port.cards.get(ompChannel)?.text).toStartWith("OMP · api-dev\n");
			expect(port.cards.get(haiso.session.channelId!)?.text).toStartWith("Haiso · backend-work\n");
			await broker.close();
			// A record written before the app split (or by an older bridge) has no app field.
			const saved = JSON.parse(await fs.readFile(storePath, "utf8")) as {
				sessions: Array<{ id: string; app?: string }>;
			};
			expect(saved.sessions.map(session => [session.id, session.app])).toEqual([
				[haiso.session.id, undefined],
				[omp.session.id, "omp"],
			]);
			for (const session of saved.sessions) delete session.app;
			await fs.writeFile(storePath, JSON.stringify(saved));
			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			expect(port.channel(ompChannel).name).toBe("🟣-api-dev");
			expect(port.cards.get(ompChannel)).toMatchObject({ app: "haiso" });
			expect(port.cards.get(ompChannel)?.text).toStartWith("Haiso · api-dev\n");
			const reattached = await broker.request(resumed(ompInput));
			expect(reattached.session).toMatchObject({ label: "api-dev", app: "omp", channelId: ompChannel });
			expect(port.channel(ompChannel).name).toBe("🔵-api-dev");
			expect(port.cards.get(ompChannel)?.text).toStartWith("OMP · api-dev\n");
		} finally {
			await broker.close();
		}
	});

	it("adopts manual renames without markers and restores the marker once per change", async () => {
		using temporary = TempDir.createSync("@discord-app-rename-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			const session = await broker.request(registration(root, "first"));
			const channelId = session.session.channelId!;
			const before = port.renames.length;
			port.channel(channelId).name = "🔵-other";
			await port.handlers!.changed();
			expect((await broker.request({ op: "status", lease: lease(session) })).session.label).toBe("other");
			expect(port.channel(channelId).name).toBe("🟣-other");
			await port.handlers!.changed();
			expect(port.renames.slice(before)).toEqual([{ id: channelId, name: "🟣-other" }]);
			port.channel(channelId).name = "other";
			await port.handlers!.changed();
			await port.handlers!.changed();
			expect(port.renames.slice(before)).toEqual([
				{ id: channelId, name: "🟣-other" },
				{ id: channelId, name: "🟣-other" },
			]);
			await broker.request({
				op: "rename",
				lease: lease(session),
				requestId: randomUUID(),
				target: "session",
				name: "🔵 Renamed",
			});
			expect(port.channel(channelId).name).toBe("🟣-renamed");
			expect((await broker.request({ op: "status", lease: lease(session) })).session.label).toBe("renamed");
		} finally {
			await broker.close();
		}
	});

	it("relabels pre-marker channels in place once on start and contains relabel failures", async () => {
		using temporary = TempDir.createSync("@discord-app-relabel-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const port = new FixtureDiscord();
		let broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const input = registration(root, "legacy");
			const session = await broker.request(input);
			const channelId = session.session.channelId!;
			await broker.close();
			port.channel(channelId).name = "legacy";
			const creates = port.creates;
			const statusCreates = port.statusCreates;
			const before = port.renames.length;
			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			expect(port.channel(channelId).name).toBe("🟣-legacy");
			await port.handlers!.changed();
			expect(port.renames.slice(before)).toEqual([{ id: channelId, name: "🟣-legacy" }]);
			expect(port.creates).toBe(creates);
			expect(port.statusCreates).toBe(statusCreates);
			await broker.close();
			port.channel(channelId).name = "legacy";
			port.failNextRename = true;
			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			const reattached = await broker.request(resumed(input));
			await port.handlers!.changed();
			expect(port.renames.slice(before)).toHaveLength(2);
			expect(port.channel(channelId).name).toBe("legacy");
			expect(reattached.session.state).toBe("ready");
			await port.owner(reattached, "still routed");
			expect((await poll(broker, reattached)).deliveries.map(delivery => delivery.text)).toEqual(["still routed"]);
		} finally {
			await broker.close();
		}
	});

	it("orders overview, Haiso, then OMP channels and splits the overview by app", async () => {
		using temporary = TempDir.createSync("@discord-app-arrange-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			const alpha = await broker.request(registration(root, "alpha"));
			const overviewId = alpha.group.overviewId!;
			expect(port.cards.get(overviewId)?.text).not.toContain("OMP sessions");
			const gamma = await broker.request({ ...registration(root, "gamma"), app: "omp" });
			const beta = await broker.request(registration(root, "beta"));
			const [alphaId, betaId, gammaId] = [alpha, beta, gamma].map(item => item.session.channelId!);
			expect(port.arrangements.get(alpha.group.categoryId!)).toEqual([overviewId, alphaId, betaId, gammaId]);
			const overview = port.cards.get(overviewId)!;
			expect(overview.app).toBeUndefined();
			const [header, haisoSection, ompSection, ...rest] = overview.text.split("\n\n");
			expect(rest).toEqual([]);
			expect(header).toBe(`Haiso · Named project\n${alpha.group.projectDir}\nDiscord service: Online`);
			expect(haisoSection!.split("\n").map(line => line.split(" · ")[0])).toEqual([
				"Haiso sessions",
				`<#${alphaId}>`,
				`<#${betaId}>`,
			]);
			expect(ompSection!.split("\n").map(line => line.split(" · ")[0])).toEqual(["OMP sessions", `<#${gammaId}>`]);
			expect(port.cards.get(gammaId)).toMatchObject({ app: "omp" });
			expect(port.cards.get(gammaId)?.text).toStartWith("OMP · gamma\n");
			expect(port.cards.get(alphaId)).toMatchObject({ app: "haiso" });
			expect(port.cards.get(alphaId)?.text).toStartWith("Haiso · alpha\n");
		} finally {
			await broker.close();
		}
	});
});

describe("Discord session settings", () => {
	const OPUS = "anthropic/claude-opus-4-5";
	const SONNET = "anthropic/claude-sonnet-4-5";
	const HAIKU = "anthropic/claude-haiku-4-5";
	const CHOICES: Record<string, ModeSettingsView["shortlist"][number]> = {
		[OPUS]: { selector: OPUS, name: "Claude Opus 4.5", role: "default", efforts: ["off", "auto", "low", "high"] },
		[SONNET]: {
			selector: SONNET,
			name: "Claude Sonnet 4.5",
			role: "smol",
			efforts: ["off", "auto", "low", "medium", "high"],
		},
		[HAIKU]: { selector: HAIKU, name: "Claude Haiku 4.5", efforts: [] },
	};
	const SEARCHABLE = ["openai/gpt-5.1-codex", "openrouter/openai/gpt-5.1", "openai/gpt-5.1"].map(selector => ({
		selector,
		name: selector,
		efforts: ["off", "low", "high"],
	}));

	function haisoReport(
		overrides: Partial<Omit<ModeSettingsView, "revision">> = {},
	): Omit<ModeSettingsView, "revision"> {
		const shortlist = [CHOICES[OPUS]!, CHOICES[SONNET]!, CHOICES[HAIKU]!];
		return {
			model: CHOICES[OPUS],
			effort: "high",
			advisor: { enabled: false, active: false },
			plan: { enabled: false },
			capabilities: { persist: true, compact: true, advisor: true, plan: true },
			shortlist,
			models: [...shortlist, ...SEARCHABLE],
			...overrides,
		};
	}

	function setting(
		port: FixtureDiscord,
		session: ModeSnapshot,
		kind: ModeSettingCommand["kind"],
		value?: string | boolean,
	): Promise<ModeControlResult> {
		return port.control(session, "setting", {
			connectionId: session.session.connectionId,
			setting: { kind, ...(value === undefined ? {} : { value }) },
		});
	}

	function report(broker: DiscordModeBroker, session: ModeSnapshot, view: Omit<ModeSettingsView, "revision">) {
		return broker.request({
			op: "poll",
			lease: lease(session),
			busy: false,
			pendingInput: false,
			settings: sealModeSettingsView(view),
		});
	}

	/** A real session client on the real broker, with a settings host that records what it applied. */
	async function liveSession(broker: DiscordModeBroker, root: string) {
		const sessionId = randomUUID();
		const state = { streaming: false };
		let current = haisoReport();
		const applied: ModeSettingCommand[] = [];
		const engine: DiscordSessionEngine = {
			sessionFile: path.join(root, `${sessionId}.jsonl`),
			get isStreaming() {
				return state.streaming;
			},
			hasAdmittedSubmission: false,
			queuedMessageCount: 0,
			sessionManager: {
				getSessionId: () => sessionId,
				getCwd: () => root,
				ensureOnDisk: async () => {},
				flush: async () => {},
			},
			subscribe: () => () => {},
			promptCustomMessage: async () => true,
			abort: async () => {},
			waitForSessionTransition: async () => {},
		};
		const mode = new DiscordModeSession(engine, {
			connect: async () => ({
				request: input => broker.request(input),
				lookup: (projectDir, id) => broker.lookup(projectDir, id),
				close: async () => {},
			}),
			receiptRoot: root,
			pollIntervalMs: 0,
			settings: {
				view: () => current,
				usage: () => ({ tokens: 50_000, contextWindow: 200_000, percent: 25 }),
				apply: async command => {
					applied.push(command);
					if (command.kind === "model") current = { ...current, model: CHOICES[String(command.value)] };
					return { outcome: "applied", text: `Applied ${command.kind}.` };
				},
			},
		});
		const snapshot = await mode.on("Named project", "live");
		return { mode, state, applied, snapshot };
	}

	it("applies an idle change once despite a double click, confirming only after the session acknowledges it", async () => {
		using temporary = TempDir.createSync("@discord-settings-idle-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		const live = await liveSession(broker, root);
		try {
			await live.mode.poll();
			const panel = await port.control(live.snapshot, "settings");
			expect(panel.settings?.view.model?.selector).toBe(OPUS);
			expect(panel.settings?.usage).toEqual({ tokens: 50_000, contextWindow: 200_000, percent: 25 });
			const first = await setting(port, live.snapshot, "model", settingsChoiceToken(SONNET));
			const again = await setting(port, live.snapshot, "model", settingsChoiceToken(SONNET));
			expect(first.text).toStartWith("Sent to the session");
			expect(again.text).toStartWith("Already pending");
			expect(again.commandId).toBeUndefined();
			expect(port.settingsResults).toEqual([]);
			await live.mode.poll();
			await port.settingsDelivered(1);
			await live.mode.poll();
			expect(live.applied).toEqual([{ id: first.commandId!, kind: "model", value: SONNET }]);
			expect(port.settingsResults).toMatchObject([
				{ channelId: live.snapshot.session.channelId, commandId: first.commandId, text: "Applied model." },
			]);
			// The confirmation carries the session's fresh view, so the panel shows the new model.
			expect(port.settingsResults[0]!.panel).toMatchObject({ view: { model: { selector: SONNET } }, pending: [] });
		} finally {
			await live.mode.off();
			await broker.close();
		}
	});

	it("holds a change made during a turn, refuses compaction until idle, then applies and confirms", async () => {
		using temporary = TempDir.createSync("@discord-settings-busy-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		const live = await liveSession(broker, root);
		try {
			live.state.streaming = true;
			await live.mode.poll();
			const queued = await setting(port, live.snapshot, "effort", "low");
			expect(queued.text).toStartWith("Pending — applies after this turn");
			await expect(setting(port, live.snapshot, "compact")).rejects.toThrow("busy");
			await live.mode.poll();
			expect(live.applied).toEqual([]);
			expect(port.settingsResults).toEqual([]);
			live.state.streaming = false;
			await live.mode.poll();
			await port.settingsDelivered(1);
			expect(live.applied).toEqual([{ id: queued.commandId!, kind: "effort", value: "low" }]);
			expect(port.settingsResults).toMatchObject([{ commandId: queued.commandId, text: "Applied effort." }]);
		} finally {
			await live.mode.off();
			await broker.close();
		}
	});

	it("offers only what the session reported: supported efforts, its models, and Haiso-only controls", async () => {
		using temporary = TempDir.createSync("@discord-settings-validate-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			const session = await broker.request(registration(root, "validated"));
			// A client that never reports settings (an older app) offers nothing to change.
			expect((await port.control(session, "settings")).settings).toBeUndefined();
			await expect(setting(port, session, "compact")).rejects.toThrow("isn't reporting");
			await report(broker, session, haisoReport());
			await expect(setting(port, session, "effort", "medium")).rejects.toThrow(
				"Claude Opus 4.5 doesn't support effort medium",
			);
			await expect(setting(port, session, "model", settingsChoiceToken("unknown/model"))).rejects.toThrow(
				"no longer offered",
			);
			// Efforts follow a pending model change.
			await setting(port, session, "model", settingsChoiceToken(SONNET));
			expect((await setting(port, session, "effort", "medium")).commandId).toBeDefined();
			await report(
				broker,
				session,
				haisoReport({
					advisor: undefined,
					plan: undefined,
					capabilities: { persist: false, compact: true, advisor: false, plan: false },
				}),
			);
			for (const [kind, value] of [
				["advisor", true],
				["advisor-model", settingsChoiceToken(SONNET)],
				["plan", undefined],
				["default", undefined],
			] as const)
				await expect(setting(port, session, kind, value)).rejects.toThrow("doesn't offer");
			expect((await poll(broker, session)).commands?.map(command => [command.kind, command.value])).toEqual([
				["model", SONNET],
				["effort", "medium"],
			]);
		} finally {
			await broker.close();
		}
	});

	it("ranks searched models by the TUI's relevance tiers and accepts a model found by search", async () => {
		using temporary = TempDir.createSync("@discord-settings-search-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			const session = await broker.request(registration(root, "search"));
			await report(broker, session, haisoReport());
			const found = await port.control(session, "settings", { query: "gpt-5.1" });
			const matches = found.settings?.matches?.map(choice => choice.selector) ?? [];
			// The exact id wins over earlier-listed partial matches; unrelated models never match.
			expect(matches[0]).toBe("openai/gpt-5.1");
			expect(matches.slice(1).sort()).toEqual(["openai/gpt-5.1-codex", "openrouter/openai/gpt-5.1"]);
			expect((await port.control(session, "settings", { query: "llama" })).settings?.matches).toEqual([]);
			await setting(port, session, "model", settingsChoiceToken("openai/gpt-5.1"));
			expect((await poll(broker, session)).commands).toMatchObject([{ kind: "model", value: "openai/gpt-5.1" }]);
		} finally {
			await broker.close();
		}
	});

	it("refuses stale panels and tells the owner which changes a disconnect dropped", async () => {
		using temporary = TempDir.createSync("@discord-settings-stale-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			const input = registration(root, "stale");
			const first = await broker.request(input);
			await report(broker, first, haisoReport());
			const dispatched = await setting(port, first, "model", settingsChoiceToken(SONNET));
			await poll(broker, first);
			const queued = await setting(port, first, "compact");
			await broker.request({ op: "detach", lease: lease(first) });
			await port.settingsDelivered(2);
			expect(port.settingsResults.map(result => [result.commandId, result.text.split(" (")[0]])).toEqual([
				[dispatched.commandId!, "Outcome unknown"],
				[queued.commandId!, "Not applied"],
			]);
			const reconnected = await broker.request(resumed(input));
			expect(reconnected.settingsRevision).toBe("");
			await expect(setting(port, first, "compact")).rejects.toThrow("stale connection");
			// The new connection must report its own settings before anything can change.
			expect((await port.control(reconnected, "settings")).settings).toBeUndefined();
		} finally {
			await broker.close();
		}
	});
});

describe("session card progress", () => {
	const LINE = "Working · 4m · editing 3 files · last: bun test (pass)";

	async function progressFixture(prefix: string) {
		const root = TempDir.createSync(prefix);
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({
			config,
			storePath: path.join(root.path(), "private", "state.json"),
			port,
		});
		await broker.start();
		const session = await broker.request(registration(root.path(), "progress"));
		const channelId = session.session.channelId!;
		const status = vi.spyOn(port, "status");
		const startedAt = Date.now() - 4 * 60_000 - 1_000;
		// The spacing window runs on fake time; broker I/O stays real.
		vi.useFakeTimers();
		const progress = (patch: Partial<ModeProgress> = {}): ModeProgress => ({
			startedAt,
			phase: "editing",
			files: 3,
			last: { label: "bun test", outcome: "pass" },
			...patch,
		});
		return {
			broker,
			session,
			progress,
			card: () => port.cards.get(channelId)!.text,
			overview: () => port.cards.get(session.group.overviewId!)!.text,
			edits: () => status.mock.calls.filter(call => call[0] === channelId).length,
			report: (value: ModeProgress | undefined, busy = true) =>
				broker.request({
					op: "poll",
					lease: lease(session),
					busy,
					pendingInput: false,
					...(value ? { progress: value } : {}),
				}),
			/** Fires due trailing edits, then waits for them: broker work is serialized behind them. */
			async elapse(ms: number) {
				vi.advanceTimersByTime(ms);
				await broker.lookup(session.session.projectDir, session.session.id);
			},
			async close() {
				vi.useRealTimers();
				await broker.close();
				root.remove();
			},
		};
	}

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("shows the line on the session card only, throttles progress edits, and clears it when idle", async () => {
		const f = await progressFixture("@discord-progress-card-");
		try {
			expect(f.session.progress).toBe(true);
			await f.report(f.progress());
			expect(f.card()).toContain(`${LINE}\n`);
			expect(f.card()).not.toContain("Working · ready");
			expect(f.overview()).toMatch(/\bWorking · ready\b/);
			expect(f.overview()).not.toContain("editing");
			const shown = f.edits();
			// Unchanged line: no edit.
			await f.report(f.progress());
			expect(f.edits()).toBe(shown);
			// Changes inside the window coalesce into one trailing edit carrying the latest line.
			await f.report(f.progress({ files: 4 }));
			await f.elapse(DISCORD_MODE_PROGRESS_CARD_MS / 2);
			await f.report(f.progress({ files: 5 }));
			expect(f.edits()).toBe(shown);
			await f.elapse(DISCORD_MODE_PROGRESS_CARD_MS / 2);
			expect(f.edits()).toBe(shown + 1);
			expect(f.card()).toContain("editing 5 files");
			await f.elapse(DISCORD_MODE_PROGRESS_CARD_MS);
			expect(f.edits()).toBe(shown + 1);
			// Past the window a change edits at once.
			await f.report(f.progress({ phase: "running", last: { label: "bun test", outcome: "fail" } }));
			expect(f.edits()).toBe(shown + 2);
			expect(f.card()).toContain("Working · 4m · running · 3 files edited · last: bun test (fail)\n");
			// Idle drops the line immediately.
			await f.report(undefined, false);
			expect(f.card()).toContain("Idle · ready\n");
			expect(f.card()).not.toContain("last:");
		} finally {
			await f.close();
		}
	});

	it("drops the line when a busy session stops reporting a run", async () => {
		const f = await progressFixture("@discord-progress-norun-");
		try {
			await f.report(f.progress());
			expect(f.card()).toContain(LINE);
			// Busy only because of local editor text: no run, no line.
			await f.report(undefined, true);
			expect(f.card()).toContain("Working · ready\n");
			expect(f.card()).not.toContain("last:");
		} finally {
			await f.close();
		}
	});

	it("clears on detach, and a pending trailing edit never brings it back", async () => {
		const f = await progressFixture("@discord-progress-detach-");
		try {
			await f.report(f.progress());
			await f.report(f.progress({ files: 9 }));
			await f.broker.request({ op: "detach", lease: lease(f.session) });
			await f.elapse(DISCORD_MODE_PROGRESS_CARD_MS);
			expect(f.card()).not.toContain("Working");
			expect(f.card()).not.toContain("last:");
		} finally {
			await f.close();
		}
	});

	it("rejects malformed progress without applying the poll", async () => {
		const f = await progressFixture("@discord-progress-invalid-");
		try {
			for (const invalid of [
				f.progress({ last: { label: "bun\u0007test", outcome: "pass" } }),
				f.progress({ files: 1000 }),
				{ ...f.progress(), output: "tool output" },
			])
				await expect(f.report(invalid as ModeProgress)).rejects.toThrow();
			expect(f.card()).toContain("Idle · ready\n");
		} finally {
			await f.close();
		}
	});
});

describe("service liveness, saved and missed messages", () => {
	const DISCORD_EPOCH = 1_420_070_400_000n;
	/** A snowflake `offset` ms from now; `sequence` orders ids within it. */
	function snowflake(offset: number, sequence = 0): string {
		return (((BigInt(Date.now() + offset) - DISCORD_EPOCH) << 22n) + BigInt(sequence)).toString();
	}
	async function journal(storePath: string): Promise<Record<string, any>> {
		return JSON.parse(await fs.readFile(storePath, "utf8"));
	}
	const SAVED_ACTIONS: ModeNoticeAction[] = [
		{ action: "review", label: "Review" },
		{ action: "send-held", label: "Send all" },
		{ action: "discard-held", label: "Discard" },
	];

	it("session cards read Online while connected and Closed once the conversation closes", async () => {
		using temporary = TempDir.createSync("@discord-honest-cards-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			const live = await broker.request(registration(root, "honest"));
			const channelId = live.session.channelId!;
			expect(port.cards.get(channelId)!.text).toContain("\nOnline · Idle · ready\n");
			await broker.request({ op: "detach", lease: lease(live) });
			expect(port.cards.get(channelId)!.text).toContain("\nClosed · resume at your desk · ready\n");
			expect(port.cards.get(channelId)!.text).not.toContain("Disconnected");
			expect(port.cards.get(live.group.overviewId!)!.text).toContain("Closed · resume at your desk");
		} finally {
			await broker.close();
		}
	});

	it("overview reads Offline since on a graceful stop and clears when back; a crash reports its window once", async () => {
		using temporary = TempDir.createSync("@discord-offline-since-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const port = new FixtureDiscord();
		let broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const live = await broker.request(registration(root, "liveness"));
			const overviewId = live.group.overviewId!;
			const channelId = live.session.channelId!;
			expect(port.cards.get(overviewId)!.text).toContain("Discord service: Online");
			const before = Date.now();
			await broker.close();
			const stopped = port.cards.get(overviewId)!.text;
			const since = /Discord service: Offline since <t:(\d+):f>/.exec(stopped);
			expect(since).not.toBeNull();
			expect(Number(since![1])).toBeGreaterThanOrEqual(Math.floor(before / 1000));
			// Session cards drop their live controls and say the conversation is closed.
			expect(port.cards.get(channelId)).toMatchObject({ connectionId: undefined });
			expect(port.cards.get(channelId)!.text).toContain("Closed · resume at your desk");
			expect((await journal(storePath)).service.stoppedAt).toBeGreaterThanOrEqual(before);

			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			expect(port.cards.get(overviewId)!.text).toContain("Discord service: Online");
			expect(port.cards.get(overviewId)!.text).not.toContain("Offline since");
			expect((await journal(storePath)).service.stoppedAt).toBeUndefined();
			// A graceful stop is not a crash: no offline-window note.
			expect(port.publications.filter(item => item.key.startsWith("offline:"))).toEqual([]);
			await broker.close();

			// A crash leaves only the last heartbeat.
			const heartbeatAt = before - 5 * 60_000;
			const crashed = await journal(storePath);
			crashed.service = { heartbeatAt };
			await writePrivateJson(storePath, crashed);
			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			const notes = port.publications.filter(item => item.key.startsWith("offline:"));
			expect(notes).toHaveLength(1);
			expect(notes[0]).toMatchObject({ kind: "publish", channelId: overviewId, key: `offline:${heartbeatAt}` });
			expect(notes[0]!.text).toContain(`was offline from <t:${Math.floor(heartbeatAt / 1000)}:f> to <t:`);
			await broker.close();
			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			expect(port.publications.filter(item => item.key.startsWith("offline:"))).toHaveLength(1);
		} finally {
			await broker.close();
		}
	});

	it("saves plain messages for a closed conversation, replies at once, and discards them within budget", async () => {
		using temporary = TempDir.createSync("@discord-closed-saved-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			const input = registration(root, "closed");
			const live = await broker.request(input);
			await broker.request({ op: "detach", lease: lease(live) });
			const saved = await port.owner(live, "while closed", "message", "8700");
			expect(saved).toMatchObject({
				text: CLOSED_SAVED_TEXT,
				saved: true,
				connectionId: live.session.connectionId,
			});
			expect(saved.deliveryId).toBeString();
			// The same Discord event again is fenced, and still reads as saved.
			expect(await port.owner(live, "while closed", "message", "8700")).toMatchObject({
				saved: true,
				deliveryId: saved.deliveryId,
			});
			for (const kind of ["steer", "abort"] as const)
				expect((await port.owner(live, kind === "abort" ? "" : "nudge", kind)).text).toContain("Nothing was saved");
			// Sending needs the conversation open; the saved message stays.
			const early = await port.control(live, "send-held", { connectionId: live.session.connectionId });
			expect(early.text).toContain("closed");
			// A button from the revoked connection still discards: saved messages outlive it by design.
			const discarded = await port.control(live, "discard", {
				connectionId: live.session.connectionId,
				deliveryId: saved.deliveryId,
			});
			expect(discarded.text).toBe("Discarded 1 saved message.");
			expect(
				(
					await port.control(live, "discard", {
						connectionId: live.session.connectionId,
						deliveryId: saved.deliveryId,
					})
				).text,
			).toContain("already sent or discarded");
			// Existing budgets apply: 32 pending per session.
			for (let index = 0; index < 32; index++)
				await port.owner(live, `saved ${index}`, "message", String(9000 + index));
			await expect(port.owner(live, "one too many", "message", "9100")).rejects.toThrow("32 per session");
			const back = await broker.request({ ...resumed(input), rejoin: true });
			const status = await broker.request({ op: "status", lease: lease(back) });
			expect(status.deliveries).toHaveLength(32);
			expect(status.deliveries.every(item => item.held === true && item.state === "queued")).toBe(true);
		} finally {
			await broker.close();
		}
	});

	it("a rejoin offers saved messages without dispatching them; Review, Discard, and Send all behave", async () => {
		using temporary = TempDir.createSync("@discord-rejoin-offer-");
		const root = temporary.path();
		const port = new FixtureDiscord();
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			const input = registration(root, "offered");
			const live = await broker.request(input);
			await broker.request({ op: "detach", lease: lease(live) });
			const first = await port.owner(live, "first saved", "message", "8800");
			const second = await port.owner(live, "second saved", "message", "8801");
			await port.owner(live, "third saved", "message", "8802");
			const back = await broker.request({ ...resumed(input), rejoin: true });
			const connectionId = back.session.connectionId;
			expect(port.notices).toEqual([
				{
					channelId: live.session.channelId!,
					text: "3 messages arrived while this session was closed.",
					key: `arrivals:${input.sessionId}:${connectionId}`,
					connectionId,
					actions: SAVED_ACTIONS,
				},
			]);
			// Offered, never dispatched on their own.
			expect((await poll(broker, back)).deliveries).toEqual([]);
			const status = await broker.request({ op: "status", lease: lease(back) });
			expect(status.deliveries.map(item => [item.text, item.held, item.state])).toEqual([
				["first saved", true, "queued"],
				["second saved", true, "queued"],
				["third saved", true, "queued"],
			]);
			const review = await port.control(back, "review", { connectionId });
			expect(review).toMatchObject({ review: true, connectionId });
			expect(review.queued!.map(item => item.text)).toEqual(["first saved", "second saved", "third saved"]);
			const picked = await port.control(back, "review", { connectionId, deliveryId: second.deliveryId });
			expect(picked).toMatchObject({ text: "Saved message\nsecond saved", deliveryId: second.deliveryId });
			// Discard one from the terminal; Send all from Discord releases the rest in arrival order.
			await broker.request({
				op: "held",
				lease: lease(back),
				requestId: randomUUID(),
				action: "discard",
				deliveryIds: [second.deliveryId!],
			});
			const sent = await port.control(back, "send-held", { connectionId });
			expect(sent.text).toBe("Sending 2 saved messages in order as the session becomes idle.");
			const dispatched = await poll(broker, back);
			expect(dispatched.deliveries.map(item => [item.id, item.text])).toEqual([[first.deliveryId!, "first saved"]]);
			await broker.request({
				op: "receipt",
				lease: lease(back),
				deliveryId: first.deliveryId!,
				state: "completed",
			});
			expect((await poll(broker, back)).deliveries.map(item => item.text)).toEqual(["third saved"]);
			// A later rejoin with nothing saved posts no offer.
			await broker.request({ op: "detach", lease: lease(back) });
			await broker.request({ ...resumed(input), rejoin: true });
			expect(port.notices).toHaveLength(1);
		} finally {
			await broker.close();
		}
	});

	it("catches up owner messages missed while offline: after the watermark, owner-only, deduplicated, offered", async () => {
		using temporary = TempDir.createSync("@discord-catch-up-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const port = new FixtureDiscord();
		let broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const input = registration(root, "missed");
			const live = await broker.request(input);
			const channelId = live.session.channelId!;
			const base = BigInt(snowflake(60_000));
			const id = (sequence: number) => (base + BigInt(sequence)).toString();
			// Received live before the outage, but past the watermark a lost write left behind.
			await port.owner(live, "seen live", "message", id(3));
			await broker.close();
			const saved = await journal(storePath);
			saved.watermarks[channelId] = id(0);
			await writePrivateJson(storePath, saved);
			const message = (sequence: number, text: string, extra: Partial<ModeOwnerMessage> = {}) => ({
				id: id(sequence),
				channelId,
				ownerId: config.ownerId,
				text,
				kind: "message" as const,
				...extra,
			});
			port.remoteHistory.set(channelId, [
				message(1, "missed one"),
				message(2, "someone else", { ownerId: "999" }),
				message(3, "seen live"),
				message(4, "", { rejected: "Attachments are unsupported." }),
				message(5, "late nudge", { kind: "steer" }),
				message(6, "missed two"),
			]);
			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			await broker.lookup(input.projectDir, input.sessionId); // Serialized after the catch-up.
			expect(port.historyRequests.at(-1)).toEqual({ channelId, afterId: id(0), limit: 50 });
			expect(port.notices).toEqual([
				{
					channelId,
					text: "2 messages arrived while Haiso was offline.",
					key: `catchup:${channelId}:${id(6)}`,
					connectionId: live.session.connectionId,
					actions: [
						{ action: "send-held", label: "Send now" },
						{ action: "discard-held", label: "Discard" },
					],
				},
			]);
			const after = await journal(storePath);
			expect(after.watermarks[channelId]).toBe(id(6));
			expect(
				after.deliveries.map((item: { text: string; held: boolean; sourceMessageId: string }) => [
					item.text,
					item.held,
					item.sourceMessageId,
				]),
			).toEqual([
				["seen live", true, id(3)],
				["missed one", true, id(1)],
				["missed two", true, id(6)],
			]);
			// Never run: the conversation is closed, so Send now waits for its resume; Discard drops them.
			expect((await port.control(live, "send-held", { connectionId: live.session.connectionId })).text).toContain(
				"closed",
			);
			// A second reconnect finds nothing new past the watermark.
			port.handlers!.connection(false);
			port.handlers!.connection(true);
			await broker.lookup(input.projectDir, input.sessionId);
			expect(port.historyRequests.at(-1)).toEqual({ channelId, afterId: id(6), limit: 50 });
			expect(port.notices).toHaveLength(1);
			expect((await port.control(live, "discard-held", { connectionId: live.session.connectionId })).text).toBe(
				"Discarded 3 saved messages.",
			);
		} finally {
			await broker.close();
		}
	});

	it("bounds catch-up to seven days and starts watching a channel that has no watermark yet", async () => {
		using temporary = TempDir.createSync("@discord-catch-up-bounds-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const port = new FixtureDiscord();
		let broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const input = registration(root, "bounded");
			const live = await broker.request(input);
			const channelId = live.session.channelId!;
			await broker.close();
			const ancient = await journal(storePath);
			ancient.watermarks[channelId] = "1";
			await writePrivateJson(storePath, ancient);
			const low = BigInt(snowflake(-DISCORD_MODE_CATCH_UP_MS));
			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			await broker.lookup(input.projectDir, input.sessionId);
			const high = BigInt(snowflake(-DISCORD_MODE_CATCH_UP_MS));
			const request = port.historyRequests.at(-1)!;
			expect(request.limit).toBe(DISCORD_MODE_CATCH_UP_LIMIT);
			expect(BigInt(request.afterId) >= low && BigInt(request.afterId) <= high).toBe(true);
			await broker.close();

			// First run after an upgrade: nothing is known to be missed, so no history is replayed.
			const unmarked = await journal(storePath);
			delete unmarked.watermarks;
			await writePrivateJson(storePath, unmarked);
			const requests = port.historyRequests.length;
			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			await broker.lookup(input.projectDir, input.sessionId);
			expect(port.historyRequests).toHaveLength(requests);
			expect(BigInt((await journal(storePath)).watermarks[channelId])).toBeGreaterThan(high);
		} finally {
			await broker.close();
		}
	});

	it("loads a journal written with fields it does not know and writes back only its own", async () => {
		using temporary = TempDir.createSync("@discord-journal-rollback-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const port = new FixtureDiscord();
		let broker = new DiscordModeBroker({ config, storePath, port });
		await broker.start();
		try {
			const input = registration(root, "rollback");
			const live = await broker.request(input);
			await port.owner(live, "pending across versions", "message", "8900");
			await broker.close();
			const future = await journal(storePath);
			future.futureTopLevel = { anything: true };
			future.groups[0].futureField = 1;
			future.sessions[0].futureField = "x";
			future.deliveries[0].futureField = [1];
			future.cards[0].futureField = true;
			(Object.values(future.operations)[0] as Record<string, unknown>).futureField = "y";
			future.service.futureField = 2;
			await writePrivateJson(storePath, future);
			broker = new DiscordModeBroker({ config, storePath, port });
			await broker.start();
			expect((await broker.lookup(input.projectDir, input.sessionId))?.session?.enabled).toBe(true);
			const written = await journal(storePath);
			expect(JSON.stringify(written)).not.toContain("future");
			expect(written.deliveries.map((item: { text: string }) => item.text)).toEqual(["pending across versions"]);
		} finally {
			await broker.close();
		}
	});
});

describe("service updates: version, pinned guide, and idle switchover", () => {
	type GuideInput = Parameters<NonNullable<DiscordPort["guide"]>>[0];
	/** Records guide requests; the adapter's placement rules are covered in discord.test.ts. */
	class GuideDiscord extends FixtureDiscord {
		readonly guides: GuideInput[] = [];
		inbound = false;
		async guide(input: GuideInput) {
			this.guides.push(structuredClone(input));
			return { channelId: "900", messageId: "901" };
		}
		busy() {
			return this.inbound;
		}
	}
	const TEMPLATE = "**Haiso — Discord guide**\n\n**In a session channel**\n{{commands}}";
	function guideWith(names: string[], extra = "") {
		return renderDiscordGuide(
			names.map(name => ({ name, description: `Do ${name}`, choices: [] })),
			TEMPLATE + extra,
		);
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reports its build, maintains the guide, and notes only what a later release added", async () => {
		using temporary = TempDir.createSync("@discord-guide-");
		const root = temporary.path();
		const storePath = path.join(root, "private", "state.json");
		const port = new GuideDiscord();
		const first = guideWith(["status", "stop"]);
		const service = { version: "18.3.0", commit: "a63bfb949a12", release: path.join(root, "release") };
		let broker = new DiscordModeBroker({ config, storePath, port, guide: first, service });
		await broker.start();
		try {
			// First ever start: no saved placement, no what's-new note.
			expect(port.guides).toEqual([{ text: first.text, exclude: [] }]);
			const session = await broker.request(registration(root, "guide"));
			expect(session.service).toEqual(service);
			await broker.close();
			expect(JSON.parse(await fs.readFile(storePath, "utf8")).guide).toEqual({
				channelId: "900",
				messageId: "901",
				hash: first.hash,
				commands: ["status", "stop"],
				sections: ["In a session channel"],
				version: "18.3.0",
			});

			broker = new DiscordModeBroker({ config, storePath, port, guide: first });
			await broker.start();
			expect(port.guides[1]).toEqual({
				text: first.text,
				saved: { channelId: "900", messageId: "901" },
				exclude: [session.group.categoryId!],
			});
			await broker.close();

			const next = guideWith(["status", "stop", "resume"], "\n\n**Sessions**\nStart them from Discord.");
			broker = new DiscordModeBroker({ config, storePath, port, guide: next });
			await broker.start();
			expect(port.guides[2]?.note).toEqual({
				text: "Haiso updated · new: `/session resume`, Sessions",
				key: `whatsnew:${next.hash}`,
			});
			await broker.close();

			broker = new DiscordModeBroker({ config, storePath, port, guide: next });
			await broker.start();
			expect(port.guides).toHaveLength(4);
			expect(port.guides[3]?.note).toBeUndefined();
		} finally {
			await broker.close();
		}
	});

	it("places the guide once Discord connects when it was offline at start", async () => {
		using temporary = TempDir.createSync("@discord-guide-offline-");
		const root = temporary.path();
		const port = new GuideDiscord();
		port.online = false;
		const broker = new DiscordModeBroker({
			config,
			storePath: path.join(root, "private", "state.json"),
			port,
			guide: guideWith(["status"]),
		});
		await broker.start();
		try {
			expect(port.guides).toEqual([]);
			port.handlers!.connection(true);
			await broker.lookup(root, randomUUID()); // Serialized after the guide.
			port.handlers!.connection(true);
			await broker.lookup(root, randomUUID());
			expect(port.guides).toHaveLength(1);
		} finally {
			await broker.close();
		}
	});

	it("stops for an update only after a quiet spell, never with work in flight", async () => {
		using temporary = TempDir.createSync("@discord-switch-quiet-");
		const root = temporary.path();
		const port = new GuideDiscord();
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const broker = new DiscordModeBroker({ config, storePath: path.join(root, "private", "state.json"), port });
		await broker.start();
		try {
			const session = await broker.request(registration(root, "switch"));
			const overviewId = session.group.overviewId!;
			// Every request below lands within one lease of the previous poll.
			await poll(broker, session, true);
			now += DISCORD_MODE_SWITCH_QUIET_MS;
			expect(await broker.stopIfQuiescent()).toBe(false); // Mid-turn.
			await broker.request({ op: "poll", lease: lease(session), busy: false, pendingInput: true });
			now += DISCORD_MODE_SWITCH_QUIET_MS;
			expect(await broker.stopIfQuiescent()).toBe(false); // Waiting for the owner.
			await poll(broker, session);

			// Queued owner work, then its dispatched and accepted turn.
			const queued = await port.owner(session, "one more thing");
			now += DISCORD_MODE_SWITCH_QUIET_MS;
			expect(await broker.stopIfQuiescent()).toBe(false);
			expect((await poll(broker, session)).deliveries).toHaveLength(1);
			now += DISCORD_MODE_SWITCH_QUIET_MS;
			expect(await broker.stopIfQuiescent()).toBe(false);
			await broker.request({
				op: "receipt",
				lease: lease(session),
				deliveryId: queued.deliveryId!,
				state: "accepted",
			});
			await poll(broker, session);
			now += DISCORD_MODE_SWITCH_QUIET_MS;
			expect(await broker.stopIfQuiescent()).toBe(false);
			await broker.request({
				op: "receipt",
				lease: lease(session),
				deliveryId: queued.deliveryId!,
				state: "completed",
			});
			await poll(broker, session);

			// An open dialog, then a Discord event still being handled.
			await broker.request({
				op: "dialog",
				lease: lease(session),
				dialog: { id: "ask-1", kind: "confirm", title: "Proceed?" },
			});
			now += DISCORD_MODE_SWITCH_QUIET_MS;
			await poll(broker, session);
			expect(await broker.stopIfQuiescent()).toBe(false);
			await broker.request({ op: "dialog-end", lease: lease(session), dialogId: "ask-1" });
			port.inbound = true;
			now += DISCORD_MODE_SWITCH_QUIET_MS;
			await poll(broker, session);
			expect(await broker.stopIfQuiescent()).toBe(false);
			port.inbound = false;

			// Idle now, but only a full quiet spell after the last activity counts.
			await poll(broker, session, true);
			const lastActive = now;
			now = lastActive + 1_000;
			await poll(broker, session);
			now = lastActive + DISCORD_MODE_SWITCH_QUIET_MS - 1;
			expect(await broker.stopIfQuiescent()).toBe(false);
			now = lastActive + DISCORD_MODE_SWITCH_QUIET_MS;
			expect(await broker.stopIfQuiescent()).toBe(true);
			await expect(poll(broker, session)).rejects.toThrow(SERVICE_UPDATING_TEXT);
			await expect(port.owner(session, "during the switch")).rejects.toThrow(SERVICE_UPDATING_TEXT);
			await broker.close();
			expect(port.cards.get(overviewId)?.text).toContain("Discord service: Updating — back in a moment");
		} finally {
			await broker.close();
		}
	});
});

describe("background conversations from Discord", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Records supervisor starts and stops; `live` are copies still running, `holders` the conversation locks. */
	class FakeHosts implements DiscordHostPort {
		readonly started: DiscordHostSpec[] = [];
		readonly stopped: string[] = [];
		readonly live = new Set<string>();
		readonly holders = new Map<string, "terminal" | "background">();
		async start(spec: DiscordHostSpec): Promise<void> {
			this.started.push(spec);
			this.live.add(spec.name);
		}
		async stop(name: string): Promise<void> {
			this.stopped.push(name);
			this.live.delete(name);
		}
		async running(): Promise<string[]> {
			return [...this.live];
		}
		async holder(sessionId: string): Promise<"terminal" | "background" | undefined> {
			return this.holders.get(sessionId);
		}
	}

	async function serviceBroker(root: string, hosts: FakeHosts | null = new FakeHosts(), port = new FixtureDiscord()) {
		const storePath = path.join(root, "private", "state.json");
		const broker = new DiscordModeBroker({ config, storePath, port, ...(hosts ? { hosts } : {}) });
		await broker.start();
		return { storePath, port, hosts: hosts ?? new FakeHosts(), broker };
	}

	/** An enrolled conversation whose file and project exist on disk, closed (still shared) unless `open`. */
	async function conversation(
		broker: DiscordModeBroker,
		root: string,
		label: string,
		options: { open?: boolean; app?: "omp"; projectDir?: string } = {},
	) {
		const input = { ...registration(root, label, options.projectDir), ...(options.app ? { app: options.app } : {}) };
		await fs.mkdir(input.projectDir, { recursive: true });
		await fs.writeFile(input.sessionFile, `${JSON.stringify({ type: "session", id: input.sessionId })}\n`);
		const snapshot = await broker.request(input);
		if (!options.open) await broker.request({ op: "detach", lease: lease(snapshot) });
		return { input, snapshot };
	}

	function claim(input: Extract<ModeRequest, { op: "register" }>, launchId: string) {
		return { ...resumed(input), rejoin: true as const, launchId, host: "background" as const };
	}

	function clock(start = Date.now()) {
		let now = start;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		return {
			advance(ms: number) {
				now += ms;
			},
		};
	}

	it("offers Resume only on closed shared Haiso cards, and only from a service that can start copies", async () => {
		using temporary = TempDir.createSync("@discord-background-cards-");
		const root = temporary.path();
		const plain = await serviceBroker(path.join(root, "plain"), null);
		try {
			const { snapshot } = await conversation(plain.broker, path.join(root, "plain"), "desk-only");
			const card = plain.port.cards.get(snapshot.session.channelId!)!;
			expect(card.resumable).toBeUndefined();
			expect(card.text).toContain("Closed · resume at your desk");
			await expect(plain.port.control(snapshot, "sessions")).rejects.toThrow("can't start conversations");
		} finally {
			await plain.broker.close();
		}
		const { port, broker } = await serviceBroker(path.join(root, "service"));
		try {
			const base = path.join(root, "service");
			const closed = await conversation(broker, base, "closed-work");
			const open = await conversation(broker, base, "open-work", { open: true });
			const omp = await conversation(broker, base, "omp-work", { app: "omp" });
			const off = await conversation(broker, base, "off-work", { open: true });
			await broker.request({ op: "off", lease: lease(off.snapshot) });
			expect(port.cards.get(closed.snapshot.session.channelId!)).toMatchObject({ resumable: true });
			expect(port.cards.get(closed.snapshot.session.channelId!)!.text).toContain(
				"Closed · resume here or at your desk",
			);
			expect(port.cards.get(open.snapshot.session.channelId!)!.resumable).toBeUndefined();
			expect(port.cards.get(open.snapshot.session.channelId!)!.connectionId).toBe(
				open.snapshot.session.connectionId,
			);
			expect(port.cards.get(omp.snapshot.session.channelId!)!.resumable).toBeUndefined();
			expect(port.cards.get(off.snapshot.session.channelId!)!.resumable).toBeUndefined();
			const listed = await port.control(open.snapshot, "sessions");
			expect(listed.resumable).toEqual([{ id: closed.input.sessionId, label: "closed-work" }]);
			// The overview offers the same project-wide list.
			const overview = await port.handlers!.control({
				id: randomUUID(),
				channelId: closed.snapshot.group.overviewId!,
				ownerId: config.ownerId,
				action: "sessions",
			});
			expect(overview.resumable).toEqual(listed.resumable);
		} finally {
			await broker.close();
		}
	});

	it("resumes a closed conversation from journal paths, and its copy claims the launch exactly once", async () => {
		using temporary = TempDir.createSync("@discord-background-resume-");
		const root = temporary.path();
		const { port, hosts, broker } = await serviceBroker(root);
		try {
			const { input, snapshot } = await conversation(broker, root, "closed-work");
			const channelId = snapshot.session.channelId!;
			expect((await port.control(snapshot, "resume")).text).toContain("Starting closed-work in the background");
			expect(hosts.started).toEqual([
				{
					launchId: expect.any(String),
					name: `haiso-s-${input.sessionId}`,
					projectDir: snapshot.session.projectDir,
					sessionFile: snapshot.session.sessionFile,
				},
			]);
			const launchId = hosts.started[0]!.launchId;
			expect(port.cards.get(channelId)!.text).toContain("Starting in the background…");
			expect(port.cards.get(channelId)!.resumable).toBeUndefined();
			expect((await port.control(snapshot, "resume")).text).toContain("already starting");
			expect(hosts.started).toHaveLength(1);
			await expect(broker.request({ ...claim(input, launchId), sessionId: randomUUID() })).rejects.toThrow();
			const copy = await broker.request(claim(input, launchId));
			expect(copy.session).toMatchObject({ connected: true, host: `haiso-s-${input.sessionId}` });
			expect(port.cards.get(channelId)!.text).toContain("Online in the background · Idle");
			expect((await port.control(copy, "resume")).text).toContain("already running in the background");
			await broker.request({ op: "detach", lease: lease(copy) });
			await expect(broker.request(claim(input, launchId))).rejects.toThrow("unknown, expired");
			// A terminal registration clears the background marker.
			const desk = await broker.request(resumed(input));
			expect(desk.session.host).toBeUndefined();
		} finally {
			await broker.close();
		}
	});

	it("refuses resumes Discord must not start, and never starts anything for them", async () => {
		using temporary = TempDir.createSync("@discord-background-refuse-");
		const root = temporary.path();
		const { port, hosts, broker } = await serviceBroker(root);
		try {
			const closed = await conversation(broker, root, "closed-work");
			const open = await conversation(broker, root, "open-work", { open: true });
			const held = await conversation(broker, root, "held-work");
			const omp = await conversation(broker, root, "omp-work", { app: "omp" });
			const off = await conversation(broker, root, "off-work", { open: true });
			await broker.request({ op: "off", lease: lease(off.snapshot) });
			const missing = await conversation(broker, root, "missing-work");
			await fs.rm(missing.input.sessionFile);
			const elsewhere = await conversation(broker, root, "elsewhere", { projectDir: path.join(root, "other") });
			hosts.holders.set(held.input.sessionId, "terminal");
			expect((await port.control(open.snapshot, "resume")).text).toContain("open at your desk");
			expect((await port.control(held.snapshot, "resume")).text).toContain("open in a terminal");
			await expect(port.control(omp.snapshot, "resume")).rejects.toThrow("OMP session");
			await expect(port.control(off.snapshot, "resume")).rejects.toThrow("Sharing is off");
			await expect(port.control(missing.snapshot, "resume")).rejects.toThrow("missing on this computer");
			await expect(
				port.control(closed.snapshot, "resume", { sessionId: elsewhere.input.sessionId }),
			).rejects.toThrow("isn't part of this project");
			await expect(
				port.handlers!.control({
					id: randomUUID(),
					channelId: closed.snapshot.session.channelId!,
					ownerId: "999",
					action: "resume",
				}),
			).rejects.toThrow("Only the configured owner");
			await expect(
				port.handlers!.control({ id: randomUUID(), channelId: "4242", ownerId: config.ownerId, action: "resume" }),
			).rejects.toThrow("Use this in a Haiso project's");
			for (let index = 0; index < DISCORD_MODE_MAX_BACKGROUND; index++) hosts.live.add(`haiso-s-${randomUUID()}`);
			await expect(port.control(closed.snapshot, "resume")).rejects.toThrow(
				`${DISCORD_MODE_MAX_BACKGROUND} conversations are already running in the background`,
			);
			expect(hosts.started).toEqual([]);
			expect(port.cards.get(closed.snapshot.session.channelId!)).toMatchObject({ resumable: true });
		} finally {
			await broker.close();
		}
	});

	it("starts a new conversation only in a known project, with a validated name and model, and runs its first message once", async () => {
		using temporary = TempDir.createSync("@discord-background-new-");
		const root = temporary.path();
		const { port, hosts, broker } = await serviceBroker(root);
		try {
			const { input, snapshot } = await conversation(broker, root, "reporter", { open: true });
			const model = { selector: "anthropic/claude-sonnet", name: "Sonnet", efforts: [] };
			await broker.request({
				op: "poll",
				lease: lease(snapshot),
				busy: false,
				pendingInput: false,
				settings: sealModeSettingsView({
					model,
					capabilities: { persist: false, compact: false, advisor: false, plan: false },
					shortlist: [model],
					models: [model],
				}),
			});
			const overviewId = snapshot.group.overviewId!;
			const start = (fields: Partial<ModeControlRequest>, channelId = overviewId, ownerId = config.ownerId) =>
				port.handlers!.control({ id: randomUUID(), channelId, ownerId, action: "new", ...fields });
			const first = "Please fix the login bug.";
			for (const selector of ["a/b c", "--x", "-a/b", "anthropic"])
				await expect(start({ name: "Fix login", message: first, model: selector })).rejects.toThrow(
					"Invalid session control",
				);
			await expect(start({ name: "Fix login", message: first, model: "anthropic/unknown" })).rejects.toThrow(
				"isn't one a running session offers",
			);
			await expect(start({ name: "Fix login" })).rejects.toThrow("Invalid session control");
			await expect(start({ name: "!!!", message: first })).rejects.toThrow("Choose a name");
			await expect(start({ name: "Fix login", message: first }, "4242")).rejects.toThrow(
				"Use this in a Haiso project's",
			);
			await expect(start({ name: "Fix login", message: first }, overviewId, "999")).rejects.toThrow(
				"Only the configured owner",
			);
			expect(hosts.started).toEqual([]);
			expect((await start({ name: "Fix login", message: first, model: model.selector })).text).toContain(
				"Starting Fix login in the background",
			);
			const spec = hosts.started[0]!;
			expect(spec).toEqual({
				launchId: expect.any(String),
				name: `haiso-n-${spec.launchId}`,
				projectDir: snapshot.group.projectDir,
				model: model.selector,
			});
			// The copy creates its own conversation in the project and registers with placeholders.
			const register = (launchId: string) => {
				const sessionId = randomUUID();
				return broker.request({
					op: "register",
					requestId: randomUUID(),
					sessionId,
					sessionFile: path.join(input.projectDir, `${sessionId}.jsonl`),
					projectDir: input.projectDir,
					connectionId: randomUUID(),
					label: "background",
					groupName: "background",
					launchId,
					host: "background",
				});
			};
			// A new conversation's launch never attaches an existing one.
			const closed = await conversation(broker, root, "closed-work");
			await expect(broker.request(claim(closed.input, spec.launchId))).rejects.toThrow("unknown, expired");
			const copy = await register(spec.launchId);
			expect(copy.group.id).toBe(snapshot.group.id);
			expect(copy.session).toMatchObject({ label: "fix-login", host: spec.name, connected: true });
			expect(port.channel(copy.session.channelId!).name).toBe("🟣-fix-login");
			expect((await poll(broker, copy)).deliveries).toEqual([
				expect.objectContaining({ source: "owner", from: config.ownerId, kind: "message", text: first }),
			]);
			expect((await poll(broker, copy)).deliveries).toEqual([]);
			expect(
				port.publications.filter(
					item => item.channelId === overviewId && item.text.includes(copy.session.channelId!),
				),
			).toHaveLength(1);
			await expect(register(spec.launchId)).rejects.toThrow("unknown, expired");
		} finally {
			await broker.close();
		}
	});

	it("keeps an unclaimed launch across a restart, expires it, and reports a copy that stopped before connecting", async () => {
		using temporary = TempDir.createSync("@discord-background-launches-");
		const root = temporary.path();
		const first = await serviceBroker(root);
		const { input, snapshot } = await conversation(first.broker, root, "survivor");
		const other = await conversation(first.broker, root, "short-lived");
		await first.port.control(snapshot, "resume");
		await first.broker.close();
		const hosts = new FakeHosts();
		hosts.live.add(`haiso-s-${input.sessionId}`);
		const { port, broker } = await serviceBroker(root, hosts, first.port);
		try {
			const copy = await broker.request(claim(input, first.hosts.started[0]!.launchId));
			expect(copy.session.host).toBe(`haiso-s-${input.sessionId}`);
			await broker.request({ op: "detach", lease: lease(copy) });
			hosts.live.clear(); // The copy exited.
			const time = clock();
			await port.control(snapshot, "resume");
			const expired = hosts.started.at(-1)!.launchId;
			time.advance(DISCORD_MODE_LAUNCH_TTL_MS + 1);
			await expect(broker.request(claim(input, expired))).rejects.toThrow("unknown, expired");
			await port.control(other.snapshot, "resume");
			const failed = hosts.started.at(-1)!;
			hosts.live.delete(failed.name);
			time.advance(DISCORD_MODE_LAUNCH_GRACE_MS + 1);
			await port.handlers!.changed();
			expect(
				port.publications.filter(
					item =>
						item.channelId === other.snapshot.session.channelId &&
						item.text.startsWith("Couldn't start short-lived"),
				),
			).toHaveLength(1);
			expect(port.cards.get(other.snapshot.session.channelId!)).toMatchObject({ resumable: true });
			await expect(broker.request(claim(other.input, failed.launchId))).rejects.toThrow("unknown, expired");
		} finally {
			await broker.close();
		}
	});

	it("closes only a background copy, at its next idle point, and stops one that stays idle without leaving", async () => {
		using temporary = TempDir.createSync("@discord-background-close-");
		const root = temporary.path();
		const { port, hosts, broker } = await serviceBroker(root);
		try {
			const { input, snapshot } = await conversation(broker, root, "copy");
			await port.control(snapshot, "resume");
			const copy = await broker.request(claim(input, hosts.started[0]!.launchId));
			const desk = await conversation(broker, root, "desk", { open: true });
			const closed = await conversation(broker, root, "closed");
			expect((await port.control(desk.snapshot, "close")).text).toContain("open in a terminal");
			expect((await port.control(closed.snapshot, "close")).text).toContain("already closed");
			expect((await poll(broker, desk.snapshot)).stepAside).toBeUndefined();
			await poll(broker, copy, true);
			expect((await port.control(copy, "close")).text).toContain("close after this turn");
			await port.owner(copy, "arrived while leaving");
			const time = clock();
			const leaving = await poll(broker, copy);
			expect(leaving.stepAside).toBe(true);
			expect(leaving.deliveries).toEqual([]);
			time.advance(40_000);
			await poll(broker, copy);
			time.advance(DISCORD_MODE_STEP_ASIDE_STOP_MS - 39_000);
			await poll(broker, copy);
			expect(hosts.stopped).toEqual([]);
			await port.handlers!.changed();
			expect(hosts.stopped).toEqual([`haiso-s-${input.sessionId}`]);
			// Leaving keeps sharing and history; the undelivered message is saved for the next resume.
			await broker.request({ op: "detach", lease: lease(copy) });
			const after = await broker.lookup(input.projectDir, input.sessionId);
			expect(after?.session).toMatchObject({ enabled: true, connected: false });
			expect(port.cards.get(copy.session.channelId!)).toMatchObject({ resumable: true });
			expect((await port.control(copy, "review")).queued?.map(item => item.text)).toEqual(["arrived while leaving"]);
		} finally {
			await broker.close();
		}
	});

	it("lets a terminal take over only from a background copy, by the conversation's exact identity", async () => {
		using temporary = TempDir.createSync("@discord-background-takeover-");
		const root = temporary.path();
		const { port, hosts, broker } = await serviceBroker(root);
		try {
			const { input, snapshot } = await conversation(broker, root, "copy");
			const identity = { sessionId: input.sessionId, sessionFile: input.sessionFile, projectDir: input.projectDir };
			// Nothing to take over from a closed conversation.
			expect((await broker.request({ op: "step-aside", ...identity })).lease).toBeUndefined();
			await port.control(snapshot, "resume");
			const copy = await broker.request(claim(input, hosts.started[0]!.launchId));
			expect((await poll(broker, copy)).stepAside).toBeUndefined();
			await expect(
				broker.request({ op: "step-aside", ...identity, sessionFile: path.join(root, "other.jsonl") }),
			).rejects.toThrow("different project directory or session file");
			await broker.request({ op: "step-aside", ...identity });
			expect((await poll(broker, copy)).stepAside).toBe(true);
			const desk = await conversation(broker, root, "desk", { open: true });
			await expect(
				broker.request({
					op: "step-aside",
					sessionId: desk.input.sessionId,
					sessionFile: desk.input.sessionFile,
					projectDir: desk.input.projectDir,
				}),
			).rejects.toThrow("Another terminal");
		} finally {
			await broker.close();
		}
	});

	it("keeps a closing terminal's conversation running as a copy and drops the terminal's lease", async () => {
		using temporary = TempDir.createSync("@discord-background-keep-");
		const root = temporary.path();
		const { port, hosts, broker } = await serviceBroker(root);
		try {
			const { input, snapshot } = await conversation(broker, root, "keep", { open: true });
			expect(snapshot.background).toBe(true);
			const refused = await conversation(broker, root, "refused", { open: true });
			for (let index = 0; index < DISCORD_MODE_MAX_BACKGROUND; index++) hosts.live.add(`haiso-s-${randomUUID()}`);
			await expect(broker.request({ op: "background", lease: lease(refused.snapshot) })).rejects.toThrow(
				"already running in the background",
			);
			expect((await poll(broker, refused.snapshot)).session.connected).toBe(true);
			hosts.live.clear();
			await broker.request({ op: "background", lease: lease(snapshot) });
			expect(hosts.started).toEqual([
				expect.objectContaining({ name: `haiso-s-${input.sessionId}`, sessionFile: snapshot.session.sessionFile }),
			]);
			await expect(poll(broker, snapshot)).rejects.toThrow("invalid, expired, or revoked");
			expect(port.cards.get(snapshot.session.channelId!)!.text).toContain("Starting in the background…");
			const copy = await broker.request(claim(input, hosts.started[0]!.launchId));
			expect(copy.session.host).toBe(`haiso-s-${input.sessionId}`);
		} finally {
			await broker.close();
		}
	});
});
