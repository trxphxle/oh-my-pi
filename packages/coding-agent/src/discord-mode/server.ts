// Socket stale-owner checks adapted from omp-discord-bridge, Copyright (c) 2026 treearc, MIT License.
import { randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { DiscordModeError, type DiscordModeBroker } from "./broker";
import { ensurePrivateDirectory } from "./private-files";
import {
	DISCORD_MODE_MAX_FRAME,
	DISCORD_MODE_MAX_PENDING,
	DISCORD_MODE_MAX_TEXT,
	DISCORD_MODE_PROTOCOL,
	type ModeEnrollment,
	type ModeRequest,
} from "./protocol";

export const DISCORD_MODE_REQUEST_TIMEOUT_MS = 30_000;
export const DISCORD_MODE_AUTH_HEADER = "x-omp-discord-token";

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
				(value.text === undefined || text(value.text, DISCORD_MODE_MAX_TEXT, true))
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

async function removeStaleSocket(socketPath: string): Promise<void> {
	if ((await inspectDiscordModeSocket(socketPath)) === "missing") return;
	const before = await fs.lstat(socketPath);
	if (!(await discordModeSocketIsStale(socketPath)))
		throw new Error("Discord socket is already live; nothing was replaced.");
	let current;
	try {
		current = await fs.lstat(socketPath);
	} catch (error) {
		if (record(error) && error.code === "ENOENT") return;
		throw error;
	}
	if (current.dev !== before.dev || current.ino !== before.ino)
		throw new Error("Discord IPC socket changed; nothing was replaced.");
	await fs.unlink(socketPath);
}

type RequestBroker = Pick<DiscordModeBroker, "request"> & {
	lookup?(projectDir: string, sessionId: string): Promise<ModeEnrollment | undefined>;
};

/** Owns the socket only. The worker owns gateway/broker lifecycle, and sessions remain in their native process. */
export async function startDiscordModeServer(options: {
	broker: RequestBroker;
	socketPath: string;
	token: string;
	configKey?: string;
	ready?: boolean;
}): Promise<{ close(): Promise<void>; ready(): void }> {
	if (!/^[A-Za-z0-9_-]{32,512}$/.test(options.token)) throw new Error("Invalid Discord IPC authentication token.");
	if (process.platform === "win32") throw new Error("Discord mode currently requires Unix-domain sockets.");
	if (Buffer.byteLength(options.socketPath) > 103)
		throw new Error("Discord mode socket path is too long; use a shorter agent directory.");
	await ensurePrivateDirectory(path.dirname(options.socketPath));
	await removeStaleSocket(options.socketPath);
	const secret = Buffer.from(options.token);
	const instanceId = randomUUID();
	let ready = options.ready ?? true;
	let active = 0;
	let closed = false;
	const failure = (status: number, outcome: "not-started" | "unknown") =>
		Response.json({ protocol: DISCORD_MODE_PROTOCOL, ok: false, outcome }, { status });
	const server = Bun.serve({
		unix: options.socketPath,
		maxRequestBodySize: DISCORD_MODE_MAX_FRAME,
		async fetch(request) {
			const supplied = Buffer.from(request.headers.get(DISCORD_MODE_AUTH_HEADER) ?? "");
			if (supplied.length !== secret.length || !timingSafeEqual(supplied, secret))
				return failure(401, "not-started");
			if (closed || !ready) return failure(503, "not-started");
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/info") {
				return Response.json({
					protocol: DISCORD_MODE_PROTOCOL,
					configKey: options.configKey ?? "fixture",
					instanceId,
				});
			}
			if (active >= DISCORD_MODE_MAX_PENDING) return failure(429, "not-started");
			if (request.method === "GET" && url.pathname === "/enrollment") {
				const projectDir = url.searchParams.get("projectDir");
				const sessionId = url.searchParams.get("sessionId");
				if (!absolutePath(projectDir) || !identifier(sessionId) || !options.broker.lookup)
					return failure(400, "not-started");
				active++;
				try {
					return Response.json({
						protocol: DISCORD_MODE_PROTOCOL,
						enrollment: (await options.broker.lookup(projectDir, sessionId)) ?? null,
					});
				} catch {
					return failure(500, "not-started");
				} finally {
					active--;
				}
			}
			if (request.method !== "POST" || url.pathname !== "/request") return failure(404, "not-started");
			active++;
			let envelope: unknown;
			try {
				envelope = await readDiscordModeJsonBody(request);
			} catch {
				active--;
				return failure(400, "not-started");
			}
			if (!record(envelope) || envelope.protocol !== DISCORD_MODE_PROTOCOL || !isModeRequest(envelope.request)) {
				active--;
				return failure(400, "not-started");
			}
			const input = envelope.request;
			const operation = Promise.resolve()
				.then(() => options.broker.request(input))
				.then(
					result => {
						const body = JSON.stringify({ protocol: DISCORD_MODE_PROTOCOL, ok: true, result });
						if (Buffer.byteLength(body) > DISCORD_MODE_MAX_FRAME) return failure(500, "unknown");
						return new Response(body, { headers: { "content-type": "application/json" } });
					},
					error =>
						error instanceof DiscordModeError
							? Response.json(
									{ protocol: DISCORD_MODE_PROTOCOL, ok: false, outcome: "unknown", error: error.message },
									{ status: 409 },
								)
							: failure(500, "unknown"),
				)
				.finally(() => {
					active--;
				});
			const deadline = Promise.withResolvers<Response>();
			const timer = setTimeout(() => deadline.resolve(failure(504, "unknown")), DISCORD_MODE_REQUEST_TIMEOUT_MS);
			try {
				return await Promise.race([operation, deadline.promise]);
			} finally {
				clearTimeout(timer);
			}
		},
		error() {
			return failure(500, "unknown");
		},
	});
	try {
		await fs.chmod(options.socketPath, 0o600);
	} catch {
		await server.stop(true);
		throw new Error("Cannot secure Discord IPC socket.");
	}
	const ownedSocket = await fs.lstat(options.socketPath);
	return {
		ready() {
			ready = true;
		},
		async close() {
			if (closed) return;
			closed = true;
			await server.stop(true);
			let current;
			try {
				current = await fs.lstat(options.socketPath);
			} catch (error) {
				if (record(error) && error.code === "ENOENT") return;
				throw error;
			}
			if (current.dev === ownedSocket.dev && current.ino === ownedSocket.ino) await fs.unlink(options.socketPath);
		},
	};
}
