import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { DiscordModeBroker, DiscordModeError } from "../../src/discord-mode/broker";
import { connectDiscordModeAt } from "@oh-my-pi/pi-utils/discord-client";
import { readPrivateJson, writePrivateJson } from "@oh-my-pi/pi-utils/discord-private-files";
import {
	commitDiscordDeletionEvent,
	discardDiscordDeletionEvent,
	prepareDiscordDeletionEvent,
	readDiscordDeletionEvents,
	withDiscordDeletionLock,
} from "../../src/discord-mode/retirement-events";
import { startDiscordModeServer } from "../../src/discord-mode/server";
import type {
	ChannelInspection,
	DiscordPort,
	DiscordPortHandlers,
	ModeControlRequest,
	ModeControlResult,
	ModeDialog,
	ModeDeletionBinding,
	ModeDeletionEvent,
	ModeRetirementPolicy,
	ModeLease,
	ModeRequest,
	ModeSnapshot,
	RemoteChannel,
} from "@oh-my-pi/pi-wire/discord-mode";

const config = { guildId: "100", ownerId: "200", botToken: "offline-fixture-only" };

/** Stateful offline Discord boundary: effects survive broker restarts, just like remote resources. */
class FixtureDiscord implements DiscordPort {
	handlers: DiscordPortHandlers | undefined;
	readonly channels = new Map<string, RemoteChannel>();
	readonly publications: Array<{ channelId: string; text: string; key: string }> = [];
	readonly cards = new Map<string, { id: string; text: string; connectionId?: string }>();
	readonly legacyCards = new Set<string>();
	readonly dialogs = new Map<string, ModeDialog>();
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
		this.channel(id).name = name;
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
		this.publications.push({ channelId, text, key });
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
		const card = { id: id ?? String(this.#next++), text, connectionId };
		if (!id) this.statusCreates++;
		this.cards.set(channelId, card);
		this.legacyCards.delete(channelId);
		const confirmation = this.nextStatusConfirmation;
		this.nextStatusConfirmation = undefined;
		if (confirmation === "lost") throw new Error("response lost after remote status publication");
		return confirmation === "invalid" ? "not-a-message-id" : card.id;
	}
	async showDialog(channelId: string, dialog: ModeDialog): Promise<void> {
		this.dialogs.set(channelId, structuredClone(dialog));
	}
	async endDialog(channelId: string, dialogId: string): Promise<void> {
		if (this.dialogs.get(channelId)?.id === dialogId) this.dialogs.delete(channelId);
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
			expect(port.channel(session.session.channelId!).name).toBe("archived-recover");
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
			expect(port.channel(channelId).name).toBe("archived-card-inspection");
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
			expect(port.channel(channelId).name).toBe("archived-missing-card");
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
			expect(port.publications.map(item => item.text)).toEqual([
				"actual result",
				"Cannot make that change.",
				"The requested review is complete.",
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
			expect([...port.cards.entries()]).toEqual(cards);
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
			expect(disconnected.text).toMatch(/\bDisconnected\b/);
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
