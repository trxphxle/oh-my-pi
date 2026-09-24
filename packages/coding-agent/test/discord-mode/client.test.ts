import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { writePrivateJson } from "@oh-my-pi/pi-utils/discord-private-files";
import { connectDiscordMode } from "../../src/discord-mode/client";
import {
	DISCORD_MODE_CONFIG_ENV,
	DISCORD_MODE_ROOT_ENV,
	DISCORD_MODE_SOCKET_ENV,
	discordModeConfigKey,
} from "../../src/discord-mode/config";
import { startDiscordModeServer } from "../../src/discord-mode/server";
import * as daemon from "../../src/launch/client";

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
