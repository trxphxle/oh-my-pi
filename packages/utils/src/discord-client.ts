// Protocol-only Discord IPC transport. No service discovery, startup, or account configuration.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import {
	DISCORD_MODE_MAX_FRAME,
	DISCORD_MODE_MAX_PENDING,
	DISCORD_MODE_MAX_SESSIONS,
	DISCORD_MODE_MAX_REPLY,
	DISCORD_MODE_MAX_TEXT,
	DISCORD_MODE_PROTOCOL,
	type DiscordModeInfo,
	type DiscordModeConnector,
	type ModeEnrollment,
	type ModeGroup,
	type ModeRequest,
	type ModeSession,
	type ModeSnapshot,
} from "@oh-my-pi/pi-wire/discord-mode";
import { readPrivateJson, readPrivateText } from "./discord-private-files";

const PROBE_TIMEOUT_MS = 1500;

export const DISCORD_MODE_REQUEST_TIMEOUT_MS = 30_000;
export const DISCORD_MODE_AUTH_HEADER = "x-omp-discord-token";
export const DISCORD_MODE_CONFIG_HEADER = "x-omp-discord-config";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown, max: number, empty = false): value is string {
	return typeof value === "string" && (empty || value.length > 0) && value.length <= max && !value.includes("\0");
}
function identifier(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
}
function absolutePath(value: unknown): value is string {
	return text(value, 4096) && path.isAbsolute(value);
}

/** Reject invalid envelopes before they can enter the effect-owning broker queue. */
export function isModeRequest(value: unknown): value is ModeRequest {
	if (!record(value) || typeof value.op !== "string") return false;
	if (value.op === "retire")
		return (
			typeof value.eventId === "string" &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.eventId)
		);
	if (value.op === "register") {
		return (
			identifier(value.requestId) &&
			identifier(value.sessionId) &&
			identifier(value.connectionId) &&
			absolutePath(value.sessionFile) &&
			absolutePath(value.projectDir) &&
			text(value.label, 100) &&
			text(value.groupName, 100)
		);
	}
	if (
		!record(value.lease) ||
		!identifier(value.lease.sessionId) ||
		!identifier(value.lease.connectionId) ||
		!text(value.lease.token, 512)
	)
		return false;
	switch (value.op) {
		case "poll":
			return typeof value.busy === "boolean" && typeof value.pendingInput === "boolean";
		case "status":
		case "off":
			return true;
		case "receipt":
			return (
				identifier(value.deliveryId) &&
				["accepted", "completed", "rejected"].includes(String(value.state)) &&
				(value.text === undefined ||
					// UTF-16 length never exceeds UTF-8 bytes, so the length check is a cheap prefilter.
					(text(value.text, DISCORD_MODE_MAX_REPLY, true) &&
						Buffer.byteLength(value.text) <= DISCORD_MODE_MAX_REPLY))
			);
		case "resolve-delivery":
			return identifier(value.requestId) && identifier(value.deliveryId);
		case "send":
			return identifier(value.requestId) && identifier(value.recipientId) && text(value.text, DISCORD_MODE_MAX_TEXT);
		case "report":
			return identifier(value.requestId) && text(value.text, DISCORD_MODE_MAX_TEXT);
		case "dialog": {
			const dialog = value.dialog;
			return (
				record(dialog) &&
				identifier(dialog.id) &&
				["select", "confirm", "input", "editor"].includes(String(dialog.kind)) &&
				text(dialog.title, DISCORD_MODE_MAX_TEXT) &&
				(dialog.message === undefined || text(dialog.message, DISCORD_MODE_MAX_TEXT, true)) &&
				(dialog.prefill === undefined || text(dialog.prefill, DISCORD_MODE_MAX_TEXT, true)) &&
				(dialog.options === undefined ||
					(Array.isArray(dialog.options) &&
						dialog.options.length <= 100 &&
						dialog.options.every(option => text(option, DISCORD_MODE_MAX_TEXT))))
			);
		}
		case "dialog-end":
			return identifier(value.dialogId);
		case "rename":
			return (
				identifier(value.requestId) &&
				(value.target === "session" || value.target === "group") &&
				text(value.name, 100)
			);
		case "repair":
			return (
				identifier(value.requestId) &&
				(value.target === "session" || value.target === "group") &&
				(value.destinationId === undefined || identifier(value.destinationId)) &&
				typeof value.resumeQueued === "boolean"
			);
		default:
			return false;
	}
}

/** Shared streaming ceiling also bounds responses from a replaced or faulty local endpoint. */
export async function readDiscordModeJsonBody(message: Request | Response): Promise<unknown> {
	const length = message.headers.get("content-length");
	if (length !== null && (!/^\d+$/.test(length) || Number(length) > DISCORD_MODE_MAX_FRAME))
		throw new Error("Discord IPC frame exceeds its limit.");
	if (!message.body) throw new Error("Discord IPC frame is empty.");
	const reader = message.body.getReader();
	let bytes = new Uint8Array(length === null ? 4096 : Number(length));
	let size = 0;
	let expired = false;
	const timer = setTimeout(() => {
		expired = true;
		void reader.cancel().catch(() => {});
	}, 10_000);
	try {
		while (true) {
			const item = await reader.read();
			if (expired) throw new Error("Discord IPC body timed out.");
			if (item.done) break;
			const nextSize = size + item.value.byteLength;
			if (nextSize > DISCORD_MODE_MAX_FRAME) throw new Error("Discord IPC frame exceeds its limit.");
			if (nextSize > bytes.length) {
				const grown = new Uint8Array(Math.min(DISCORD_MODE_MAX_FRAME, Math.max(nextSize, bytes.length * 2)));
				grown.set(bytes.subarray(0, size));
				bytes = grown;
			}
			bytes.set(item.value, size);
			size = nextSize;
		}
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))) as unknown;
	} finally {
		clearTimeout(timer);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

export async function inspectDiscordModeSocket(socketPath: string): Promise<"missing" | "present"> {
	if (!absolutePath(socketPath)) throw new Error("Discord IPC requires an absolute socket path.");
	let info;
	try {
		info = await fs.lstat(socketPath);
	} catch (error) {
		if (record(error) && error.code === "ENOENT") return "missing";
		throw new Error("Cannot inspect Discord IPC socket safely.");
	}
	if (!info.isSocket() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
		throw new Error("Refusing an unsafe Discord IPC socket; require an owned socket with mode 0600.");
	}
	return "present";
}

/** Only a positive refused/absent connection proves staleness; a timeout never authorizes replacement. */
export async function discordModeSocketIsStale(socketPath: string): Promise<boolean> {
	if ((await inspectDiscordModeSocket(socketPath)) === "missing") return true;
	const probe = net.createConnection(socketPath);
	const result = Promise.withResolvers<boolean>();
	const timer = setTimeout(
		() => result.reject(new Error("Discord socket liveness is unknown; nothing was replaced.")),
		1000,
	);
	probe.once("connect", () => result.resolve(false));
	probe.once("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "ECONNREFUSED" || error.code === "ENOENT") result.resolve(true);
		else result.reject(new Error("Discord socket liveness is unknown; nothing was replaced."));
	});
	try {
		return await result.promise;
	} finally {
		clearTimeout(timer);
		probe.destroy();
	}
}

function binding(value: unknown): boolean {
	return (
		typeof value === "string" &&
		["ready", "missing", "inaccessible", "moved", "offline", "unbound", "uncertain"].includes(value)
	);
}
function group(value: unknown): value is ModeGroup {
	return (
		record(value) &&
		typeof value.id === "string" &&
		typeof value.projectDir === "string" &&
		typeof value.name === "string" &&
		binding(value.state) &&
		(value.categoryId === undefined || typeof value.categoryId === "string") &&
		(value.overviewId === undefined || typeof value.overviewId === "string")
	);
}
function retirement(value: unknown): boolean {
	return (
		record(value) &&
		typeof value.eventId === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.eventId) &&
		(value.policy === "retain" || value.policy === "delete") &&
		typeof value.deletedAt === "number" &&
		Number.isSafeInteger(value.deletedAt) &&
		value.deletedAt >= 0 &&
		["pending", "done", "attention"].includes(String(value.state)) &&
		(value.channelId === undefined || (typeof value.channelId === "string" && /^\d{1,22}$/.test(value.channelId))) &&
		(value.error === undefined || (typeof value.error === "string" && value.error.length <= 500))
	);
}
function session(value: unknown): value is ModeSession {
	return (
		record(value) &&
		["id", "groupId", "sessionFile", "projectDir", "label", "connectionId"].every(
			key => typeof value[key] === "string",
		) &&
		["enabled", "connected", "busy", "pendingInput"].every(key => typeof value[key] === "boolean") &&
		binding(value.state) &&
		(value.channelId === undefined || typeof value.channelId === "string") &&
		(value.retirement === undefined ||
			(retirement(value.retirement) &&
				record(value.retirement) &&
				value.retirement.channelId === value.channelId &&
				!value.enabled &&
				!value.connected &&
				!value.busy &&
				!value.pendingInput))
	);
}
function snapshot(value: unknown): value is ModeSnapshot {
	return (
		record(value) &&
		group(value.group) &&
		session(value.session) &&
		typeof value.gatewayConnected === "boolean" &&
		Array.isArray(value.peers) &&
		value.peers.length <= DISCORD_MODE_MAX_SESSIONS &&
		value.peers.every(session) &&
		(value.lease === undefined ||
			(record(value.lease) &&
				["sessionId", "connectionId", "token"].every(
					key =>
						typeof value.lease === "object" &&
						value.lease !== null &&
						typeof (value.lease as Record<string, unknown>)[key] === "string",
				))) &&
		Array.isArray(value.deliveries) &&
		value.deliveries.length <= DISCORD_MODE_MAX_PENDING &&
		value.deliveries.every(
			item =>
				record(item) &&
				["id", "sessionId", "from", "text"].every(key => typeof item[key] === "string") &&
				["owner", "peer"].includes(String(item.source)) &&
				["message", "steer", "abort"].includes(String(item.kind)) &&
				["queued", "dispatched", "accepted", "completed", "rejected", "unknown", "resolved"].includes(
					String(item.state),
				) &&
				typeof item.createdAt === "number" &&
				Number.isFinite(item.createdAt),
		) &&
		Array.isArray(value.answers) &&
		value.answers.length <= DISCORD_MODE_MAX_PENDING &&
		value.answers.every(
			item =>
				record(item) &&
				typeof item.id === "string" &&
				typeof item.cancelled === "boolean" &&
				(item.value === undefined || typeof item.value === "string" || typeof item.value === "boolean"),
		) &&
		(value.maxReply === undefined ||
			(typeof value.maxReply === "number" && Number.isSafeInteger(value.maxReply) && value.maxReply > 0))
	);
}

/** Unknown means the request may already have taken effect. Never automatically replay it. */
export class DiscordModeRequestError extends Error {
	constructor(
		readonly outcome: "not-started" | "unknown",
		message: string,
	) {
		super(message);
		this.name = "DiscordModeRequestError";
	}
}

export async function readDiscordModeToken(tokenPath: string): Promise<string | undefined> {
	const value = await readPrivateJson(tokenPath, 1024);
	if (value === undefined) return undefined;
	if (!record(value) || typeof value.token !== "string" || !/^[A-Za-z0-9_-]{32,512}$/.test(value.token))
		throw new Error("Invalid private Discord IPC token file.");
	return value.token;
}

export class DiscordModeClient {
	readonly #socketPath: string;
	readonly #token: string;
	#closed = false;
	#active = 0;
	#configKey: string | undefined;
	readonly #supervisor: net.Socket | undefined;
	readonly #controllers = new Set<AbortController>();

	constructor(socketPath: string, token: string, supervisor?: net.Socket) {
		if (!/^[A-Za-z0-9_-]{32,512}$/.test(token)) throw new Error("Invalid Discord IPC authentication token.");
		this.#socketPath = socketPath;
		this.#token = token;
		this.#supervisor = supervisor;
		supervisor?.once("close", () => {
			void this.close();
		});
	}

	async #fetch(
		route: string,
		init: RequestInit = {},
		timeoutMs = DISCORD_MODE_REQUEST_TIMEOUT_MS + 2000,
		signal?: AbortSignal,
	): Promise<{ response: Response; body: unknown }> {
		if (this.#closed) throw new DiscordModeRequestError("not-started", "Discord mode client is closed.");
		if (signal?.aborted) throw new DiscordModeRequestError("not-started", "Discord mode request was cancelled.");
		if (this.#active >= DISCORD_MODE_MAX_PENDING)
			throw new DiscordModeRequestError("not-started", "Discord mode request capacity reached.");
		this.#active++;
		const controller = new AbortController();
		this.#controllers.add(controller);
		const abort = () => controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let sent = false;
		try {
			if ((await inspectDiscordModeSocket(this.#socketPath)) === "missing") throw new Error("Socket unavailable.");
			if (this.#closed || controller.signal.aborted) throw new Error("Connection cancelled.");
			sent = true;
			const response = await fetch(`http://discord-mode.local${route}`, {
				...init,
				unix: this.#socketPath,
				headers: {
					[DISCORD_MODE_AUTH_HEADER]: this.#token,
					...(this.#configKey === undefined ? {} : { [DISCORD_MODE_CONFIG_HEADER]: this.#configKey }),
					"content-type": "application/json",
				},
				signal: controller.signal,
			});
			if (this.#closed || controller.signal.aborted) throw new Error("Connection cancelled.");
			return { response, body: await readDiscordModeJsonBody(response) };
		} catch {
			throw new DiscordModeRequestError(
				sent ? "unknown" : "not-started",
				sent
					? "Discord mode connection failed; the request outcome is unknown. Inspect status before deciding whether to retry."
					: "Discord mode socket is unavailable or unsafe; the request was not sent.",
			);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			this.#controllers.delete(controller);
			this.#active--;
		}
	}

	async probe(expectedConfigKey?: string): Promise<DiscordModeInfo> {
		const { response, body } = await this.#fetch("/info", {}, PROBE_TIMEOUT_MS);
		if (
			!response.ok ||
			!record(body) ||
			body.protocol !== DISCORD_MODE_PROTOCOL ||
			!text(body.instanceId, 128) ||
			!text(body.configKey, 512)
		) {
			throw new Error(
				"Discord mode broker authentication or protocol does not match; no existing service was replaced.",
			);
		}
		if (
			(expectedConfigKey !== undefined && body.configKey !== expectedConfigKey) ||
			(this.#configKey !== undefined && body.configKey !== this.#configKey)
		)
			throw new Error(
				"Discord mode configuration differs from the running service. Stop that service explicitly before reconnecting; it was not replaced.",
			);
		this.#configKey = body.configKey;
		return { protocol: DISCORD_MODE_PROTOCOL, instanceId: body.instanceId, configKey: body.configKey };
	}

	async request(input: ModeRequest, signal?: AbortSignal): Promise<ModeSnapshot> {
		if (!isModeRequest(input)) throw new DiscordModeRequestError("not-started", "Invalid Discord mode request.");
		const encoded = JSON.stringify({ protocol: DISCORD_MODE_PROTOCOL, request: input });
		if (Buffer.byteLength(encoded) > DISCORD_MODE_MAX_FRAME)
			throw new DiscordModeRequestError("not-started", "Discord mode request exceeds its size limit.");
		const { response, body } = await this.#fetch("/request", { method: "POST", body: encoded }, undefined, signal);
		if (
			record(body) &&
			body.protocol === DISCORD_MODE_PROTOCOL &&
			body.ok === false &&
			body.outcome === "not-started"
		) {
			throw new DiscordModeRequestError(
				"not-started",
				"Discord mode rejected the request before execution (authentication, protocol, readiness, or capacity).",
			);
		}
		if (
			!response.ok ||
			!record(body) ||
			body.protocol !== DISCORD_MODE_PROTOCOL ||
			body.ok !== true ||
			!snapshot(body.result) ||
			!(await snapshotMatches(body.result, input))
		) {
			// Only the authenticated broker's explicit conflict envelope carries a safe recovery reason.
			let detail = "";
			if (
				response.status === 409 &&
				record(body) &&
				body.protocol === DISCORD_MODE_PROTOCOL &&
				body.ok === false &&
				body.outcome === "unknown" &&
				typeof body.error === "string" &&
				body.error.length <= 500 &&
				/^[\x20-\x7e]+$/.test(body.error)
			) {
				detail = body.error.replaceAll(this.#token, "[redacted]");
				if (this.#configKey) detail = detail.replaceAll(this.#configKey, "[redacted]");
				if ("lease" in input) detail = detail.replaceAll(input.lease.token, "[redacted]");
				detail += " ";
			}
			throw new DiscordModeRequestError(
				"unknown",
				`${detail}Discord mode did not confirm the result; outcome may be unknown. Inspect status before retrying.`,
			);
		}
		return body.result;
	}

	async lookup(projectDir: string, sessionId: string): Promise<ModeEnrollment | undefined> {
		if (!absolutePath(projectDir) || !identifier(sessionId)) throw new Error("Invalid Discord enrollment identity.");
		const { response, body } = await this.#fetch(
			`/enrollment?projectDir=${encodeURIComponent(projectDir)}&sessionId=${encodeURIComponent(sessionId)}`,
		);
		if (!response.ok || !record(body) || body.protocol !== DISCORD_MODE_PROTOCOL)
			throw new Error("Discord mode enrollment lookup failed.");
		const enrollment = body.enrollment;
		if (enrollment === null) return undefined;
		if (
			!record(enrollment) ||
			!group(enrollment.group) ||
			!(await sameDirectory(projectDir, enrollment.group.projectDir))
		)
			throw new Error("Discord mode enrollment lookup failed.");
		const retained = enrollment.session;
		if (
			retained !== undefined &&
			(!session(retained) ||
				retained.id !== sessionId ||
				retained.groupId !== enrollment.group.id ||
				retained.projectDir !== enrollment.group.projectDir)
		)
			throw new Error("Discord mode enrollment lookup returned a mismatched session.");
		return { group: enrollment.group, ...(retained === undefined ? {} : { session: retained }) };
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#supervisor?.destroy();
		for (const controller of this.#controllers) controller.abort();
		this.#controllers.clear();
	}
}

/** Authenticated real transport seam; never reads configuration or starts a service. */
export async function connectDiscordModeAt(socketPath: string, token: string): Promise<DiscordModeClient> {
	const client = new DiscordModeClient(socketPath, token);
	try {
		await client.probe();
		return client;
	} catch (error) {
		await client.close();
		throw error;
	}
}

async function snapshotMatches(value: ModeSnapshot, input: ModeRequest): Promise<boolean> {
	if (
		value.session.groupId !== value.group.id ||
		value.session.projectDir !== value.group.projectDir ||
		value.peers.some(peer => peer.groupId !== value.group.id || peer.projectDir !== value.group.projectDir) ||
		value.deliveries.some(delivery => delivery.sessionId !== value.session.id) ||
		(value.lease !== undefined &&
			(value.lease.sessionId !== value.session.id ||
				value.lease.connectionId !== value.session.connectionId ||
				!text(value.lease.token, 512)))
	)
		return false;
	if (input.op === "retire") return value.session.retirement?.eventId === input.eventId;
	if (input.op === "register") {
		return (
			value.session.id === input.sessionId &&
			value.session.connectionId === input.connectionId &&
			(await sameDirectory(input.projectDir, value.session.projectDir)) &&
			path.basename(value.session.sessionFile) === path.basename(input.sessionFile) &&
			(await sameDirectory(path.dirname(input.sessionFile), path.dirname(value.session.sessionFile))) &&
			value.lease !== undefined
		);
	}
	return value.session.id === input.lease.sessionId && value.session.connectionId === input.lease.connectionId;
}

/** The native broker canonicalizes directories while retaining the session filename. */
async function sameDirectory(input: string, canonical: string): Promise<boolean> {
	if (path.resolve(input) === canonical) return true;
	return (await fs.realpath(input).catch(() => undefined)) === canonical;
}

/** A ping-only lease: never starts, administers, or reconnects to a supervisor. */
async function holdSupervisor(descriptor: NonNullable<DiscordModeConnector["supervisor"]>): Promise<net.Socket> {
	const token = (await readPrivateText(descriptor.tokenPath, 1024))?.trim();
	if (!token || !/^[A-Za-z0-9_-]{32,512}$/.test(token))
		throw new Error(
			"Existing Discord supervisor credentials are missing or invalid; update/bootstrap the Haiso broker.",
		);
	if ((await inspectDiscordModeSocket(descriptor.endpoint)) === "missing")
		throw new Error("Existing Discord supervisor is unavailable; start the configured Haiso broker first.");
	const socket = net.createConnection(descriptor.endpoint);
	const result = Promise.withResolvers<net.Socket>();
	const id = randomUUID();
	const bytes = Buffer.alloc(8192);
	let length = 0;
	let admitted = false;
	const fail = () => {
		socket.destroy();
		result.reject(new Error("Existing Discord supervisor lease failed; update/bootstrap the Haiso broker."));
	};
	const timer = setTimeout(fail, PROBE_TIMEOUT_MS);
	socket.once("connect", () => socket.write(`${JSON.stringify({ id, token, operation: { op: "ping" } })}\n`));
	socket.on("error", fail);
	socket.once("close", () => {
		clearTimeout(timer);
		if (!admitted) fail();
	});
	socket.on("data", function receive(chunk: Buffer) {
		if (admitted || length + chunk.length > bytes.length) {
			fail();
			return;
		}
		bytes.set(chunk, length);
		length += chunk.length;
		const newline = bytes.subarray(0, length).indexOf(10);
		if (newline < 0) return;
		try {
			const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, newline)));
			if (
				newline !== length - 1 ||
				!record(body) ||
				body.id !== id ||
				body.ok !== true ||
				!record(body.result) ||
				body.result.op !== "ping" ||
				body.result.projectDir !== descriptor.projectDir
			) {
				fail();
				return;
			}
			admitted = true;
			clearTimeout(timer);
			socket.removeListener("data", receive);
			socket.on("data", fail);
			result.resolve(socket);
		} catch {
			fail();
		}
	});
	try {
		return await result.promise;
	} catch (error) {
		socket.destroy();
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

let connecting = 0;

/** Attach only to the existing private connector; never read bot config or start a service. */
export async function connectExistingDiscordMode(root: string): Promise<DiscordModeClient> {
	if (!absolutePath(root)) throw new Error("Discord bridge root must be an absolute private directory.");
	if (connecting >= DISCORD_MODE_MAX_PENDING) throw new Error("Discord bridge connection capacity reached.");
	connecting++;
	let supervisor: net.Socket | undefined;
	let client: DiscordModeClient | undefined;
	try {
		const value = await readPrivateJson(path.join(root, "connector.json"), 8192);
		if (
			!record(value) ||
			value.version !== 1 ||
			!text(value.configKey, 512) ||
			Object.keys(value).some(key => !["version", "configKey", "supervisor"].includes(key))
		) {
			throw new Error(
				"Discord bridge connector is missing or invalid; update/bootstrap the configured Haiso broker first.",
			);
		}
		if (value.supervisor !== undefined) {
			const lease = value.supervisor;
			if (
				!record(lease) ||
				!absolutePath(lease.projectDir) ||
				path.normalize(lease.projectDir) !== lease.projectDir ||
				lease.endpoint !== path.join(lease.projectDir, "broker.sock") ||
				lease.tokenPath !== path.join(lease.projectDir, "broker.token") ||
				Object.keys(lease).some(key => !["endpoint", "tokenPath", "projectDir"].includes(key))
			) {
				throw new Error("Discord bridge supervisor descriptor is unsafe; update/bootstrap the Haiso broker.");
			}
			supervisor = await holdSupervisor({
				endpoint: lease.endpoint as string,
				tokenPath: lease.tokenPath as string,
				projectDir: lease.projectDir,
			});
		}
		const token = await readDiscordModeToken(path.join(root, "ipc-token.json"));
		if (!token)
			throw new Error("Discord bridge IPC credentials are missing; start the configured Haiso broker first.");
		if (supervisor?.destroyed) throw new Error("Discord bridge supervisor disconnected during attachment.");
		client = new DiscordModeClient(path.join(root, "ipc.sock"), token, supervisor);
		await client.probe(value.configKey);
		return client;
	} catch (error) {
		supervisor?.destroy();
		await client?.close();
		throw error;
	} finally {
		connecting--;
	}
}
