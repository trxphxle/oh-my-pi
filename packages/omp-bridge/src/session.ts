import { createHash, randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	connectExistingDiscordMode,
	DiscordModeRequestError,
	sealModeSettingsView,
} from "@oh-my-pi/pi-utils/discord-client";
import { ensurePrivateDirectory, readPrivateJson, writePrivateJson } from "@oh-my-pi/pi-utils/discord-private-files";
import {
	DISCORD_MODE_MAX_PENDING,
	DISCORD_MODE_MAX_REPLY,
	DISCORD_MODE_MAX_TEXT,
	type ModeDelivery,
	type ModeLease,
	type ModeProgress,
	type ModeRequest,
	type ModeSession,
	type ModeSettingCommand,
	type ModeSettingsView,
	type ModeSnapshot,
	type ModeUsage,
} from "@oh-my-pi/pi-wire/discord-mode";
import {
	BRIDGE_MESSAGE_SOURCE,
	BRIDGE_OWNER_MESSAGE_TYPE,
	BRIDGE_PEER_MESSAGE_TYPE,
	type BridgeAgentEnd,
	type BridgeConnection,
	type BridgeHost,
	type BridgeHostState,
	type BridgePeer,
	type BridgeSettingResult,
} from "./host";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_RECEIPTS = 4096;
const MAX_JOURNAL_BYTES = 1024 * 1024;
const owners = new Map<string, BridgeSession>();
const RECOVERY =
	"Bridge work is held; nothing will be replayed. Inspect /bridge status. For an uncertain delivery, detach and reattach locally, then use /bridge reconcile. Resume queued work only with explicit /bridge repair.";
/** One broker lease (45 s) plus margin: a crashed or just-closed window has released it by then. */
const REJOIN_RETRY_MS = 50_000;
const MAX_STATE_BYTES = 24 * 1024 * 1024;
/** A reported settings view is rebuilt at most this often, and after every applied change. */
const SETTINGS_REFRESH_MS = 5_000;
/** Applied results remembered to re-send a lost acknowledgement instead of applying twice. */
const SETTLED_COMMANDS = 32;

type ReceiptState = "attempted" | "accepted" | "settled" | "held" | "resolved";
interface Receipt {
	id: string;
	kind: "delivery" | "effect";
	state: ReceiptState;
	fingerprint?: string;
}
interface Identity {
	sessionId: string;
	sessionFile: string;
	projectDir: string;
}

/** IDs are never evicted: reaching the bound stops intake instead of losing replay fences. */
class ReceiptJournal {
	#entries = new Map<string, Receipt>();
	#serial: Promise<void> = Promise.resolve();
	constructor(
		readonly file: string,
		readonly identity: Identity,
	) {}

	async load(): Promise<void> {
		const value = await readPrivateJson(this.file, MAX_JOURNAL_BYTES);
		if (value === undefined) return;
		if (
			!record(value) ||
			value.version !== 1 ||
			value.sessionId !== this.identity.sessionId ||
			value.sessionFile !== this.identity.sessionFile ||
			value.projectDir !== this.identity.projectDir ||
			!Array.isArray(value.entries) ||
			value.entries.length > MAX_RECEIPTS
		) {
			throw new Error("Invalid bridge receipt journal; retain it and inspect private storage locally.");
		}
		for (const item of value.entries as unknown[]) {
			if (
				!record(item) ||
				typeof item.id !== "string" ||
				(item.kind !== "delivery" && item.kind !== "effect") ||
				!(item.kind === "delivery" ? UUID : REQUEST_ID).test(item.id) ||
				!["attempted", "accepted", "settled", "held", "resolved"].includes(String(item.state)) ||
				(item.kind === "effect" &&
					(typeof item.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(item.fingerprint)))
			) {
				throw new Error("Invalid bridge receipt journal; intake is disabled.");
			}
			const receipt = item as unknown as Receipt;
			const key = `${receipt.kind}:${receipt.id}`;
			if (this.#entries.has(key)) throw new Error("Duplicate bridge receipt journal identity; intake is disabled.");
			this.#entries.set(key, {
				id: receipt.id,
				kind: receipt.kind,
				state: receipt.state,
				...(receipt.fingerprint ? { fingerprint: receipt.fingerprint } : {}),
			});
		}
	}

	get(kind: Receipt["kind"], id: string): Receipt | undefined {
		return this.#entries.get(`${kind}:${id}`);
	}

	unsettled(): Receipt[] {
		return [...this.#entries.values()].filter(item => item.state !== "settled" && item.state !== "resolved");
	}

	async save(receipt: Receipt): Promise<void> {
		const operation = this.#serial.then(async () => {
			const key = `${receipt.kind}:${receipt.id}`;
			const previous = this.#entries.get(key);
			if (!previous && this.#entries.size >= MAX_RECEIPTS) {
				throw new Error(
					"Bridge receipt journal is full; retain its replay fences and archive the inactive profile explicitly.",
				);
			}
			this.#entries.set(key, receipt);
			try {
				const data = { version: 1, ...this.identity, entries: [...this.#entries.values()] };
				if (Buffer.byteLength(JSON.stringify(data)) > MAX_JOURNAL_BYTES)
					throw new Error("Bridge receipt journal size limit reached.");
				await writePrivateJson(this.file, data);
			} catch (error) {
				if (previous) this.#entries.set(key, previous);
				else this.#entries.delete(key);
				throw error;
			}
		});
		this.#serial = operation.catch(() => {});
		await operation;
	}

	flush(): Promise<void> {
		return this.#serial;
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameHost(state: BridgeHostState, expected: BridgeHostState): boolean {
	return (
		state.local &&
		state.sessionId === expected.sessionId &&
		state.sessionFile === expected.sessionFile &&
		state.cwd === expected.cwd
	);
}

/**
 * Offline pre-filter from the broker's saved state, so opening a conversation that was never shared causes no broker
 * traffic. The broker's own lookup and its `rejoin` guard stay authoritative.
 */
async function sharedOffline(root: string, identity: Identity): Promise<boolean> {
	const saved = await readPrivateJson(path.join(root, "state.json"), MAX_STATE_BYTES).catch(() => undefined);
	return (
		record(saved) &&
		Array.isArray(saved.sessions) &&
		saved.sessions.some(
			session =>
				record(session) &&
				session.id === identity.sessionId &&
				session.enabled === true &&
				session.retirement === undefined &&
				session.sessionFile === identity.sessionFile,
		)
	);
}

async function savedIdentity(state: BridgeHostState): Promise<Identity> {
	if (!state.local) throw new Error("Attach the bridge from the local interactive OMP UI only.");
	if (
		!UUID.test(state.sessionId) ||
		!state.sessionFile ||
		!path.isAbsolute(state.sessionFile) ||
		!path.isAbsolute(state.cwd)
	) {
		throw new Error(
			"Bridge requires a saved native session with a persistent UUID. Save a local turn or resume an existing session, then use /bridge on.",
		);
	}
	let file: fs.FileHandle | undefined;
	try {
		const projectDir = await fs.realpath(state.cwd);
		if (!(await fs.stat(projectDir)).isDirectory()) throw new Error("Not a project directory");
		const sessionFile = path.join(
			await fs.realpath(path.dirname(state.sessionFile)),
			path.basename(state.sessionFile),
		);
		file = await fs.open(
			sessionFile,
			nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_NONBLOCK,
		);
		const info = await file.stat();
		if (!info.isFile() || info.uid !== process.getuid?.() || info.size === 0) throw new Error("Not a saved session");
		// Only the bounded native header is inspected. Native JSONL is never written by this extension.
		const bytes = Buffer.alloc(64 * 1024);
		const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
		const prefix = bytes.subarray(0, bytesRead);
		const decoder = new TextDecoder("utf-8", { fatal: true });
		let end = prefix.indexOf(10);
		if (end < 0) throw new Error("Missing complete native header");
		let header: unknown = JSON.parse(decoder.decode(prefix.subarray(0, end)));
		// Modern OMP stores a fixed-width title entry before its session header.
		if (record(header) && header.type === "title") {
			if (
				header.v !== 1 ||
				typeof header.title !== "string" ||
				typeof header.updatedAt !== "string" ||
				typeof header.pad !== "string" ||
				(header.source !== undefined && header.source !== "auto" && header.source !== "user")
			) {
				throw new Error("Invalid native title slot");
			}
			const start = end + 1;
			end = prefix.indexOf(10, start);
			if (end < 0) throw new Error("Missing complete native header");
			header = JSON.parse(decoder.decode(prefix.subarray(start, end)));
		}
		if (
			!record(header) ||
			header.type !== "session" ||
			header.id !== state.sessionId ||
			typeof header.cwd !== "string" ||
			!path.isAbsolute(header.cwd) ||
			(await fs.realpath(header.cwd)) !== projectDir
		)
			throw new Error("Session identity mismatch");
		return { sessionId: state.sessionId, sessionFile, projectDir };
	} catch {
		throw new Error(
			"Bridge requires an actually saved native session matching this UUID and project. Save a local turn or resume the session before /bridge on; no session file was created or modified.",
		);
	} finally {
		await file?.close();
	}
}

function validateText(text: string): void {
	if (!text.trim() || Buffer.byteLength(text) > DISCORD_MODE_MAX_TEXT || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
		throw new Error(
			`Bridge text must be nonempty, contain no unsupported control characters, and fit ${DISCORD_MODE_MAX_TEXT} UTF-8 bytes.`,
		);
	}
}

function matches(message: AgentMessage, delivery: ModeDelivery): boolean {
	const value = message as unknown as Record<string, unknown>;
	return (
		value.role === "custom" &&
		value.customType === (delivery.source === "owner" ? BRIDGE_OWNER_MESSAGE_TYPE : BRIDGE_PEER_MESSAGE_TYPE) &&
		value.attribution === (delivery.source === "owner" ? "user" : "agent") &&
		record(value.details) &&
		value.details.bridge === BRIDGE_MESSAGE_SOURCE &&
		value.details.deliveryId === delivery.id
	);
}

function userBoundary(message: AgentMessage): boolean {
	const value = message as unknown as Record<string, unknown>;
	return value.role === "user" || (value.role === "custom" && value.attribution === "user");
}

/** Collect only public text within `max` UTF-8 bytes, without first materializing an unbounded model response. */
function finalText(message: Extract<AgentMessage, { role: "assistant" }>, max: number): string | undefined {
	const bytes = new Uint8Array(max + 1);
	const encoder = new TextEncoder();
	let offset = 0;
	let first = true;
	let truncated = false;
	for (const part of message.content) {
		if (part.type !== "text") continue;
		if (!first) {
			if (offset === bytes.length) {
				truncated = true;
				break;
			}
			bytes[offset++] = 10;
		}
		first = false;
		const encoded = encoder.encodeInto(part.text, bytes.subarray(offset));
		offset += encoded.written;
		if (encoded.read < part.text.length || offset > max) {
			truncated = true;
			break;
		}
	}
	let suffix = "";
	if (truncated) {
		suffix = "\n[response truncated]";
		offset = Math.min(offset, max - Buffer.byteLength(suffix));
		while (offset > 0 && bytes[offset]! >= 0x80 && bytes[offset]! < 0xc0) offset--;
	}
	const text = new TextDecoder().decode(bytes.subarray(0, offset)) + suffix;
	return text.trim() ? text : undefined;
}

interface Admission {
	delivery: ModeDelivery;
	observed: boolean;
	contaminated: boolean;
	reported: boolean;
	finishing: boolean;
}
interface Attachment {
	epoch: number;
	hostState: BridgeHostState;
	identity: Identity;
	client: BridgeConnection;
	lease: ModeLease;
	journal: ReceiptJournal;
	signal: AbortSignal;
	snapshot: ModeSnapshot;
	queue: ModeDelivery[];
	controls: Map<string, Admission>;
	active?: Admission;
	holds: Set<string>;
	effects: Set<string>;
	available: boolean;
	polling: boolean;
	cancelTimer?: () => void;
	/** Owner settings changes received on this attachment and not yet applied, oldest first. */
	commands: ModeSettingCommand[];
	/** Applied results; a repeated command re-sends its result, never applies twice. */
	settled: Map<string, BridgeSettingResult>;
	acknowledging: Set<string>;
	applying: boolean;
	view?: { at: number; view: ModeSettingsView };
}

export interface BridgeSessionOptions {
	root: string;
	connect?: (root: string) => Promise<BridgeConnection>;
	receiptRoot?: string;
	pollIntervalMs?: number;
	/** Delay before the one automatic-rejoin retry while another window still holds the conversation's lease. */
	rejoinRetryMs?: number;
}

/** The public host owns generation/admission. Only observed, marked host events prove delivery. */
export class BridgeSession {
	#attachment?: Attachment;
	#epoch = 0;
	#localRevision = 0;
	#attaching = false;
	#abort?: AbortController;
	#toolSerial: Promise<void> = Promise.resolve();
	#closing: Promise<void> = Promise.resolve();
	#statusText = "Bridge: off";
	#cancelRejoin?: () => void;

	constructor(
		readonly host: BridgeHost,
		readonly options: BridgeSessionOptions,
	) {
		if (!path.isAbsolute(options.root) || (options.receiptRoot && !path.isAbsolute(options.receiptRoot)))
			throw new Error("Bridge storage requires an absolute root path.");
		if (
			options.pollIntervalMs !== undefined &&
			(!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs < 0)
		)
			throw new Error("Invalid bridge poll interval.");
	}

	get enabled(): boolean {
		return !!this.#attachment && this.#current(this.#attachment);
	}

	get statusText(): string {
		return this.enabled ? this.#statusText : "Bridge: off";
	}

	on(label?: string): Promise<ModeSnapshot> {
		return this.#attach(label, false);
	}

	/**
	 * Automatic reattach after this conversation is opened or resumed. Never enrolls, names, or creates anything: the
	 * broker must still share this exact identity, and `rejoin` makes it refuse if sharing was turned off meanwhile.
	 * Unsaved conversations and an unreachable broker stay silent; never throws.
	 */
	async rejoin(retried = false): Promise<ModeSnapshot | undefined> {
		if (this.enabled || this.#attaching) return undefined;
		this.#cancelRejoin?.();
		this.#cancelRejoin = undefined;
		const state = { ...this.host.getState() };
		const epoch = this.#epoch;
		let identity: Identity;
		let shared: ModeSession | undefined;
		try {
			identity = await savedIdentity(state);
			if (!(await sharedOffline(this.options.root, identity))) return undefined;
			// Probe the broker before attaching, so a stale offline view leaves no receipt storage behind.
			const client = await (this.options.connect ?? connectExistingDiscordMode)(this.options.root);
			try {
				shared = (await client.lookup(identity.projectDir, identity.sessionId))?.session;
			} finally {
				await client.close().catch(() => {});
			}
		} catch {
			return undefined;
		}
		if (
			epoch !== this.#epoch ||
			!sameHost(this.host.getState(), state) ||
			!shared?.enabled ||
			shared.retirement ||
			shared.sessionFile !== identity.sessionFile
		)
			return undefined;
		if (shared.connected) {
			if (retried)
				this.host.notify(
					`Bridge: #${shared.label} is attached in another window, so this one stays local. Detach it there, then use /bridge on here.`,
					"warning",
				);
			// A crashed or just-closed window still holds the lease until it expires; never displace a live one.
			else
				this.#cancelRejoin = this.host.schedule(() => {
					this.#cancelRejoin = undefined;
					if (epoch === this.#epoch) void this.rejoin(true);
				}, this.options.rejoinRetryMs ?? REJOIN_RETRY_MS);
			return undefined;
		}
		try {
			return await this.#attach(undefined, true);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!/automatic rejoin skipped|cancelled by a session\/lifecycle change/.test(message))
				this.host.notify(`Bridge couldn't rejoin #${shared.label}: ${message}`, "warning");
			return undefined;
		}
	}

	async #attach(label: string | undefined, rejoin: boolean): Promise<ModeSnapshot> {
		if (!this.host.getState().local) throw new Error("Use /bridge on from the local interactive OMP UI only.");
		if (this.enabled) return (await this.status())!;
		if (this.#attaching) throw new Error("Bridge attachment is already in progress; wait for its local result.");
		this.#attaching = true;
		const closing = this.detach();
		const epoch = this.#epoch;
		const state = { ...this.host.getState() };
		const abort = new AbortController();
		this.#abort = abort;
		let client: BridgeConnection | undefined;
		let ownedFile: string | undefined;
		let registeredLease: ModeLease | undefined;
		const check = () => {
			if (epoch !== this.#epoch || !sameHost(this.host.getState(), state))
				throw new Error("Bridge attachment cancelled by a session/lifecycle change; attach again locally.");
		};
		try {
			await closing;
			check();
			const identity = await savedIdentity(state);
			check();
			if (owners.has(identity.sessionFile))
				throw new Error("This native session already has a bridge writer; detach its original window first.");
			owners.set(identity.sessionFile, this);
			ownedFile = identity.sessionFile;
			const base = this.options.receiptRoot ?? this.options.root;
			await ensurePrivateDirectory(base);
			check();
			await ensurePrivateDirectory(path.join(base, "omp-bridge"));
			check();
			await ensurePrivateDirectory(path.join(base, "omp-bridge", "receipts"));
			check();
			const journal = new ReceiptJournal(
				path.join(base, "omp-bridge", "receipts", `${identity.sessionId}.json`),
				identity,
			);
			await journal.load();
			check();
			client = await (this.options.connect ?? connectExistingDiscordMode)(this.options.root);
			check();
			const enrollment = await client.lookup(identity.projectDir, identity.sessionId);
			check();
			if (enrollment?.session?.connected)
				throw new Error(
					"This session already has a live broker lease. Detach its original owner or wait for lease expiry; bridge never borrows another connection's token.",
				);
			// A rejoin never names anything: it keeps the retained channel label.
			const selectedLabel =
				(rejoin ? enrollment?.session?.label : undefined) ||
				label?.trim() ||
				state.label?.trim() ||
				enrollment?.session?.label ||
				`Session ${identity.sessionId.slice(0, 8)}`;
			const groupName = enrollment?.group.name ?? path.basename(identity.projectDir);
			if (
				[selectedLabel, groupName].some(
					value => !value.trim() || value.length > 100 || /[\x00-\x1f\x7f]/.test(value),
				)
			)
				throw new Error("Choose a session/project label of 1–100 characters without control characters.");
			const connectionId = randomUUID();
			const registration: Extract<ModeRequest, { op: "register" }> = {
				op: "register",
				...identity,
				connectionId,
				requestId: randomUUID(),
				label: selectedLabel,
				groupName,
				app: "omp",
				...(rejoin ? { rejoin: true as const } : {}),
			};
			let snapshot: ModeSnapshot;
			try {
				snapshot = await client.request(registration, abort.signal);
			} catch (error) {
				// Brokers predating the app split reject `app` before any effect; attach untagged (shown as Haiso).
				// Rejoin stays fail-closed: such brokers reject `rejoin` too and must never see it as a plain register.
				if (rejoin || !(error instanceof Error) || !error.message.startsWith("Invalid Discord request"))
					throw error;
				check();
				const { app: _app, ...untagged } = registration;
				snapshot = await client.request(untagged, abort.signal);
			}
			// Remember only our freshly requested lease, even if the host changed while registering.
			if (snapshot.lease?.sessionId === identity.sessionId && snapshot.lease.connectionId === connectionId)
				registeredLease = snapshot.lease;
			check();
			if (
				!registeredLease ||
				!registeredLease.token ||
				snapshot.session.id !== identity.sessionId ||
				snapshot.session.connectionId !== connectionId ||
				!snapshot.session.enabled ||
				!snapshot.session.connected ||
				snapshot.session.sessionFile !== identity.sessionFile ||
				snapshot.session.projectDir !== identity.projectDir ||
				snapshot.group.projectDir !== identity.projectDir
			) {
				throw new Error("Broker did not return this fresh connection's session lease; nothing was attached.");
			}
			const attachment: Attachment = {
				epoch,
				hostState: state,
				identity,
				client,
				lease: registeredLease,
				journal,
				signal: abort.signal,
				snapshot,
				queue: [],
				controls: new Map(),
				holds: new Set(journal.unsettled().map(item => `${item.kind}:${item.id}`)),
				effects: new Set(),
				available: true,
				polling: false,
				commands: [],
				settled: new Map(),
				acknowledging: new Set(),
				applying: false,
			};
			this.#attachment = attachment;
			await this.#tool(true);
			check();
			this.#render(attachment);
			if (!rejoin)
				this.host.notify(
					"Bridge attached to this saved session. Approvals stay local; Discord's Settings panel can change this session's model, effort, and context (applied when idle). Switching, branching, or shutdown only detaches: resuming this conversation reattaches it until /bridge off. Official OMP has no authoritative permanent-deletion event, so a missing file never retires or deletes a Discord channel.",
					"info",
				);
			if (attachment.holds.size) this.host.notify(RECOVERY, "warning");
			this.#schedule(attachment);
			void this.#offerSaved(attachment);
			return snapshot;
		} catch (error) {
			if (epoch === this.#epoch) {
				this.#epoch++;
				this.#attachment = undefined;
				this.#abort?.abort();
				this.#abort = undefined;
				await this.#tool(false).catch(() => {});
				this.host.setStatus(undefined);
			}
			if (client) {
				if (registeredLease)
					await client
						.request({ op: rejoin ? "detach" : "off", lease: registeredLease }, AbortSignal.timeout(2000))
						.catch(() => {});
				await client.close().catch(() => {});
			}
			if (ownedFile && owners.get(ownedFile) === this) owners.delete(ownedFile);
			// The broker refusing an automatic rejoin (sharing turned off meanwhile) is expected, not uncertain.
			if (rejoin && error instanceof Error && /automatic rejoin skipped/.test(error.message)) throw error;
			if (error instanceof DiscordModeRequestError)
				throw new Error(
					error.outcome === "unknown"
						? "Bridge attachment outcome is uncertain. No automatic retry; inspect the broker locally and wait for lease expiry before attaching again."
						: "Existing bridge broker is unavailable. Bootstrap/update the configured Haiso broker locally, then attach again.",
				);
			throw error;
		} finally {
			this.#attaching = false;
		}
	}

	/** Close locally but keep sharing: resuming this conversation reattaches it. Older brokers get `off` instead. */
	detach(): Promise<boolean> {
		return this.#close("detach");
	}

	/**
	 * Explicit and sticky: this conversation stays unshared, also across resume, until /bridge on. Resolves true once
	 * the broker confirmed it; otherwise nothing was attached here (see `disable`).
	 */
	off(): Promise<boolean> {
		return this.#close("off");
	}

	/** Sticky off by identity for a conversation not attached here; a no-op unless the broker still shares it. */
	async disable(): Promise<void> {
		let identity: Identity;
		try {
			identity = await savedIdentity(this.host.getState());
		} catch {
			return; // An unsaved or non-local conversation was never shared.
		}
		let client: BridgeConnection;
		try {
			client = await (this.options.connect ?? connectExistingDiscordMode)(this.options.root);
		} catch {
			throw new Error(
				"Bridge is off here, but the broker is unreachable, so this conversation may reattach when resumed. Run /bridge off again once the broker is running.",
			);
		}
		try {
			const shared = (await client.lookup(identity.projectDir, identity.sessionId))?.session;
			if (!shared?.enabled || shared.retirement) return;
			await client.request({ op: "disable", ...identity }, AbortSignal.timeout(2000));
		} finally {
			await client.close().catch(() => {});
		}
	}

	#close(op: "detach" | "off"): Promise<boolean> {
		const attachment = this.#attachment;
		this.#epoch++;
		this.#attachment = undefined;
		this.#abort?.abort();
		this.#abort = undefined;
		attachment?.cancelTimer?.();
		this.#cancelRejoin?.();
		this.#cancelRejoin = undefined;
		this.#statusText = "Bridge: off";
		this.host.setStatus(undefined);
		const disable = this.#tool(false);
		const prior = this.#closing;
		let released = false;
		this.#closing = (async () => {
			await prior.catch(() => {});
			try {
				if (attachment) {
					const signal = AbortSignal.timeout(2000);
					try {
						await attachment.client.request({ op, lease: attachment.lease }, signal);
						released = true;
					} catch (error) {
						// Brokers without `detach` reject it unexecuted; `off` was their only release.
						if (op === "detach" && error instanceof DiscordModeRequestError && error.outcome === "not-started")
							await attachment.client.request({ op: "off", lease: attachment.lease }, signal).catch(() => {});
					}
					await attachment.client.close().catch(() => {});
					await attachment.journal.flush();
				}
			} finally {
				if (attachment && owners.get(attachment.identity.sessionFile) === this)
					owners.delete(attachment.identity.sessionFile);
				await disable;
			}
		})();
		return this.#closing.then(() => released);
	}

	async status(): Promise<ModeSnapshot | undefined> {
		if (!this.#attachment) return undefined;
		const attachment = this.#require();
		return this.#request(attachment, { op: "status", lease: attachment.lease });
	}

	async peers(): Promise<BridgePeer[]> {
		const attachment = this.#require();
		const snapshot = await this.#request(attachment, { op: "status", lease: attachment.lease });
		return snapshot.peers
			.filter(
				peer =>
					peer.id !== attachment.identity.sessionId &&
					peer.projectDir === attachment.identity.projectDir &&
					peer.enabled &&
					peer.connected &&
					!peer.retirement,
			)
			.map(peer => ({ id: peer.id, label: peer.label, busy: peer.busy, pendingInput: peer.pendingInput }));
	}

	async send(recipientId: string, text: string, requestId: string): Promise<void> {
		const attachment = this.#require();
		if (
			!UUID.test(recipientId) ||
			!attachment.snapshot.peers.some(
				peer =>
					peer.id === recipientId &&
					peer.id !== attachment.identity.sessionId &&
					peer.projectDir === attachment.identity.projectDir &&
					peer.enabled &&
					peer.connected &&
					!peer.retirement,
			)
		)
			throw new Error("Choose a currently connected peer from bridge peers in this exact project.");
		await this.#effect(attachment, { op: "send", lease: attachment.lease, recipientId, text, requestId });
	}

	async report(text: string, requestId: string): Promise<void> {
		const attachment = this.#require();
		validateText(text);
		if (!REQUEST_ID.test(requestId)) throw new Error("Invalid bridge request identity.");
		if (attachment.active) attachment.active.reported = true;
		await this.#effect(attachment, { op: "report", lease: attachment.lease, text, requestId });
	}

	async resolve(deliveryId: string): Promise<ModeSnapshot> {
		const attachment = this.#requireLocal();
		if (!UUID.test(deliveryId)) throw new Error("Choose an unknown delivery from /bridge status.");
		const snapshot = await this.#request(attachment, {
			op: "resolve-delivery",
			lease: attachment.lease,
			requestId: randomUUID(),
			deliveryId,
		});
		this.#assert(attachment);
		await attachment.journal.save({ id: deliveryId, kind: "delivery", state: "resolved" });
		this.#assert(attachment);
		attachment.holds.delete(`delivery:${deliveryId}`);
		attachment.queue = attachment.queue.filter(delivery => delivery.id !== deliveryId);
		if (attachment.active?.delivery.id === deliveryId) attachment.active = undefined;
		attachment.controls.delete(deliveryId);
		this.#render(attachment);
		return snapshot;
	}

	async repair(target: "session" | "group", destinationId?: string, resumeQueued = false): Promise<ModeSnapshot> {
		const attachment = this.#requireLocal();
		if (target !== "session" && target !== "group") throw new Error("Choose the session or group binding to repair.");
		if (destinationId !== undefined && !/^\d{1,22}$/.test(destinationId))
			throw new Error("Provide a Discord channel/category identifier, not credentials.");
		const snapshot = await this.#request(attachment, {
			op: "repair",
			lease: attachment.lease,
			requestId: randomUUID(),
			target,
			destinationId,
			resumeQueued,
		});
		this.#assert(attachment);
		if (resumeQueued) {
			// Owner acknowledgment never claims execution or retries an effect. Status, unlike
			// repair's compact response, enumerates all remaining broker deliveries.
			const status = await this.#request(attachment, { op: "status", lease: attachment.lease });
			this.#assert(attachment);
			for (const receipt of attachment.journal.unsettled()) {
				if (
					receipt.kind === "delivery" &&
					(status.deliveries.some(item => item.id === receipt.id) ||
						attachment.active?.delivery.id === receipt.id ||
						attachment.controls.has(receipt.id))
				)
					continue;
				await attachment.journal.save({ ...receipt, state: "resolved" });
				this.#assert(attachment);
				attachment.holds.delete(`${receipt.kind}:${receipt.id}`);
			}
			attachment.holds.delete("intake");
		}
		this.#render(attachment);
		return snapshot;
	}

	async poll(): Promise<void> {
		const attachment = this.#attachment;
		if (!attachment || attachment.polling) return;
		if (!this.#current(attachment)) {
			await this.detach();
			return;
		}
		attachment.polling = true;
		try {
			const state = this.host.getState();
			const snapshot = await this.#request(attachment, {
				op: "poll",
				lease: attachment.lease,
				busy: this.#busy(attachment),
				pendingInput: state.pendingInput || state.draft,
				...this.#settingsReport(attachment),
				...this.#progressReport(attachment),
			});
			for (const delivery of snapshot.deliveries) {
				if (
					delivery.sessionId !== attachment.identity.sessionId ||
					delivery.state !== "dispatched" ||
					attachment.journal.get("delivery", delivery.id) ||
					attachment.queue.some(item => item.id === delivery.id)
				)
					continue;
				// Reserve one of the bounded slots for an owner stop even when guidance is awaiting admission.
				const limit = delivery.kind === "abort" ? DISCORD_MODE_MAX_PENDING : DISCORD_MODE_MAX_PENDING - 1;
				if (attachment.queue.length + attachment.controls.size + Number(!!attachment.active) >= limit) {
					this.#hold(attachment, "intake");
					continue;
				}
				attachment.queue.push(delivery);
			}
			// Settings apply first, so the next owner message already runs with them.
			this.#intakeCommands(attachment, snapshot.commands ?? []);
			await this.#drain(attachment);
		} catch (error) {
			if (!(error instanceof DiscordModeRequestError && error.outcome === "not-started"))
				this.#hold(attachment, "intake");
		} finally {
			attachment.polling = false;
		}
	}

	/** Settings ride polls only to brokers that advertise them, and the full view only when its revision changed. */
	#settingsReport(attachment: Attachment): { settings?: ModeSettingsView; usage?: ModeUsage } {
		const revision = attachment.snapshot.settingsRevision;
		if (revision === undefined) return {};
		const view = this.#settingsView(attachment);
		const usage = this.#usage();
		return { ...(view && view.revision !== revision ? { settings: view } : {}), ...(usage ? { usage } : {}) };
	}

	/** Only to brokers that advertise it, and only while a run is active. */
	#progressReport(attachment: Attachment): { progress?: ModeProgress } {
		if (!attachment.snapshot.progress) return {};
		let progress: ModeProgress | undefined;
		try {
			progress = this.host.progress?.();
		} catch {
			// Progress is cosmetic; polling and delivery continue without it.
		}
		return progress ? { progress } : {};
	}

	#settingsView(attachment: Attachment): ModeSettingsView | undefined {
		const now = performance.now();
		if (attachment.view && now - attachment.view.at < SETTINGS_REFRESH_MS) return attachment.view.view;
		let view: ModeSettingsView | undefined;
		try {
			const report = this.host.settings();
			view = report ? sealModeSettingsView(report) : undefined;
		} catch {
			// A host that cannot describe itself reports nothing; polling and delivery continue.
		}
		attachment.view = view ? { at: now, view } : undefined;
		return view;
	}

	#usage(): ModeUsage | undefined {
		try {
			return this.host.usage();
		} catch {
			return undefined;
		}
	}

	#intakeCommands(attachment: Attachment, commands: ModeSettingCommand[]): void {
		for (const command of commands) {
			const settled = attachment.settled.get(command.id);
			if (settled) void this.#acknowledge(attachment, command.id, settled);
			else if (!attachment.commands.some(item => item.id === command.id)) attachment.commands.push(command);
		}
		if (attachment.commands.length && !this.#busy(attachment)) void this.#applyCommands(attachment);
	}

	/** Detached from polling: a compaction can outlast the lease, so heartbeats continue while it runs. */
	async #applyCommands(attachment: Attachment): Promise<void> {
		attachment.applying = true;
		try {
			while (this.#current(attachment) && attachment.commands.length && !this.#hostBusy(attachment)) {
				const command = attachment.commands.shift()!;
				let result: BridgeSettingResult;
				try {
					result = await this.host.applySetting(command);
				} catch (error) {
					result = {
						outcome: "failed",
						text: `Failed: ${error instanceof Error ? error.message : String(error)}`,
					};
				}
				attachment.view = undefined;
				if (!this.#current(attachment)) return;
				attachment.settled.set(command.id, result);
				if (attachment.settled.size > SETTLED_COMMANDS)
					attachment.settled.delete(attachment.settled.keys().next().value!);
				await this.#acknowledge(attachment, command.id, result);
			}
		} finally {
			attachment.applying = false;
		}
	}

	async #acknowledge(attachment: Attachment, commandId: string, result: BridgeSettingResult): Promise<void> {
		if (attachment.acknowledging.has(commandId) || !this.#current(attachment)) return;
		attachment.acknowledging.add(commandId);
		try {
			const view = this.#settingsView(attachment);
			const usage = this.#usage();
			// Straight to the broker: a refused acknowledgement is not a transport fault and must not hold intake.
			await attachment.client.request(
				{
					op: "command-result",
					lease: attachment.lease,
					commandId,
					outcome: result.outcome,
					text:
						result.text
							.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, " ")
							.slice(0, 500)
							.trim() || result.outcome,
					...(view ? { settings: view } : {}),
					...(usage ? { usage } : {}),
				},
				attachment.signal,
			);
		} catch {
			// The broker repeats an unacknowledged command on the next poll; the settled result is re-sent then.
		} finally {
			attachment.acknowledging.delete(commandId);
		}
	}

	onLocalInput(): void {
		this.#localRevision++;
		const attachment = this.#attachment;
		if (!attachment || !this.#current(attachment)) return;
		if (attachment.active) attachment.active.contaminated = true;
	}

	onMessageStart(message: AgentMessage): void {
		const attachment = this.#attachment;
		if (!attachment || !this.#current(attachment)) return;
		const control = [...attachment.controls.values()].find(item => matches(message, item.delivery));
		if (control) {
			control.observed = true;
			if (attachment.active) attachment.active.contaminated = true;
			void this.#complete(attachment, control).catch(() => {});
			return;
		}
		const active = attachment.active;
		if (active && matches(message, active.delivery)) {
			active.observed = true;
			attachment.holds.delete(`delivery:${active.delivery.id}`);
			this.#render(attachment);
			return;
		}
		if (userBoundary(message)) this.onLocalInput();
	}

	async onAgentEnd(event: BridgeAgentEnd): Promise<void> {
		const attachment = this.#attachment;
		const active = attachment?.active;
		if (!attachment || !active || !this.#current(attachment) || event.willContinue || active.finishing) return;
		let boundary = -1;
		for (let index = 0; index < event.messages.length; index++) {
			if (!matches(event.messages[index]!, active.delivery)) continue;
			if (boundary >= 0) {
				this.#hold(attachment, `delivery:${active.delivery.id}`);
				return;
			}
			boundary = index;
		}
		if (!active.observed || boundary < 0) {
			this.#hold(attachment, `delivery:${active.delivery.id}`);
			return;
		}
		let assistant: Extract<AgentMessage, { role: "assistant" }> | undefined;
		for (let index = boundary + 1; index < event.messages.length; index++) {
			const message = event.messages[index]!;
			if (userBoundary(message)) active.contaminated = true;
			if (message.role === "assistant") assistant = message;
		}
		const state = this.host.getState();
		if (state.pendingInput || state.draft || state.pendingMessages) active.contaminated = true;
		// Older brokers omit maxReply and accept only MAX_TEXT; never exceed this build's own bound.
		const max = Math.min(attachment.snapshot.maxReply ?? DISCORD_MODE_MAX_TEXT, DISCORD_MODE_MAX_REPLY);
		const text =
			active.delivery.source === "owner" &&
			!active.contaminated &&
			!active.reported &&
			assistant?.stopReason === "stop"
				? finalText(assistant, max)
				: undefined;
		await this.#complete(attachment, active, text);
	}

	#current(attachment: Attachment): boolean {
		return (
			this.#attachment === attachment &&
			attachment.epoch === this.#epoch &&
			sameHost(this.host.getState(), attachment.hostState)
		);
	}

	#assert(attachment: Attachment): void {
		if (!this.#current(attachment))
			throw new Error(
				"Bridge connection changed; stale results were discarded. Attach this session locally if needed.",
			);
	}

	#require(): Attachment {
		const attachment = this.#attachment;
		if (!attachment || !this.#current(attachment)) {
			if (attachment) void this.detach().catch(() => {});
			throw new Error(
				"Bridge is off for this session. Use /bridge on locally; only resuming a still-shared conversation reattaches it automatically.",
			);
		}
		return attachment;
	}

	#requireLocal(): Attachment {
		if (!this.host.getState().local) throw new Error("Bridge recovery requires the local owner UI.");
		return this.#require();
	}

	#tool(enabled: boolean): Promise<void> {
		const change = this.#toolSerial.then(() => this.host.setToolEnabled(enabled));
		this.#toolSerial = change.catch(() => {});
		return change;
	}

	/** Applying an owner settings change counts as busy, so no owner message starts mid-change. */
	#busy(attachment: Attachment): boolean {
		return attachment.applying || this.#hostBusy(attachment);
	}

	#hostBusy(attachment: Attachment): boolean {
		const state = this.host.getState();
		return (
			!state.idle ||
			state.pendingMessages ||
			state.pendingInput ||
			state.draft ||
			!!attachment.active ||
			!!attachment.controls.size ||
			!!attachment.holds.size
		);
	}

	#render(attachment: Attachment): void {
		if (!this.#current(attachment)) return;
		const snapshot = attachment.snapshot;
		this.#statusText = !attachment.available
			? "Bridge: broker unavailable; no automatic reattachment"
			: attachment.holds.size
				? "Bridge: held; /bridge status and reconcile"
				: !snapshot.gatewayConnected
					? "Bridge: Discord offline"
					: snapshot.session.state !== "ready" || snapshot.group.state !== "ready"
						? "Bridge: binding needs /bridge repair"
						: attachment.active
							? "Bridge: remote turn active"
							: "Bridge: connected";
		this.host.setStatus(this.#statusText);
	}

	#hold(attachment: Attachment, key: string): void {
		if (!this.#current(attachment)) return;
		const first = !attachment.holds.size;
		attachment.holds.add(key);
		this.#render(attachment);
		if (first) this.host.notify(RECOVERY, "warning");
	}

	#schedule(attachment: Attachment): void {
		if (!this.#current(attachment) || attachment.cancelTimer || this.options.pollIntervalMs === 0) return;
		attachment.cancelTimer = this.host.schedule(() => {
			attachment.cancelTimer = undefined;
			if (this.#attachment !== attachment) return;
			void this.poll().finally(() => this.#schedule(attachment));
		}, this.options.pollIntervalMs ?? 1000);
	}

	/** Offer owner messages saved while this conversation was closed; only the owner's choice releases or drops them. */
	async #offerSaved(attachment: Attachment): Promise<void> {
		if (!this.host.select) return;
		try {
			const status = await this.#request(attachment, { op: "status", lease: attachment.lease });
			// Brokers before saved messages omit `held`; their queued work is never offered here.
			const saved = status.deliveries.filter(
				item => item.held === true && item.source === "owner" && item.kind === "message" && item.state === "queued",
			);
			if (!saved.length || !this.#current(attachment)) return;
			const count = `${saved.length} message${saved.length === 1 ? "" : "s"}`;
			const choice = await this.host.select(`Discord: ${count} arrived while this session was closed`, [
				"Review",
				"Send all",
				"Discard",
			]);
			const send: string[] = [];
			const discard: string[] = [];
			if (choice === "Send all") send.push(...saved.map(item => item.id));
			else if (choice === "Discard") discard.push(...saved.map(item => item.id));
			else if (choice === "Review")
				for (const [index, message] of saved.entries()) {
					this.host.notify(`Saved Discord message ${index + 1} of ${saved.length}:\n${message.text}`, "info");
					const answer = await this.host.select(`Saved message ${index + 1} of ${saved.length}`, [
						"Send",
						"Discard",
						"Keep for later",
					]);
					if (answer === undefined) break;
					if (answer === "Send") send.push(message.id);
					else if (answer === "Discard") discard.push(message.id);
				}
			for (const [action, deliveryIds] of [
				["discard", discard],
				["send", send],
			] as const)
				if (deliveryIds.length && this.#current(attachment))
					await this.#request(attachment, {
						op: "held",
						lease: attachment.lease,
						requestId: randomUUID(),
						action,
						deliveryIds,
					});
		} catch {
			/* The channel's notice offers the same choices; unsent messages stay saved. */
		}
	}

	async #request(attachment: Attachment, input: ModeRequest): Promise<ModeSnapshot> {
		this.#assert(attachment);
		try {
			const snapshot = await attachment.client.request(input, attachment.signal);
			this.#assert(attachment);
			if (
				snapshot.session.id !== attachment.identity.sessionId ||
				snapshot.session.connectionId !== attachment.lease.connectionId ||
				!snapshot.session.enabled ||
				!snapshot.session.connected ||
				snapshot.session.projectDir !== attachment.identity.projectDir ||
				snapshot.session.sessionFile !== attachment.identity.sessionFile ||
				snapshot.group.projectDir !== attachment.identity.projectDir
			) {
				void this.detach().catch(() => {});
				throw new Error(
					"Broker connection was revoked; attach explicitly from this session after checking its owner.",
				);
			}
			const restored = !attachment.available;
			attachment.snapshot = snapshot;
			attachment.available = true;
			this.#render(attachment);
			if (restored)
				this.host.notify(
					"Bridge broker is reachable on the same connection again; held work has not been replayed or resumed.",
					"info",
				);
			return snapshot;
		} catch (error) {
			if (this.#current(attachment)) {
				const wasAvailable = attachment.available;
				attachment.available = false;
				this.#render(attachment);
				if (wasAvailable)
					this.host.notify(
						"Bridge request failed. Inspect /bridge status locally; uncertain actions must not be retried blindly.",
						"warning",
					);
			}
			if (error instanceof DiscordModeRequestError) throw error;
			throw new Error(
				"Bridge request failed or its connection changed. Inspect /bridge status locally; no automatic replay was attempted.",
			);
		}
	}

	async #effect(attachment: Attachment, input: Extract<ModeRequest, { op: "send" | "report" }>): Promise<void> {
		validateText(input.text);
		if (!REQUEST_ID.test(input.requestId)) throw new Error("Invalid bridge request identity.");
		if (attachment.effects.has(input.requestId))
			throw new Error("This bridge request is already in flight; wait for its result instead of replaying it.");
		if (attachment.effects.size >= DISCORD_MODE_MAX_PENDING)
			throw new Error("Bridge outbound request capacity reached; wait for current sends to settle.");
		const fingerprint = createHash("sha256")
			.update(JSON.stringify([input.op, input.op === "send" ? input.recipientId : "", input.text]))
			.digest("hex");
		const existing = attachment.journal.get("effect", input.requestId);
		if (existing) {
			if (existing.fingerprint !== fingerprint)
				throw new Error("Bridge request identity was reused for different content; nothing was sent.");
			if (existing.state === "settled") return;
			throw new Error(
				"This bridge send/report was already attempted with an uncertain or resolved outcome; inspect Discord before any new explicit action. Nothing was replayed.",
			);
		}
		if ([...attachment.holds].some(key => key.startsWith("effect:")))
			throw new Error(
				"A previous send/report has an uncertain outcome. Inspect Discord and acknowledge it with local /bridge repair before sending more.",
			);
		if (!attachment.available)
			throw new Error("Bridge connection is unavailable; inspect /bridge status locally before sending.");
		attachment.effects.add(input.requestId);
		const receipt: Receipt = { id: input.requestId, kind: "effect", state: "attempted", fingerprint };
		try {
			await attachment.journal.save(receipt);
			this.#assert(attachment);
			await this.#request(attachment, input);
			this.#assert(attachment);
			await attachment.journal.save({ ...receipt, state: "settled" });
			this.#assert(attachment);
		} catch {
			this.#hold(attachment, `effect:${input.requestId}`);
			throw new Error(
				"Bridge send/report was not confirmed. It may have taken effect; inspect Discord and use local recovery. Do not repeat it blindly.",
			);
		} finally {
			attachment.effects.delete(input.requestId);
		}
	}

	async #receipt(
		attachment: Attachment,
		delivery: ModeDelivery,
		state: "accepted" | "completed" | "rejected",
		text?: string,
	): Promise<void> {
		await this.#request(attachment, {
			op: "receipt",
			lease: attachment.lease,
			deliveryId: delivery.id,
			state,
			...(text ? { text } : {}),
		});
		this.#assert(attachment);
		await attachment.journal.save({
			id: delivery.id,
			kind: "delivery",
			state: state === "accepted" ? "accepted" : "settled",
		});
		this.#assert(attachment);
	}

	async #drain(attachment: Attachment): Promise<void> {
		while (this.#current(attachment) && attachment.queue.length) {
			const remoteReady =
				attachment.snapshot.gatewayConnected &&
				attachment.snapshot.session.state === "ready" &&
				attachment.snapshot.group.state === "ready";
			// Stop/guidance controls bypass ordinary busy work, but never another session generation.
			const eligible = (item: ModeDelivery) => remoteReady || item.source === "peer";
			let index = attachment.queue.findIndex(item => item.kind !== "message" && eligible(item));
			if (index < 0) {
				if (this.#busy(attachment)) return;
				index = attachment.queue.findIndex(eligible);
			}
			if (index < 0) return;
			const delivery = attachment.queue.splice(index, 1)[0]!;
			if (attachment.journal.get("delivery", delivery.id)) continue;
			const revision = this.#localRevision;
			try {
				await attachment.journal.save({ id: delivery.id, kind: "delivery", state: "attempted" });
				this.#assert(attachment);
				if (delivery.source !== "owner" && delivery.kind !== "message") {
					await this.#receipt(attachment, delivery, "rejected");
					continue;
				}
				if (
					delivery.kind !== "abort" &&
					(revision !== this.#localRevision || (delivery.kind === "message" && this.#busy(attachment)))
				) {
					await this.#receipt(attachment, delivery, "rejected");
					continue;
				}
				await this.#receipt(attachment, delivery, "accepted");
				this.#assert(attachment);
				if (delivery.kind === "abort") {
					if (attachment.active) attachment.active.contaminated = true;
					this.host.abort();
					this.#assert(attachment);
					// Completion acknowledges the host abort request only, not child-process shutdown.
					await this.#receipt(attachment, delivery, "completed");
					continue;
				}
				if (revision !== this.#localRevision || (delivery.kind === "message" && this.#busy(attachment))) {
					await this.#receipt(attachment, delivery, "rejected");
					continue;
				}
				const state = this.host.getState();
				const control =
					delivery.kind === "steer" &&
					(!state.idle ||
						state.pendingMessages ||
						state.pendingInput ||
						state.draft ||
						!!attachment.active ||
						!!attachment.controls.size);
				const admission: Admission = {
					delivery,
					observed: false,
					contaminated: false,
					reported: false,
					finishing: false,
				};
				if (control) {
					if (attachment.active) attachment.active.contaminated = true;
					attachment.controls.set(delivery.id, admission);
				} else attachment.active = admission;
				this.host.deliver(delivery, delivery.kind === "steer" ? "steer" : "nextTurn");
				this.#assert(attachment);
				// sendMessage returns void: only a later marked host event can clear this fence.
				if (!admission.observed) this.#hold(attachment, `delivery:${delivery.id}`);
				this.#render(attachment);
			} catch {
				this.#hold(attachment, `delivery:${delivery.id}`);
				return;
			}
		}
	}

	async #complete(attachment: Attachment, admission: Admission, text?: string): Promise<void> {
		if (!this.#current(attachment) || admission.finishing || !admission.observed) return;
		admission.finishing = true;
		try {
			await this.#receipt(attachment, admission.delivery, "completed", text);
			this.#assert(attachment);
			attachment.holds.delete(`delivery:${admission.delivery.id}`);
			if (attachment.active === admission) attachment.active = undefined;
			attachment.controls.delete(admission.delivery.id);
			this.#render(attachment);
		} catch {
			// Completion may already have published; duplicate events must never retry it.
			this.#hold(attachment, `delivery:${admission.delivery.id}`);
		}
	}
}
