import { afterEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writePrivateJson } from "@oh-my-pi/pi-utils/discord-private-files";
import {
	DISCORD_MODE_CONFIG_ENV,
	DISCORD_MODE_ROOT_ENV,
	DISCORD_MODE_SOCKET_ENV,
	discordModeConfigKey,
} from "../../src/discord-mode/config";
import {
	type DiscordDoctorCheck,
	type DiscordDoctorFetch,
	discordDoctorExitCode,
	formatDiscordDoctor,
	runDiscordDoctor,
} from "../../src/discord-mode/doctor";
import { startDiscordModeServer } from "../../src/discord-mode/server";

const config = {
	botToken: "doctor-fixture-secret-bot-token-value",
	guildId: "100000000000000001",
	ownerId: "200000000000000002",
};
const BOT = "300000000000000003";
const APP = "400000000000000004";
const REQUIRED = (1n << 4n) | (1n << 11n) | (1n << 14n) | (1n << 15n) | (1n << 16n);
const BRIDGE_MARKER = "// Haiso OMP bridge loader, maintained by `haiso update`. Delete this file to stop loading it.";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setEnv(key: string, value: string): void {
	const previous = process.env[key];
	process.env[key] = value;
	cleanups.push(() => {
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	});
}

/** Everything healthy: private config, live service, connector, journal, installed release and bridge loader. */
async function fixture(options: { configured?: boolean; service?: boolean } = {}) {
	const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "doctor-")));
	cleanups.push(() => fs.rm(base, { recursive: true, force: true }));
	const root = path.join(base, "dm");
	await fs.mkdir(root, { mode: 0o700 });
	setEnv(DISCORD_MODE_ROOT_ENV, root);
	setEnv(DISCORD_MODE_CONFIG_ENV, path.join(root, "config.json"));
	setEnv(DISCORD_MODE_SOCKET_ENV, path.join(root, "ipc.sock"));
	const configKey = discordModeConfigKey(config);
	if (options.configured !== false) {
		await writePrivateJson(path.join(root, "config.json"), config);
		await writePrivateJson(path.join(root, "connector.json"), { version: 1, configKey });
	}
	await writePrivateJson(path.join(root, "state.json"), {
		version: 1,
		groups: [{ id: "g" }],
		sessions: [{ id: "a" }, { id: "b" }],
		fromTheFuture: { anything: true },
	});
	if (options.service !== false) {
		const token = randomBytes(32).toString("base64url");
		await writePrivateJson(path.join(root, "ipc-token.json"), { token });
		const server = await startDiscordModeServer({
			socketPath: path.join(root, "ipc.sock"),
			token,
			configKey,
			service: { version: "1.2.3" },
			broker: {
				async request() {
					throw new Error("doctor must not send broker requests");
				},
			},
		});
		cleanups.push(() => server.close());
	}
	const release = path.join(base, "releases", "r1");
	await fs.mkdir(path.join(release, "bin"), { recursive: true });
	await fs.mkdir(path.join(release, "omp-bridge"));
	await fs.writeFile(path.join(release, "bin", "haiso"), "#!/bin/sh\n", { mode: 0o755 });
	await fs.writeFile(path.join(release, "omp-bridge", "index.js"), "export default {};\n");
	await fs.writeFile(
		path.join(release, "receipt.json"),
		JSON.stringify({
			owner: "haiso-release-installer",
			release,
			executable: path.join(release, "bin", "haiso"),
			source: { commit: "a".repeat(40) },
		}),
	);
	const prefix = path.join(base, "fork");
	await fs.symlink(release, prefix);
	const agentDir = path.join(base, "agent");
	await fs.mkdir(path.join(agentDir, "extensions"), { recursive: true });
	await fs.writeFile(
		path.join(agentDir, "extensions", "haiso-bridge.ts"),
		`${BRIDGE_MARKER}\nexport { default } from "file://${prefix}/omp-bridge/index.js";\n`,
	);
	return { root, prefix, agentDir };
}

interface FakeDiscord {
	status?: Partial<Record<string, number>>;
	permissions?: bigint;
	commands?: string[];
	hang?: boolean;
}

/** Offline Discord REST: routes by path; records every Authorization header it sees. */
function fakeDiscord(options: FakeDiscord = {}): { fetch: DiscordDoctorFetch; auth: string[] } {
	const auth: string[] = [];
	const bodies: Record<string, unknown> = {
		"/users/@me": { id: BOT, username: "haiso-bot" },
		[`/guilds/${config.guildId}`]: {
			id: config.guildId,
			name: "Workshop",
			owner_id: config.ownerId,
			roles: [
				{ id: config.guildId, permissions: "0" },
				{ id: "500000000000000005", permissions: String(options.permissions ?? REQUIRED) },
			],
		},
		[`/guilds/${config.guildId}/members/${BOT}`]: { roles: ["500000000000000005"] },
		"/oauth2/applications/@me": { id: APP },
		[`/applications/${APP}/guilds/${config.guildId}/commands`]: (options.commands ?? ["session"]).map(name => ({
			name,
		})),
	};
	const fetch: DiscordDoctorFetch = async (url, init) => {
		auth.push(init.headers.Authorization ?? "");
		if (options.hang) {
			const { promise, reject } = Promise.withResolvers<Response>();
			init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
			return promise;
		}
		const route = url.replace("https://discord.com/api/v10", "");
		const status = options.status?.[route];
		if (status) return new Response(JSON.stringify({ message: "nope", token: config.botToken }), { status });
		if (!(route in bodies)) return new Response("{}", { status: 404 });
		return Response.json(bodies[route]);
	};
	return { fetch, auth };
}

function byId(checks: DiscordDoctorCheck[]): Record<string, DiscordDoctorCheck> {
	return Object.fromEntries(checks.map(check => [check.id, check]));
}

describe("Discord doctor", () => {
	it("passes every check on a healthy installation and exits 0", async () => {
		const { prefix, agentDir } = await fixture();
		const discord = fakeDiscord();
		const checks = await runDiscordDoctor({ fetch: discord.fetch, prefix, agentDir });
		expect(checks.filter(check => check.status !== "pass")).toEqual([]);
		expect(checks.map(check => check.id)).toEqual([
			"storage",
			"config",
			"token",
			"guild",
			"permissions",
			"commands",
			"service",
			"connector",
			"state",
			"release",
			"bridge",
		]);
		// Unknown journal keys are tolerated; only groups and sessions are counted.
		expect(byId(checks).state!.detail).toContain("1 projects, 2 sessions");
		expect(byId(checks).service!.detail).toContain("1.2.3");
		expect(discord.auth.every(header => header === `Bot ${config.botToken}`)).toBe(true);
		expect(discordDoctorExitCode(checks)).toBe(0);
	});

	it("fails an unconfigured installation without contacting Discord", async () => {
		const { prefix, agentDir } = await fixture({ configured: false, service: false });
		const discord = fakeDiscord();
		const checks = byId(await runDiscordDoctor({ fetch: discord.fetch, prefix, agentDir }));
		expect(checks.config!.status).toBe("fail");
		expect(checks.config!.fix).toContain("/discord setup");
		expect(checks.token!.status).toBe("warn");
		expect(discord.auth).toEqual([]);
		expect(discordDoctorExitCode(Object.values(checks))).toBe(1);
	});

	it("fails group/world-readable private files with a chmod fix", async () => {
		const { root, prefix, agentDir } = await fixture({ service: false });
		await fs.chmod(path.join(root, "config.json"), 0o644);
		const checks = byId(await runDiscordDoctor({ fetch: fakeDiscord().fetch, prefix, agentDir }));
		expect(checks.storage!.status).toBe("fail");
		expect(checks.storage!.detail).toContain("config.json is 644");
		expect(checks.storage!.fix).toBe(`Run: chmod 600 '${path.join(root, "config.json")}'`);
		expect(checks.config!.status).toBe("fail");
	});

	it("fails a hard-linked private file", async () => {
		const { root, prefix, agentDir } = await fixture({ service: false });
		await fs.link(path.join(root, "state.json"), path.join(root, "state-copy.json"));
		const checks = byId(await runDiscordDoctor({ fetch: fakeDiscord().fetch, prefix, agentDir }));
		expect(checks.storage!.status).toBe("fail");
		expect(checks.storage!.detail).toContain("state.json has 2 hard links");
	});

	it("reports a rejected token as FAIL and never prints the token", async () => {
		const { prefix, agentDir } = await fixture();
		const checks = await runDiscordDoctor({
			fetch: fakeDiscord({ status: { "/users/@me": 401 } }).fetch,
			prefix,
			agentDir,
		});
		expect(byId(checks).token!.status).toBe("fail");
		expect(byId(checks).token!.detail).toContain("token invalid");
		const output = `${formatDiscordDoctor(checks)}\n${JSON.stringify(checks)}`;
		expect(output).not.toContain(config.botToken);
		expect(output).not.toContain(discordModeConfigKey(config));
		expect(discordDoctorExitCode(checks)).toBe(1);
	});

	it("names each missing guild permission, and treats Administrator as all of them", async () => {
		const { prefix, agentDir } = await fixture({ service: false });
		const withoutAttach = byId(
			await runDiscordDoctor({
				fetch: fakeDiscord({ permissions: REQUIRED & ~(1n << 15n) }).fetch,
				prefix,
				agentDir,
			}),
		);
		expect(withoutAttach.permissions!.status).toBe("fail");
		expect(withoutAttach.permissions!.detail).toBe("Missing: Attach Files.");
		const admin = byId(
			await runDiscordDoctor({ fetch: fakeDiscord({ permissions: 1n << 3n }).fetch, prefix, agentDir }),
		);
		expect(admin.permissions!.status).toBe("pass");
	});

	it("warns, not fails, when Discord times out, and skips dependent REST checks", async () => {
		const { prefix, agentDir } = await fixture();
		const discord = fakeDiscord({ hang: true });
		const started = Date.now();
		const checks = await runDiscordDoctor({ fetch: discord.fetch, timeoutMs: 50, prefix, agentDir });
		expect(Date.now() - started).toBeLessThan(2000);
		expect(byId(checks).token!.status).toBe("warn");
		expect(byId(checks).token!.detail).toContain("timed out");
		expect(discord.auth).toHaveLength(1);
		expect(discordDoctorExitCode(checks)).toBe(0);
	});

	it("warns when the service is down, since it starts on demand", async () => {
		const { prefix, agentDir } = await fixture({ service: false });
		const checks = await runDiscordDoctor({ fetch: fakeDiscord().fetch, prefix, agentDir });
		expect(byId(checks).service!.status).toBe("warn");
		expect(byId(checks).service!.detail).toContain("Not running");
		expect(checks.filter(check => check.status !== "pass").map(check => check.id)).toEqual(["service"]);
		expect(discordDoctorExitCode(checks)).toBe(0);
	});

	it("warns when /session is not registered and when the connector belongs to another configuration", async () => {
		const { root, prefix, agentDir } = await fixture({ service: false });
		await writePrivateJson(path.join(root, "connector.json"), { version: 1, configKey: "stale" });
		const checks = byId(
			await runDiscordDoctor({ fetch: fakeDiscord({ commands: ["omp"] }).fetch, prefix, agentDir }),
		);
		expect(checks.commands!.status).toBe("warn");
		expect(checks.connector!.status).toBe("warn");
	});

	it("fails a journal that is not a JSON object", async () => {
		const { root, prefix, agentDir } = await fixture({ service: false });
		await writePrivateJson(path.join(root, "state.json"), [1, 2]);
		const checks = byId(await runDiscordDoctor({ fetch: fakeDiscord().fetch, prefix, agentDir }));
		expect(checks.state!.status).toBe("fail");
	});

	it("fails a release without a valid receipt and warns when the bridge loader is foreign", async () => {
		const { prefix, agentDir } = await fixture({ service: false });
		const release = await fs.realpath(prefix);
		await fs.writeFile(path.join(release, "receipt.json"), JSON.stringify({ owner: "someone-else" }));
		await fs.writeFile(path.join(agentDir, "extensions", "haiso-bridge.ts"), "export default {};\n");
		const checks = byId(await runDiscordDoctor({ fetch: fakeDiscord().fetch, prefix, agentDir }));
		expect(checks.release!.status).toBe("fail");
		expect(checks.bridge!.status).toBe("warn");
	});
});
