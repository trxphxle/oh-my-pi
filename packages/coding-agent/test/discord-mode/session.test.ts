import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as discordClient from "../../src/discord-mode/client";
import * as discordConfig from "../../src/discord-mode/config";
import * as retirementEvents from "../../src/discord-mode/retirement-events";
import * as discordSessions from "../../src/discord-mode/session";
import { DiscordDialogs, raceDiscordDialog, requestDiscordAsk } from "../../src/discord-mode/dialog";
import {
	DiscordModeSession,
	DiscordReceiptJournal,
	type DiscordSavedDecision,
	type DiscordSessionClient,
	type DiscordSessionEngine,
	type DiscordSessionOptions,
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
import { type DiscordModeClient, DiscordModeRequestError } from "@oh-my-pi/pi-utils/discord-client";
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
function fakeClock(start = performance.now()): FakeClock {
	let now = start;
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

async function fixture(
	options: {
		rejoinRetryMs?: number;
		offerSaved?: DiscordSessionOptions["offerSaved"];
		background?: DiscordSessionOptions["background"];
	} = {},
) {
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
	/** Offline state.json view: whether this conversation is listed as shared. */
	let sharedOffline = false;
	/** A broker from before `detach`, `disable`, and `rejoin`. */
	let legacy = false;
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
		waitForSessionTransition: async () => {},
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
			if (input.op === "register") {
				if (input.rejoin && legacy)
					throw new DiscordModeRequestError(
						"unknown",
						"Invalid Discord request: check operation, UUIDs, absolute paths, text/byte limits, and allowed fields. Discord mode did not confirm the result; outcome may be unknown. Inspect status before retrying.",
					);
				if (input.rejoin && (forgotten || !snapshot.session.enabled))
					throw new DiscordModeRequestError(
						"unknown",
						"Sharing is off or unknown for this conversation; automatic rejoin skipped. Discord mode did not confirm the result; outcome may be unknown. Inspect status before retrying.",
					);
				snapshot = {
					...snapshot,
					session: {
						...snapshot.session,
						id: input.sessionId,
						connectionId: input.connectionId,
						enabled: true,
						connected: true,
					},
					lease: { sessionId: input.sessionId, connectionId: input.connectionId, token: "private-lease" },
				};
			}
			if (legacy && (input.op === "detach" || input.op === "disable"))
				throw new DiscordModeRequestError(
					"not-started",
					"Discord mode rejected the request before execution (authentication, protocol, readiness, or capacity).",
				);
			// Like the broker: detach keeps sharing; off and disable turn it off.
			if (input.op === "detach" || input.op === "off" || input.op === "disable")
				snapshot = {
					...snapshot,
					session: { ...snapshot.session, connected: false, ...(input.op === "detach" ? {} : { enabled: false }) },
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
		shared: async () => sharedOffline,
		rejoinRetryMs: options.rejoinRetryMs,
		offerSaved: options.offerSaved,
		background: options.background,
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
		/** Broker-held settings revision; brokers without settings support omit it. */
		setSettingsRevision(settingsRevision: string | undefined) {
			snapshot = { ...snapshot, settingsRevision };
		},
		/** Broker progress capability; older brokers omit it. */
		setProgressCapability(progress: true | undefined) {
			snapshot = { ...snapshot, progress };
		},
		/** Broker-level snapshot fields as the next response carries them (capabilities, step-aside). */
		setBroker(patch: Partial<Pick<ModeSnapshot, "background" | "stepAside" | "wait">>) {
			snapshot = { ...snapshot, ...patch };
		},
		emit,
		/** Broker state reset: the UUID is no longer enrolled. */
		forget() {
			forgotten = true;
		},
		/** Saved broker state lists this conversation as shared (the offline pre-gate). */
		share(value = true) {
			sharedOffline = value;
		},
		legacyBroker() {
			legacy = true;
		},
		ops() {
			return requests.map(request => request.op);
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
		finish(text: string, failure?: string) {
			const message: AssistantMessage = failure
				? { ...assistant(text), stopReason: "error", errorMessage: failure }
				: assistant(text);
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

	test("a provider error answers the owner with the error line instead of leaving the channel silent", async () => {
		const f = await fixture();
		await f.enroll();
		f.queue(f.delivery());
		await f.mode.poll();
		f.finish("partial draft", "Codex error event: The usage limit has been reached\ninternal detail");
		const text = (await f.completed).text!;
		expect(text).toContain("The usage limit has been reached");
		expect(text).not.toContain("internal detail");
		expect(text).not.toContain("partial draft");
		expect(text).not.toContain("private reasoning");
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

	test("settings ride polls only to brokers advertising them, and the view only when its revision changed", async () => {
		// At this start, `(start + 5000) - start` rounds to 4999.999…: the view cache must expire by its deadline anyway.
		const clock = fakeClock(3192.3);
		const f = await fixture();
		let effort = "high";
		const mode = new DiscordModeSession(f.engine, {
			connect: async () => f.client,
			receiptRoot: f.root,
			pollIntervalMs: 0,
			settings: {
				view: () => ({
					model: { selector: "provider/model", name: "Model", efforts: ["off", "low", "high"] },
					effort,
					capabilities: { persist: true, compact: true, advisor: true, plan: true },
					shortlist: [],
					models: [],
				}),
				usage: () => ({ tokens: 1_000, contextWindow: 10_000, percent: 10 }),
				apply: async () => ({ outcome: "applied", text: "Applied." }),
			},
		});
		cleanups.push(() => mode.off());
		await mode.on("Project", "Session");
		const polls = () =>
			f.requests.filter((request): request is Extract<ModeRequest, { op: "poll" }> => request.op === "poll");
		await mode.poll();
		// An older broker rejects unknown poll fields, so it never receives them.
		f.setSettingsRevision("");
		await mode.poll();
		expect(polls().map(request => "settings" in request || "usage" in request)).toEqual([false, false]);
		await mode.poll();
		const reported = polls().at(-1)!;
		expect(reported.settings).toMatchObject({ effort: "high" });
		expect(reported.usage).toEqual({ tokens: 1_000, contextWindow: 10_000, percent: 10 });
		// The broker stored it; once its answer carries that revision, the view stops riding along.
		f.setSettingsRevision(reported.settings!.revision);
		await mode.poll();
		await mode.poll();
		expect(polls().at(-1)).not.toHaveProperty("settings");
		expect(polls().at(-1)!.usage).toBeDefined();
		effort = "low";
		clock.advance(5_000);
		await mode.poll();
		expect(polls().at(-1)!.settings).toMatchObject({ effort: "low" });
		expect(polls().at(-1)!.settings!.revision).not.toBe(reported.settings!.revision);
	});

	test("run progress rides polls only to brokers advertising it, and only while a run is active", async () => {
		const f = await fixture();
		await f.enroll();
		const polls = () =>
			f.requests.filter((request): request is Extract<ModeRequest, { op: "poll" }> => request.op === "poll");
		f.emit({ type: "agent_start" });
		f.emit({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "API_KEY=secret bun test --token secret" },
			intent: "Running the secret tests",
		});
		f.emit({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "secret output" }], details: {} },
			isError: false,
		});
		// An older broker rejects unknown poll fields, so it never receives progress.
		await f.mode.poll();
		expect(polls().at(-1)).not.toHaveProperty("progress");
		f.setProgressCapability(true);
		await f.mode.poll();
		await f.mode.poll();
		const reported = polls().at(-1)!;
		expect(reported.progress).toMatchObject({
			phase: "thinking",
			files: 0,
			last: { label: "bun test", outcome: "pass" },
		});
		expect(JSON.stringify(reported.progress)).not.toContain("secret");
		f.emit({ type: "agent_end", messages: [], isTerminal: true });
		await f.mode.poll();
		expect(polls().at(-1)).not.toHaveProperty("progress");
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

/**
 * Automatic rejoins run detached from their trigger (after a transition settles, or a lease-expiry retry) and cross
 * real filesystem I/O, so fake timers cannot drive them; poll for the observable end state instead of a fixed delay.
 */
async function until(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 400 && !condition(); attempt++) await Bun.sleep(5);
	expect(condition()).toBe(true);
}

describe("remembered Discord sharing", () => {
	test("closing keeps the conversation shared; an older broker without detach gets its previous off", async () => {
		const f = await fixture();
		await f.enroll();
		await f.mode.detach();
		expect(f.ops().at(-1)).toBe("detach");
		expect(f.snapshot().session).toMatchObject({ enabled: true, connected: false });
		expect(f.mode.enabled).toBe(false);

		const legacy = await fixture();
		legacy.legacyBroker();
		await legacy.enroll();
		await legacy.mode.detach();
		expect(legacy.ops().slice(-2)).toEqual(["detach", "off"]);
		expect(legacy.snapshot().session.enabled).toBe(false);
	});

	test("explicit off is sticky, uses the lease when attached, and works by identity when not", async () => {
		const f = await fixture();
		// Never shared: nothing to turn off, and the broker is not even contacted.
		await f.mode.off();
		expect(f.connects()).toBe(0);
		await f.enroll();
		await f.mode.off();
		expect(f.ops().slice(-1)).toEqual(["off"]);
		await f.enroll();
		await f.mode.detach();
		f.share();
		await f.mode.off();
		expect(f.requests.at(-1)).toEqual({
			op: "disable",
			sessionId: f.state.id,
			sessionFile: path.join(f.root, "session.jsonl"),
			projectDir: await fs.realpath(f.root),
		});
		expect(f.snapshot().session.enabled).toBe(false);
		expect(await f.mode.rejoin()).toBeUndefined();
		expect(f.registers()).toHaveLength(2);
	});

	test("rejoin reattaches the same still-shared conversation to its channel without naming or enrolling", async () => {
		const f = await fixture();
		await f.enroll();
		await f.mode.detach();
		const rejoined = await f.mode.rejoin();
		expect(rejoined?.session.channelId).toBe("101");
		expect(f.registers()).toHaveLength(2);
		expect(f.registers()[1]).toMatchObject({
			rejoin: true,
			sessionId: f.state.id,
			label: "Session",
			groupName: "Project",
		});
		expect(f.mode.enabled).toBe(true);
		expect(f.mode.presentation.footer).toContain("Rejoined");
		expect(f.notices).toEqual([]);
		// The marker lasts until local activity.
		f.local("local work");
		expect(f.mode.presentation.footer).not.toContain("Rejoined");
	});

	test.each<[string, Partial<ModeSession> | undefined]>([
		["turned off", { enabled: false }],
		["deleted", { retirement: { eventId: crypto.randomUUID(), policy: "retain", deletedAt: 1, state: "done" } }],
		["bound to another file", { sessionFile: path.join(os.tmpdir(), "other-session.jsonl") }],
		["unknown to the broker", undefined],
	])("a conversation %s never rejoins", async (_name, patch) => {
		const f = await fixture();
		await f.enroll();
		await f.mode.detach();
		if (patch) f.setSession(patch);
		else f.forget();
		expect(await f.mode.rejoin()).toBeUndefined();
		expect(f.registers()).toHaveLength(1);
		expect(f.notices).toEqual([]);
		expect(f.mode.presentation.state).toBe("off");
	});

	test("a live lease elsewhere is retried once after it could expire, then reported instead of displaced", async () => {
		const f = await fixture({ rejoinRetryMs: 1 });
		await f.enroll();
		await f.mode.detach();
		f.setSession({ connected: true, connectionId: crypto.randomUUID() });
		expect(await f.mode.rejoin()).toBeUndefined();
		expect(f.mode.presentation.footer).toBe("[Discord · REJOINING]");
		await until(() => f.notices.length > 0);
		expect(f.notices).toEqual([expect.stringContaining("open in another window")]);
		expect(f.registers()).toHaveLength(1);
		expect(f.mode.presentation.state).toBe("off");
		f.setSession({ connected: false });
		expect((await f.mode.rejoin())?.session.connected).toBe(true);
		expect(f.registers()).toHaveLength(2);
	});

	test("a rejoin offers saved owner messages, never dispatches them, and sends the owner's decisions", async () => {
		const offered: ModeDelivery[][] = [];
		let pendingDuringOffer: boolean | undefined;
		let decide: (messages: ModeDelivery[]) => DiscordSavedDecision[] | undefined = () => undefined;
		const f = await fixture({
			offerSaved: async messages => {
				offered.push(messages);
				pendingDuringOffer = f.mode.pendingInput;
				return decide(messages);
			},
		});
		await f.enroll();
		await f.mode.detach();
		const first = f.delivery({ state: "queued", held: true, text: "first saved" });
		const second = f.delivery({ state: "queued", held: true, text: "second saved" });
		const uncertain = f.delivery({ state: "unknown", text: "maybe ran" });
		f.statusDeliveries([first, second, uncertain, f.delivery({ state: "queued", held: false, text: "live" })]);
		decide = messages => [
			{ id: messages[1]!.id, action: "discard" },
			{ id: messages[0]!.id, action: "send" },
		];
		expect((await f.mode.rejoin())?.session.connected).toBe(true);
		await until(() => f.ops().filter(op => op === "held").length === 2);
		expect(offered).toEqual([[first, second]]);
		// The offer is a local dialog: nothing dispatches while the owner decides.
		expect(pendingDuringOffer).toBe(true);
		expect(f.mode.pendingInput).toBe(false);
		const held = f.requests.filter(
			(request): request is Extract<ModeRequest, { op: "held" }> => request.op === "held",
		);
		expect(held.map(({ action, deliveryIds }) => ({ action, deliveryIds }))).toEqual([
			{ action: "discard", deliveryIds: [second.id] },
			{ action: "send", deliveryIds: [first.id] },
		]);
		// Only uncertain work still points at repair/reconcile.
		expect(f.notices).toEqual([expect.stringContaining("1 held or uncertain message(s)")]);

		// Declining leaves them saved; /discord offers them again later.
		decide = () => undefined;
		f.statusDeliveries([first]);
		expect(await f.mode.reviewSaved()).toBe(1);
		expect(offered).toHaveLength(2);
		expect(f.ops().filter(op => op === "held")).toHaveLength(2);
	});

	test("an unexpected rejoin failure notifies once; sharing turned off in the meantime stays quiet", async () => {
		const legacy = await fixture();
		await legacy.enroll();
		await legacy.mode.detach();
		// A broker from before `rejoin` refuses the flag unexecuted: fail closed, never a plain re-enable.
		legacy.legacyBroker();
		expect(await legacy.mode.rejoin()).toBeUndefined();
		expect(legacy.notices).toEqual([expect.stringContaining("couldn't rejoin #Session")]);
		expect(legacy.mode.enabled).toBe(false);

		const f = await fixture();
		await f.enroll();
		await f.mode.detach();
		const request = f.client.request;
		vi.spyOn(f.client, "request").mockImplementation(async input => {
			// Turned off in another window between the lookup and the register.
			if (input.op === "register") f.setSession({ enabled: false });
			return request(input);
		});
		expect(await f.mode.rejoin()).toBeUndefined();
		expect(f.notices).toEqual([]);
		expect(f.mode.enabled).toBe(false);
	});
});

describe("automatic Discord rejoin hosts", () => {
	test("interactive hosts rejoin shared conversations at start and after transitions; other hosts never join", async () => {
		const f = await fixture();
		const previousRoot = process.env.OMP_DISCORD_MODE_ROOT;
		process.env.OMP_DISCORD_MODE_ROOT = f.root;
		cleanups.push(async () => {
			if (previousRoot === undefined) delete process.env.OMP_DISCORD_MODE_ROOT;
			else process.env.OMP_DISCORD_MODE_ROOT = previousRoot;
		});
		const sharedId = f.state.id;
		const canonicalRoot = await fs.realpath(f.root);
		vi.spyOn(discordConfig, "loadDiscordModeConfig").mockResolvedValue({
			botToken: "offline-fixture-only",
			guildId: "100",
			ownerId: "200",
		});
		const shared = vi.spyOn(retirementEvents, "readDiscordSharedSessions").mockResolvedValue([
			{
				sessionId: sharedId,
				sessionFile: path.join(canonicalRoot, "session.jsonl"),
				projectDir: canonicalRoot,
				label: "Session",
				guildId: "100",
				ownerId: "200",
			},
		]);
		const connect = vi
			.spyOn(discordClient, "connectDiscordMode")
			.mockResolvedValue(f.client as unknown as DiscordModeClient);
		// The live AgentSession object the TUI hands to transitions and dispose; a rejoin is scheduled on its transition.
		const engine: DiscordSessionEngine = Object.create(f.engine);
		const transitions = vi.fn(async () => {});
		engine.waitForSessionTransition = transitions;
		// Shared, and closed by its previous process.
		f.setSession({ connected: false });

		// RPC, print, and ACP register no host: a transition schedules no rejoin at all.
		await discordSessions.invalidateDiscordModeSession(engine);
		expect(transitions).not.toHaveBeenCalled();
		expect(connect).not.toHaveBeenCalled();

		const footers: Array<string | undefined> = [];
		const warnings: string[] = [];
		const ctx = createInteractiveModeContext({
			session: engine,
			sessionManager: f.engine.sessionManager,
			setHookStatus: (_key: string, text: string | undefined) => footers.push(text),
			showWarning: (message: string) => warnings.push(message),
		});
		discordSessions.startDiscordModeAutoRejoin(ctx);
		await until(() => discordSessions.getDiscordModeSession(engine)?.enabled === true);
		expect(f.registers()).toEqual([expect.objectContaining({ rejoin: true, sessionId: sharedId })]);
		expect(footers.at(-1)).toContain("Rejoined");

		// Switching to a conversation that was never shared detaches the old one, which stays shared, and the
		// offline gate keeps the broker out of it.
		const connections = connect.mock.calls.length;
		f.state.id = crypto.randomUUID();
		await discordSessions.invalidateDiscordModeSession(engine);
		expect(f.ops().at(-1)).toBe("detach");
		expect(f.snapshot().session).toMatchObject({ enabled: true, connected: false });
		await until(() => shared.mock.calls.length === 2);
		expect(connect).toHaveBeenCalledTimes(connections);
		expect(f.registers()).toHaveLength(1);

		// Back to the shared one: it rejoins its channel.
		f.state.id = sharedId;
		await discordSessions.invalidateDiscordModeSession(engine);
		await until(() => discordSessions.getDiscordModeSession(engine)?.enabled === true);
		expect(f.registers()).toHaveLength(2);

		// Exit keeps sharing and forgets the host, so nothing joins afterwards.
		await discordSessions.disposeDiscordModeSession(engine);
		expect(f.ops().at(-1)).toBe("detach");
		expect(f.snapshot().session).toMatchObject({ enabled: true, connected: false });
		const scheduled = transitions.mock.calls.length;
		await discordSessions.invalidateDiscordModeSession(engine);
		expect(transitions).toHaveBeenCalledTimes(scheduled);
		expect(warnings).toEqual([]);

		// A moved conversation stops sharing for good, even with nothing attached.
		await discordSessions.offDiscordModeSession(engine);
		expect(f.requests.at(-1)).toMatchObject({ op: "disable", sessionId: sharedId });
		expect(f.snapshot().session.enabled).toBe(false);
	});
});

describe("background copies and the exit question", () => {
	test("a background copy marks every registration and claims its launch only once", async () => {
		const clock = fakeClock();
		const launchId = crypto.randomUUID();
		const f = await fixture({ background: { launchId, release: () => {} } });
		await f.enroll();
		// The broker lost the lease (a restart); the copy re-registers on its own.
		f.setSession({ connected: false });
		await f.mode.poll();
		clock.advance(2_000);
		await f.mode.poll();
		const [first, second] = f.registers();
		expect(first).toMatchObject({ launchId, host: "background" });
		expect(second).toMatchObject({ host: "background" });
		expect(second).not.toHaveProperty("launchId");
		expect(f.mode.enabled).toBe(true);
	});

	test("a copy asked to step aside leaves once, at an idle point, after the work it already received", async () => {
		let released = 0;
		const f = await fixture({
			background: {
				release: () => {
					released++;
				},
			},
		});
		await f.enroll();
		f.setBroker({ stepAside: true });
		f.state.busy = true;
		await f.mode.poll();
		expect(released).toBe(0);
		f.state.busy = false;
		f.queue(f.delivery({ text: "Dispatched before the close" }));
		await f.mode.poll();
		expect(f.prompts).toHaveLength(1);
		expect(released).toBe(0);
		f.finish("Done.");
		await f.completed;
		await f.mode.poll();
		await f.mode.poll();
		expect(released).toBe(1);
	});

	test("a terminal never leaves on a step-aside flag", async () => {
		const f = await fixture();
		await f.enroll();
		f.setBroker({ stepAside: true });
		await f.mode.poll();
		expect(f.mode.enabled).toBe(true);
	});

	test("the exit question is offered to an attached terminal whose service can run it; Yes hands it over", async () => {
		const f = await fixture();
		const offers = discordSessions.offersDiscordBackground;
		expect(offers(f.mode, false)).toBe(false);
		await f.enroll();
		expect(offers(f.mode, false)).toBe(false);
		f.setBroker({ background: true });
		await f.mode.poll();
		expect(offers(f.mode, false)).toBe(true);
		expect(offers(f.mode, true)).toBe(false);
		const answers: Array<string | undefined> = [undefined, "No", "Yes"];
		const asked: Array<{ title: string; pending: boolean }> = [];
		const warnings: string[] = [];
		const ctx = createInteractiveModeContext({
			showHookSelector: async (title: string) => {
				asked.push({ title, pending: f.mode.pendingInput });
				return answers.shift();
			},
			showWarning: (text: string) => warnings.push(text),
		});
		// Dismissed: the terminal stays open and attached.
		expect(await discordSessions.confirmDiscordExit(ctx, f.mode)).toBe(false);
		expect(f.mode.enabled).toBe(true);
		// No: closes as before, nothing is started.
		expect(await discordSessions.confirmDiscordExit(ctx, f.mode)).toBe(true);
		expect(f.ops()).not.toContain("background");
		expect(f.mode.enabled).toBe(true);
		// Yes: the broker starts the copy and this terminal lets go of the conversation.
		expect(await discordSessions.confirmDiscordExit(ctx, f.mode)).toBe(true);
		expect(f.ops().filter(op => op === "background")).toHaveLength(1);
		expect(f.ops()).not.toContain("detach");
		expect(f.mode.enabled).toBe(false);
		expect(asked).toEqual(
			Array.from({ length: 3 }, () => ({ title: "Keep running in the background?", pending: true })),
		);
		expect(warnings).toEqual([]);
		// Nothing left to hand over: no question.
		expect(await discordSessions.confirmDiscordExit(ctx, f.mode)).toBe(true);
		expect(asked).toHaveLength(3);
	});

	test("a refused hand-over warns, closes as before, and keeps the terminal attached until then", async () => {
		const f = await fixture();
		await f.enroll();
		f.setBroker({ background: true });
		await f.mode.poll();
		const request = f.client.request;
		f.client.request = async input =>
			input.op === "background"
				? Promise.reject(new Error("4 conversations are already running in the background."))
				: request(input);
		const warnings: string[] = [];
		const ctx = createInteractiveModeContext({
			showHookSelector: async () => "Yes",
			showWarning: (text: string) => warnings.push(text),
		});
		expect(await discordSessions.confirmDiscordExit(ctx, f.mode)).toBe(true);
		expect(f.mode.enabled).toBe(true);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("already running in the background");
	});
});

describe("push waits instead of one-second polling", () => {
	/** A broker `/wait`: parks until `wake`, the timeout, or the caller's abort. */
	function waitingClient(base: DiscordSessionClient) {
		const waits: number[] = [];
		let wake: ((ready: boolean) => void) | undefined;
		const client: DiscordSessionClient = {
			...base,
			wait: async (_lease, timeoutMs, signal) => {
				waits.push(timeoutMs);
				const { promise, resolve } = Promise.withResolvers<boolean>();
				wake = resolve;
				const timer = setTimeout(() => resolve(false), timeoutMs);
				signal?.addEventListener("abort", () => resolve(false), { once: true });
				try {
					return await promise;
				} finally {
					clearTimeout(timer);
				}
			},
		};
		return { client, waits, wake: () => wake?.(true) };
	}

	async function looping(engine: DiscordSessionEngine, root: string, client: DiscordSessionClient) {
		const mode = new DiscordModeSession(engine, {
			connect: async () => client,
			receiptRoot: root,
			pollIntervalMs: 5,
			waitMs: 60_000,
		});
		cleanups.push(() => mode.off());
		await mode.on("Project", "Session");
		return mode;
	}

	const polls = (requests: ModeRequest[]) =>
		requests.filter((request): request is Extract<ModeRequest, { op: "poll" }> => request.op === "poll");

	// The loop under test is driven by its own timers; short real waits keep this an honest end-to-end check.
	test("an idle session parks on the broker instead of polling every interval", async () => {
		const legacy = await fixture();
		await looping(legacy.engine, legacy.root, waitingClient(legacy.client).client);
		await until(() => polls(legacy.requests).length >= 10);

		const f = await fixture();
		f.setBroker({ wait: true });
		const broker = waitingClient(f.client);
		await looping(f.engine, f.root, broker.client);
		await until(() => broker.waits.length === 1);
		expect(broker.waits).toEqual([60_000]);
		const parkedAt = polls(f.requests).length;
		await Bun.sleep(100);
		// The same idle stretch that cost the older broker 10+ polls costs none here.
		expect(polls(f.requests).length).toBe(parkedAt);
		expect(parkedAt).toBeLessThanOrEqual(2);
	});

	test("broker work wakes the wait and the next poll picks it up", async () => {
		const f = await fixture();
		f.setBroker({ wait: true });
		const broker = waitingClient(f.client);
		await looping(f.engine, f.root, broker.client);
		await until(() => broker.waits.length === 1);
		f.queue(f.delivery({ text: "from Discord" }));
		broker.wake();
		await until(() => f.prompts.length === 1);
		expect(f.prompts[0]).toContain("from Discord");
	});

	test("a local state change ends the wait so the broker hears it at once", async () => {
		const f = await fixture();
		f.setBroker({ wait: true });
		const broker = waitingClient(f.client);
		await looping(f.engine, f.root, broker.client);
		await until(() => broker.waits.length === 1);
		expect(polls(f.requests).at(-1)?.busy).toBe(false);
		f.state.busy = true;
		await until(() => polls(f.requests).at(-1)?.busy === true);
		// Busy is reported now; the session parks again until something else changes.
		await until(() => broker.waits.length === 2);
	});

	test("a wait failure falls back to polling at the normal interval", async () => {
		const f = await fixture();
		f.setBroker({ wait: true });
		let failures = 0;
		await looping(f.engine, f.root, {
			...f.client,
			wait: async () => {
				failures++;
				throw new DiscordModeRequestError("not-started", "Discord mode did not accept the wait.");
			},
		});
		await until(() => failures >= 3 && polls(f.requests).length >= 3);
		expect(polls(f.requests).length).toBeGreaterThanOrEqual(failures);
	});
});
