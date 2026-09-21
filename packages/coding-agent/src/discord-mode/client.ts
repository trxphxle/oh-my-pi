import { createHash } from "node:crypto";
import { DISCORD_MODE_WORKER_ARG } from "../cli/worker-selectors";
import { daemonClientForGlobal } from "../launch/client";
import { canonicalProjectDir } from "../launch/paths";
import { resolveWorkerSpawnCmd, type WorkerSpawnCommand } from "../subprocess/worker-client";
import {
	DISCORD_MODE_CONFIG_ENV,
	DISCORD_MODE_ROOT_ENV,
	DISCORD_MODE_SOCKET_ENV,
	discordModeConfigKey,
	discordModePaths,
	loadDiscordModeConfig,
} from "./config";
import { ensurePrivateDirectory, readPrivateJson } from "./private-files";
import {
	DISCORD_MODE_DAEMON_NAME,
	DISCORD_MODE_MAX_FRAME,
	DISCORD_MODE_MAX_PENDING,
	DISCORD_MODE_MAX_SESSIONS,
	DISCORD_MODE_PROTOCOL,
	DISCORD_MODE_READY,
	type ModeEnrollment,
	type ModeGroup,
	type ModeRequest,
	type ModeSession,
	type ModeSnapshot,
} from "./protocol";
import {
	DISCORD_MODE_AUTH_HEADER,
	DISCORD_MODE_REQUEST_TIMEOUT_MS,
	discordModeSocketIsStale,
	inspectDiscordModeSocket,
	isModeRequest,
	readDiscordModeJsonBody,
} from "./server";

const READY_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 1500;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
function session(value: unknown): value is ModeSession {
	return (
		record(value) &&
		["id", "groupId", "sessionFile", "projectDir", "label", "connectionId"].every(
			key => typeof value[key] === "string",
		) &&
		["enabled", "connected", "busy", "pendingInput"].every(key => typeof value[key] === "boolean") &&
		binding(value.state) &&
		(value.channelId === undefined || typeof value.channelId === "string")
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
		)
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

export function resolveDiscordModeWorkerCommand(): WorkerSpawnCommand {
	return resolveWorkerSpawnCmd(DISCORD_MODE_WORKER_ARG);
}

export class DiscordModeClient {
	readonly #socketPath: string;
	readonly #token: string;
	#closed = false;
	#active = 0;
	readonly #controllers = new Set<AbortController>();

	constructor(socketPath: string, token: string) {
		if (!/^[A-Za-z0-9_-]{32,512}$/.test(token)) throw new Error("Invalid Discord IPC authentication token.");
		this.#socketPath = socketPath;
		this.#token = token;
	}

	async #fetch(
		route: string,
		init: RequestInit = {},
		timeoutMs = DISCORD_MODE_REQUEST_TIMEOUT_MS + 2000,
	): Promise<{ response: Response; body: unknown }> {
		if (this.#closed) throw new DiscordModeRequestError("not-started", "Discord mode client is closed.");
		if (this.#active >= DISCORD_MODE_MAX_PENDING)
			throw new DiscordModeRequestError("not-started", "Discord mode request capacity reached.");
		this.#active++;
		const controller = new AbortController();
		this.#controllers.add(controller);
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let sent = false;
		try {
			if ((await inspectDiscordModeSocket(this.#socketPath)) === "missing") throw new Error("Socket unavailable.");
			sent = true;
			const response = await fetch(`http://discord-mode.local${route}`, {
				...init,
				unix: this.#socketPath,
				headers: { [DISCORD_MODE_AUTH_HEADER]: this.#token, "content-type": "application/json" },
				signal: controller.signal,
			});
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
			this.#controllers.delete(controller);
			this.#active--;
		}
	}

	async probe(expectedConfigKey?: string): Promise<void> {
		const { response, body } = await this.#fetch("/info", {}, PROBE_TIMEOUT_MS);
		if (
			!response.ok ||
			!record(body) ||
			body.protocol !== DISCORD_MODE_PROTOCOL ||
			typeof body.instanceId !== "string" ||
			typeof body.configKey !== "string"
		) {
			throw new Error(
				"Discord mode broker authentication or protocol does not match; no existing service was replaced.",
			);
		}
		if (expectedConfigKey !== undefined && body.configKey !== expectedConfigKey)
			throw new Error(
				"Discord mode configuration differs from the running service. Stop that service explicitly before reconnecting; it was not replaced.",
			);
	}

	async request(input: ModeRequest): Promise<ModeSnapshot> {
		if (!isModeRequest(input)) throw new DiscordModeRequestError("not-started", "Invalid Discord mode request.");
		const encoded = JSON.stringify({ protocol: DISCORD_MODE_PROTOCOL, request: input });
		if (Buffer.byteLength(encoded) > DISCORD_MODE_MAX_FRAME)
			throw new DiscordModeRequestError("not-started", "Discord mode request exceeds its size limit.");
		const { response, body } = await this.#fetch("/request", { method: "POST", body: encoded });
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
			!snapshot(body.result)
		) {
			const detail =
				record(body) && body.protocol === DISCORD_MODE_PROTOCOL && typeof body.error === "string"
					? `${body.error} `
					: "";
			throw new DiscordModeRequestError(
				"unknown",
				`${detail}Discord mode did not confirm the result; outcome may be unknown. Inspect status before retrying.`,
			);
		}
		return body.result;
	}

	async lookup(projectDir: string, sessionId: string): Promise<ModeEnrollment | undefined> {
		const { response, body } = await this.#fetch(
			`/enrollment?projectDir=${encodeURIComponent(projectDir)}&sessionId=${encodeURIComponent(sessionId)}`,
		);
		if (!response.ok || !record(body) || body.protocol !== DISCORD_MODE_PROTOCOL)
			throw new Error("Discord mode enrollment lookup failed.");
		const enrollment = body.enrollment;
		if (enrollment === null) return undefined;
		if (!record(enrollment) || !group(enrollment.group)) throw new Error("Discord mode enrollment lookup failed.");
		const retained = enrollment.session;
		if (
			retained !== undefined &&
			(!session(retained) || retained.id !== sessionId || retained.groupId !== enrollment.group.id)
		)
			throw new Error("Discord mode enrollment lookup returned a mismatched session.");
		return { group: enrollment.group, ...(retained === undefined ? {} : { session: retained }) };
	}

	async close(): Promise<void> {
		this.#closed = true;
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

/** One profile-scoped account service, leased by the parent process rather than by individual sessions. */
export async function connectDiscordMode(): Promise<DiscordModeClient> {
	const config = await loadDiscordModeConfig();
	const paths = discordModePaths();
	await ensurePrivateDirectory(paths.root);
	const configKey = discordModeConfigKey(config);
	const scope = createHash("sha256")
		.update(await canonicalProjectDir(paths.root))
		.digest("hex")
		.slice(0, 16);
	const supervisor = await daemonClientForGlobal(`haiso-discord-${scope}`);
	await supervisor.request({ op: "ping" });
	const adopt = async (): Promise<DiscordModeClient | undefined> => {
		if ((await inspectDiscordModeSocket(paths.socketPath)) === "missing") return undefined;
		const token = await readDiscordModeToken(paths.tokenPath);
		if (!token)
			throw new Error("Discord mode socket exists without its private authentication file; nothing was replaced.");
		const client = new DiscordModeClient(paths.socketPath, token);
		try {
			await client.probe(configKey);
			return client;
		} catch (error) {
			await client.close();
			throw error;
		}
	};
	for (let attempt = 0; attempt < 3; attempt++) {
		const listed = await supervisor.request({ op: "list" });
		if (listed.op !== "list") throw new Error("Discord mode supervisor returned an invalid response.");
		const existing = listed.daemons.find(daemon => daemon.name === DISCORD_MODE_DAEMON_NAME);
		if (existing && existing.state !== "exited" && existing.state !== "failed") {
			if (existing.readyAt === undefined)
				await supervisor.request({
					op: "wait",
					name: DISCORD_MODE_DAEMON_NAME,
					for: "ready",
					timeoutMs: READY_TIMEOUT_MS,
				});
			const live = await adopt();
			if (live) return live;
			throw new Error("Discord mode service is active but not verifiably ready; it was not stopped or replaced.");
		}
		// A live independently started endpoint is adopted only after protocol/config authentication.
		if (
			(await inspectDiscordModeSocket(paths.socketPath)) === "present" &&
			!(await discordModeSocketIsStale(paths.socketPath))
		) {
			const live = await adopt();
			if (live) return live;
			throw new Error("Discord mode socket cannot be authenticated; no existing service was replaced.");
		}
		const spawn = resolveDiscordModeWorkerCommand();
		try {
			await supervisor.request({
				op: "start",
				spec: {
					name: DISCORD_MODE_DAEMON_NAME,
					application: spawn.cmd[0]!,
					args: spawn.cmd.slice(1),
					cwd: spawn.cwd ?? paths.root,
					env: {
						[DISCORD_MODE_ROOT_ENV]: paths.root,
						[DISCORD_MODE_CONFIG_ENV]: paths.configPath,
						[DISCORD_MODE_SOCKET_ENV]: paths.socketPath,
					},
					pty: false,
					ready: { log: DISCORD_MODE_READY, timeoutMs: READY_TIMEOUT_MS },
					restart: "no",
					persist: false,
					detached: false,
				},
			});
		} catch {
			// Only startup is retried. A concurrently registered worker may have won; no operation is replayed.
			continue;
		}
		const live = await adopt();
		if (live) return live;
	}
	throw new Error("Discord mode service did not become ready; no existing service was stopped or restarted.");
}
