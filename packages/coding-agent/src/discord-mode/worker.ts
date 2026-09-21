import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ptree } from "@oh-my-pi/pi-utils";
import { SMOKE_TEST_TIMEOUT_MS, workerEnvFromParent } from "../subprocess/worker-client";
import { DiscordModeBroker } from "./broker";
import { connectDiscordModeAt, readDiscordModeToken, resolveDiscordModeWorkerCommand } from "./client";
import {
	DISCORD_MODE_ROOT_ENV,
	DISCORD_MODE_SOCKET_ENV,
	discordModeConfigKey,
	discordModePaths,
	loadDiscordModeConfig,
} from "./config";
import { DiscordAdapter } from "./discord";
import { createPrivateJson, ensurePrivateDirectory } from "./private-files";
import { DISCORD_MODE_PROTOCOL, DISCORD_MODE_READY } from "./protocol";
import { DISCORD_MODE_AUTH_HEADER, startDiscordModeServer } from "./server";

const SMOKE_ARG = "--discord-mode-smoke";

/** Only contention during first publication is retried; unsafe or incomplete tokens are never replaced. */
export async function ensureDiscordModeToken(tokenPath: string): Promise<string> {
	const candidate = randomBytes(32).toString("base64url");
	if (await createPrivateJson(tokenPath, { token: candidate })) return candidate;
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			const existing = await readDiscordModeToken(tokenPath);
			if (existing) return existing;
		} catch {
			// Another creator may still be removing its transient staging hard link.
		}
		await Bun.sleep(25);
	}
	throw new Error("Discord mode authentication file is unsafe or incompletely published; it was not replaced.");
}

/** Hidden CLI entry; the explicit distribution smoke branch never opens a Discord connection. */
export async function startDiscordModeWorker(): Promise<void> {
	const paths = discordModePaths();
	const smoke = process.argv.includes(SMOKE_ARG);
	let server: { close(): Promise<void>; ready(): void } | undefined;
	let broker: DiscordModeBroker | undefined;
	const stopped = Promise.withResolvers<void>();
	const stop = () => stopped.resolve();
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	try {
		await ensurePrivateDirectory(paths.root);
		const token = await ensureDiscordModeToken(paths.tokenPath);
		if (smoke) {
			server = await startDiscordModeServer({
				socketPath: paths.socketPath,
				token,
				configKey: "distribution-smoke",
				ready: false,
				broker: {
					async request() {
						throw new Error("Distribution smoke does not accept session mutations.");
					},
					async lookup() {
						return undefined;
					},
				},
			});
		} else {
			const config = await loadDiscordModeConfig();
			broker = new DiscordModeBroker({ config, storePath: paths.statePath, port: new DiscordAdapter(config) });
			// Claim IPC before logging into Discord, so a startup loser cannot create another gateway connection.
			server = await startDiscordModeServer({
				broker,
				socketPath: paths.socketPath,
				token,
				configKey: discordModeConfigKey(config),
				ready: false,
			});
			await broker.start();
		}
		server.ready();
		const probe = await connectDiscordModeAt(paths.socketPath, token);
		await probe.close();
		process.stdout.write(`${DISCORD_MODE_READY}\n`);
		await stopped.promise;
	} catch {
		throw new Error(
			"Discord mode worker could not start or continue safely. Inspect private configuration and the service state; no session was terminated.",
		);
	} finally {
		process.removeListener("SIGTERM", stop);
		process.removeListener("SIGINT", stop);
		try {
			await server?.close();
		} finally {
			await broker?.close();
		}
	}
}

/** Launches the actual worker selector and verifies private authenticated IPC without credentials or Discord. */
export async function smokeTestDiscordModeWorker(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-discord-smoke-"));
	await fs.chmod(root, 0o700);
	const socketPath = path.join(root, "ipc.sock");
	const spawn = resolveDiscordModeWorkerCommand();
	const proc = ptree.spawn([...spawn.cmd, SMOKE_ARG], {
		cwd: spawn.cwd,
		env: workerEnvFromParent({ [DISCORD_MODE_ROOT_ENV]: root, [DISCORD_MODE_SOCKET_ENV]: socketPath }),
	});
	try {
		const deadline = Date.now() + SMOKE_TEST_TIMEOUT_MS;
		let authenticated = false;
		while (Date.now() < deadline && proc.exitCode === null) {
			try {
				const token = await readDiscordModeToken(path.join(root, "ipc-token.json"));
				if (token) {
					const client = await connectDiscordModeAt(socketPath, token);
					try {
						await client.probe("distribution-smoke");
						if ((await client.lookup(root, crypto.randomUUID())) !== undefined)
							throw new Error("Smoke enrollment lookup was not empty.");
					} finally {
						await client.close();
					}
					authenticated = true;
					break;
				}
			} catch {
				/* Only this read-only readiness probe is retried. */
			}
			await Bun.sleep(50);
		}
		if (!authenticated) throw new Error("Discord mode worker smoke failed to authenticate its ready IPC endpoint.");
		const unauthorized = await fetch("http://discord-mode.local/info", {
			unix: socketPath,
			headers: { [DISCORD_MODE_AUTH_HEADER]: "incorrect" },
			signal: AbortSignal.timeout(1500),
		});
		const denied: unknown = await unauthorized.json();
		if (
			unauthorized.status !== 401 ||
			typeof denied !== "object" ||
			denied === null ||
			!("protocol" in denied) ||
			denied.protocol !== DISCORD_MODE_PROTOCOL
		) {
			throw new Error("Discord mode worker smoke failed its authentication/protocol boundary.");
		}
	} finally {
		proc.kill();
		await proc.exited.catch(() => {});
		await fs.rm(root, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	await startDiscordModeWorker();
}
