import { afterEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	DISCORD_MODE_MAX_FRAME,
	DISCORD_MODE_PROTOCOL,
	type ModeRequest,
	type ModeSnapshot,
} from "@oh-my-pi/pi-wire/discord-mode";
import {
	connectDiscordModeAt,
	connectExistingDiscordMode,
	DISCORD_MODE_AUTH_HEADER,
	DISCORD_MODE_CONFIG_HEADER,
	DiscordModeRequestError,
	readDiscordModeJsonBody,
} from "../src/discord-client";
import { readPrivateText, writePrivateJson } from "../src/discord-private-files";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function directory(): Promise<string> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dc-")));
	await fs.chmod(root, 0o700);
	cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
	return root;
}

const request: ModeRequest = {
	op: "report",
	requestId: "report-1",
	text: "publish once",
	lease: { sessionId: "session-1", connectionId: "connection-1", token: "lease-secret" },
};
const snapshot: ModeSnapshot = {
	group: { id: "group-1", projectDir: "/project", name: "Project", state: "ready" },
	session: {
		id: "session-1",
		groupId: "group-1",
		projectDir: "/project",
		sessionFile: "/project/session.jsonl",
		label: "Session",
		connectionId: "connection-1",
		enabled: true,
		connected: true,
		busy: false,
		pendingInput: false,
		state: "ready",
	},
	peers: [],
	deliveries: [],
	answers: [],
	gatewayConnected: true,
};

async function endpoint(root: string) {
	const token = randomBytes(32).toString("base64url");
	let configKey = "account-a";
	let instanceId = "instance-a";
	let effects = 0;
	let respond: () => Response | Promise<Response> = () =>
		Response.json({ protocol: DISCORD_MODE_PROTOCOL, ok: true, result: snapshot });
	const socketPath = path.join(root, "ipc.sock");
	const server = Bun.serve({
		unix: socketPath,
		async fetch(input) {
			const auth = input.headers.get(DISCORD_MODE_AUTH_HEADER);
			const bound = input.headers.get(DISCORD_MODE_CONFIG_HEADER);
			if (auth !== token || (bound !== null && bound !== configKey))
				return Response.json(
					{ protocol: DISCORD_MODE_PROTOCOL, ok: false, outcome: "not-started" },
					{ status: 401 },
				);
			if (new URL(input.url).pathname === "/info")
				return Response.json({ protocol: DISCORD_MODE_PROTOCOL, configKey, instanceId });
			await input.text();
			effects++;
			return respond();
		},
	});
	await fs.chmod(socketPath, 0o600);
	cleanups.push(() => server.stop(true));
	await writePrivateJson(path.join(root, "ipc-token.json"), { token });
	await writePrivateJson(path.join(root, "connector.json"), { version: 1, configKey });
	return {
		token,
		socketPath,
		get effects() {
			return effects;
		},
		set respond(value: () => Response | Promise<Response>) {
			respond = value;
		},
		set configKey(value: string) {
			configKey = value;
		},
		set instanceId(value: string) {
			instanceId = value;
		},
	};
}

async function supervisor(root: string, mode: "valid" | "wrong-scope" | "oversized" | "malformed" = "valid") {
	const runtime = path.join(root, "supervisor");
	await fs.mkdir(runtime, { mode: 0o700 });
	const descriptor = {
		projectDir: runtime,
		endpoint: path.join(runtime, "broker.sock"),
		tokenPath: path.join(runtime, "broker.token"),
	};
	const token = randomBytes(32).toString("hex");
	await fs.writeFile(descriptor.tokenPath, token, { mode: 0o600 });
	const connections = new Set<net.Socket>();
	const operations: unknown[] = [];
	let shutdown = false;
	const released = Promise.withResolvers<void>();
	const server = net.createServer(socket => {
		connections.add(socket);
		socket.on("error", () => {});
		socket.once("close", () => {
			connections.delete(socket);
			if (connections.size === 0) {
				shutdown = true;
				released.resolve();
			}
		});
		let input = "";
		socket.on("data", chunk => {
			input += chunk.toString();
			if (!input.endsWith("\n")) return;
			const envelope = JSON.parse(input);
			input = "";
			operations.push(envelope.operation);
			if (envelope.token !== token) {
				socket.end();
				return;
			}
			if (mode === "oversized") {
				socket.write("x".repeat(8193));
				return;
			}
			if (mode === "malformed") {
				socket.write("secret-invalid-json\n");
				return;
			}
			socket.write(
				`${JSON.stringify({ id: envelope.id, ok: true, result: { op: "ping", projectDir: mode === "wrong-scope" ? "/elsewhere" : runtime } })}\n`,
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
	await writePrivateJson(path.join(root, "connector.json"), {
		version: 1,
		configKey: "account-a",
		supervisor: descriptor,
	});
	return {
		descriptor,
		operations,
		connections,
		released: released.promise,
		get shutdown() {
			return shutdown;
		},
	};
}

describe("protocol-only Discord attachment", () => {
	it("authenticates Unix transport and binds the configured account, not a transient instance", async () => {
		const root = await directory();
		const server = await endpoint(root);
		await expect(connectDiscordModeAt(server.socketPath, randomBytes(32).toString("base64url"))).rejects.toThrow();
		const client = await connectExistingDiscordMode(root);
		cleanups.push(() => client.close());
		expect((await client.probe()).instanceId).toBe("instance-a");
		server.instanceId = "instance-b";
		expect((await client.probe()).instanceId).toBe("instance-b");
		expect((await client.request(request)).session.id).toBe("session-1");
		server.configKey = "account-b";
		await expect(client.request(request)).rejects.toMatchObject({ outcome: "not-started" });
		await expect(connectExistingDiscordMode(root)).rejects.toThrow();
		expect(server.effects).toBe(1);
		await writePrivateJson(path.join(root, "connector.json"), { version: 1, configKey: "account-b" });
		const reattached = await connectExistingDiscordMode(root);
		cleanups.push(() => reattached.close());
		expect((await reattached.request(request)).session.id).toBe("session-1");
		await expect(client.request(request)).rejects.toMatchObject({ outcome: "not-started" });
		expect(server.effects).toBe(2);
	});

	it("requires the published descriptor instead of discovering config or silently weakening attachment", async () => {
		const root = await directory();
		await endpoint(root);
		await fs.unlink(path.join(root, "connector.json"));
		await fs.writeFile(path.join(root, "config.json"), "not-readable-bot-config", { mode: 0 });
		await expect(connectExistingDiscordMode(root)).rejects.toThrow("bootstrap");
	});

	it("rejects unsafe descriptor, token, root aliases and socket paths", async () => {
		const root = await directory();
		const server = await endpoint(root);
		const descriptor = path.join(root, "connector.json");
		await fs.chmod(descriptor, 0o644);
		await expect(connectExistingDiscordMode(root)).rejects.toThrow();
		await fs.chmod(descriptor, 0o600);
		const original = path.join(root, "original.json");
		await fs.rename(descriptor, original);
		await fs.symlink(original, descriptor);
		await expect(connectExistingDiscordMode(root)).rejects.toThrow();
		await fs.unlink(descriptor);
		await fs.link(original, descriptor);
		await expect(connectExistingDiscordMode(root)).rejects.toThrow();
		await fs.unlink(descriptor);
		await fs.rename(original, descriptor);
		const alias = path.join(await directory(), "root-alias");
		await fs.symlink(root, alias);
		await expect(connectExistingDiscordMode(alias)).rejects.toThrow();
		await fs.chmod(server.socketPath, 0o666);
		await expect(connectExistingDiscordMode(root)).rejects.toThrow();
		await fs.chmod(server.socketPath, 0o600);
		await fs.chmod(path.join(root, "ipc-token.json"), 0o644);
		await expect(connectExistingDiscordMode(root)).rejects.toThrow();
	});

	it("bounds response streams and rejects malformed JSON without exposing endpoint text", async () => {
		const root = await directory();
		const server = await endpoint(root);
		const client = await connectExistingDiscordMode(root);
		cleanups.push(() => client.close());
		for (const payload of ["secret-invalid-json", "x".repeat(DISCORD_MODE_MAX_FRAME + 1)]) {
			server.respond = () => new Response(payload);
			try {
				await client.request(request);
				throw new Error("expected rejection");
			} catch (error) {
				expect(error).toBeInstanceOf(DiscordModeRequestError);
				expect(error).toMatchObject({ outcome: "unknown" });
				expect(String(error)).not.toContain("secret-invalid-json");
			}
		}
		expect(server.effects).toBe(2);
		await expect(
			readDiscordModeJsonBody(
				new Response("{}", { headers: { "content-length": String(DISCORD_MODE_MAX_FRAME + 1) } }),
			),
		).rejects.toThrow();
	});

	it("does not replay uncertain mutations or disclose arbitrary error envelopes", async () => {
		const root = await directory();
		const server = await endpoint(root);
		server.respond = () =>
			Response.json(
				{ protocol: DISCORD_MODE_PROTOCOL, ok: false, outcome: "unknown", error: "secret-account-and-token" },
				{ status: 500 },
			);
		const client = await connectExistingDiscordMode(root);
		cleanups.push(() => client.close());
		try {
			await client.request(request);
			throw new Error("expected rejection");
		} catch (error) {
			expect(error).toMatchObject({ outcome: "unknown" });
			expect(String(error)).not.toContain("secret-account-and-token");
		}
		expect(server.effects).toBe(1);
		await client.close();
		await expect(client.request(request)).rejects.toMatchObject({ outcome: "not-started" });
		expect(server.effects).toBe(1);
	});

	it("preserves safe recovery reasons but redacts known credentials and rejects terminal-control text", async () => {
		const root = await directory();
		const server = await endpoint(root);
		const client = await connectExistingDiscordMode(root);
		cleanups.push(() => client.close());
		server.respond = () =>
			Response.json(
				{
					protocol: DISCORD_MODE_PROTOCOL,
					ok: false,
					outcome: "unknown",
					error: `Session lease expired; reconnect explicitly. ${server.token} account-a lease-secret`,
				},
				{ status: 409 },
			);
		try {
			await client.request(request);
			throw new Error("expected rejection");
		} catch (error) {
			expect(error).toMatchObject({ outcome: "unknown" });
			expect(String(error)).toContain("lease expired");
			expect(String(error)).not.toContain(server.token);
			expect(String(error)).not.toContain("account-a");
			expect(String(error)).not.toContain("lease-secret");
		}
		server.respond = () =>
			Response.json(
				{
					protocol: DISCORD_MODE_PROTOCOL,
					ok: false,
					outcome: "unknown",
					error: `${String.fromCharCode(27)}[2Jsecret-control`,
				},
				{ status: 409 },
			);
		try {
			await client.request(request);
			throw new Error("expected rejection");
		} catch (error) {
			expect(error).toMatchObject({ outcome: "unknown" });
			expect(String(error)).not.toContain("secret-control");
		}
	});

	it("rejects a response for another session after a mutation instead of accepting its lease", async () => {
		const root = await directory();
		const server = await endpoint(root);
		server.respond = () =>
			Response.json({
				protocol: DISCORD_MODE_PROTOCOL,
				ok: true,
				result: { ...snapshot, session: { ...snapshot.session, id: "another-session" } },
			});
		const client = await connectExistingDiscordMode(root);
		cleanups.push(() => client.close());
		await expect(client.request(request)).rejects.toMatchObject({ outcome: "unknown" });
		expect(server.effects).toBe(1);
	});

	it("keeps a ping-only supervisor lease alive until close, then fails closed without reconnecting", async () => {
		const root = await directory();
		const server = await endpoint(root);
		const lease = await supervisor(root);
		const client = await connectExistingDiscordMode(root);
		cleanups.push(() => client.close());
		expect(lease.connections.size).toBe(1);
		expect(lease.shutdown).toBe(false);
		expect((await client.request(request)).session.id).toBe("session-1");
		expect(lease.operations).toEqual([{ op: "ping" }]);
		await client.close();
		await lease.released;
		expect(lease.shutdown).toBe(true);
		await expect(client.request(request)).rejects.toMatchObject({ outcome: "not-started" });
		expect(server.effects).toBe(1);
	});

	it("fails closed when its held supervisor connection disappears", async () => {
		const root = await directory();
		const server = await endpoint(root);
		const lease = await supervisor(root);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<Response>();
		server.respond = () => {
			entered.resolve();
			return release.promise;
		};
		const client = await connectExistingDiscordMode(root);
		cleanups.push(() => client.close());
		const pending = client.request(request);
		await entered.promise;
		for (const socket of lease.connections) socket.destroy();
		await lease.released;
		await expect(pending).rejects.toMatchObject({ outcome: "unknown" });
		release.resolve(new Response("{}"));
		await expect(client.request(request)).rejects.toMatchObject({ outcome: "not-started" });
		expect(lease.operations).toEqual([{ op: "ping" }]);
		expect(server.effects).toBe(1);
	});

	it("releases supervisor leases when IPC authentication fails during attachment", async () => {
		const root = await directory();
		const server = await endpoint(root);
		const lease = await supervisor(root);
		server.configKey = "account-b";
		await expect(connectExistingDiscordMode(root)).rejects.toThrow();
		await lease.released;
		expect(lease.shutdown).toBe(true);
	});

	for (const mode of ["wrong-scope", "oversized", "malformed"] as const) {
		it(`rejects ${mode} supervisor handshakes and releases the socket`, async () => {
			const root = await directory();
			const server = await endpoint(root);
			const lease = await supervisor(root, mode);
			await expect(connectExistingDiscordMode(root)).rejects.toThrow("lease failed");
			await lease.released;
			expect(lease.shutdown).toBe(true);
			expect(server.effects).toBe(0);
		});
	}

	it("refuses supervisor token aliases and paths outside the declared private scope", async () => {
		const root = await directory();
		await endpoint(root);
		const lease = await supervisor(root);
		const secret = path.join(lease.descriptor.projectDir, "original-token");
		await fs.rename(lease.descriptor.tokenPath, secret);
		await fs.symlink(secret, lease.descriptor.tokenPath);
		await expect(connectExistingDiscordMode(root)).rejects.toThrow();
		await writePrivateJson(path.join(root, "connector.json"), {
			version: 1,
			configKey: "account-a",
			supervisor: { ...lease.descriptor, tokenPath: "/outside/broker.token" },
		});
		await expect(connectExistingDiscordMode(root)).rejects.toThrow("unsafe");
		expect(lease.operations).toEqual([]);
	});

	it("distinguishes pre-admission cancellation from uncertain in-flight cancellation and releases on close", async () => {
		const root = await directory();
		const server = await endpoint(root);
		const lease = await supervisor(root);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<Response>();
		server.respond = () => {
			entered.resolve();
			return release.promise;
		};
		const client = await connectExistingDiscordMode(root);
		cleanups.push(() => client.close());
		await expect(client.request(request, AbortSignal.abort())).rejects.toMatchObject({ outcome: "not-started" });
		expect(server.effects).toBe(0);
		const abort = new AbortController();
		const pending = client.request(request, abort.signal);
		await entered.promise;
		abort.abort();
		await expect(pending).rejects.toMatchObject({ outcome: "unknown" });
		release.resolve(new Response("{}"));
		await client.close();
		await lease.released;
		expect(lease.shutdown).toBe(true);
		expect(server.effects).toBe(1);
	});

	it("reads raw supervisor secrets with the same bounded private-file protections", async () => {
		const root = await directory();
		const file = path.join(root, "token");
		await fs.writeFile(file, "sensitive", { mode: 0o600 });
		expect(await readPrivateText(file, 9)).toBe("sensitive");
		await expect(readPrivateText(file, 8)).rejects.toThrow();
		await fs.chmod(file, 0o644);
		await expect(readPrivateText(file)).rejects.toThrow();
	});
});
