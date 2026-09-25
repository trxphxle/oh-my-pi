import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { postmortem, ptree } from "@oh-my-pi/pi-utils";
import { SMOKE_TEST_TIMEOUT_MS, workerEnvFromParent } from "../subprocess/worker-client";
import { DiscordModeBroker } from "./broker";
import {
	connectDiscordModeAt,
	readDiscordModeToken,
	DISCORD_MODE_AUTH_HEADER,
} from "@oh-my-pi/pi-utils/discord-client";
import { connectDiscordMode, resolveDiscordModeWorkerCommand } from "./client";
import {
	DISCORD_MODE_ROOT_ENV,
	DISCORD_MODE_SOCKET_ENV,
	discordModeConfigKey,
	discordModePaths,
	loadDiscordModeConfig,
} from "./config";
import { DiscordAdapter, sessionCommandGuide } from "./discord";
import { renderDiscordGuide } from "./guide";
import { DiscordHostLauncher } from "./launcher";
import { DISCORD_SERVICE_SETTINGS_MS, DiscordKeepAwake, readDiscordServiceSettings } from "./service";
import {
	DISCORD_REPLACES_ENV,
	DiscordServiceSwitchover,
	discordServiceTarget,
	readDiscordServiceRelease,
	spawnDiscordServiceReplacement,
} from "./switchover";
import { createPrivateJson, ensurePrivateDirectory } from "@oh-my-pi/pi-utils/discord-private-files";
import { DISCORD_MODE_PROTOCOL, DISCORD_MODE_READY } from "@oh-my-pi/pi-wire/discord-mode";
import { startDiscordModeServer } from "./server";

const SMOKE_ARG = "--discord-mode-smoke";
/** A replacement waits at most this long for the service it replaces to exit. */
const REPLACE_WAIT_MS = 60_000;

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
	let switchover: DiscordServiceSwitchover | undefined;
	let settingsTimer: NodeJS.Timeout | undefined;
	const keepAwake = new DiscordKeepAwake();
	/** Set once the service stopped for an update: hand over to the prefix's release after closing. */
	let handover: string | undefined;
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
			const release = readDiscordServiceRelease();
			// The setting is re-read periodically, so `/discord service awake on|off` applies without a restart.
			const applySettings = async () => keepAwake.setEnabled((await readDiscordServiceSettings()).keepAwake);
			await applySettings();
			settingsTimer = setInterval(() => void applySettings(), DISCORD_SERVICE_SETTINGS_MS);
			settingsTimer.unref();
			broker = new DiscordModeBroker({
				config,
				storePath: paths.statePath,
				port: new DiscordAdapter(config),
				service: release.info,
				guide: renderDiscordGuide(sessionCommandGuide()),
				hosts: new DiscordHostLauncher(),
				onSharing: sharing => keepAwake.setSharing(sharing),
			});
			// Claim IPC before logging into Discord, so a startup loser cannot create another gateway connection.
			server = await startDiscordModeServer({
				broker,
				socketPath: paths.socketPath,
				token,
				configKey: discordModeConfigKey(config),
				ready: false,
				service: release.info,
			});
			await broker.start();
			const prefix = process.env.HAISO_PREFIX;
			if (release.release && prefix) {
				switchover = new DiscordServiceSwitchover({
					running: release.release,
					target: () => discordServiceTarget(prefix),
					keepOnline: async () => (await readDiscordServiceSettings()).keepOnline,
					broker,
					switched: () => {
						handover = prefix;
						stop();
					},
				});
				switchover.start();
			}
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
		switchover?.stop();
		clearInterval(settingsTimer);
		keepAwake.close();
		try {
			await server?.close();
		} finally {
			await broker?.close();
		}
	}
	if (handover) {
		spawnDiscordServiceReplacement(handover);
		process.exit(0);
	}
}

/**
 * Hidden entry (the only argument) for the OMP bridge and service updates: start or adopt the account service through
 * the normal path, print DISCORD_MODE_READY, and exit. A replacement first waits for the service it replaces to exit.
 */
export async function ensureDiscordModeService(): Promise<void> {
	const replaces = Number(process.env[DISCORD_REPLACES_ENV]);
	delete process.env[DISCORD_REPLACES_ENV];
	if (Number.isSafeInteger(replaces) && replaces > 1 && replaces !== process.pid) {
		const deadline = Date.now() + REPLACE_WAIT_MS;
		while (Date.now() < deadline) {
			try {
				process.kill(replaces, 0);
			} catch {
				break;
			}
			await Bun.sleep(200);
		}
	}
	try {
		const client = await connectDiscordMode();
		await client.close();
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	}
	await Bun.write(Bun.stdout, `${DISCORD_MODE_READY}\n`);
	// The shared supervisor client would keep this one-shot process alive.
	process.exit(0);
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

// The fallback entry must not impose top-level await on the compiled CLI's require graph.
if (import.meta.main) {
	void startDiscordModeWorker().catch(postmortem.fatal);
}
