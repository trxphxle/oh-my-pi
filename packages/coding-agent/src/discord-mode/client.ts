import { createHash } from "node:crypto";
import * as path from "node:path";
import { getGlobalDaemonRuntimeDir } from "@oh-my-pi/pi-utils";
import {
	connectExistingDiscordMode,
	DiscordModeClient,
	readDiscordModeToken,
	discordModeSocketIsStale,
	inspectDiscordModeSocket,
} from "@oh-my-pi/pi-utils/discord-client";
import { DISCORD_MODE_WORKER_ARG } from "../cli/worker-selectors";
import { daemonClientForGlobal } from "../launch/client";
import { canonicalProjectDir, daemonBrokerEndpoint } from "../launch/paths";
import { resolveWorkerSpawnCmd, type WorkerSpawnCommand } from "../subprocess/worker-client";
import {
	DISCORD_MODE_CONFIG_ENV,
	DISCORD_MODE_ROOT_ENV,
	DISCORD_MODE_SOCKET_ENV,
	discordModeConfigKey,
	discordModePaths,
	loadDiscordModeConfig,
} from "./config";
import {
	createPrivateJson,
	ensurePrivateDirectory,
	readPrivateJson,
	writePrivateJson,
} from "@oh-my-pi/pi-utils/discord-private-files";
import {
	DISCORD_MODE_DAEMON_NAME,
	DISCORD_MODE_READY,
	type DiscordModeConnector,
} from "@oh-my-pi/pi-wire/discord-mode";

const READY_TIMEOUT_MS = 60_000;

export function resolveDiscordModeWorkerCommand(): WorkerSpawnCommand {
	return resolveWorkerSpawnCmd(DISCORD_MODE_WORKER_ARG);
}

/** One profile-scoped account service, leased by the parent process rather than by individual sessions. */
export async function connectDiscordMode(): Promise<DiscordModeClient> {
	const config = await loadDiscordModeConfig();
	const paths = discordModePaths();
	await ensurePrivateDirectory(paths.root);
	const configKey = discordModeConfigKey(config);
	const descriptorPath = path.join(paths.root, "connector.json");
	const adoptConnector = async (): Promise<DiscordModeClient | undefined> => {
		if ((await readPrivateJson(descriptorPath, 8192)) === undefined) return undefined;
		if (paths.socketPath !== path.join(paths.root, "ipc.sock"))
			throw new Error("Discord mode connector does not describe the configured socket; nothing was replaced.");
		const client = await connectExistingDiscordMode(paths.root);
		try {
			await client.probe(configKey);
			return client;
		} catch (error) {
			await client.close();
			throw error;
		}
	};
	if (
		(await inspectDiscordModeSocket(paths.socketPath)) === "present" &&
		!(await discordModeSocketIsStale(paths.socketPath))
	) {
		const live = await adoptConnector();
		if (live) return live;
	}
	const scope = createHash("sha256")
		.update(await canonicalProjectDir(paths.root))
		.digest("hex")
		.slice(0, 16);
	const service = `haiso-discord-${scope}`;
	const supervisor = await daemonClientForGlobal(service);
	await supervisor.request({ op: "ping" });
	const adopt = async (managed: boolean, started = false): Promise<DiscordModeClient | undefined> => {
		if ((await inspectDiscordModeSocket(paths.socketPath)) === "missing") return undefined;
		if (!started) {
			const live = await adoptConnector();
			if (live) return live;
		}
		const token = await readDiscordModeToken(paths.tokenPath);
		if (!token)
			throw new Error("Discord mode socket exists without its private authentication file; nothing was replaced.");
		const client = new DiscordModeClient(paths.socketPath, token);
		try {
			await client.probe(configKey);
			const runtimeDir = await canonicalProjectDir(getGlobalDaemonRuntimeDir(service));
			const descriptor: DiscordModeConnector = {
				version: 1,
				configKey,
				...(managed
					? {
							supervisor: {
								endpoint: daemonBrokerEndpoint(supervisor.projectDir, runtimeDir),
								tokenPath: path.join(runtimeDir, "broker.token"),
								projectDir: supervisor.projectDir,
							},
						}
					: {}),
			};
			if (started) {
				await writePrivateJson(descriptorPath, descriptor);
			} else if (!(await createPrivateJson(descriptorPath, descriptor))) {
				// A concurrent publisher owns the durable lease; never overwrite it.
				await client.close();
				const live = await adoptConnector();
				if (!live) throw new Error("Discord mode connector changed during attachment; nothing was replaced.");
				return live;
			}
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
			const live = await adopt(true);
			if (live) return live;
			throw new Error("Discord mode service is active but not verifiably ready; it was not stopped or replaced.");
		}
		// A live independently started endpoint is adopted only after protocol/config authentication.
		if (
			(await inspectDiscordModeSocket(paths.socketPath)) === "present" &&
			!(await discordModeSocketIsStale(paths.socketPath))
		) {
			const live = await adopt(false);
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
		const live = await adopt(true, true);
		if (live) return live;
	}
	throw new Error("Discord mode service did not become ready; no existing service was stopped or restarted.");
}
