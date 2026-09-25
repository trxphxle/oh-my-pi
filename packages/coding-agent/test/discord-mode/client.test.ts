import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { writePrivateJson } from "@oh-my-pi/pi-utils/discord-private-files";
import * as discordClient from "@oh-my-pi/pi-utils/discord-client";
import { DISCORD_MODE_DAEMON_NAME } from "@oh-my-pi/pi-wire/discord-mode";
import { DISCORD_MODE_WORKER_ARG } from "../../src/cli/worker-selectors";
import { connectDiscordMode, resolveDiscordModeWorkerCommand } from "../../src/discord-mode/client";
import {
	DISCORD_MODE_CONFIG_ENV,
	DISCORD_MODE_ROOT_ENV,
	DISCORD_MODE_SOCKET_ENV,
	discordModeConfigKey,
} from "../../src/discord-mode/config";
import { startDiscordModeServer } from "../../src/discord-mode/server";
import { readDiscordServiceSettings, setDiscordServiceKeepOnline } from "../../src/discord-mode/service";
import * as daemon from "../../src/launch/client";
import type { DaemonOperation } from "../../src/launch/protocol";
import { resolveWorkerSpawnCmd } from "../../src/subprocess/worker-client";

const config = {
	botToken: "offline-native-client-fixture-token",
	guildId: "100000000000000001",
	ownerId: "200000000000000002",
};
const configKey = discordModeConfigKey(config);
const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dnc-")));
	await fs.chmod(root, 0o700);
	cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
	for (const [key, value] of Object.entries({
		[DISCORD_MODE_ROOT_ENV]: root,
		[DISCORD_MODE_CONFIG_ENV]: path.join(root, "config.json"),
		[DISCORD_MODE_SOCKET_ENV]: path.join(root, "ipc.sock"),
		HAISO_DAEMON_NAMESPACE: "native-client-new-runtime",
	})) {
		const previous = process.env[key];
		process.env[key] = value;
		cleanups.push(() => {
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		});
	}
	await writePrivateJson(path.join(root, "config.json"), config);
	const factory = spyOn(daemon, "daemonClientForGlobal").mockImplementation(async () => {
		throw new Error("new supervisor creation reached");
	});
	cleanups.push(() => factory.mockRestore());
	return { root, factory };
}

function setEnv(key: string, value: string | undefined) {
	const previous = process.env[key];
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
	cleanups.push(() => {
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	});
}

/** Records supervisor operations; `start` brings up an authenticated endpoint like a real worker would. */
function fakeSupervisor(
	root: string,
	factory: { mockImplementation(implementation: typeof daemon.daemonClientForGlobal): unknown },
	daemons: unknown[] = [],
) {
	const operations: DaemonOperation[] = [];
	const projectDir = path.join(root, "supervisor");
	factory.mockImplementation(
		async () =>
			({
				projectDir,
				async request(operation: DaemonOperation) {
					operations.push(operation);
					if (operation.op === "list") return { op: "list", daemons };
					if (operation.op === "start") {
						await endpoint(root);
						return { op: "start", daemon: {}, readyTimedOut: false };
					}
					return { op: operation.op, projectDir, daemon: {} };
				},
			}) as unknown as daemon.DaemonBrokerClient,
	);
	return operations;
}

async function readConnector(root: string) {
	return JSON.parse(await fs.readFile(path.join(root, "connector.json"), "utf8"));
}

async function endpoint(root: string) {
	const token = randomBytes(32).toString("base64url");
	let effects = 0;
	const server = await startDiscordModeServer({
		socketPath: path.join(root, "ipc.sock"),
		token,
		configKey,
		broker: {
			async request() {
				effects++;
				throw new Error("Attachment must not issue a mutating request");
			},
		},
	});
	cleanups.push(() => server.close());
	await writePrivateJson(path.join(root, "ipc-token.json"), { token });
	return {
		get effects() {
			return effects;
		},
	};
}

async function supervisor(root: string, validToken = true) {
	const runtime = path.join(root, "old");
	await fs.mkdir(runtime, { mode: 0o700 });
	const descriptor = {
		projectDir: runtime,
		endpoint: path.join(runtime, "broker.sock"),
		tokenPath: path.join(runtime, "broker.token"),
	};
	const token = randomBytes(32).toString("base64url");
	await fs.writeFile(descriptor.tokenPath, validToken ? token : randomBytes(32).toString("base64url"), {
		mode: 0o600,
	});
	const connections = new Set<net.Socket>();
	const operations: string[] = [];
	const released = Promise.withResolvers<void>();
	const server = net.createServer(socket => {
		connections.add(socket);
		socket.on("error", () => {});
		socket.once("close", () => {
			connections.delete(socket);
			if (connections.size === 0) released.resolve();
		});
		let input = "";
		socket.on("data", chunk => {
			input += chunk.toString();
			if (!input.endsWith("\n")) return;
			const envelope = JSON.parse(input);
			input = "";
			if (envelope.token !== token || envelope.operation.op !== "ping") {
				socket.destroy();
				return;
			}
			operations.push(envelope.operation.op);
			socket.write(
				`${JSON.stringify({ id: envelope.id, ok: true, result: { op: "ping", projectDir: runtime } })}\n`,
			);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(descriptor.endpoint, resolve);
	});
	await fs.chmod(descriptor.endpoint, 0o600);
	cleanups.push(async () => {
		for (const socket of connections) socket.destroy();
		await new Promise<void>(resolve => server.close(() => resolve()));
	});
	await writePrivateJson(path.join(root, "connector.json"), { version: 1, configKey, supervisor: descriptor });
	return { connections, operations, released: released.promise };
}

describe("native Discord durable connector adoption", () => {
	it("retains the old supervisor lease across a new runtime namespace without publishing or creating", async () => {
		const { root, factory } = await fixture();
		const service = await endpoint(root);
		const old = await supervisor(root);
		const descriptorPath = path.join(root, "connector.json");
		const before = await fs.stat(descriptorPath);
		const descriptor = await fs.readFile(descriptorPath, "utf8");
		const client = await connectDiscordMode();
		cleanups.push(() => client.close());
		expect((await client.probe(configKey)).configKey).toBe(configKey);
		expect(old.connections.size).toBe(1);
		expect(old.operations).toEqual(["ping"]);
		expect(factory).not.toHaveBeenCalled();
		expect(await fs.readFile(descriptorPath, "utf8")).toBe(descriptor);
		expect((await fs.stat(descriptorPath)).ino).toBe(before.ino);
		expect(service.effects).toBe(0);
		await client.close();
		await old.released;
		expect(old.connections.size).toBe(0);
		await expect(client.probe()).rejects.toThrow("closed");
	});

	it("closes the adopted lease when current configuration selects a different account", async () => {
		const { root, factory } = await fixture();
		await endpoint(root);
		const old = await supervisor(root);
		const descriptor = await fs.readFile(path.join(root, "connector.json"), "utf8");
		await writePrivateJson(path.join(root, "config.json"), { ...config, ownerId: "300000000000000003" });
		await expect(connectDiscordMode()).rejects.toThrow("configuration differs");
		await old.released;
		expect(old.connections.size).toBe(0);
		expect(factory).not.toHaveBeenCalled();
		expect(await fs.readFile(path.join(root, "connector.json"), "utf8")).toBe(descriptor);
	});

	it("rejects stale account metadata without bypassing it via the independent endpoint fallback", async () => {
		const { root, factory } = await fixture();
		await endpoint(root);
		await writePrivateJson(path.join(root, "connector.json"), { version: 1, configKey: "retired-account" });
		await expect(connectDiscordMode()).rejects.toThrow("configuration differs");
		expect(factory).not.toHaveBeenCalled();
	});

	it("fails closed when the recorded supervisor cannot authenticate", async () => {
		const { root, factory } = await fixture();
		await endpoint(root);
		const old = await supervisor(root, false);
		await expect(connectDiscordMode()).rejects.toThrow("supervisor lease failed");
		await old.released;
		expect(factory).not.toHaveBeenCalled();
	});

	it("keeps independently started connectors usable without inventing a supervisor lease", async () => {
		const { root, factory } = await fixture();
		await endpoint(root);
		const descriptorPath = path.join(root, "connector.json");
		await writePrivateJson(descriptorPath, { version: 1, configKey });
		const before = await fs.stat(descriptorPath);
		const client = await connectDiscordMode();
		cleanups.push(() => client.close());
		expect((await client.probe()).configKey).toBe(configKey);
		expect(factory).not.toHaveBeenCalled();
		expect((await fs.stat(descriptorPath)).ino).toBe(before.ino);
	});

	it("leaves descriptor-free independent endpoints on the existing authenticated fallback path", async () => {
		const { root, factory } = await fixture();
		await endpoint(root);
		await expect(connectDiscordMode()).rejects.toThrow("new supervisor creation reached");
		expect(factory).toHaveBeenCalledTimes(1);
		await expect(fs.stat(path.join(root, "connector.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	for (const state of ["missing", "stale"] as const) {
		it(`allows the normal creation path for a ${state} endpoint despite obsolete connector metadata`, async () => {
			const { root, factory } = await fixture();
			await writePrivateJson(path.join(root, "connector.json"), { version: 1, configKey: "obsolete-account" });
			if (state === "stale") {
				const socketPath = path.join(root, "ipc.sock");
				const movedPath = path.join(root, "stale.sock");
				const server = net.createServer();
				await new Promise<void>((resolve, reject) => {
					server.once("error", reject);
					server.listen(socketPath, resolve);
				});
				await fs.chmod(socketPath, 0o600);
				await fs.rename(socketPath, movedPath);
				await new Promise<void>(resolve => server.close(() => resolve()));
				await fs.rename(movedPath, socketPath);
			}
			await expect(connectDiscordMode()).rejects.toThrow("new supervisor creation reached");
			expect(factory).toHaveBeenCalledTimes(1);
		});
	}
});

describe("native Discord service lifecycle", () => {
	it("starts a persisted service by default and publishes a supervisor-free connector", async () => {
		const { root, factory } = await fixture();
		setEnv("HAISO_PREFIX", path.join(root, "prefix"));
		const operations = fakeSupervisor(root, factory);
		const client = await connectDiscordMode();
		cleanups.push(() => client.close());
		const start = operations.find(operation => operation.op === "start");
		expect(start?.op === "start" && start.spec).toMatchObject({
			name: DISCORD_MODE_DAEMON_NAME,
			persist: true,
			restart: "no",
			detached: false,
			env: { HAISO_PREFIX: path.join(root, "prefix") },
		});
		expect(await readConnector(root)).toEqual({ version: 1, configKey });
	});

	it("starts a session-scoped service with a supervisor lease when keep online is off", async () => {
		const { root, factory } = await fixture();
		setEnv("HAISO_PREFIX", undefined);
		await writePrivateJson(path.join(root, "service.json"), { version: 1, keepOnline: false });
		const operations = fakeSupervisor(root, factory);
		const client = await connectDiscordMode();
		cleanups.push(() => client.close());
		const start = operations.find(operation => operation.op === "start");
		expect(start?.op === "start" && start.spec.persist).toBe(false);
		expect(start?.op === "start" && "HAISO_PREFIX" in start.spec.env).toBe(false);
		expect((await readConnector(root)).supervisor).toBeDefined();
	});

	it("replaces a connector whose recorded supervisor is positively dead and adopts the live endpoint", async () => {
		const { root, factory } = await fixture();
		await endpoint(root);
		const dead = path.join(root, "gone");
		await writePrivateJson(path.join(root, "connector.json"), {
			version: 1,
			configKey,
			supervisor: {
				projectDir: dead,
				endpoint: path.join(dead, "broker.sock"),
				tokenPath: path.join(dead, "broker.token"),
			},
		});
		const operations = fakeSupervisor(root, factory);
		const client = await connectDiscordMode();
		cleanups.push(() => client.close());
		expect((await client.probe(configKey)).configKey).toBe(configKey);
		expect(operations.map(operation => operation.op)).toEqual(["ping", "list"]);
		expect(await readConnector(root)).toEqual({ version: 1, configKey });
		const again = await connectDiscordMode();
		cleanups.push(() => again.close());
		expect(factory).toHaveBeenCalledTimes(1);
	});

	it("runs the worker through the Haiso prefix link only when it is executable", async () => {
		const { root } = await fixture();
		const prefix = path.join(root, "prefix");
		setEnv("PI_COMPILED", "1");
		setEnv("HAISO_PREFIX", prefix);
		expect(resolveDiscordModeWorkerCommand()).toEqual(resolveWorkerSpawnCmd(DISCORD_MODE_WORKER_ARG));
		await fs.mkdir(path.join(prefix, "bin"), { recursive: true });
		await fs.writeFile(path.join(prefix, "bin", "haiso"), "#!/bin/sh\n", { mode: 0o755 });
		expect(resolveDiscordModeWorkerCommand().cmd).toEqual([
			path.join(prefix, "bin", "haiso"),
			DISCORD_MODE_WORKER_ARG,
		]);
	});

	it("persists keep online and switches a running supervised service live", async () => {
		const { root, factory } = await fixture();
		expect(await readDiscordServiceSettings()).toEqual({ keepOnline: true });
		const operations = fakeSupervisor(root, factory, [{ name: DISCORD_MODE_DAEMON_NAME, state: "running" }]);
		const probe = discordClient.discordModeSocketIsStale;
		const liveness = spyOn(discordClient, "discordModeSocketIsStale").mockImplementation(async socketPath =>
			socketPath.endsWith("broker.sock") ? false : probe(socketPath),
		);
		cleanups.push(() => liveness.mockRestore());
		await writePrivateJson(path.join(root, "connector.json"), { version: 1, configKey });
		expect(await setDiscordServiceKeepOnline(false)).toEqual({ live: true });
		expect(await readDiscordServiceSettings()).toEqual({ keepOnline: false });
		expect(operations.at(-1)).toEqual({ op: "mode", name: DISCORD_MODE_DAEMON_NAME, mode: "session" });
		// Session-scoped again: bridges must lease the supervisor, so the connector publishes it.
		expect((await readConnector(root)).supervisor).toMatchObject({ projectDir: path.join(root, "supervisor") });
		expect(await setDiscordServiceKeepOnline(true)).toEqual({ live: true });
		expect(await readConnector(root)).toEqual({ version: 1, configKey });
		liveness.mockImplementation(async () => true);
		expect(await setDiscordServiceKeepOnline(true)).toEqual({ live: false });
		expect(await readDiscordServiceSettings()).toEqual({ keepOnline: true });
		expect(operations.filter(operation => operation.op === "mode")).toHaveLength(2);
	});
});
