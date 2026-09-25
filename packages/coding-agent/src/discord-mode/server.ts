// Socket stale-owner checks adapted from omp-discord-bridge, Copyright (c) 2026 treearc, MIT License.
import { randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DiscordModeError, type DiscordModeBroker } from "./broker";
import { ensurePrivateDirectory } from "@oh-my-pi/pi-utils/discord-private-files";
import {
	DISCORD_MODE_MAX_FRAME,
	DISCORD_MODE_MAX_PENDING,
	DISCORD_MODE_MAX_SESSIONS,
	DISCORD_MODE_PROTOCOL,
	type ModeEnrollment,
	type ModeLease,
	type ModeServiceInfo,
} from "@oh-my-pi/pi-wire/discord-mode";

import {
	DISCORD_MODE_REQUEST_TIMEOUT_MS,
	DISCORD_MODE_AUTH_HEADER,
	DISCORD_MODE_CONFIG_HEADER,
	isModeRequest,
	isModeWaitRequest,
	readDiscordModeJsonBody,
	inspectDiscordModeSocket,
	discordModeSocketIsStale,
} from "@oh-my-pi/pi-utils/discord-client";

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
	wait?(lease: ModeLease, timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
};

/** Owns the socket only. The worker owns gateway/broker lifecycle, and sessions remain in their native process. */
export async function startDiscordModeServer(options: {
	broker: RequestBroker;
	socketPath: string;
	token: string;
	configKey?: string;
	ready?: boolean;
	/** The running build, reported by `/info`. */
	service?: ModeServiceInfo;
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
	/** Parked `/wait`s: idle sessions hold one each, so they have their own cap instead of `active`'s. */
	let waiting = 0;
	let closed = false;
	const failure = (status: number, outcome: "not-started" | "unknown") =>
		Response.json({ protocol: DISCORD_MODE_PROTOCOL, ok: false, outcome }, { status });
	const server = Bun.serve({
		unix: options.socketPath,
		maxRequestBodySize: DISCORD_MODE_MAX_FRAME,
		async fetch(request, http) {
			// Bun's per-connection idle timeout defaults to 10 s (and `idleTimeout` is not an option for Unix sockets);
			// outlive the request deadline, and the client's timeout just past it, so a slow broker answers 504 and
			// never drops the socket mid-request.
			http.timeout(request, Math.ceil(DISCORD_MODE_REQUEST_TIMEOUT_MS / 1000) + 10);
			const supplied = Buffer.from(request.headers.get(DISCORD_MODE_AUTH_HEADER) ?? "");
			if (supplied.length !== secret.length || !timingSafeEqual(supplied, secret))
				return failure(401, "not-started");
			const configKey = request.headers.get(DISCORD_MODE_CONFIG_HEADER);
			if (configKey !== null && configKey !== (options.configKey ?? "fixture")) return failure(409, "not-started");
			if (closed || !ready) return failure(503, "not-started");
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/info") {
				return Response.json({
					protocol: DISCORD_MODE_PROTOCOL,
					configKey: options.configKey ?? "fixture",
					instanceId,
					...(options.service ? { service: options.service } : {}),
				});
			}
			if (request.method === "POST" && url.pathname === "/wait") {
				if (!options.broker.wait) return failure(404, "not-started");
				if (waiting >= DISCORD_MODE_MAX_SESSIONS) return failure(429, "not-started");
				waiting++;
				try {
					let body: unknown;
					try {
						body = await readDiscordModeJsonBody(request);
					} catch {
						return failure(400, "not-started");
					}
					if (!record(body) || body.protocol !== DISCORD_MODE_PROTOCOL || !isModeWaitRequest(body))
						return failure(400, "not-started");
					// A client that hangs up (it moved on) aborts the request, which drops the waiter.
					const ready = await options.broker.wait(body.lease, body.timeoutMs, request.signal);
					return Response.json({ protocol: DISCORD_MODE_PROTOCOL, ok: true, ready });
				} catch {
					return failure(500, "not-started");
				} finally {
					waiting--;
				}
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
