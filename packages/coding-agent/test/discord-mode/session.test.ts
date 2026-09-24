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
	DISCORD_MODE_MAX_TEXT,
	type ModeDelivery,
	type ModeDialog,
	type ModeRequest,
	type ModeSnapshot,
} from "@oh-my-pi/pi-wire/discord-mode";
import type { AgentSessionEvent } from "../../src/session/agent-session-events";
import { normalizeCustomMessagePayload } from "../../src/session/messages";
import { executeBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

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
	const completed = Promise.withResolvers<Extract<ModeRequest, { op: "receipt" }>>();
	let pollGate: Promise<ModeSnapshot> | undefined;
	let statusDeliveries: ModeDelivery[] = [];
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
		lookup: async () => ({ group: snapshot.group, session: snapshot.session }),
		close: async () => {},
		request: async input => {
			requests.push(input);
			if (input.op === "register")
				snapshot = {
					...snapshot,
					session: { ...snapshot.session, id: input.sessionId, connectionId: input.connectionId },
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
	const mode = new DiscordModeSession(engine, { connect: async () => client, receiptRoot: root, pollIntervalMs: 0 });
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
		completed: completed.promise,
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
	test("connection loss stays visible across local activity until a fresh poll confirms recovery", async () => {
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

	test("bounds Unicode final output in UTF8 bytes without broken characters", async () => {
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
