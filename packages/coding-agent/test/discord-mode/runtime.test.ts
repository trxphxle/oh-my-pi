import { afterEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { connectDiscordModeAt, DiscordModeRequestError } from "../../src/discord-mode/client";
import { parseDiscordModeConfig } from "../../src/discord-mode/config";
import { ensurePrivateDirectory, readPrivateJson, writePrivateJson } from "../../src/discord-mode/private-files";
import { DISCORD_MODE_MAX_FRAME, DISCORD_MODE_PROTOCOL, type ModeRequest } from "../../src/discord-mode/protocol";
import { DISCORD_MODE_AUTH_HEADER, startDiscordModeServer } from "../../src/discord-mode/server";
import { ensureDiscordModeToken, smokeTestDiscordModeWorker } from "../../src/discord-mode/worker";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function directory(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-discord-test-"));
	await fs.chmod(root, 0o700);
	cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
	return root;
}

const report: ModeRequest = {
	op: "report",
	requestId: "request-1",
	text: "report once",
	lease: { sessionId: "session-1", connectionId: "connection-1", token: "lease-token" },
};

describe("Discord private storage", () => {
	it("publishes one immutable IPC credential across concurrent startup contenders", async () => {
		const root = await directory();
		const file = path.join(root, "ipc-token.json");
		const tokens = await Promise.all(Array.from({ length: 16 }, () => ensureDiscordModeToken(file)));
		expect(new Set(tokens).size).toBe(1);
		expect(await readPrivateJson(file)).toEqual({ token: tokens[0] });
		expect((await fs.stat(file)).nlink).toBe(1);
		expect(await ensureDiscordModeToken(file)).toBe(tokens[0]);
	});

	it("keeps atomic replacement private and rejects unsafe destinations without altering them", async () => {
		const root = await directory();
		const file = path.join(root, "config.json");
		await writePrivateJson(file, { revision: 1 });
		await writePrivateJson(file, { revision: 2 });
		expect(await readPrivateJson(file)).toEqual({ revision: 2 });
		expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
		await fs.chmod(file, 0o644);
		await expect(readPrivateJson(file)).rejects.toThrow();
		await expect(writePrivateJson(file, { revision: 3 })).rejects.toThrow();
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ revision: 2 });
	});

	it("refuses symlink, hard-link, and directory aliases for secrets", async () => {
		const root = await directory();
		const file = path.join(root, "secret.json");
		await writePrivateJson(file, { secret: "private" });
		const symlink = path.join(root, "symlink.json");
		await fs.symlink(file, symlink);
		await expect(readPrivateJson(symlink)).rejects.toThrow();
		await expect(writePrivateJson(symlink, {})).rejects.toThrow();
		const hardlink = path.join(root, "hardlink.json");
		await fs.link(file, hardlink);
		await expect(readPrivateJson(hardlink)).rejects.toThrow();
		await expect(writePrivateJson(file, {})).rejects.toThrow();
		const alias = path.join(root, "alias");
		await fs.symlink(root, alias);
		await expect(ensurePrivateDirectory(alias)).rejects.toThrow();
		await expect(readPrivateJson(path.join(alias, "secret.json"))).rejects.toThrow();
	});

	it("distinguishes missing from malformed or oversized private JSON without exposing its contents", async () => {
		const root = await directory();
		const file = path.join(root, "config.json");
		expect(await readPrivateJson(file)).toBeUndefined();
		await writePrivateJson(file, { value: "too much for a tiny ceiling" });
		await expect(readPrivateJson(file, 8)).rejects.toThrow();
		await fs.writeFile(file, "PRIVATE_TOKEN_MUST_NOT_APPEAR", { mode: 0o600 });
		let message = "";
		try {
			await readPrivateJson(file);
		} catch (error) {
			message = String(error);
		}
		expect(message).toContain("invalid JSON");
		expect(message).not.toContain("PRIVATE_TOKEN_MUST_NOT_APPEAR");
	});

	it("rejects invalid credentials without including them in diagnostics", () => {
		const invalid = {
			botToken: "token-secret\nprivate",
			guildId: "123456789012345678",
			ownerId: "123456789012345679",
		};
		let message = "";
		try {
			parseDiscordModeConfig(invalid);
		} catch (error) {
			message = String(error);
		}
		expect(message).toContain("configuration");
		expect(message).not.toContain("token-secret");
	});
});

describe("Discord authenticated Unix transport", () => {
	it("rejects unauthorized, incompatible, malformed, and oversized requests before executing effects", async () => {
		const root = await directory();
		const socketPath = path.join(root, "ipc.sock");
		const token = randomBytes(32).toString("base64url");
		let calls = 0;
		const server = await startDiscordModeServer({
			socketPath,
			token,
			broker: {
				async request() {
					calls++;
					throw new Error("should not execute");
				},
			},
		});
		cleanups.push(() => server.close());
		const submit = (body: unknown, auth = token) =>
			fetch("http://discord-mode.local/request", {
				unix: socketPath,
				method: "POST",
				headers: { [DISCORD_MODE_AUTH_HEADER]: auth, "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(2000),
			});
		expect((await submit({ protocol: DISCORD_MODE_PROTOCOL, request: report }, "wrong")).status).toBe(401);
		expect((await submit({ protocol: DISCORD_MODE_PROTOCOL + 1, request: report })).status).toBe(400);
		expect((await submit({ protocol: DISCORD_MODE_PROTOCOL, request: { ...report, text: 99 } })).status).toBe(400);
		const oversized = await submit({
			protocol: DISCORD_MODE_PROTOCOL,
			request: { ...report, text: "x".repeat(DISCORD_MODE_MAX_FRAME) },
		});
		expect(oversized.ok).toBe(false);
		expect(calls).toBe(0);
		expect((await fs.stat(socketPath)).mode & 0o777).toBe(0o600);
		await expect(connectDiscordModeAt(socketPath, randomBytes(32).toString("base64url"))).rejects.toThrow();
	});

	it("preserves uncertain effects and never blindly resends a mutation", async () => {
		const root = await directory();
		const socketPath = path.join(root, "ipc.sock");
		const token = randomBytes(32).toString("base64url");
		let effects = 0;
		const server = await startDiscordModeServer({
			socketPath,
			token,
			broker: {
				async request() {
					effects++;
					throw new Error("secret-from-adapter");
				},
			},
		});
		cleanups.push(() => server.close());
		const client = await connectDiscordModeAt(socketPath, token);
		cleanups.push(() => client.close());
		let failure: unknown;
		try {
			await client.request(report);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(DiscordModeRequestError);
		if (!(failure instanceof DiscordModeRequestError)) throw new Error("Expected uncertain request failure.");
		expect(failure.outcome).toBe("unknown");
		expect(failure.message).not.toContain("secret-from-adapter");
		expect(effects).toBe(1);
		await client.close();
		await expect(client.request(report)).rejects.toMatchObject({ outcome: "not-started" });
		expect(effects).toBe(1);
	});

	it("refuses to replace a live or unsafe endpoint and leaves the incumbent usable", async () => {
		const root = await directory();
		const socketPath = path.join(root, "ipc.sock");
		const token = randomBytes(32).toString("base64url");
		const broker = {
			async request(): Promise<never> {
				throw new Error("not used");
			},
		};
		const server = await startDiscordModeServer({ socketPath, token, broker });
		cleanups.push(() => server.close());
		await expect(startDiscordModeServer({ socketPath, token, broker })).rejects.toThrow();
		const client = await connectDiscordModeAt(socketPath, token);
		await client.close();
		const alias = path.join(root, "alias.sock");
		await fs.symlink(socketPath, alias);
		await expect(startDiscordModeServer({ socketPath: alias, token, broker })).rejects.toThrow();
		expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
	});

	it("does not adopt an incompatible broker configuration", async () => {
		const root = await directory();
		const socketPath = path.join(root, "ipc.sock");
		const token = randomBytes(32).toString("base64url");
		const server = await startDiscordModeServer({
			socketPath,
			token,
			configKey: "account-a",
			broker: {
				async request(): Promise<never> {
					throw new Error("not used");
				},
			},
		});
		cleanups.push(() => server.close());
		const client = await connectDiscordModeAt(socketPath, token);
		cleanups.push(() => client.close());
		await expect(client.probe("account-b")).rejects.toThrow();
		await client.probe("account-a");
	});

	it("launches the source-fallback worker and authenticates protocol identity without Discord", async () => {
		await smokeTestDiscordModeWorker();
	}, 60_000);
});
