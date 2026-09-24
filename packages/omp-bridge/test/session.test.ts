import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { DiscordModeRequestError } from "@oh-my-pi/pi-utils/discord-client";
import {
	DISCORD_MODE_MAX_TEXT,
	type ModeDelivery,
	type ModeEnrollment,
	type ModeRequest,
	type ModeSession,
	type ModeSnapshot,
} from "@oh-my-pi/pi-wire/discord-mode";
import {
	BRIDGE_MESSAGE_SOURCE,
	BRIDGE_OWNER_MESSAGE_TYPE,
	BRIDGE_PEER_MESSAGE_TYPE,
	type BridgeConnection,
	type BridgeHost,
	type BridgeHostState,
} from "../src/host";
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

async function fixture(options: { timers?: boolean; saved?: boolean } = {}) {
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
	const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
	const connections: Array<{ closed: boolean }> = [];
	const completions = new Map<string, PromiseWithResolvers<void>>();
	let aborts = 0;
	let connects = 0;
	let mode: BridgeSession;
	const snapshot = (items: ModeDelivery[] = [...deliveries.values()]): ModeSnapshot =>
		structuredClone({ group, session, lease, peers: [peer], deliveries: items, answers: [], gatewayConnected: true });
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
			request: async input => {
				if (connection.closed) throw new DiscordModeRequestError("not-started", "fixture connection closed");
				requests.push(input);
				await beforeRequest?.(input);
				let result: ModeSnapshot;
				if (input.op === "register") {
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
								if (item.state !== "queued" || (item.kind === "message" && (busy || input.pendingInput)))
									continue;
								item.state = "dispatched";
								intake.push(item);
								if (item.kind === "message") busy = true;
							}
							result = snapshot(intake);
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
							session = { ...session, connected: false, enabled: false };
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
		schedule: callback => {
			const timer = { callback, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
	};
	const create = () => new BridgeSession(host, { root, connect, pollIntervalMs: options.timers ? 1000 : 0 });
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
		deliveries,
		delivered,
		publications,
		sent,
		notices,
		statuses,
		activeTools,
		timers,
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
		await expect(f.mode.on()).rejects.toThrow("actually saved");
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
		await expect(f.mode.on()).rejects.toThrow("actually saved");
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

	test("non-stop terminal results never publish and UTF-8 final text is bounded without reasoning", async () => {
		const f = await fixture();
		await f.mode.on();
		const failed = f.queue();
		await f.mode.poll();
		await f.mode.onAgentEnd({ messages: [marker(failed), assistant("partial failure", "error")] });
		f.state.idle = true;
		const completed = f.queue();
		await f.mode.poll();
		await f.end(completed, "界".repeat(8000));
		expect(f.publications).toHaveLength(1);
		expect(Buffer.byteLength(f.publications[0]!)).toBeLessThanOrEqual(DISCORD_MODE_MAX_TEXT);
		expect(f.publications[0]).toEndWith("\n[response truncated]");
		expect(f.publications[0]).not.toContain("\ufffd");
		expect(f.publications[0]).not.toContain("private chain");
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
