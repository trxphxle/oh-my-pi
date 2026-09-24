import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { prompt as promptRenderer } from "@oh-my-pi/pi-utils";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-wire";
import ownerTemplate from "../prompts/discord-owner.md" with { type: "text" };
import peerTemplate from "../prompts/discord-peer.md" with { type: "text" };
import { truncateHeadBytes } from "@oh-my-pi/pi-tui/tools/streaming-output";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-events";
import type { InteractiveModeContext } from "../modes/types";
import { canonicalProjectDir } from "../launch/paths";
import { connectDiscordMode } from "./client";
import { discordModePaths } from "./config";
import { DiscordDialogs, type DiscordDialogResult } from "./dialog";
import { readPrivateJson, writePrivateJson } from "@oh-my-pi/pi-utils/discord-private-files";
import { describeDiscordMode, type DiscordModePresentation } from "./presentation";
import {
	DISCORD_MODE_MAX_PENDING,
	DISCORD_MODE_MAX_TEXT,
	type ModeDelivery,
	type ModeDialog,
	type ModeEnrollment,
	type ModeLease,
	type ModeRequest,
	type ModeSnapshot,
} from "@oh-my-pi/pi-wire/discord-mode";

export interface DiscordSessionClient {
	request(input: ModeRequest): Promise<ModeSnapshot>;
	lookup(projectDir: string, sessionId: string): Promise<ModeEnrollment | undefined>;
	close(): Promise<void>;
}

export type DiscordSessionEngine = Pick<
	AgentSession,
	| "sessionFile"
	| "isStreaming"
	| "hasAdmittedSubmission"
	| "queuedMessageCount"
	| "subscribe"
	| "promptCustomMessage"
	| "abort"
> & {
	sessionManager: Pick<AgentSession["sessionManager"], "getSessionId" | "getCwd" | "ensureOnDisk" | "flush">;
};

interface Receipt {
	id: string;
	state: "attempted" | "accepted" | "completed" | "rejected";
}

/** Immutable attempted IDs never expire: a full journal fails closed rather than replaying effects. */
export class DiscordReceiptJournal {
	#receipts = new Map<string, Receipt>();
	#serial: Promise<void> = Promise.resolve();
	constructor(private file: string) {}

	async load(): Promise<void> {
		const value = await readPrivateJson(this.file, 1024 * 1024);
		if (value === undefined) return;
		if (!Array.isArray(value) || value.length > 4096) throw new Error("Invalid Discord receipt journal");
		for (const item of value as unknown[]) {
			if (
				!item ||
				typeof item !== "object" ||
				!("id" in item) ||
				typeof item.id !== "string" ||
				!("state" in item) ||
				(item.state !== "attempted" &&
					item.state !== "accepted" &&
					item.state !== "completed" &&
					item.state !== "rejected")
			) {
				throw new Error("Invalid Discord receipt journal");
			}
			this.#receipts.set(item.id, { id: item.id, state: item.state });
		}
	}

	has(id: string): boolean {
		return this.#receipts.has(id);
	}

	async save(receipt: Receipt): Promise<void> {
		const operation = this.#serial.then(async () => {
			if (!this.#receipts.has(receipt.id) && this.#receipts.size >= 4096) {
				throw new Error("Discord receipt journal is full; intake held. No delivery will be replayed.");
			}
			const previous = this.#receipts.get(receipt.id);
			this.#receipts.set(receipt.id, receipt);
			try {
				await writePrivateJson(this.file, [...this.#receipts.values()]);
			} catch (error) {
				if (previous) this.#receipts.set(receipt.id, previous);
				else this.#receipts.delete(receipt.id);
				throw error;
			}
		});
		this.#serial = operation.catch(() => {});
		await operation;
	}
}

interface ActiveDelivery {
	delivery: ModeDelivery;
	boundary?: AgentMessage;
	contaminated: boolean;
	reported: boolean;
}

export interface DiscordSessionOptions {
	connect?: () => Promise<DiscordSessionClient>;
	receiptRoot?: string;
	pollIntervalMs?: number;
	status?: (text: string | undefined) => void;
	notify?: (text: string) => void;
	pendingLocalInput?: () => boolean;
	isWorking?: () => boolean;
}

const sessions = new WeakMap<DiscordSessionEngine, DiscordModeSession>();
const enrolledFiles = new Map<string, DiscordModeSession>();

/** Existing engine owns every turn. This adapter only routes authorized deliveries and attributable output. */
export class DiscordModeSession {
	#client?: DiscordSessionClient;
	#lease?: ModeLease;
	#identity?: string;
	#sessionFile?: string;
	#snapshot?: ModeSnapshot;
	#transportAvailable = false;
	#journal?: DiscordReceiptJournal;
	#epoch = 0;
	#polling = false;
	#timer?: NodeJS.Timeout;
	#unsubscribe?: () => void;
	#queue: ModeDelivery[] = [];
	#active?: ActiveDelivery;
	#intakeHeld = false;
	#localDialogs = 0;
	#dialogs: DiscordDialogs;
	#options: DiscordSessionOptions;

	constructor(
		readonly engine: DiscordSessionEngine,
		options: DiscordSessionOptions = {},
	) {
		this.#options = options;
		this.#dialogs = new DiscordDialogs(
			async dialog => {
				await this.#request({ op: "dialog", lease: this.#requireLease(), dialog });
			},
			async dialogId => {
				if (this.enabled) await this.#request({ op: "dialog-end", lease: this.#requireLease(), dialogId });
			},
			() => this.#renderStatus(),
		);
		this.#renderStatus();
	}

	get enabled(): boolean {
		return this.#lease !== undefined && this.#identity === this.engine.sessionManager.getSessionId();
	}
	get snapshot(): ModeSnapshot | undefined {
		return this.#snapshot;
	}
	get pendingInput(): boolean {
		return this.#localDialogs > 0 || this.#dialogs.pending;
	}

	get presentation(): DiscordModePresentation {
		return describeDiscordMode({
			enabled: this.enabled,
			snapshot: this.#snapshot,
			transportAvailable: this.#transportAvailable,
			intakeHeld: this.#intakeHeld,
			pendingInput: this.pendingInput,
			working: this.engine.isStreaming || this.#options.isWorking?.(),
		});
	}

	beginLocalDialog(): () => void {
		const epoch = this.#epoch;
		this.#localDialogs++;
		this.#renderStatus();
		let ended = false;
		return () => {
			if (ended || epoch !== this.#epoch) return;
			ended = true;
			this.#localDialogs--;
			this.#renderStatus();
		};
	}

	async lookup(): Promise<ModeEnrollment | undefined> {
		const client = await (this.#options.connect ?? connectDiscordMode)();
		try {
			return await client.lookup(
				await canonicalProjectDir(this.engine.sessionManager.getCwd()),
				this.engine.sessionManager.getSessionId(),
			);
		} finally {
			await client.close();
		}
	}

	async on(groupName: string, label: string): Promise<ModeSnapshot> {
		if (this.enabled) return this.status();
		await this.off();
		const epoch = this.#epoch;
		const identity = this.engine.sessionManager.getSessionId();
		const file = this.engine.sessionFile;
		if (!file) throw new Error("Discord mode requires a saved native session.");
		const current = () => epoch === this.#epoch && identity === this.engine.sessionManager.getSessionId();
		await this.engine.sessionManager.ensureOnDisk();
		await this.engine.sessionManager.flush();
		const projectDir = await canonicalProjectDir(this.engine.sessionManager.getCwd());
		const journal = new DiscordReceiptJournal(
			path.join(this.#options.receiptRoot ?? discordModePaths().root, "receipts", `${identity}.json`),
		);
		await journal.load();
		if (!current()) throw new Error("Session changed during Discord enrollment.");
		const client = await (this.#options.connect ?? connectDiscordMode)();
		let snapshot: ModeSnapshot;
		try {
			if (!current()) throw new Error("Session changed during Discord enrollment.");
			snapshot = await client.request({
				op: "register",
				requestId: crypto.randomUUID(),
				sessionId: identity,
				sessionFile: file,
				projectDir,
				connectionId: crypto.randomUUID(),
				label,
				groupName,
			});
			if (!snapshot.lease) throw new Error("Discord broker did not grant a session lease.");
			if (!current()) {
				await client.request({ op: "off", lease: snapshot.lease });
				throw new Error("Session changed during Discord enrollment.");
			}
		} catch (error) {
			await client.close();
			throw error;
		}
		this.#client = client;
		this.#lease = snapshot.lease;
		this.#identity = identity;
		this.#sessionFile = file;
		this.#journal = journal;
		this.#intakeHeld = false;
		enrolledFiles.set(file, this);
		this.#unsubscribe = this.engine.subscribe(event => this.#event(event));
		this.#applySnapshot(snapshot);
		this.#schedulePoll();
		return snapshot;
	}

	/** Invalidate synchronously before awaiting I/O; off never aborts local work or deletes resources. */
	async off(): Promise<void> {
		this.#epoch++;
		const client = this.#client;
		const lease = this.#lease;
		this.#client = undefined;
		this.#lease = undefined;
		this.#identity = undefined;
		this.#active = undefined;
		this.#localDialogs = 0;
		this.#transportAvailable = false;
		this.#queue = [];
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		if (this.#sessionFile && enrolledFiles.get(this.#sessionFile) === this) enrolledFiles.delete(this.#sessionFile);
		this.#dialogs.unavailable();
		this.#renderStatus();
		if (!client) return;
		const deadline = new AbortController();
		const timeout = setTimeout(() => deadline.abort(), 1500);
		const { promise, resolve } = Promise.withResolvers<void>();
		deadline.signal.addEventListener("abort", () => resolve(), { once: true });
		try {
			await Promise.race([
				lease
					? client
							.request({ op: "off", lease })
							.then(() => {})
							.catch(() => {})
					: Promise.resolve(),
				promise,
			]);
		} finally {
			clearTimeout(timeout);
			await client.close().catch(() => {});
		}
	}

	status(): Promise<ModeSnapshot> {
		return this.#request({ op: "status", lease: this.#requireLease() });
	}

	async rename(target: "session" | "group", name: string): Promise<ModeSnapshot> {
		return this.#request({ op: "rename", lease: this.#requireLease(), requestId: crypto.randomUUID(), target, name });
	}

	async repair(
		target: "session" | "group",
		destinationId: string | undefined,
		resumeQueued: boolean,
	): Promise<ModeSnapshot> {
		const snapshot = await this.#request({
			op: "repair",
			lease: this.#requireLease(),
			requestId: crypto.randomUUID(),
			target,
			destinationId,
			resumeQueued,
		});
		this.#intakeHeld = false;
		this.#renderStatus();
		return snapshot;
	}

	async send(recipientId: string, text: string, requestId: string): Promise<ModeSnapshot> {
		return this.#request({ op: "send", lease: this.#requireLease(), requestId, recipientId, text });
	}

	async report(text: string, requestId: string): Promise<ModeSnapshot> {
		const snapshot = await this.#request({ op: "report", lease: this.#requireLease(), requestId, text });
		if (this.#active) this.#active.reported = true;
		return snapshot;
	}

	async resolveDelivery(deliveryId: string): Promise<ModeSnapshot> {
		return this.#request({
			op: "resolve-delivery",
			lease: this.#requireLease(),
			requestId: crypto.randomUUID(),
			deliveryId,
		});
	}

	requestDialog(dialog: Omit<ModeDialog, "id">, signal?: AbortSignal): Promise<DiscordDialogResult> {
		if (!this.enabled || !this.#snapshot?.gatewayConnected || this.#snapshot.session.state !== "ready") {
			return Promise.resolve({ kind: "unavailable" });
		}
		return this.#dialogs.request(dialog, signal);
	}

	/** Public single-flight seam also permits deterministic offline exercising of the real adapter. */
	async poll(): Promise<void> {
		if (this.#polling || !this.#lease) return;
		if (!this.enabled) {
			await this.off();
			return;
		}
		this.#polling = true;
		const epoch = this.#epoch;
		try {
			await this.#request({
				op: "poll",
				lease: this.#requireLease(),
				busy: this.#busy(),
				pendingInput: this.pendingInput,
			});
			if (epoch === this.#epoch && this.enabled && !this.#intakeHeld) await this.#drain(epoch);
		} catch {
			if (epoch === this.#epoch) {
				this.#dialogs.unavailable();
				this.#transportAvailable = false;
				this.#renderStatus();
			}
		} finally {
			this.#polling = false;
		}
	}

	#schedulePoll(): void {
		if (!this.enabled || this.#timer || this.#options.pollIntervalMs === 0) return;
		const epoch = this.#epoch;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.poll().finally(() => {
				if (epoch === this.#epoch) this.#schedulePoll();
			});
		}, this.#options.pollIntervalMs ?? 1000);
		this.#timer.unref();
	}

	#requireLease(): ModeLease {
		if (!this.enabled || !this.#lease)
			throw new Error("Discord mode is off for this session. Use /discord on locally.");
		return this.#lease;
	}

	async #request(input: ModeRequest): Promise<ModeSnapshot> {
		const client = this.#client;
		const epoch = this.#epoch;
		if (!client || !this.enabled) throw new Error("Discord mode is off for this session.");
		try {
			const snapshot = await client.request(input);
			if (epoch !== this.#epoch || !this.enabled)
				throw new Error("Discord session lease changed; result discarded.");
			this.#applySnapshot(snapshot, input.op === "poll");
			return snapshot;
		} catch (error) {
			if (epoch === this.#epoch && this.enabled && (input.op === "poll" || input.op === "status")) {
				this.#transportAvailable = false;
				this.#renderStatus();
			}
			throw error;
		}
	}

	#applySnapshot(snapshot: ModeSnapshot, intake = false): void {
		this.#snapshot = snapshot;
		this.#transportAvailable = true;
		if (!snapshot.gatewayConnected || snapshot.session.state !== "ready" || !snapshot.session.enabled)
			this.#dialogs.unavailable();
		else for (const answer of snapshot.answers) this.#dialogs.answer(answer);
		for (const delivery of snapshot.deliveries) {
			if (
				!intake ||
				delivery.state !== "dispatched" ||
				delivery.sessionId !== this.#identity ||
				this.#journal?.has(delivery.id) ||
				this.#queue.some(item => item.id === delivery.id)
			)
				continue;
			if (this.#queue.length >= DISCORD_MODE_MAX_PENDING) {
				this.#intakeHeld = true;
				break;
			}
			if (delivery.kind === "message") this.#queue.push(delivery);
			else this.#queue.unshift(delivery);
		}
		this.#renderStatus();
	}

	#busy(): boolean {
		return Boolean(
			this.#active ||
			this.engine.isStreaming ||
			this.engine.hasAdmittedSubmission ||
			this.engine.queuedMessageCount ||
			this.pendingInput ||
			this.#options.pendingLocalInput?.() ||
			this.#options.isWorking?.(),
		);
	}

	#renderStatus(): void {
		this.#options.status?.(this.presentation.footer);
	}

	async #receipt(delivery: ModeDelivery, state: "accepted" | "completed" | "rejected", text?: string): Promise<void> {
		const epoch = this.#epoch;
		const lease = this.#requireLease();
		await this.#journal?.save({ id: delivery.id, state });
		if (epoch !== this.#epoch || !this.enabled) return;
		await this.#request({ op: "receipt", lease, deliveryId: delivery.id, state, text });
	}

	async #drain(epoch: number): Promise<void> {
		if (!this.#snapshot?.session.enabled) return;
		while (epoch === this.#epoch && this.enabled && this.#queue.length) {
			const remoteReady =
				this.#snapshot.gatewayConnected &&
				this.#snapshot.session.state === "ready" &&
				this.#snapshot.group.state === "ready";
			const index = remoteReady ? 0 : this.#queue.findIndex(delivery => delivery.source === "peer");
			if (index < 0) return;
			const delivery = this.#queue[index]!;
			if (delivery.kind === "message" && this.#busy()) return;
			this.#queue.splice(index, 1);
			if (this.#journal?.has(delivery.id)) continue;
			try {
				await this.#journal?.save({ id: delivery.id, state: "attempted" });
				if (epoch !== this.#epoch || !this.enabled) return;
				if (delivery.source !== "owner" && delivery.kind !== "message") {
					await this.#receipt(delivery, "rejected");
					continue;
				}
				if (delivery.kind === "message" && this.#busy()) {
					await this.#receipt(
						delivery,
						"rejected",
						"Local input won the intake race; resend explicitly when idle.",
					);
					continue;
				}
				await this.#receipt(delivery, "accepted");
				if (epoch !== this.#epoch || !this.enabled) return;
				if (delivery.kind === "abort") {
					if (this.#active) this.#active.contaminated = true;
					await this.engine.abort({ reason: "Discord owner requested abort" });
					if (epoch === this.#epoch && this.enabled) await this.#receipt(delivery, "completed");
					continue;
				}
				const content =
					delivery.source === "owner"
						? promptRenderer.render(ownerTemplate, {
								from: delivery.from,
								deliveryId: delivery.id,
								text: delivery.text,
							})
						: promptRenderer.render(peerTemplate, {
								payload: JSON.stringify({ from: delivery.from, deliveryId: delivery.id, text: delivery.text }),
							});
				const message = {
					customType: delivery.source === "owner" ? COLLAB_PROMPT_MESSAGE_TYPE : "discord-peer",
					content,
					display: true,
					details: {
						deliveryId: delivery.id,
						from: delivery.source === "owner" ? `Discord owner ${delivery.from}` : delivery.from,
					},
					attribution: delivery.source === "owner" ? ("user" as const) : ("agent" as const),
				};
				if (delivery.kind === "steer" && this.engine.isStreaming) {
					if (this.#active) this.#active.contaminated = true;
					await this.engine.promptCustomMessage(message, { streamingBehavior: "steer" });
					if (epoch === this.#epoch && this.enabled) await this.#receipt(delivery, "completed");
					continue;
				}
				this.#active = {
					delivery,
					contaminated:
						this.engine.isStreaming || this.engine.hasAdmittedSubmission || this.engine.queuedMessageCount > 0,
					reported: false,
				};
				// Native custom prompts capture the generation before async preprocessing; owner attribution converts to a user turn.
				const turn = this.engine.promptCustomMessage(message, { streamingBehavior: "aside" });
				void turn.then(
					forwarded => {
						if (!forwarded && epoch === this.#epoch) void this.#finishWithoutOutput(delivery, epoch);
					},
					() => {
						if (epoch === this.#epoch) void this.#finishWithoutOutput(delivery, epoch);
					},
				);
				return;
			} catch {
				if (epoch === this.#epoch) {
					this.#intakeHeld = true;
					this.#options.notify?.(
						"Discord intake outcome uncertain; no automatic replay. Inspect /discord status, then /discord reconcile before explicitly resuming queued work.",
					);
					this.#renderStatus();
				}
				return;
			}
		}
	}

	async #finishWithoutOutput(delivery: ModeDelivery, epoch: number): Promise<void> {
		if (this.#active?.delivery.id !== delivery.id || epoch !== this.#epoch) return;
		this.#active = undefined;
		try {
			await this.#receipt(delivery, "completed");
		} catch {
			/* Attempt remains durable; never reinject. */
		}
	}

	#event(event: AgentSessionEvent): void {
		if (!this.enabled) return;
		this.#renderStatus();
		const active = this.#active;
		if (!active) return;
		if (event.type === "message_start") {
			const message = event.message;
			if (
				message.role === "custom" &&
				(message.customType === "discord-peer" || message.customType === COLLAB_PROMPT_MESSAGE_TYPE) &&
				message.details &&
				typeof message.details === "object" &&
				"deliveryId" in message.details &&
				message.details.deliveryId === active.delivery.id
			) {
				if (!active.boundary) active.boundary = message;
				else active.contaminated = true;
			} else if (message.role === "user" || (message.role === "custom" && message.attribution === "user"))
				active.contaminated = true;
		}
		if (event.type !== "agent_end" || event.isTerminal === false || !active.boundary) return;
		const boundary = event.messages.indexOf(active.boundary);
		if (boundary < 0) return;
		let last: AgentMessage | undefined;
		for (let index = boundary + 1; index < event.messages.length; index++) {
			const message = event.messages[index]!;
			if (message.role === "user" || (message.role === "custom" && message.attribution === "user"))
				active.contaminated = true;
			if (message.role === "assistant") last = message;
		}
		let text: string | undefined;
		if (
			active.delivery.source === "owner" &&
			!active.contaminated &&
			!active.reported &&
			last?.role === "assistant" &&
			last.stopReason === "stop"
		) {
			const final = last.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.join("\n");
			const suffix = "\n[response truncated]";
			text =
				Buffer.byteLength(final) > DISCORD_MODE_MAX_TEXT
					? truncateHeadBytes(final, DISCORD_MODE_MAX_TEXT - Buffer.byteLength(suffix)).text + suffix
					: final;
		}
		this.#active = undefined;
		void this.#receipt(active.delivery, "completed", text || undefined).catch(() => {
			this.#options.notify?.("Discord result delivery is uncertain; it will not be posted again automatically.");
		});
	}
}

export function getDiscordModeSession(session: DiscordSessionEngine): DiscordModeSession | undefined {
	return sessions.get(session);
}

export function ensureDiscordModeSession(ctx: InteractiveModeContext): DiscordModeSession {
	let mode = sessions.get(ctx.session);
	if (!mode) {
		mode = new DiscordModeSession(ctx.session, {
			status: text => ctx.setHookStatus("discord-mode", text),
			notify: text => ctx.showWarning(text),
			pendingLocalInput: () => ctx.editor.getText().trim().length > 0,
			isWorking: () =>
				ctx.session.isBashRunning ||
				ctx.session.isEvalRunning ||
				ctx.session.isCompacting ||
				ctx.session.isGeneratingHandoff ||
				ctx.session.isRetrying,
		});
		sessions.set(ctx.session, mode);
	}
	return mode;
}

export function discordModeSessionForFile(
	file: string | null,
	sessionId: string | null,
): DiscordModeSession | undefined {
	const mode = file ? enrolledFiles.get(file) : undefined;
	return mode?.enabled && mode.engine.sessionManager.getSessionId() === sessionId ? mode : undefined;
}

export async function invalidateDiscordModeSession(session: DiscordSessionEngine): Promise<void> {
	await sessions.get(session)?.off();
}

export async function disposeDiscordModeSession(session: DiscordSessionEngine): Promise<void> {
	const mode = sessions.get(session);
	sessions.delete(session);
	await mode?.off();
}
