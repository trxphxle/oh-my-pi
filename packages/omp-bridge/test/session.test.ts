import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { DiscordModeRequestError } from "@oh-my-pi/pi-utils/discord-client";
import { writePrivateJson } from "@oh-my-pi/pi-utils/discord-private-files";
import {
	DISCORD_MODE_MAX_REPLY,
	DISCORD_MODE_MAX_TEXT,
	type ModeDelivery,
	type ModeEnrollment,
	type ModeLease,
	type ModeRequest,
	type ModeSession,
	type ModeSettingCommand,
	type ModeSettingsView,
	type ModeSnapshot,
} from "@oh-my-pi/pi-wire/discord-mode";
import {
	BRIDGE_MESSAGE_SOURCE,
	BRIDGE_OWNER_MESSAGE_TYPE,
	BRIDGE_PEER_MESSAGE_TYPE,
	type BridgeConnection,
	type BridgeHost,
	type BridgeHostState,
	type BridgeSettingResult,
} from "../src/host";
import type { HaisoServiceStarter } from "../src/service";
import { BridgeSession } from "../src/session";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function assistant(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "private chain of thought" },
			{ type: "text", text },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "fixture",
		stopReason,
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

function marker(delivery: ModeDelivery): AgentMessage {
	return {
		role: "custom",
		customType: delivery.source === "owner" ? BRIDGE_OWNER_MESSAGE_TYPE : BRIDGE_PEER_MESSAGE_TYPE,
		attribution: delivery.source === "owner" ? "user" : "agent",
		content: delivery.text,
		display: true,
		timestamp: 1,
		details: { bridge: BRIDGE_MESSAGE_SOURCE, deliveryId: delivery.id, from: delivery.from },
	} as AgentMessage;
}

async function fixture(
	options: {
		timers?: boolean;
		saved?: boolean;
		maxReply?: number;
		/** Broker advertises settings. */ settings?: boolean;
		/** Interactive host choice; absent like hosts without a UI. */
		select?: BridgeHost["select"];
		startService?: HaisoServiceStarter;
		/** Broker advertises and answers `/wait`. */
		wait?: boolean;
	} = {},
) {
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bridge-session-"));
	const root = await fs.realpath(temporary);
	cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
	const state: BridgeHostState = {
		sessionId: randomUUID(),
		sessionFile: path.join(root, "native.jsonl"),
		cwd: root,
		label: "Saved native label",
		local: true,
		idle: true,
		pendingMessages: false,
		pendingInput: false,
		draft: false,
	};
	if (options.saved !== false)
		await fs.writeFile(
			state.sessionFile!,
			`${JSON.stringify({ type: "session", version: 3, id: state.sessionId, cwd: root, timestamp: "2026-01-01T00:00:00Z" })}\n`,
		);
	const group = {
		id: randomUUID(),
		projectDir: root,
		name: "Existing project",
		state: "ready" as const,
		categoryId: "100",
		overviewId: "101",
	};
	let session: ModeSession = {
		id: state.sessionId,
		groupId: group.id,
		projectDir: root,
		sessionFile: state.sessionFile!,
		label: "Existing channel",
		channelId: "102",
		connectionId: randomUUID(),
		enabled: false,
		connected: false,
		busy: false,
		pendingInput: false,
		state: "ready",
	};
	const peer: ModeSession = {
		...session,
		id: randomUUID(),
		sessionFile: path.join(root, "peer-private.jsonl"),
		label: "Peer",
		connectionId: randomUUID(),
		enabled: true,
		connected: true,
	};
	let lease: ModeSnapshot["lease"];
	let enrollment: ModeEnrollment | undefined = { group, session };
	let beforeRequest: ((input: ModeRequest) => Promise<void>) | undefined;
	let afterRequest: ((input: ModeRequest) => Promise<void>) | undefined;
	let connectHook: (() => Promise<void>) | undefined;
	let autoBoundary = true;
	let throwDelivery = false;
	const requests: ModeRequest[] = [];
	const deliveries = new Map<string, ModeDelivery>();
	const replay: ModeDelivery[] = [];
	const delivered: Array<{ delivery: ModeDelivery; behavior: "nextTurn" | "steer" }> = [];
	const publications: string[] = [];
	const sent: Array<{ recipient: string; text: string }> = [];
	const notices: string[] = [];
	const statuses: Array<string | undefined> = [];
	const activeTools = new Set(["read", "custom-tool"]);
	const timers: Array<{ callback: () => void; cancelled: boolean; delay: number }> = [];
	/** Parked `/wait`s, oldest first; `resolve(true)` rings like broker work would. */
	const waits: Array<{ timeoutMs: number; resolve: (ready: boolean) => void; signal?: AbortSignal }> = [];
	const connections: Array<{ closed: boolean }> = [];
	const completions = new Map<string, PromiseWithResolvers<void>>();
	let aborts = 0;
	let connects = 0;
	let mode: BridgeSession;
	/** Broker-side settings: the stored view revision, unacknowledged commands, and acknowledgements received. */
	let settingsRevision = "";
	const reportedViews: ModeSettingsView[] = [];
	const commands: ModeSettingCommand[] = [];
	const results: Array<Extract<ModeRequest, { op: "command-result" }>> = [];
	const applied: ModeSettingCommand[] = [];
	let applyResult: (command: ModeSettingCommand) => Promise<BridgeSettingResult> = async command => ({
		outcome: "applied",
		text: `Applied ${command.kind}.`,
	});
	const snapshot = (items: ModeDelivery[] = [...deliveries.values()]): ModeSnapshot =>
		structuredClone({
			group,
			session,
			lease,
			peers: [peer],
			deliveries: items,
			answers: [],
			gatewayConnected: true,
			...(options.maxReply === undefined ? {} : { maxReply: options.maxReply }),
			...(options.settings ? { settingsRevision } : {}),
			...(options.wait ? { wait: true as const } : {}),
		});
	const connect = async (): Promise<BridgeConnection> => {
		connects++;
		await connectHook?.();
		const connection = { closed: false };
		connections.push(connection);
		return {
			lookup: async () => structuredClone(enrollment),
			close: async () => {
				connection.closed = true;
			},
			...(options.wait
				? {
						wait: (_lease: ModeLease, timeoutMs: number, signal?: AbortSignal) => {
							const { promise, resolve } = Promise.withResolvers<boolean>();
							waits.push({ timeoutMs, resolve, signal });
							signal?.addEventListener("abort", () => resolve(false), { once: true });
							return promise;
						},
					}
				: {}),
			request: async input => {
				if (connection.closed) throw new DiscordModeRequestError("not-started", "fixture connection closed");
				requests.push(input);
				await beforeRequest?.(input);
				let result: ModeSnapshot;
				if (input.op === "register") {
					if (input.rejoin && !session.enabled)
						throw new DiscordModeRequestError(
							"unknown",
							"Sharing is off or unknown for this conversation; automatic rejoin skipped. Discord mode did not confirm the result; outcome may be unknown. Inspect status before retrying.",
						);
					if (session.connected) throw new Error("live lease exists");
					for (const delivery of deliveries.values())
						if (delivery.state === "accepted" || delivery.state === "dispatched") delivery.state = "unknown";
					session = {
						...session,
						id: input.sessionId,
						sessionFile: input.sessionFile,
						projectDir: input.projectDir,
						connectionId: input.connectionId,
						enabled: true,
						connected: true,
					};
					lease = { sessionId: input.sessionId, connectionId: input.connectionId, token: "a".repeat(64) };
					enrollment = { group, session };
					result = snapshot();
				} else if (input.op === "disable") {
					session = { ...session, connected: false, enabled: false };
					enrollment = { group, session };
					result = snapshot();
				} else {
					if (
						!("lease" in input) ||
						input.lease.token !== lease?.token ||
						input.lease.connectionId !== session.connectionId
					)
						throw new Error("invalid lease");
					switch (input.op) {
						case "poll": {
							session.busy = input.busy;
							session.pendingInput = input.pendingInput;
							const intake: ModeDelivery[] = replay.splice(0, 4);
							let busy =
								input.busy ||
								[...deliveries.values()].some(
									item =>
										item.state === "unknown" ||
										(item.kind === "message" && (item.state === "accepted" || item.state === "dispatched")),
								);
							for (const item of deliveries.values()) {
								if (intake.length === 4) break;
								if (
									item.state !== "queued" ||
									item.held ||
									(item.kind === "message" && (busy || input.pendingInput))
								)
									continue;
								item.state = "dispatched";
								intake.push(item);
								if (item.kind === "message") busy = true;
							}
							if (input.settings) {
								settingsRevision = input.settings.revision;
								reportedViews.push(input.settings);
							}
							result = {
								...snapshot(intake),
								...(commands.length ? { commands: structuredClone(commands) } : {}),
							};
							break;
						}
						case "command-result": {
							results.push(input);
							const index = commands.findIndex(item => item.id === input.commandId);
							if (index < 0) throw new Error("unknown settings command");
							commands.splice(index, 1);
							if (input.settings) settingsRevision = input.settings.revision;
							result = snapshot();
							break;
						}
						case "receipt": {
							const item = deliveries.get(input.deliveryId);
							if (!item || (item.state !== "dispatched" && item.state !== "accepted"))
								throw new Error("receipt cannot complete queued or unknown work");
							if (input.state === "accepted") item.state = "accepted";
							else {
								if (input.text) publications.push(input.text);
								deliveries.delete(item.id);
								completions.get(item.id)?.resolve();
							}
							result = snapshot();
							break;
						}
						case "off":
						case "detach":
							// Like the broker: detach keeps sharing; off turns it off.
							session = { ...session, connected: false, enabled: input.op === "detach" && session.enabled };
							enrollment = { group, session };
							for (const item of deliveries.values())
								if (item.state === "accepted" || item.state === "dispatched") item.state = "unknown";
							result = snapshot();
							break;
						case "resolve-delivery": {
							const item = deliveries.get(input.deliveryId);
							if (item?.state !== "unknown") throw new Error("only unknown work can be resolved");
							deliveries.delete(item.id);
							result = snapshot([{ ...item, state: "resolved" }]);
							break;
						}
						case "send":
							sent.push({ recipient: input.recipientId, text: input.text });
							result = snapshot();
							break;
						case "report":
							publications.push(input.text);
							result = snapshot();
							break;
						case "held":
							for (const item of [...deliveries.values()])
								if (item.held && (!input.deliveryIds || input.deliveryIds.includes(item.id))) {
									if (input.action === "discard") deliveries.delete(item.id);
									else item.held = false;
								}
							result = snapshot();
							break;
						default:
							result = snapshot();
					}
				}
				await afterRequest?.(input);
				return result;
			},
		};
	};
	const host: BridgeHost = {
		getState: () => ({ ...state }),
		deliver: (delivery, behavior) => {
			delivered.push({ delivery, behavior });
			if (throwDelivery) throw new Error("public admission failed");
			state.idle = false;
			if (autoBoundary) mode.onMessageStart(marker(delivery));
		},
		abort: () => {
			aborts++;
		},
		setToolEnabled: async enabled => {
			if (enabled) activeTools.add("bridge");
			else activeTools.delete("bridge");
		},
		setStatus: text => {
			statuses.push(text);
		},
		notify: text => {
			notices.push(text);
		},
		schedule: (callback, delay) => {
			const timer = { callback, cancelled: false, delay };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
		settings: () => ({
			model: { selector: "fixture/alpha", name: "Alpha", efforts: ["off", "low", "high"] },
			effort: "low",
			capabilities: { persist: false, compact: true, advisor: false, plan: false },
			shortlist: [{ selector: "fixture/alpha", name: "Alpha", efforts: ["off", "low", "high"] }],
			models: [{ selector: "fixture/alpha", name: "Alpha", efforts: ["off", "low", "high"] }],
		}),
		usage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
		applySetting: command => {
			applied.push(command);
			return applyResult(command);
		},
		...(options.select ? { select: options.select } : {}),
	};
	const create = () =>
		new BridgeSession(host, {
			root,
			connect,
			pollIntervalMs: options.timers ? 1000 : 0,
			...(options.startService ? { startService: options.startService } : {}),
		});
	mode = create();
	cleanups.push(async () => {
		beforeRequest = undefined;
		afterRequest = undefined;
		connectHook = undefined;
		await mode.off();
	});
	return {
		root,
		state,
		host,
		peer,
		requests,
		reportedViews,
		commands,
		results,
		applied,
		set applyResult(value: typeof applyResult) {
			applyResult = value;
		},
		deliveries,
		delivered,
		publications,
		sent,
		notices,
		statuses,
		activeTools,
		timers,
		waits,
		connections,
		replay,
		get mode() {
			return mode;
		},
		get aborts() {
			return aborts;
		},
		get connects() {
			return connects;
		},
		get journalPath() {
			return path.join(root, "omp-bridge", "receipts", `${state.sessionId}.json`);
		},
		set beforeRequest(value: typeof beforeRequest) {
			beforeRequest = value;
		},
		set afterRequest(value: typeof afterRequest) {
			afterRequest = value;
		},
		set connectHook(value: typeof connectHook) {
			connectHook = value;
		},
		set autoBoundary(value: boolean) {
			autoBoundary = value;
		},
		set throwDelivery(value: boolean) {
			throwDelivery = value;
		},
		set enrollment(value: ModeEnrollment | undefined) {
			enrollment = value;
		},
		/** Broker-side session state as the next lookup or register sees it. */
		setSession(patch: Partial<ModeSession>) {
			session = { ...session, ...patch };
			enrollment = { group, session };
		},
		/** Saved broker state lists this conversation as shared (the offline pre-filter). */
		async share() {
			await writePrivateJson(path.join(root, "state.json"), {
				version: 1,
				sessions: [{ id: state.sessionId, sessionFile: state.sessionFile, enabled: true }],
			});
		},
		async restart() {
			await mode.off();
			mode = create();
			await mode.on();
		},
		queue(overrides: Partial<ModeDelivery> = {}): ModeDelivery {
			if (deliveries.size >= 32) throw new Error("bounded fixture queue is full");
			const delivery: ModeDelivery = {
				id: randomUUID(),
				sessionId: state.sessionId,
				from: "discord-owner",
				source: "owner",
				kind: "message",
				text: "Remote owner task",
				state: "queued",
				createdAt: 1,
				...overrides,
			};
			deliveries.set(delivery.id, delivery);
			completions.set(delivery.id, Promise.withResolvers<void>());
			return delivery;
		},
		completed(id: string) {
			return completions.get(id)!.promise;
		},
		async end(delivery: ModeDelivery, text: string, extra: AgentMessage[] = [], willContinue = false) {
			state.idle = !willContinue;
			await mode.onAgentEnd({
				messages: [structuredClone(marker(delivery)), ...extra, assistant(text)],
				willContinue,
			});
		},
	};
}

describe("BridgeSession local identity and lifecycle", () => {
	test("admits a saved OMP conversation with its native title-slot prefix", async () => {
		const f = await fixture();
		const original =
			serializeTitleSlot({ title: "Saved OMP conversation", source: "user", updatedAt: "2026-01-01T00:00:00Z" }) +
			(await Bun.file(f.state.sessionFile!).text());
		await Bun.write(f.state.sessionFile!, original);
		await f.mode.on();
		const delivery = f.queue();
		await f.mode.poll();
		await f.end(delivery, "Reply from the saved conversation.");
		expect(f.publications).toEqual(["Reply from the saved conversation."]);
		expect(await Bun.file(f.state.sessionFile!).text()).toBe(original);
	});

	test("loaded but off is inert; unsaved sessions never connect or create native JSONL", async () => {
		const f = await fixture({ saved: false });
		expect(f.connects).toBe(0);
		expect(f.timers).toEqual([]);
		expect(f.notices).toEqual([]);
		await expect(f.mode.on()).rejects.toThrow("isn't saved yet");
		expect(f.connects).toBe(0);
		expect(await fs.stat(f.state.sessionFile!).catch(() => undefined)).toBeUndefined();
	});

	test("requires local UI and the saved UUID/project header, not just an existing filename", async () => {
		const f = await fixture();
		f.state.local = false;
		await expect(f.mode.on()).rejects.toThrow("local interactive");
		f.state.local = true;
		await fs.writeFile(
			f.state.sessionFile!,
			`${JSON.stringify({ type: "session", id: randomUUID(), cwd: f.root })}\n`,
		);
		await expect(f.mode.on()).rejects.toThrow("isn't saved yet");
		expect(f.connects).toBe(0);
	});

	test("reuses enrollment and uses fresh connection identities without exposing private peer metadata", async () => {
		const f = await fixture();
		const before = await fs.readFile(f.state.sessionFile!, "utf8");
		const first = await f.mode.on();
		expect(first.session.channelId).toBe("102");
		expect(f.requests.find(input => input.op === "register")).toMatchObject({
			label: "Saved native label",
			groupName: "Existing project",
			app: "omp",
		});
		expect(await f.mode.peers()).toEqual([{ id: f.peer.id, label: "Peer", busy: false, pendingInput: false }]);
		expect(JSON.stringify(await f.mode.peers())).not.toContain("private");
		expect(f.notices.some(text => text.includes("permanent-deletion event"))).toBe(true);
		await f.mode.off();
		const second = await f.mode.on("Explicit label");
		expect(second.session.connectionId).not.toBe(first.session.connectionId);
		const registrations = f.requests.filter(input => input.op === "register");
		expect(registrations[1]).toMatchObject({ label: "Explicit label" });
		expect(registrations[0]!.requestId).not.toBe(registrations[1]!.requestId);
		expect(await fs.readFile(f.state.sessionFile!, "utf8")).toBe(before);
	});

	test("attaches untagged when a broker predating the app split rejects the app field", async () => {
		const f = await fixture();
		f.beforeRequest = async input => {
			if (input.op === "register" && input.app !== undefined)
				throw new DiscordModeRequestError(
					"unknown",
					"Invalid Discord request: check operation, UUIDs, absolute paths, text/byte limits, and allowed fields. Discord mode did not confirm the result; outcome may be unknown. Inspect status before retrying.",
				);
		};
		expect((await f.mode.on()).session.connected).toBe(true);
		const [tagged, untagged, ...rest] = f.requests.filter(input => input.op === "register");
		expect(rest).toEqual([]);
		if (tagged?.op !== "register") throw new Error("tagged registration missing");
		const { app, ...fields } = tagged;
		expect(app).toBe("omp");
		expect(untagged).toEqual(fields);
	});

	test("new group defaults to canonical cwd basename and refuses another live lease", async () => {
		const f = await fixture();
		f.enrollment = undefined;
		await f.mode.on();
		expect(f.requests.find(input => input.op === "register")).toMatchObject({ groupName: path.basename(f.root) });
		await f.mode.off();
		f.enrollment = {
			group: { id: randomUUID(), projectDir: f.root, name: "Group", state: "ready" },
			session: { ...f.peer, id: f.state.sessionId },
		};
		await expect(f.mode.on()).rejects.toThrow("live broker lease");
		expect(f.requests.filter(input => input.op === "register")).toHaveLength(1);
	});

	test("off invalidates delayed attachment and cancels only its timer/tool", async () => {
		const f = await fixture({ timers: true });
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		f.connectHook = async () => {
			entered.resolve();
			await gate.promise;
		};
		const attaching = f.mode.on();
		await entered.promise;
		await f.mode.off();
		gate.resolve();
		await expect(attaching).rejects.toThrow("cancelled");
		expect(f.requests).toEqual([]);
		expect(f.connections.every(item => item.closed)).toBe(true);
		f.connectHook = undefined;
		await f.mode.on();
		const timer = f.timers.at(-1)!;
		await f.mode.off();
		const requestCount = f.requests.length;
		timer.callback();
		expect(timer.cancelled).toBe(true);
		expect(f.requests).toHaveLength(requestCount);
		expect([...f.activeTools]).toEqual(["read", "custom-tool"]);
	});

	test("a switch during accepted receipt never injects into the new session", async () => {
		const f = await fixture();
		await f.mode.on();
		const delivery = f.queue();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		f.afterRequest = async input => {
			if (input.op === "receipt" && input.state === "accepted") {
				entered.resolve();
				await release.promise;
			}
		};
		const polling = f.mode.poll();
		await entered.promise;
		f.state.sessionId = randomUUID();
		const off = f.mode.off();
		release.resolve();
		await Promise.all([polling, off]);
		await f.mode.onAgentEnd({ messages: [marker(delivery), assistant("unrelated local answer")] });
		expect(f.delivered).toEqual([]);
		expect(f.publications).toEqual([]);
		expect(f.mode.enabled).toBe(false);
	});
});

describe("BridgeSession admission and attribution", () => {
	test("persists attempt before acceptance and waits for an exact marked host boundary", async () => {
		const f = await fixture();
		await f.mode.on();
		f.autoBoundary = false;
		const delivery = f.queue();
		let sawDurableAttempt = false;
		f.beforeRequest = async input => {
			if (input.op === "receipt" && input.state === "accepted") {
				const journal = JSON.parse(await fs.readFile(f.journalPath, "utf8"));
				sawDurableAttempt = journal.entries.some(
					(entry: { id: string; state: string }) => entry.id === delivery.id && entry.state === "attempted",
				);
			}
		};
		await f.mode.poll();
		expect(sawDurableAttempt).toBe(true);
		expect(f.delivered.map(item => item.behavior)).toEqual(["nextTurn"]);
		await f.end(delivery, "not yet attributable");
		expect(f.deliveries.get(delivery.id)?.state).toBe("accepted");
		expect(f.publications).toEqual([]);
		expect(f.mode.statusText).toContain("held");
		const wrong = marker(delivery) as unknown as { attribution: string; details: { bridge: string } };
		wrong.details.bridge = "another-extension";
		wrong.attribution = "agent";
		f.mode.onMessageStart(wrong as unknown as AgentMessage);
		await f.end(delivery, "still unrelated");
		expect(f.publications).toEqual([]);
		f.mode.onMessageStart(marker(delivery));
		await f.end(delivery, "Verified answer");
		expect(f.publications).toEqual(["Verified answer"]);
		expect((await fs.stat(f.journalPath)).mode & 0o777).toBe(0o600);
		expect(await fs.readFile(f.journalPath, "utf8")).not.toContain(delivery.text);
		expect(await fs.readFile(f.journalPath, "utf8")).not.toContain("a".repeat(64));
	});

	test("willContinue and missing own boundaries cannot publish or complete", async () => {
		const f = await fixture();
		await f.mode.on();
		const delivery = f.queue();
		await f.mode.poll();
		await f.end(delivery, "intermediate", [], true);
		await f.mode.onAgentEnd({ messages: [assistant("a different turn")] });
		expect(f.publications).toEqual([]);
		expect(f.deliveries.get(delivery.id)?.state).toBe("accepted");
		await f.end(delivery, "terminal");
		expect(f.publications).toEqual(["terminal"]);
		await f.end(delivery, "duplicate terminal event");
		expect(f.publications).toEqual(["terminal"]);
	});

	test("interleaved local input and custom-user boundaries suppress automatic publication", async () => {
		const f = await fixture();
		await f.mode.on();
		const first = f.queue();
		await f.mode.poll();
		f.mode.onLocalInput();
		await f.end(first, "local private answer");
		const second = f.queue();
		await f.mode.poll();
		const localCustom = { ...marker(second), customType: "local-prompt", details: {} } as AgentMessage;
		await f.end(second, "another local private answer", [localCustom]);
		expect(f.publications).toEqual([]);
		expect(f.deliveries.size).toBe(0);
	});

	test("explicit reports publish once and peer turns never auto-report", async () => {
		const f = await fixture();
		await f.mode.on();
		const owner = f.queue();
		await f.mode.poll();
		await f.mode.report("explicit owner update", "report-1");
		await f.mode.report("explicit owner update", "report-1");
		await f.end(owner, "automatic duplicate must not post");
		const peer = f.queue({ source: "peer", from: f.peer.id });
		await f.mode.poll();
		await f.end(peer, "peer result stays local");
		expect(f.publications).toEqual(["explicit owner update"]);
	});

	test("final text uses the broker's advertised reply bound and still truncates beyond it", async () => {
		const f = await fixture({ maxReply: DISCORD_MODE_MAX_REPLY });
		await f.mode.on();
		const long = "界".repeat(8000);
		const first = f.queue();
		await f.mode.poll();
		await f.end(first, long);
		f.state.idle = true;
		const second = f.queue();
		await f.mode.poll();
		await f.end(second, "界".repeat(DISCORD_MODE_MAX_REPLY));
		expect(f.publications).toHaveLength(2);
		expect(f.publications[0]).toBe(long);
		expect(Buffer.byteLength(f.publications[1]!)).toBeLessThanOrEqual(DISCORD_MODE_MAX_REPLY);
		expect(Buffer.byteLength(f.publications[1]!)).toBeGreaterThan(DISCORD_MODE_MAX_TEXT);
		expect(f.publications[1]).toEndWith("\n[response truncated]");
		expect(f.publications[1]).not.toContain("\ufffd");
	});

	test("provider errors publish only a bounded failure notice; aborted turns stay silent; text bound holds", async () => {
		const f = await fixture();
		await f.mode.on();
		const failed = f.queue();
		await f.mode.poll();
		await f.mode.onAgentEnd({
			messages: [
				marker(failed),
				{
					...assistant("partial failure", "error"),
					errorMessage: "Codex error event: The usage limit has been reached\nstack line",
				},
			],
		});
		expect(f.publications).toHaveLength(1);
		expect(f.publications[0]).toContain("The usage limit has been reached");
		expect(f.publications[0]).not.toContain("stack line");
		expect(f.publications[0]).not.toContain("partial failure");
		expect(f.publications[0]).not.toContain("private chain");
		f.state.idle = true;
		const aborted = f.queue();
		await f.mode.poll();
		await f.mode.onAgentEnd({ messages: [marker(aborted), assistant("half an answer", "aborted")] });
		expect(f.publications).toHaveLength(1);
		f.state.idle = true;
		const completed = f.queue();
		await f.mode.poll();
		await f.end(completed, "界".repeat(8000));
		expect(f.publications).toHaveLength(2);
		expect(Buffer.byteLength(f.publications[1]!)).toBeLessThanOrEqual(DISCORD_MODE_MAX_TEXT);
		expect(f.publications[1]).toEndWith("\n[response truncated]");
		expect(f.publications[1]).not.toContain("\ufffd");
		expect(f.publications[1]).not.toContain("private chain");
	});

	test("busy, draft, and pending input defer ordinary delivery while stop controls still operate", async () => {
		const f = await fixture();
		await f.mode.on();
		const ordinary = f.queue();
		f.state.idle = false;
		f.state.draft = true;
		f.state.pendingInput = true;
		const stop = f.queue({ kind: "abort", text: "" });
		await f.mode.poll();
		expect(f.delivered).toEqual([]);
		expect(f.aborts).toBe(1);
		expect(f.deliveries.has(stop.id)).toBe(false);
		expect(f.deliveries.get(ordinary.id)?.state).toBe("queued");
		expect(f.publications).toEqual([]);
		f.state.idle = true;
		f.state.draft = false;
		f.state.pendingInput = false;
		f.state.pendingMessages = true;
		await f.mode.poll();
		expect(f.delivered).toEqual([]);
		f.state.pendingMessages = false;
		await f.mode.poll();
		expect(f.delivered.map(item => item.delivery.id)).toEqual([ordinary.id]);
	});

	test("local input winning the acceptance race rejects without injecting", async () => {
		const f = await fixture();
		await f.mode.on();
		const delivery = f.queue();
		f.afterRequest = async input => {
			if (input.op === "receipt" && input.state === "accepted") f.mode.onLocalInput();
		};
		await f.mode.poll();
		expect(f.delivered).toEqual([]);
		expect(f.requests).toContainEqual(
			expect.objectContaining({ op: "receipt", deliveryId: delivery.id, state: "rejected" }),
		);
	});

	test("active guidance contaminates attribution and completes only after its own observed admission", async () => {
		const f = await fixture();
		await f.mode.on();
		const owner = f.queue();
		await f.mode.poll();
		f.autoBoundary = false;
		const guidance = f.queue({ kind: "steer", text: "change course" });
		await f.mode.poll();
		expect(f.deliveries.get(guidance.id)?.state).toBe("accepted");
		expect(f.delivered.at(-1)?.behavior).toBe("steer");
		f.mode.onMessageStart(marker(guidance));
		await f.completed(guidance.id);
		await f.end(owner, "contaminated result");
		expect(f.publications).toEqual([]);
		expect(
			f.requests.filter(
				input => input.op === "receipt" && input.deliveryId === guidance.id && input.state === "completed",
			),
		).toHaveLength(1);
	});

	test("idle guidance can own a remote turn; abort never mirrors its interrupted result", async () => {
		const f = await fixture();
		await f.mode.on();
		const guidance = f.queue({ kind: "steer" });
		await f.mode.poll();
		await f.end(guidance, "idle guidance answer");
		const owner = f.queue();
		await f.mode.poll();
		f.queue({ kind: "abort", text: "" });
		await f.mode.poll();
		await f.end(owner, "interrupted answer");
		expect(f.aborts).toBe(1);
		expect(f.publications).toEqual(["idle guidance answer"]);
	});

	test("poll is single-flight and duplicate deliveries/events never execute twice across restart", async () => {
		const f = await fixture();
		await f.mode.on();
		const delivery = f.queue();
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		f.beforeRequest = async input => {
			if (input.op === "poll") {
				entered.resolve();
				await gate.promise;
			}
		};
		const poll = f.mode.poll();
		await entered.promise;
		await f.mode.poll();
		expect(f.requests.filter(input => input.op === "poll")).toHaveLength(1);
		gate.resolve();
		await poll;
		f.beforeRequest = undefined;
		f.mode.onMessageStart(marker(delivery));
		f.replay.push({ ...delivery, state: "dispatched" });
		await f.mode.poll();
		await f.end(delivery, "one result");
		await f.restart();
		f.replay.push({ ...delivery, state: "dispatched" });
		await f.mode.poll();
		expect(f.delivered).toHaveLength(1);
		expect(f.publications).toEqual(["one result"]);
	});

	test("unconfirmed admission stays fenced across restart and explicit resolution never replays it", async () => {
		const f = await fixture();
		await f.mode.on();
		f.autoBoundary = false;
		const delivery = f.queue();
		await f.mode.poll();
		await f.restart();
		expect(f.mode.statusText).toContain("held");
		expect((await f.mode.status())!.deliveries.find(item => item.id === delivery.id)?.state).toBe("unknown");
		await f.mode.repair("session", undefined, false);
		expect(f.mode.statusText).toContain("held");
		await f.mode.resolve(delivery.id);
		await f.mode.poll();
		expect(f.delivered).toHaveLength(1);
		expect(f.publications).toEqual([]);
	});

	test("bounded unconfirmed guidance reserves room for stop without admitting more work", async () => {
		const f = await fixture();
		await f.mode.on();
		f.autoBoundary = false;
		for (let index = 0; index < 31; index++) f.queue({ kind: "steer" });
		f.queue({ kind: "abort", text: "" });
		for (let index = 0; index < 8; index++) await f.mode.poll();
		expect(f.delivered).toHaveLength(31);
		expect(f.aborts).toBe(1);
		f.queue({ kind: "steer", text: "beyond the admission bound" });
		await f.mode.poll();
		expect(f.delivered).toHaveLength(31);
		expect(f.mode.statusText).toContain("held");
		expect(f.publications).toEqual([]);
	});
});

describe("BridgeSession private storage and uncertain effects", () => {
	test("unsafe receipt symlinks block attachment before connecting or modifying their target", async () => {
		const f = await fixture();
		await fs.mkdir(path.dirname(f.journalPath), { recursive: true, mode: 0o700 });
		const target = path.join(f.root, "keep-private.txt");
		await fs.writeFile(target, "unchanged", { mode: 0o600 });
		await fs.symlink(target, f.journalPath);
		await expect(f.mode.on()).rejects.toThrow();
		expect(f.connects).toBe(0);
		expect(await fs.readFile(target, "utf8")).toBe("unchanged");
	});

	test("unsafe storage appearing after attach prevents acceptance and delivery", async () => {
		const f = await fixture();
		await f.mode.on();
		await fs.chmod(path.dirname(f.journalPath), 0o755);
		f.queue();
		await f.mode.poll();
		expect(f.delivered).toEqual([]);
		expect(f.requests.some(input => input.op === "receipt")).toBe(false);
		expect(f.mode.statusText).toContain("held");
	});

	test("full receipt journals fail closed instead of evicting replay fences", async () => {
		const f = await fixture();
		await fs.mkdir(path.dirname(f.journalPath), { recursive: true, mode: 0o700 });
		const entries = Array.from({ length: 4096 }, () => ({ kind: "delivery", id: randomUUID(), state: "settled" }));
		await fs.writeFile(
			f.journalPath,
			JSON.stringify({
				version: 1,
				sessionId: f.state.sessionId,
				sessionFile: f.state.sessionFile,
				projectDir: f.root,
				entries,
			}),
			{ mode: 0o600 },
		);
		await f.mode.on();
		f.queue();
		await f.mode.poll();
		expect(f.delivered).toEqual([]);
		expect(JSON.parse(await fs.readFile(f.journalPath, "utf8")).entries).toEqual(entries);
		expect(f.mode.statusText).toContain("held");
	});

	test("acceptance failure and void host failure remain uncertain, never falsely completed", async () => {
		const f = await fixture();
		await f.mode.on();
		const first = f.queue();
		f.afterRequest = async input => {
			if (input.op === "receipt" && input.state === "accepted")
				throw new DiscordModeRequestError("unknown", "reply lost");
		};
		await f.mode.poll();
		expect(f.delivered).toEqual([]);
		f.afterRequest = undefined;
		await f.restart();
		await f.mode.resolve(first.id);
		f.throwDelivery = true;
		const second = f.queue();
		await f.mode.poll();
		await f.end(second, "must not claim success");
		expect(f.deliveries.get(second.id)?.state).toBe("accepted");
		expect(f.publications).toEqual([]);
	});

	test("uncertain report is not replayed after restart, and local repair never sends it again", async () => {
		const f = await fixture();
		await f.mode.on();
		f.afterRequest = async input => {
			if (input.op === "report") throw new DiscordModeRequestError("unknown", "reply lost after publication");
		};
		await expect(f.mode.report("possibly published", "uncertain-report")).rejects.toThrow("not confirmed");
		f.afterRequest = undefined;
		await f.restart();
		await expect(f.mode.report("possibly published", "uncertain-report")).rejects.toThrow("already attempted");
		await expect(f.mode.report("new result", "new-report")).rejects.toThrow("previous send/report");
		await f.mode.repair("session", undefined, false);
		await expect(f.mode.report("new result", "new-report")).rejects.toThrow("previous send/report");
		await f.mode.repair("session", undefined, true);
		await f.mode.report("new result", "new-report");
		expect(f.publications).toEqual(["possibly published", "new result"]);
	});

	test("lost completion acknowledgement cannot republish and orphaned fences require explicit local repair", async () => {
		const f = await fixture();
		await f.mode.on();
		const delivery = f.queue();
		await f.mode.poll();
		f.afterRequest = async input => {
			if (input.op === "receipt" && input.state === "completed")
				throw new DiscordModeRequestError("unknown", "published before connection loss");
		};
		await f.end(delivery, "published once");
		await f.end(delivery, "must not retry terminal event");
		f.afterRequest = undefined;
		await f.restart();
		expect((await f.mode.status())!.deliveries).toEqual([]);
		expect(f.mode.statusText).toContain("held");
		await f.mode.repair("session", undefined, false);
		expect(f.mode.statusText).toContain("held");
		await f.mode.repair("session", undefined, true);
		const next = f.queue();
		await f.mode.poll();
		await f.end(next, "new explicitly resumed work");
		expect(f.publications).toEqual(["published once", "new explicitly resumed work"]);
	});

	test("outbound messages require a current peer, enforce byte limits and deduplicate concurrent requests", async () => {
		const f = await fixture();
		await f.mode.on();
		await expect(f.mode.send(randomUUID(), "hello", "wrong-peer")).rejects.toThrow("currently connected peer");
		await expect(f.mode.send(f.peer.id, "界".repeat(DISCORD_MODE_MAX_TEXT), "oversize")).rejects.toThrow(
			"UTF-8 bytes",
		);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		f.beforeRequest = async input => {
			if (input.op === "send") {
				entered.resolve();
				await release.promise;
			}
		};
		const sending = f.mode.send(f.peer.id, "hello peer", "send-once");
		await entered.promise;
		await expect(f.mode.send(f.peer.id, "hello peer", "send-once")).rejects.toThrow("in flight");
		release.resolve();
		await sending;
		f.beforeRequest = undefined;
		await f.mode.send(f.peer.id, "hello peer", "send-once");
		await expect(f.mode.send(f.peer.id, "different message", "send-once")).rejects.toThrow("different content");
		expect(f.sent).toEqual([{ recipient: f.peer.id, text: "hello peer" }]);
		await f.mode.off();
		await expect(f.mode.report("must stay local", "off-report")).rejects.toThrow("off");
	});
});

describe("BridgeSession remembered sharing", () => {
	test("detach keeps sharing, and rejoin reattaches only a still-shared conversation under its retained name", async () => {
		const f = await fixture();
		await f.mode.on("Explicit label");
		expect(await f.mode.detach()).toBe(true);
		expect(f.requests.at(-1)).toMatchObject({ op: "detach" });
		expect(f.mode.enabled).toBe(false);
		// Not listed as shared in saved state: opening it causes no broker traffic.
		const connects = f.connects;
		expect(await f.mode.rejoin()).toBeUndefined();
		expect(f.connects).toBe(connects);
		await f.share();
		const notices = f.notices.length;
		const rejoined = await f.mode.rejoin();
		expect(rejoined?.session.channelId).toBe("102");
		expect(f.requests.filter(input => input.op === "register").at(-1)).toMatchObject({
			rejoin: true,
			label: "Existing channel",
		});
		expect(f.mode.enabled).toBe(true);
		expect(f.notices).toHaveLength(notices);
	});

	test("explicit off is sticky, by lease when attached and by identity when not", async () => {
		const f = await fixture();
		await f.share();
		await f.mode.on();
		expect(await f.mode.off()).toBe(true);
		// The broker, not the saved view, decides: sharing is off, so nothing reattaches.
		expect(await f.mode.rejoin()).toBeUndefined();
		expect(f.requests.filter(input => input.op === "register")).toHaveLength(1);
		await f.mode.on();
		await f.mode.detach();
		expect(await f.mode.off()).toBe(false);
		await f.mode.disable();
		expect(f.requests.at(-1)).toEqual({
			op: "disable",
			sessionId: f.state.sessionId,
			sessionFile: path.join(f.root, "native.jsonl"),
			projectDir: f.root,
		});
		expect(await f.mode.rejoin()).toBeUndefined();
		expect(f.requests.filter(input => input.op === "register")).toHaveLength(2);
	});

	test("a live lease elsewhere is retried once after it could expire, then reported instead of displaced", async () => {
		const f = await fixture();
		await f.share();
		await f.mode.on();
		await f.mode.detach();
		f.setSession({ connected: true, connectionId: randomUUID() });
		expect(await f.mode.rejoin()).toBeUndefined();
		const retry = f.timers.at(-1)!;
		expect(retry.cancelled).toBe(false);
		// The scheduled retry is this second attempt.
		expect(await f.mode.rejoin(true)).toBeUndefined();
		expect(retry.cancelled).toBe(true);
		expect(f.notices.at(-1)).toContain("attached in another window");
		expect(f.requests.filter(input => input.op === "register")).toHaveLength(1);
		// A lifecycle change cancels a pending retry.
		await f.mode.rejoin();
		const pending = f.timers.at(-1)!;
		await f.mode.detach();
		expect(pending.cancelled).toBe(true);
	});

	test("a rejoin offers saved owner messages locally, never runs them unasked, and applies the owner's review", async () => {
		const answers = ["Review", "Discard", "Send"];
		const prompts: string[] = [];
		const f = await fixture({
			select: async title => {
				prompts.push(title);
				return answers.shift();
			},
		});
		await f.share();
		await f.mode.on();
		await f.mode.detach();
		const first = f.queue({ text: "first saved", held: true });
		const second = f.queue({ text: "second saved", held: true });
		const sent = Promise.withResolvers<void>();
		f.afterRequest = async input => {
			if (input.op === "held" && input.action === "send") sent.resolve();
		};
		await f.mode.rejoin();
		await sent.promise;
		expect(prompts).toEqual([
			"Discord: 2 messages arrived while this session was closed",
			"Saved message 1 of 2",
			"Saved message 2 of 2",
		]);
		expect(f.notices.some(text => text.includes("first saved"))).toBe(true);
		const held = f.requests.filter((input): input is Extract<ModeRequest, { op: "held" }> => input.op === "held");
		expect(held.map(({ action, deliveryIds }) => ({ action, deliveryIds }))).toEqual([
			{ action: "discard", deliveryIds: [first.id] },
			{ action: "send", deliveryIds: [second.id] },
		]);
		expect([...f.deliveries.values()].map(item => [item.text, item.held])).toEqual([["second saved", false]]);
		expect(f.delivered).toEqual([]);
		await f.mode.poll();
		expect(f.delivered.map(item => item.delivery.text)).toEqual(["second saved"]);
	});
});

describe("BridgeSession Discord settings", () => {
	test("reports settings only to brokers advertising them and applies an owner change once, at idle", async () => {
		const legacy = await fixture();
		await legacy.mode.on();
		await legacy.mode.poll();
		// Brokers without settings support reject unknown poll fields.
		expect(legacy.requests.some(request => "settings" in request || "usage" in request)).toBe(false);

		const f = await fixture({ settings: true });
		await f.mode.on();
		await f.mode.poll();
		expect(f.reportedViews).toMatchObject([
			{
				model: { selector: "fixture/alpha" },
				capabilities: { persist: false, compact: true, advisor: false, plan: false },
			},
		]);
		const command = { id: randomUUID(), kind: "effort" as const, value: "high" };
		f.commands.push(command);
		f.state.idle = false;
		await f.mode.poll();
		expect(f.applied).toEqual([]);
		const acknowledged = Promise.withResolvers<void>();
		f.afterRequest = async input => {
			if (input.op === "command-result") acknowledged.resolve();
		};
		f.state.idle = true;
		await f.mode.poll();
		await acknowledged.promise;
		await f.mode.poll();
		expect(f.applied).toEqual([command]);
		expect(f.results).toMatchObject([{ commandId: command.id, outcome: "applied", text: "Applied effort." }]);
	});
});

describe("BridgeSession starts Haiso's stopped service", () => {
	function starter(started: boolean) {
		const roots: string[] = [];
		const start: HaisoServiceStarter = async (root, starting) => {
			starting?.();
			roots.push(root);
			return started;
		};
		return { roots, start };
	}
	/** The first connection fails like a missing connector; later ones reach the started service. */
	function stoppedOnce(f: { connectHook: (() => Promise<void>) | undefined }) {
		let down = true;
		f.connectHook = async () => {
			if (!down) return;
			down = false;
			throw new Error(
				"Discord bridge connector is missing or invalid; update/bootstrap the configured Haiso broker first.",
			);
		};
	}

	test("/bridge on starts it once, says so, then attaches", async () => {
		const s = starter(true);
		const f = await fixture({ startService: s.start });
		stoppedOnce(f);
		expect((await f.mode.on()).session.connected).toBe(true);
		expect(s.roots).toEqual([f.root]);
		expect(f.notices[0]).toBe("Starting Haiso's Discord service…");
	});

	test("keeps today's error when the service could not be started", async () => {
		const s = starter(false);
		const f = await fixture({ startService: s.start });
		stoppedOnce(f);
		await expect(f.mode.on()).rejects.toThrow("connector is missing or invalid");
		expect(s.roots).toEqual([f.root]);
		expect(f.mode.enabled).toBe(false);
	});

	test("rejoin starts it only for a conversation that is still shared", async () => {
		const s = starter(true);
		const f = await fixture({ startService: s.start });
		stoppedOnce(f);
		expect(await f.mode.rejoin()).toBeUndefined();
		expect(s.roots).toEqual([]);
		expect(f.connects).toBe(0);
		await f.share();
		f.setSession({ enabled: true });
		expect((await f.mode.rejoin())?.session.connected).toBe(true);
		expect(s.roots).toEqual([f.root]);
		// Automatic rejoin stays quiet: no starting notice.
		expect(f.notices).not.toContain("Starting Haiso's Discord service…");
	});
});

describe("BridgeSession push waits", () => {
	/** Timers are the host's; each loop step runs the one live timer, then lets its async work reach the next one. */
	async function step(f: { timers: Array<{ callback: () => void; cancelled: boolean }> }): Promise<void> {
		const live = f.timers.filter(timer => !timer.cancelled);
		expect(live).toHaveLength(1);
		live[0]!.cancelled = true;
		live[0]!.callback();
		await until(() => f.timers.some(timer => !timer.cancelled));
	}
	async function until(condition: () => boolean): Promise<void> {
		for (let attempt = 0; attempt < 400 && !condition(); attempt++) await Bun.sleep(1);
		expect(condition()).toBe(true);
	}
	const polls = (requests: ModeRequest[]) =>
		requests.filter((request): request is Extract<ModeRequest, { op: "poll" }> => request.op === "poll");

	test("an idle bridge polls once per broker wait instead of once per interval", async () => {
		const legacy = await fixture({ timers: true });
		await legacy.mode.on();
		for (let tick = 0; tick < 10; tick++) await step(legacy);
		expect(polls(legacy.requests)).toHaveLength(10);

		const f = await fixture({ timers: true, wait: true });
		await f.mode.on();
		await step(f);
		expect(polls(f.requests)).toHaveLength(1);
		expect(f.waits.map(wait => wait.timeoutMs)).toEqual([25_000]);
		// The same ten idle intervals only run the local check: no IPC, no polls.
		for (let tick = 0; tick < 10; tick++) await step(f);
		expect(polls(f.requests)).toHaveLength(1);
		expect(f.waits).toHaveLength(1);
	});

	test("broker work ends the wait and the next poll takes it", async () => {
		const f = await fixture({ timers: true, wait: true });
		await f.mode.on();
		await step(f);
		const watch = f.timers.find(timer => !timer.cancelled)!;
		const delivery = f.queue({ text: "wake up" });
		f.waits[0]!.resolve(true);
		await until(() => watch.cancelled && f.timers.some(timer => !timer.cancelled));
		await step(f);
		expect(polls(f.requests)).toHaveLength(2);
		expect(f.delivered.map(item => item.delivery.id)).toEqual([delivery.id]);
	});

	test("a local change ends the wait so the broker hears it on the next poll; detach aborts it", async () => {
		const f = await fixture({ timers: true, wait: true });
		await f.mode.on();
		await step(f);
		f.state.draft = true;
		// The local check notices the draft, ends the wait, and the loop polls with it.
		await step(f);
		expect(f.waits[0]!.signal?.aborted).toBe(true);
		await step(f);
		expect(polls(f.requests).at(-1)).toMatchObject({ busy: true, pendingInput: true });
		expect(f.waits).toHaveLength(2);
		await f.mode.detach();
		expect(f.waits[1]!.signal?.aborted).toBe(true);
	});
});
