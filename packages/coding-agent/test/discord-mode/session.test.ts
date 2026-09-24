import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as discordConfig from "../../src/discord-mode/config";
import * as discordSessions from "../../src/discord-mode/session";
import { DiscordDialogs, raceDiscordDialog, requestDiscordAsk } from "../../src/discord-mode/dialog";
import {
	DiscordModeSession,
	DiscordReceiptJournal,
	type DiscordSessionClient,
	type DiscordSessionEngine,
} from "../../src/discord-mode/session";
import {
	DISCORD_MODE_MAX_REPLY,
	DISCORD_MODE_MAX_TEXT,
	type ModeDelivery,
	type ModeDialog,
	type ModeRequest,
	type ModeSession,
	type ModeSnapshot,
} from "@oh-my-pi/pi-wire/discord-mode";
import { DiscordModeRequestError } from "@oh-my-pi/pi-utils/discord-client";
import type { AgentSessionEvent } from "../../src/session/agent-session-events";
import { normalizeCustomMessagePayload } from "../../src/session/messages";
import { executeBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

interface FakeClock {
	advance(ms: number): void;
}

/** Reconnect backoff reads the monotonic clock; tests advance it explicitly instead of sleeping. */
function fakeClock(): FakeClock {
	let now = performance.now();
	vi.spyOn(performance, "now").mockImplementation(() => now);
	return {
		advance(ms) {
			now += ms;
		},
	};
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "private reasoning" },
			{ type: "text", text },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "fixture",
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-discord-session-"));
	cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
	const state = { id: crypto.randomUUID() as string, busy: false, admitted: false, queued: 0, aborts: 0 };
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const prompts: string[] = [];
	const customs: AgentMessage[] = [];
	const messages: AgentMessage[] = [];
	const requests: ModeRequest[] = [];
	const pending: ModeDelivery[] = [];
	const notices: string[] = [];
	const completed = Promise.withResolvers<Extract<ModeRequest, { op: "receipt" }>>();
	let pollGate: Promise<ModeSnapshot> | undefined;
	let statusDeliveries: ModeDelivery[] = [];
	let connects = 0;
	let connectFailure: Error | undefined;
	let forgotten = false;
	let snapshot: ModeSnapshot = {
		group: { id: crypto.randomUUID(), projectDir: root, name: "Project", state: "ready", categoryId: "100" },
		session: {
			id: state.id,
			groupId: "group",
			projectDir: root,
			sessionFile: path.join(root, "session.jsonl"),
			label: "Session",
			connectionId: "",
			enabled: true,
			connected: true,
			busy: false,
			pendingInput: false,
			state: "ready",
			channelId: "101",
		},
		peers: [],
		deliveries: [],
		answers: [],
		gatewayConnected: true,
	};
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const engine: DiscordSessionEngine = {
		get sessionFile() {
			return path.join(root, "session.jsonl");
		},
		get isStreaming() {
			return state.busy;
		},
		get hasAdmittedSubmission() {
			return state.admitted;
		},
		get queuedMessageCount() {
			return state.queued;
		},
		sessionManager: {
			getSessionId: () => state.id,
			getCwd: () => root,
			ensureOnDisk: async () => {},
			flush: async () => {},
		},
		subscribe: listener => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		promptCustomMessage: async payload => {
			const message: AgentMessage = { ...normalizeCustomMessagePayload(payload), role: "custom", timestamp: 1 };
			if (payload.attribution === "user") prompts.push(typeof payload.content === "string" ? payload.content : "");
			else customs.push(message);
			messages.push(message);
			state.busy = true;
			emit({ type: "message_start", message });
			return true;
		},
		abort: async () => {
			state.aborts++;
			state.busy = false;
		},
	};
	const client: DiscordSessionClient = {
		lookup: async () => (forgotten ? undefined : { group: snapshot.group, session: snapshot.session }),
		close: async () => {},
		request: async input => {
			requests.push(input);
			// Like the broker, a lease only authorizes the live connection generation.
			if (
				"lease" in input &&
				(!snapshot.session.connected || input.lease.connectionId !== snapshot.session.connectionId)
			)
				throw new DiscordModeRequestError(
					"unknown",
					"Session lease is invalid, expired, or revoked; reconnect explicitly. Discord mode did not confirm the result; outcome may be unknown. Inspect status before retrying.",
				);
			if (input.op === "register")
				snapshot = {
					...snapshot,
					session: { ...snapshot.session, id: input.sessionId, connectionId: input.connectionId, connected: true },
					lease: { sessionId: input.sessionId, connectionId: input.connectionId, token: "private-lease" },
				};
			if (input.op === "receipt" && input.state === "completed") completed.resolve(input);
			if (input.op === "poll" && pollGate) return pollGate;
			return {
				...snapshot,
				deliveries: input.op === "poll" ? pending.splice(0) : input.op === "status" ? statusDeliveries : [],
			};
		},
	};
	const mode = new DiscordModeSession(engine, {
		connect: async () => {
			connects++;
			if (connectFailure) throw connectFailure;
			return client;
		},
		receiptRoot: root,
		pollIntervalMs: 0,
		notify: text => notices.push(text),
	});
	cleanups.push(() => mode.off());
	return {
		root,
		state,
		engine,
		client,
		mode,
		prompts,
		customs,
		messages,
		requests,
		notices,
		completed: completed.promise,
		registers() {
			return requests.filter(
				(request): request is Extract<ModeRequest, { op: "register" }> => request.op === "register",
			);
		},
		connects() {
			return connects;
		},
		failConnect(error: Error | undefined) {
			connectFailure = error;
		},
		/** Broker-side session state as the next lookup, poll, or status sees it. */
		setSession(patch: Partial<ModeSession>) {
			snapshot = { ...snapshot, session: { ...snapshot.session, ...patch } };
		},
		/** Broker-advertised final-reply bound; old brokers omit it. */
		setMaxReply(maxReply: number | undefined) {
			snapshot = { ...snapshot, maxReply };
		},
		/** Broker state reset: the UUID is no longer enrolled. */
		forget() {
			forgotten = true;
		},
		async enroll() {
			await mode.on("Project", "Session");
		},
		delivery(overrides: Partial<ModeDelivery> = {}): ModeDelivery {
			return {
				id: crypto.randomUUID(),
				sessionId: state.id,
				from: "owner-id",
				source: "owner",
				kind: "message",
				text: "Run this task",
				state: "dispatched",
				createdAt: 1,
				...overrides,
			};
		},
		queue(delivery: ModeDelivery) {
			pending.push(delivery);
		},
		statusDeliveries(deliveries: ModeDelivery[]) {
			statusDeliveries = deliveries;
		},
		deferPoll(promise: Promise<ModeSnapshot>) {
			pollGate = promise;
		},
		snapshot() {
			return snapshot;
		},
		local(text: string) {
			const message: AgentMessage = { role: "user", content: text, timestamp: 2 };
			messages.push(message);
			emit({ type: "message_start", message });
		},
		finish(text: string) {
			const message = assistant(text);
			messages.push(message);
			state.busy = false;
			emit({ type: "message_end", message });
			emit({ type: "agent_end", messages, isTerminal: true });
		},
		remoteUnavailable() {
			snapshot = {
				...snapshot,
				gatewayConnected: false,
				group: { ...snapshot.group, state: "missing" },
				session: { ...snapshot.session, state: "missing" },
			};
		},
	};
}

test("reconnects a saved Discord binding without asking to name a new channel", async () => {
	const f = await fixture();
	await f.enroll();
	await f.mode.off();
	const reconnecting = new DiscordModeSession(f.engine, {
		connect: async () => f.client,
		receiptRoot: f.root,
		pollIntervalMs: 0,
	});
	cleanups.push(() => reconnecting.off());
	vi.spyOn(discordConfig, "loadDiscordModeConfig").mockResolvedValue({
		botToken: "offline-fixture-only",
		guildId: "100",
		ownerId: "200",
	});
	vi.spyOn(discordSessions, "ensureDiscordModeSession").mockReturnValue(reconnecting);
	const naming = vi.fn(async () => undefined);
	const errors: string[] = [];
	const ctx = createInteractiveModeContext({
		session: f.engine,
		sessionManager: f.engine.sessionManager,
		showHookEditor: naming,
		showError: message => errors.push(message),
	});
	await executeBuiltinSlashCommand("/discord on", { ctx });
	expect(errors).toEqual([]);
	expect(naming).not.toHaveBeenCalled();
	expect(reconnecting.enabled).toBe(true);
});

describe("native Discord session routing", () => {
	test("connection loss stays visible until a backed-off probe confirms the still-live lease", async () => {
		const clock = fakeClock();
		const f = await fixture();
		await f.enroll();
		const gate = Promise.withResolvers<ModeSnapshot>();
		f.deferPoll(gate.promise);
		const polling = f.mode.poll();
		gate.reject(new Error("Bridge connection lost"));
		await polling;
		expect(f.mode.enabled).toBe(true);
		expect(f.mode.presentation.state).toBe("disconnected");
		f.local("Unrelated local work");
		expect(f.mode.presentation.state).toBe("disconnected");

		f.deferPoll(
			Promise.resolve({
				...f.snapshot(),
				session: { ...f.snapshot().session, state: "missing" },
			}),
		);
		await f.mode.poll();
		expect(f.mode.presentation.state).toBe("disconnected");
		clock.advance(2_000);
		await f.mode.poll();
		// The lease never lapsed: recovery keeps it rather than revoking in-flight work with a new registration.
		expect(f.registers()).toHaveLength(1);
		expect(f.mode.presentation.state).toBe("connected");
		await f.mode.poll();
		expect(f.mode.presentation.state).toBe("repair");
		f.deferPoll(Promise.resolve(f.snapshot()));
		await f.mode.poll();
		expect(f.mode.presentation.state).toBe("connected");
		await f.mode.off();
		expect(f.mode.presentation.state).toBe("off");
	});

	test("publishes only the attributable owner final, never thinking", async () => {
		const f = await fixture();
		await f.enroll();
		const delivery = f.delivery();
		f.queue(delivery);
		await f.mode.poll();
		expect(f.prompts[0]).toContain(delivery.id);
		expect(f.prompts[0]).toContain("Discord owner owner-id");
		f.finish("Owner result");
		expect((await f.completed).text).toBe("Owner result");
	});

	test("a concurrent local user boundary suppresses automatic publication", async () => {
		const f = await fixture();
		await f.enroll();
		f.queue(f.delivery());
		await f.mode.poll();
		f.local("Unrelated private local task");
		f.finish("Private local answer");
		expect((await f.completed).text).toBeUndefined();
	});

	test("an older broker without maxReply keeps the 12000-byte bound without broken characters", async () => {
		const f = await fixture();
		await f.enroll();
		f.queue(f.delivery());
		await f.mode.poll();
		f.finish("界".repeat(DISCORD_MODE_MAX_TEXT));
		const result = (await f.completed).text!;
		expect(Buffer.byteLength(result)).toBeLessThanOrEqual(DISCORD_MODE_MAX_TEXT);
		expect(result).not.toContain("�");
		expect(result).toEndWith("[response truncated]");
	});

	test("a broker advertising maxReply receives long final output whole, bounded by this build", async () => {
		const f = await fixture();
		f.setMaxReply(DISCORD_MODE_MAX_REPLY * 4);
		await f.enroll();
		f.queue(f.delivery());
		await f.mode.poll();
		const long = "界".repeat(DISCORD_MODE_MAX_TEXT); // 36000 bytes: over the report bound, under maxReply
		f.finish(long);
		expect((await f.completed).text).toBe(long);

		const g = await fixture();
		g.setMaxReply(DISCORD_MODE_MAX_REPLY * 4);
		await g.enroll();
		g.queue(g.delivery());
		await g.mode.poll();
		g.finish("x".repeat(DISCORD_MODE_MAX_REPLY + 10));
		const bounded = (await g.completed).text!;
		expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(DISCORD_MODE_MAX_REPLY);
		expect(bounded).toEndWith("[response truncated]");
	});

	test("status and registration never execute broker-held queued work", async () => {
		const f = await fixture();
		await f.enroll();
		const delivery = f.delivery({ state: "queued" });
		f.statusDeliveries([delivery]);
		await f.mode.status();
		await f.mode.poll();
		expect(f.prompts).toEqual([]);
		f.queue({ ...delivery, state: "dispatched" });
		await f.mode.poll();
		expect(f.prompts).toHaveLength(1);
	});

	test("normal delivery waits for busy, admission, and native queue boundaries; explicit abort does not", async () => {
		const f = await fixture();
		await f.enroll();
		f.state.busy = true;
		f.state.queued = 1;
		f.queue(f.delivery());
		await f.mode.poll();
		expect(f.prompts).toEqual([]);
		f.queue(f.delivery({ kind: "abort", text: "abort" }));
		await f.mode.poll();
		expect(f.state.aborts).toBe(1);
		expect(f.prompts).toEqual([]);
		f.state.queued = 0;
		f.state.admitted = true;
		await f.mode.poll();
		expect(f.prompts).toEqual([]);
		f.state.admitted = false;
		await f.mode.poll();
		expect(f.prompts).toHaveLength(1);
	});

	test("poll stays single-flight while transport is waiting", async () => {
		const f = await fixture();
		await f.enroll();
		const gate = Promise.withResolvers<ModeSnapshot>();
		f.deferPoll(gate.promise);
		const first = f.mode.poll();
		await f.mode.poll();
		await f.mode.poll();
		expect(f.requests.filter(request => request.op === "poll")).toHaveLength(1);
		gate.resolve({ ...f.snapshot(), deliveries: [f.delivery()] });
		await first;
		expect(f.prompts).toHaveLength(1);
	});

	test("off invalidates an in-flight poll before a different identity can receive it", async () => {
		const f = await fixture();
		await f.enroll();
		const gate = Promise.withResolvers<ModeSnapshot>();
		f.deferPoll(gate.promise);
		const delivery = f.delivery();
		const polling = f.mode.poll();
		const off = f.mode.off();
		f.state.id = crypto.randomUUID();
		gate.resolve({ ...f.snapshot(), deliveries: [delivery] });
		await polling;
		await off;
		expect(f.prompts).toEqual([]);
		expect(f.state.aborts).toBe(0);
		expect(f.mode.enabled).toBe(false);
	});

	test("durable attempted delivery survives adapter recreation without reinjection", async () => {
		const f = await fixture();
		const delivery = f.delivery();
		const journal = new DiscordReceiptJournal(path.join(f.root, "receipts", `${f.state.id}.json`));
		await journal.load();
		await journal.save({ id: delivery.id, state: "attempted" });
		await f.enroll();
		f.queue(delivery);
		await f.mode.poll();
		expect(f.prompts).toEqual([]);
	});

	test("idle peers wake through custom data and never publish an unsolicited final", async () => {
		const f = await fixture();
		await f.enroll();
		f.queue(f.delivery({ source: "peer", from: "peer-session", text: "Review the result" }));
		await f.mode.poll();
		expect(f.prompts).toEqual([]);
		expect(f.state.busy).toBe(true);
		expect(f.customs[0]?.role).toBe("custom");
		f.finish("Peer response remains local unless explicitly reported");
		expect((await f.completed).text).toBeUndefined();
	});

	test("local peers remain usable when Discord resources disappear", async () => {
		const f = await fixture();
		await f.enroll();
		f.remoteUnavailable();
		f.queue(f.delivery());
		f.queue(f.delivery({ source: "peer", from: "peer-session" }));
		await f.mode.poll();
		expect(f.prompts).toEqual([]);
		expect(f.customs).toHaveLength(1);
		f.finish("Local peer final");
		expect((await f.completed).text).toBeUndefined();
	});
});

describe("native Discord lease reconnect", () => {
	/** First poll observes the lost lease; the next poll after the initial backoff reconnects. */
	async function reconnectAfterLoss(mode: DiscordModeSession, clock: FakeClock) {
		await mode.poll();
		expect(mode.presentation.state).toBe("disconnected");
		clock.advance(2_000);
		await mode.poll();
	}

	test("a lost lease re-registers the retained enrollment once and keeps local dialogs and intake", async () => {
		const clock = fakeClock();
		const f = await fixture();
		await f.enroll();
		const endDialog = f.mode.beginLocalDialog();
		f.setSession({ connected: false, label: "Renamed in Discord" });
		await reconnectAfterLoss(f.mode, clock);
		const [enrolled, reconnected] = f.registers();
		expect(f.registers()).toHaveLength(2);
		// Retained names from lookup: the broker reuses the existing channel; nothing asks for a new one.
		expect(reconnected).toMatchObject({ sessionId: f.state.id, label: "Renamed in Discord", groupName: "Project" });
		expect(reconnected!.connectionId).not.toBe(enrolled!.connectionId);
		expect(f.mode.enabled).toBe(true);
		expect(f.mode.presentation.state).toBe("connected");
		expect(f.mode.pendingInput).toBe(true);
		expect(f.notices).toEqual([]);

		await f.mode.poll();
		expect(f.requests.filter(request => request.op === "poll").at(-1)).toMatchObject({
			lease: { connectionId: reconnected!.connectionId },
			pendingInput: true,
		});
		endDialog();
		expect(f.mode.pendingInput).toBe(false);
		f.queue(f.delivery());
		await f.mode.poll();
		expect(f.prompts).toHaveLength(1);
	});

	test("a forgotten enrollment is never registered again, which would create a new channel", async () => {
		const clock = fakeClock();
		const f = await fixture();
		await f.enroll();
		f.setSession({ connected: false });
		f.forget();
		await reconnectAfterLoss(f.mode, clock);
		expect(f.registers()).toHaveLength(1);
		expect(f.mode.enabled).toBe(true);
		expect(f.mode.presentation.state).toBe("disconnected");
		expect(f.notices).toHaveLength(1);
		clock.advance(60_000);
		await f.mode.poll();
		expect(f.connects()).toBe(2);
		expect(f.registers()).toHaveLength(1);
	});

	test("a foreign live connection is never displaced", async () => {
		const clock = fakeClock();
		const f = await fixture();
		await f.enroll();
		f.setSession({ connectionId: crypto.randomUUID() });
		await reconnectAfterLoss(f.mode, clock);
		expect(f.registers()).toHaveLength(1);
		expect(f.mode.enabled).toBe(true);
		expect(f.mode.presentation.state).toBe("disconnected");
		expect(f.notices).toHaveLength(1);
		clock.advance(60_000);
		await f.mode.poll();
		expect(f.connects()).toBe(2);
		expect(f.registers()).toHaveLength(1);
	});

	test("a retired conversation turns Discord off instead of reconnecting", async () => {
		const clock = fakeClock();
		const f = await fixture();
		await f.enroll();
		f.setSession({
			connected: false,
			retirement: { eventId: crypto.randomUUID(), policy: "retain", deletedAt: 1, state: "done" },
		});
		await reconnectAfterLoss(f.mode, clock);
		expect(f.registers()).toHaveLength(1);
		expect(f.mode.enabled).toBe(false);
		expect(f.mode.presentation.state).toBe("off");
	});

	test("held and uncertain work after reconnect is reported once and never resumed", async () => {
		const clock = fakeClock();
		const f = await fixture();
		await f.enroll();
		const running = f.delivery();
		f.queue(running);
		await f.mode.poll();
		expect(f.prompts).toHaveLength(1);
		// Dispatched while the engine is busy, so it waits locally behind the running turn.
		const waiting = f.delivery();
		f.queue(waiting);
		await f.mode.poll();
		// Revocation made both dispatched deliveries unknown and held a queued message.
		f.setSession({ connected: false });
		f.statusDeliveries([
			{ ...running, state: "unknown" },
			{ ...waiting, state: "unknown" },
			f.delivery({ state: "queued" }),
		]);
		await reconnectAfterLoss(f.mode, clock);
		expect(f.registers()).toHaveLength(2);
		expect(f.notices).toHaveLength(1);
		expect(f.notices[0]).toMatch(/\b3\b/);
		expect(f.mode.presentation.state).toBe("held");

		// The old-generation turn still finishes locally but is never published, and waiting work never runs.
		f.finish("Late result");
		await f.mode.poll();
		await f.mode.poll();
		expect(f.requests.filter(request => request.op === "receipt" && request.state === "completed")).toEqual([]);
		expect(f.requests.some(request => request.op === "repair")).toBe(false);
		expect(f.prompts).toHaveLength(1);
		expect(f.notices).toHaveLength(1);
	});

	test("transport failures back off exponentially, register once, and reset the backoff on success", async () => {
		const clock = fakeClock();
		const f = await fixture();
		await f.enroll();
		f.setSession({ connected: false });
		f.failConnect(
			new DiscordModeRequestError(
				"not-started",
				"Discord mode socket is unavailable or unsafe; the request was not sent.",
			),
		);
		await f.mode.poll();
		const attempts: number[] = [];
		for (const step of [1_999, 1, 1_000, 3_000, 7_999, 1]) {
			clock.advance(step);
			await f.mode.poll();
			attempts.push(f.connects());
		}
		// Enrollment connected once; retries land at 2s, then 4s and 8s after each failure.
		expect(attempts).toEqual([1, 2, 2, 3, 3, 4]);
		// The dead lease is not polled while a reconnect is pending.
		expect(f.requests.filter(request => request.op === "poll")).toHaveLength(1);
		f.failConnect(undefined);
		clock.advance(15_999);
		await f.mode.poll();
		expect(f.registers()).toHaveLength(1);
		clock.advance(1);
		await f.mode.poll();
		expect(f.registers()).toHaveLength(2);
		await f.mode.poll();
		expect(f.mode.presentation.state).toBe("connected");

		f.setSession({ connected: false });
		await reconnectAfterLoss(f.mode, clock);
		expect(f.registers()).toHaveLength(3);
	});
});

describe("native Discord dialog races", () => {
	test("local answer closes the remote presentation; stale answer cannot affect a later dialog", async () => {
		const published: ModeDialog[] = [];
		const ended: string[] = [];
		const dialogs = new DiscordDialogs(
			async dialog => {
				published.push(dialog);
			},
			async id => {
				ended.push(id);
			},
			() => {},
		);
		const local = Promise.withResolvers<string | boolean | undefined>();
		const winner = raceDiscordDialog(
			signal => dialogs.request({ kind: "input", title: "First" }, signal),
			async () => local.promise,
		);
		const oldId = published[0]!.id;
		local.resolve("local answer");
		expect(await winner).toBe("local answer");
		const second = dialogs.request({ kind: "input", title: "Second" });
		dialogs.answer({ id: oldId, value: "stale", cancelled: false });
		dialogs.answer({ id: published[1]!.id, value: "new answer", cancelled: false });
		expect(await second).toEqual({ kind: "answered", value: "new answer" });
		await Promise.resolve();
		expect(ended).toContain(oldId);
	});

	test("remote answer cancels local input but disconnection leaves local input available", async () => {
		const published: ModeDialog[] = [];
		const dialogs = new DiscordDialogs(
			async dialog => {
				published.push(dialog);
			},
			async () => {},
			() => {},
		);
		const local = Promise.withResolvers<string | boolean | undefined>();
		let aborted = false;
		const winner = raceDiscordDialog(
			signal => dialogs.request({ kind: "confirm", title: "Approve?" }, signal),
			signal => {
				signal.addEventListener(
					"abort",
					() => {
						aborted = true;
					},
					{ once: true },
				);
				return local.promise;
			},
		);
		dialogs.answer({ id: published[0]!.id, value: false, cancelled: false });
		expect(await winner).toBe(false);
		expect(aborted).toBe(true);
		const stillLocal = Promise.withResolvers<string | boolean | undefined>();
		const unavailable = raceDiscordDialog(
			signal => dialogs.request({ kind: "input", title: "Local remains" }, signal),
			async () => stillLocal.promise,
		);
		dialogs.unavailable();
		stillLocal.resolve("local survives transport loss");
		expect(await unavailable).toBe("local survives transport loss");
	});

	test("structured asks preserve labels that collide with control wording and full option descriptions", async () => {
		const drafts: Array<Omit<ModeDialog, "id">> = [];
		const result = await requestDiscordAsk(
			[
				{
					id: "choice",
					question: "Choose",
					options: [
						{ label: "Chat about this", description: "Full approval consequence", preview: "Complete preview" },
					],
				},
			],
			async draft => {
				drafts.push(draft);
				return {
					kind: "answered",
					value:
						drafts.length === 1 ? draft.options![0] : draft.options!.find(option => option.startsWith("[next]")),
				};
			},
			new AbortController().signal,
		);
		expect(drafts[0]!.options![0]).toContain("Full approval consequence\nComplete preview");
		expect(result).toMatchObject({
			kind: "answered",
			value: { kind: "submit", results: [{ selectedOptions: ["Chat about this"] }] },
		});
	});
});
