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
import { discordModePaths, loadDiscordModeConfig } from "./config";
import { DiscordDialogs, type DiscordDialogResult } from "./dialog";
import { readPrivateJson, writePrivateJson } from "@oh-my-pi/pi-utils/discord-private-files";
import { describeDiscordMode, type DiscordModePresentation } from "./presentation";
import { readDiscordSharedSessions } from "./retirement-events";
import { createDiscordSettingsHost } from "./settings-host";
import { DiscordModeRequestError, sealModeSettingsView } from "@oh-my-pi/pi-utils/discord-client";
import {
	DISCORD_MODE_MAX_PENDING,
	DISCORD_MODE_MAX_REPLY,
	DISCORD_MODE_MAX_TEXT,
	type ModeDelivery,
	type ModeDialog,
	type ModeEnrollment,
	type ModeLease,
	type ModeRequest,
	type ModeSettingCommand,
	type ModeSettingsView,
	type ModeSnapshot,
	type ModeUsage,
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
	| "waitForSessionTransition"
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

export interface DiscordSettingResult {
	outcome: "applied" | "rejected" | "failed";
	/** Shown to the Discord owner verbatim; plain, credential-free. */
	text: string;
}

/** What a host lets its Discord owner see and change. Only `apply` mutates, and only while the session is idle. */
export interface DiscordSettingsHost {
	/** Undefined while there is nothing to report (no model yet, or the host moved to another engine). */
	view(): Omit<ModeSettingsView, "revision"> | undefined;
	usage(): ModeUsage | undefined;
	apply(command: ModeSettingCommand): Promise<DiscordSettingResult>;
}

export interface DiscordSessionOptions {
	connect?: () => Promise<DiscordSessionClient>;
	receiptRoot?: string;
	pollIntervalMs?: number;
	status?: (text: string | undefined) => void;
	notify?: (text: string) => void;
	pendingLocalInput?: () => boolean;
	isWorking?: () => boolean;
	/** Offline check that saved broker state still shares this conversation; default reads it without connecting. */
	shared?: () => Promise<boolean>;
	/** Delay before the one rejoin retry while another process still holds the conversation's lease. */
	rejoinRetryMs?: number;
	/** Discord settings panel support; without it the session reports no settings and never applies changes. */
	settings?: DiscordSettingsHost;
}

const sessions = new WeakMap<DiscordSessionEngine, DiscordModeSession>();
const enrolledFiles = new Map<string, DiscordModeSession>();

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
/** A register whose response was lost may still own a lease until expiry; never mistake it for a foreign owner. */
const MAX_ATTEMPTED_CONNECTIONS = 16;
/**
 * Service mismatches (the `DiscordModeClient.probe` config/protocol errors) need an explicit owner decision; every
 * other reconnect failure is retried with backoff.
 */
const MANUAL_RECONNECT_FAILURE = /configuration differs|protocol does not match/;
/** One broker lease (45 s) plus margin: a crashed or just-closed process has released it by then. */
const REJOIN_RETRY_MS = 50_000;
/** Expected refusals during automatic rejoin (sharing turned off meanwhile, or the conversation changed): stay quiet. */
const QUIET_REJOIN_FAILURE = /automatic rejoin skipped|Session changed during Discord enrollment/;
/** A reported settings view is rebuilt at most this often, and after every applied change. */
const SETTINGS_REFRESH_MS = 5_000;
/** Applied results remembered to re-send a lost acknowledgement instead of applying twice. */
const SETTLED_COMMANDS = 32;

/** The broker's stored form: canonical directory plus basename. */
async function canonicalSessionFile(file: string): Promise<string> {
	return path.join(await canonicalProjectDir(path.dirname(file)), path.basename(file));
}

/** Offline gate: saved broker state shares this exact conversation under the configured account. Never connects. */
async function sharedOffline(engine: DiscordSessionEngine): Promise<boolean> {
	const file = engine.sessionFile;
	if (!file) return false;
	const sessionId = engine.sessionManager.getSessionId();
	const shared = (await readDiscordSharedSessions()).find(session => session.sessionId === sessionId);
	if (!shared) return false;
	try {
		const config = await loadDiscordModeConfig();
		if (shared.guildId !== config.guildId || shared.ownerId !== config.ownerId) return false;
	} catch {
		return false;
	}
	return shared.sessionFile === (await canonicalSessionFile(file).catch(() => undefined));
}

/** Drop a lease but keep sharing; brokers without `detach` reject it unexecuted and get their only release, `off`. */
async function releaseLease(client: DiscordSessionClient, lease: ModeLease): Promise<void> {
	try {
		await client.request({ op: "detach", lease });
	} catch (error) {
		if (error instanceof DiscordModeRequestError && error.outcome === "not-started")
			await client.request({ op: "off", lease }).catch(() => {});
	}
}

/** Bounded best-effort goodbye on a released connection; the connection always closes. */
async function release(client: DiscordSessionClient, send: () => Promise<void>): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timeout = setTimeout(resolve, 1500);
	try {
		await Promise.race([send().catch(() => {}), promise]);
	} finally {
		clearTimeout(timeout);
		await client.close().catch(() => {});
	}
}

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
	/** Lease swaps keep the epoch (local dialogs, subscription, journal) but fence every older lease's results. */
	#generation = 0;
	#polling = false;
	/** Monotonic deadline, set while a reconnect is due or in flight; polls on the dead lease are skipped until then. */
	#reconnectAt?: number;
	#reconnectDelay = RECONNECT_BASE_MS;
	/** Why automatic reconnect stopped; only an explicit off/on (or a working lease) clears it. */
	#reconnectBlocked?: string;
	#attemptedConnections = new Set<string>();
	#timer?: NodeJS.Timeout;
	#unsubscribe?: () => void;
	#queue: ModeDelivery[] = [];
	#active?: ActiveDelivery;
	#intakeHeld = false;
	#localDialogs = 0;
	#dialogs: DiscordDialogs;
	#options: DiscordSessionOptions;
	/** Automatic rejoin in flight or its single retry pending; the footer reads REJOINING meanwhile. */
	#rejoining = false;
	#rejoinTimer?: NodeJS.Timeout;
	/** Set by a successful automatic rejoin; the footer says so until local activity. */
	#rejoined = false;
	/** Owner settings changes received on this lease and not yet applied, oldest first. */
	#commands: ModeSettingCommand[] = [];
	/** Results already applied on this lease; a repeated command re-sends its result, never applies twice. */
	#settled = new Map<string, DiscordSettingResult>();
	#acknowledging = new Set<string>();
	#applying = false;
	#settingsView?: { at: number; view: ModeSettingsView };

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
			reconnectBlocked: this.#reconnectBlocked,
			intakeHeld: this.#intakeHeld,
			pendingInput: this.pendingInput,
			working: this.engine.isStreaming || this.#options.isWorking?.(),
			rejoining: this.#rejoining || this.#rejoinTimer !== undefined,
			rejoined: this.#rejoined,
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

	/** `rejoin` is automatic resume only: the broker refuses unless it still shares this conversation. */
	async on(groupName: string, label: string, options: { rejoin?: boolean } = {}): Promise<ModeSnapshot> {
		if (this.enabled) return this.status();
		await this.detach();
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
				...(options.rejoin ? { rejoin: true as const } : {}),
			});
			if (!snapshot.lease) throw new Error("Discord broker did not grant a session lease.");
			if (!current()) {
				await releaseLease(client, snapshot.lease);
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

	/**
	 * Resume sharing a reopened conversation. Never enrolls, names, or creates anything: the broker must still have
	 * this exact identity enabled, and `rejoin` makes it refuse if sharing was turned off in the meantime.
	 */
	async rejoin(retried = false): Promise<ModeSnapshot | undefined> {
		const identity = this.engine.sessionManager.getSessionId();
		const file = this.engine.sessionFile;
		if (this.enabled || this.#rejoining || !file) return undefined;
		clearTimeout(this.#rejoinTimer);
		this.#rejoinTimer = undefined;
		this.#rejoining = true;
		this.#renderStatus();
		const epoch = this.#epoch;
		const current = () =>
			epoch === this.#epoch &&
			identity === this.engine.sessionManager.getSessionId() &&
			file === this.engine.sessionFile;
		let label: string | undefined;
		try {
			const enrollment = await this.lookup();
			const shared = enrollment?.session;
			if (!current() || !enrollment || shared?.id !== identity || shared.retirement || !shared.enabled)
				return undefined;
			const sameFile = (await canonicalSessionFile(shared.sessionFile)) === (await canonicalSessionFile(file));
			if (!sameFile || !current()) return undefined;
			label = shared.label;
			if (shared.connected) {
				if (retried)
					this.#options.notify?.(
						`Discord: #${shared.label} is open in another window, so this one stays local. Close it there, then use /discord on here.`,
					);
				else {
					// A crashed or just-closed process still holds the lease until it expires; never displace a live one.
					this.#rejoinTimer = setTimeout(() => {
						this.#rejoinTimer = undefined;
						if (epoch === this.#epoch) void this.rejoin(true);
					}, this.#options.rejoinRetryMs ?? REJOIN_RETRY_MS);
					this.#rejoinTimer.unref();
				}
				return undefined;
			}
			const snapshot = await this.on(enrollment.group.name, shared.label, { rejoin: true });
			this.#rejoined = true;
			const attached = this.#epoch;
			let held = 0;
			try {
				const status = await this.status();
				held = status.deliveries.filter(item => item.state === "queued" || item.state === "unknown").length;
			} catch {
				/* Polling surfaces transport trouble; the held count is advisory. */
			}
			if (held && attached === this.#epoch)
				this.#options.notify?.(
					`Discord rejoined #${shared.label}; ${held} held or uncertain message(s) need /discord repair or /discord reconcile.`,
				);
			return snapshot;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!QUIET_REJOIN_FAILURE.test(message))
				this.#options.notify?.(
					`Discord couldn't rejoin${label ? ` #${label}` : " this conversation"}: ${
						// Brokers from before automatic rejoin refuse the flag without executing anything.
						/Invalid Discord request/.test(message)
							? "the running Discord service predates automatic rejoin; restart it."
							: message
					} Use /discord on to retry.`,
				);
			return undefined;
		} finally {
			this.#rejoining = false;
			this.#renderStatus();
		}
	}

	/** Invalidate synchronously before awaiting I/O; never aborts local work or deletes resources. */
	#teardown(): { client?: DiscordSessionClient; lease?: ModeLease } {
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
		this.#clearCommands();
		this.#reconnectAt = undefined;
		this.#reconnectDelay = RECONNECT_BASE_MS;
		this.#reconnectBlocked = undefined;
		this.#attemptedConnections.clear();
		clearTimeout(this.#rejoinTimer);
		this.#rejoinTimer = undefined;
		this.#rejoined = false;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		if (this.#sessionFile && enrolledFiles.get(this.#sessionFile) === this) enrolledFiles.delete(this.#sessionFile);
		this.#dialogs.unavailable();
		this.#renderStatus();
		return { client, lease };
	}

	/**
	 * Close this conversation locally but keep it shared: the broker holds its queued work, and resuming it later
	 * rejoins the same channel. Older brokers without `detach` get `off`, their previous close behavior.
	 */
	async detach(): Promise<void> {
		const { client, lease } = this.#teardown();
		if (client)
			await release(client, async () => {
				if (lease) await releaseLease(client, lease);
			});
	}

	/** Explicit and sticky: sharing stays off, also across resume, until /discord on. Works when not attached here. */
	async off(): Promise<void> {
		const { client, lease } = this.#teardown();
		let done = false;
		if (client)
			await release(client, async () => {
				if (!lease) return;
				await client.request({ op: "off", lease });
				done = true;
			});
		if (!done) await this.#disable();
	}

	/** Turn sharing off by identity when no working lease is held here; conversations that aren't shared are skipped. */
	async #disable(): Promise<void> {
		const file = this.engine.sessionFile;
		if (!file || !(await (this.#options.shared?.() ?? sharedOffline(this.engine)))) return;
		const sessionId = this.engine.sessionManager.getSessionId();
		const client = await (this.#options.connect ?? connectDiscordMode)();
		try {
			const projectDir = await canonicalProjectDir(this.engine.sessionManager.getCwd());
			const shared = (await client.lookup(projectDir, sessionId))?.session;
			if (!shared?.enabled || shared.retirement) return;
			await client.request({ op: "disable", sessionId, sessionFile: file, projectDir });
		} catch (error) {
			if (error instanceof DiscordModeRequestError && error.outcome === "not-started")
				throw new Error(
					"The running Discord service did not accept turning sharing off. If it predates this Haiso version, restart it, then run /discord off again.",
				);
			throw error;
		} finally {
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
			// The engine moved to another conversation; the previous one stays shared.
			await this.detach();
			return;
		}
		// A lost lease never recovers by polling it again; wait out the reconnect backoff instead.
		if (this.#reconnectAt !== undefined && performance.now() < this.#reconnectAt) return;
		this.#polling = true;
		const epoch = this.#epoch;
		const generation = this.#generation;
		try {
			if (this.#reconnectAt !== undefined) {
				await this.#reconnect(epoch);
				return;
			}
			const snapshot = await this.#request({
				op: "poll",
				lease: this.#requireLease(),
				busy: this.#busy(),
				pendingInput: this.pendingInput,
				...this.#settingsReport(),
			});
			// Settings apply first, so the next owner message already runs with them.
			if (this.#current(epoch, generation)) this.#intakeCommands(snapshot.commands ?? [], epoch, generation);
			if (this.#current(epoch, generation) && !this.#intakeHeld) await this.#drain(epoch, generation);
		} catch {
			if (epoch === this.#epoch && generation === this.#generation) {
				this.#dialogs.unavailable();
				this.#transportAvailable = false;
				this.#renderStatus();
			}
		} finally {
			this.#polling = false;
		}
	}

	/** Settings ride polls only to brokers that advertise them, and the full view only when its revision changed. */
	#settingsReport(): { settings?: ModeSettingsView; usage?: ModeUsage } {
		const revision = this.#snapshot?.settingsRevision;
		if (!this.#options.settings || revision === undefined) return {};
		const view = this.#currentSettings();
		const usage = this.#usage();
		return { ...(view && view.revision !== revision ? { settings: view } : {}), ...(usage ? { usage } : {}) };
	}

	#currentSettings(): ModeSettingsView | undefined {
		const now = performance.now();
		if (this.#settingsView && now - this.#settingsView.at < SETTINGS_REFRESH_MS) return this.#settingsView.view;
		let view: ModeSettingsView | undefined;
		try {
			const report = this.#options.settings?.view();
			view = report ? sealModeSettingsView(report) : undefined;
		} catch {
			// A host that cannot describe itself reports nothing; polling and delivery continue.
		}
		this.#settingsView = view ? { at: now, view } : undefined;
		return view;
	}

	#usage(): ModeUsage | undefined {
		try {
			return this.#options.settings?.usage();
		} catch {
			return undefined;
		}
	}

	#intakeCommands(commands: ModeSettingCommand[], epoch: number, generation: number): void {
		for (const command of commands) {
			const settled = this.#settled.get(command.id);
			if (settled) void this.#acknowledge(command.id, settled, epoch, generation);
			else if (!this.#commands.some(item => item.id === command.id)) this.#commands.push(command);
		}
		if (this.#commands.length && !this.#busy()) void this.#applyCommands(epoch, generation);
	}

	/** Detached from polling: a compaction can outlast the lease, so heartbeats continue while it runs. */
	async #applyCommands(epoch: number, generation: number): Promise<void> {
		this.#applying = true;
		try {
			while (this.#current(epoch, generation) && this.#commands.length && !this.#engineBusy()) {
				const command = this.#commands.shift()!;
				let result: DiscordSettingResult;
				try {
					result = this.#options.settings
						? await this.#options.settings.apply(command)
						: { outcome: "rejected", text: "This session can't change its settings from Discord." };
				} catch (error) {
					result = {
						outcome: "failed",
						text: `Failed: ${error instanceof Error ? error.message : String(error)}`,
					};
				}
				this.#settingsView = undefined;
				if (!this.#current(epoch, generation)) return;
				this.#settled.set(command.id, result);
				if (this.#settled.size > SETTLED_COMMANDS) this.#settled.delete(this.#settled.keys().next().value!);
				await this.#acknowledge(command.id, result, epoch, generation);
			}
		} finally {
			if (epoch === this.#epoch && generation === this.#generation) this.#applying = false;
		}
	}

	async #acknowledge(
		commandId: string,
		result: DiscordSettingResult,
		epoch: number,
		generation: number,
	): Promise<void> {
		if (this.#acknowledging.has(commandId) || !this.#current(epoch, generation)) return;
		this.#acknowledging.add(commandId);
		try {
			const view = this.#currentSettings();
			const usage = this.#usage();
			await this.#request({
				op: "command-result",
				lease: this.#requireLease(),
				commandId,
				outcome: result.outcome,
				text:
					result.text
						.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, " ")
						.slice(0, 500)
						.trim() || result.outcome,
				...(view ? { settings: view } : {}),
				...(usage ? { usage } : {}),
			});
		} catch {
			// The broker repeats an unacknowledged command on the next poll; the settled result is re-sent then.
		} finally {
			this.#acknowledging.delete(commandId);
		}
	}

	#clearCommands(): void {
		this.#commands = [];
		this.#settled.clear();
		this.#acknowledging.clear();
		this.#applying = false;
		this.#settingsView = undefined;
	}

	/**
	 * Re-lease the same enrolled conversation after its lease was lost (sleep, stall, broker restart). Never registers
	 * an unknown session (that would create a channel), never replays work, and never goes through off/on, which would
	 * drop local dialog state, the engine subscription, and the receipt journal.
	 */
	async #reconnect(epoch: number): Promise<void> {
		const identity = this.#identity;
		const file = this.#sessionFile;
		const previous = this.#lease;
		const generation = this.#generation;
		if (!identity || !file || !previous) return;
		if (this.engine.sessionFile !== file) {
			this.#blockReconnect("This session's file changed since it was shared with Discord.");
			return;
		}
		const live = () => this.#current(epoch, generation) && this.engine.sessionFile === file;
		let client: DiscordSessionClient | undefined;
		try {
			// A fresh connection also restarts a broker that exited.
			client = await (this.#options.connect ?? connectDiscordMode)();
			if (!live()) return;
			const projectDir = await canonicalProjectDir(this.engine.sessionManager.getCwd());
			const enrollment = await client.lookup(projectDir, identity);
			if (!live()) return;
			const retained = enrollment?.session;
			if (!enrollment || retained?.id !== identity) {
				this.#blockReconnect(
					"Discord no longer has this session's enrollment; reconnecting would create a new channel.",
				);
				return;
			}
			if (retained.retirement) {
				await this.detach();
				this.#options.notify?.("This conversation was deleted from Discord; Discord mode is off.");
				return;
			}
			if (!retained.enabled) {
				this.#blockReconnect("Discord mode was turned off for this session elsewhere.");
				return;
			}
			const sameFile = (await canonicalSessionFile(retained.sessionFile)) === (await canonicalSessionFile(file));
			if (!live()) return;
			if (!sameFile) {
				this.#blockReconnect("Discord binds this session to a different session file.");
				return;
			}
			const ours = retained.connectionId === previous.connectionId;
			if (retained.connected && !ours && !this.#attemptedConnections.has(retained.connectionId)) {
				this.#blockReconnect("Another process holds this session's Discord connection.");
				return;
			}
			// Our own lease may still be live behind a dead or flaky transport.
			let snapshot =
				retained.connected && ours
					? await client.request({ op: "status", lease: previous }).catch(() => undefined)
					: undefined;
			if (!live()) return;
			let lease = previous;
			if (!snapshot) {
				const connectionId = crypto.randomUUID();
				this.#attemptedConnections.add(connectionId);
				if (this.#attemptedConnections.size > MAX_ATTEMPTED_CONNECTIONS)
					this.#attemptedConnections.delete(this.#attemptedConnections.values().next().value!);
				snapshot = await client.request({
					op: "register",
					requestId: crypto.randomUUID(),
					sessionId: identity,
					sessionFile: file,
					projectDir,
					connectionId,
					label: retained.label,
					groupName: enrollment.group.name,
				});
				if (!snapshot.lease) throw new Error("Discord broker did not grant a session lease.");
				if (!live()) {
					await releaseLease(client, snapshot.lease);
					return;
				}
				lease = snapshot.lease;
			}
			const replaced = this.#client;
			this.#client = client;
			client = replaced === client ? undefined : replaced;
			this.#reconnectAt = undefined;
			this.#reconnectDelay = RECONNECT_BASE_MS;
			this.#attemptedConnections.clear();
			if (lease === previous) {
				this.#applySnapshot(snapshot);
				return;
			}
			this.#lease = lease;
			this.#generation++;
			// Old-generation deliveries are unknown or held on the broker now; the journal already fences reinjection.
			this.#queue = [];
			this.#active = undefined;
			// The broker drops the old connection's settings changes and tells the owner; none is applied here.
			this.#clearCommands();
			this.#dialogs.unavailable();
			this.#applySnapshot(snapshot);
		} catch (error) {
			if (!live()) return;
			const message = error instanceof Error ? error.message : String(error);
			if (MANUAL_RECONNECT_FAILURE.test(message)) this.#blockReconnect(message);
			else this.#backoff();
			return;
		} finally {
			await client?.close().catch(() => {});
		}
		// Only a fresh registration reaches here. Surface broker-held work once; it is never resumed automatically.
		const generationAfter = this.#generation;
		let held: number;
		try {
			const status = await this.status();
			held = status.deliveries.filter(item => item.state === "queued" || item.state === "unknown").length;
		} catch {
			return; // #request already re-armed the reconnect backoff.
		}
		if (held && this.#current(epoch, generationAfter))
			this.#options.notify?.(
				`Discord reconnected; ${held} held or uncertain message(s) need /discord repair or /discord reconcile.`,
			);
	}

	#backoff(): void {
		this.#reconnectAt = performance.now() + this.#reconnectDelay;
		this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, RECONNECT_MAX_MS);
	}

	#blockReconnect(reason: string): void {
		this.#reconnectAt = undefined;
		this.#reconnectBlocked = reason;
		this.#transportAvailable = false;
		this.#renderStatus();
		this.#options.notify?.(`${reason} Automatic Discord reconnect stopped; use /discord off, then /discord on.`);
	}

	#current(epoch: number, generation: number): boolean {
		return epoch === this.#epoch && generation === this.#generation && this.enabled;
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
		const generation = this.#generation;
		if (!client || !this.enabled) throw new Error("Discord mode is off for this session.");
		try {
			const snapshot = await client.request(input);
			if (!this.#current(epoch, generation)) throw new Error("Discord session lease changed; result discarded.");
			if (input.op === "poll" || input.op === "status") {
				// A working lease needs no reconnect.
				this.#reconnectAt = undefined;
				this.#reconnectDelay = RECONNECT_BASE_MS;
				this.#reconnectBlocked = undefined;
			}
			this.#applySnapshot(snapshot, input.op === "poll");
			return snapshot;
		} catch (error) {
			if (this.#current(epoch, generation) && (input.op === "poll" || input.op === "status")) {
				this.#transportAvailable = false;
				if (this.#reconnectAt === undefined && this.#reconnectBlocked === undefined) this.#backoff();
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

	/** Applying an owner settings change counts as busy, so no owner message starts mid-change. */
	#busy(): boolean {
		return this.#applying || this.#engineBusy();
	}

	#engineBusy(): boolean {
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
		const generation = this.#generation;
		const lease = this.#requireLease();
		await this.#journal?.save({ id: delivery.id, state });
		if (!this.#current(epoch, generation)) return;
		await this.#request({ op: "receipt", lease, deliveryId: delivery.id, state, text });
	}

	async #drain(epoch: number, generation: number): Promise<void> {
		if (!this.#snapshot?.session.enabled) return;
		while (this.#current(epoch, generation) && this.#queue.length) {
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
				if (!this.#current(epoch, generation)) return;
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
				if (!this.#current(epoch, generation)) return;
				if (delivery.kind === "abort") {
					if (this.#active) this.#active.contaminated = true;
					await this.engine.abort({ reason: "Discord owner requested abort" });
					if (this.#current(epoch, generation)) await this.#receipt(delivery, "completed");
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
					if (this.#current(epoch, generation)) await this.#receipt(delivery, "completed");
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
				if (epoch === this.#epoch && generation === this.#generation) {
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
		this.#rejoined = false;
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
			// Old brokers omit maxReply and keep the report bound; never exceed this build's own limit.
			const limit = Math.min(this.#snapshot?.maxReply ?? DISCORD_MODE_MAX_TEXT, DISCORD_MODE_MAX_REPLY);
			const suffix = "\n[response truncated]";
			text =
				Buffer.byteLength(final) > limit
					? truncateHeadBytes(final, limit - Buffer.byteLength(suffix)).text + suffix
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
			settings: createDiscordSettingsHost(ctx),
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

/** Interactive TUI hosts only; RPC, print, and ACP never register, so they never join automatically. */
const hosts = new WeakMap<DiscordSessionEngine, InteractiveModeContext>();

/** Rejoin the host's current conversation if it is still shared; silent unless the broker refuses unexpectedly. */
async function rejoinDiscordModeSession(engine: DiscordSessionEngine): Promise<void> {
	const ctx = hosts.get(engine);
	if (!ctx || ctx.collabGuest || getDiscordModeSession(engine)?.enabled) return;
	// Offline first: never start the broker, or create the footer, for a conversation that was never shared.
	if (!(await sharedOffline(engine)) || hosts.get(engine) !== ctx) return;
	await ensureDiscordModeSession(ctx).rejoin();
}

/** Remember the interactive host and rejoin a resumed conversation that is still shared with Discord. */
export function startDiscordModeAutoRejoin(ctx: InteractiveModeContext): void {
	hosts.set(ctx.session, ctx);
	void rejoinDiscordModeSession(ctx.session).catch(() => {});
}

/** Session transitions close the previous conversation but keep it shared; the next one rejoins if it is shared. */
export async function invalidateDiscordModeSession(session: DiscordSessionEngine): Promise<void> {
	await sessions.get(session)?.detach();
	// Called inside the transition, so rejoin only after it (or its rollback) settles.
	if (hosts.has(session))
		void session
			.waitForSessionTransition()
			.then(() => rejoinDiscordModeSession(session))
			.catch(() => {});
}

/** A moved conversation file can never be rebound by the broker, so sharing it stops for good. */
export async function offDiscordModeSession(session: DiscordSessionEngine): Promise<void> {
	await (sessions.get(session) ?? new DiscordModeSession(session)).off().catch(() => {});
}

/** Closing keeps sharing; the conversation rejoins when it is resumed in an interactive TUI. */
export async function disposeDiscordModeSession(session: DiscordSessionEngine): Promise<void> {
	const mode = sessions.get(session);
	sessions.delete(session);
	hosts.delete(session);
	await mode?.detach();
}
