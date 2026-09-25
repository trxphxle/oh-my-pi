/**
 * Background copies of Discord conversations: the normal interactive CLI in a PTY under the Discord service's own
 * process supervisor. Fixed arguments only; names and first messages travel over the authenticated IPC, and the copy
 * learns nothing from its environment but a random single-use launch id.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getGlobalDaemonRuntimeDir, isCompiledBinary } from "@oh-my-pi/pi-utils";
import type { DaemonSpec } from "@oh-my-pi/pi-tui/tools/daemon";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../launch/client";
import { resolveCliEntryCmd } from "../subprocess/worker-client";
import type { DiscordHostPort, DiscordHostSpec } from "./broker";
import { DISCORD_MODE_CONFIG_ENV, DISCORD_MODE_ROOT_ENV, DISCORD_MODE_SOCKET_ENV, discordModePaths } from "./config";
import { DISCORD_HOST_LAUNCH_ENV, discordConversationHolder } from "./hosts";
import { discordModeSupervisorService } from "./service";

const HOST_NAME = /^haiso-[sn]-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9._:@+/-]{1,160}$/;
/** Only these inherited variables reach a copy: what selects the same profile, agent folder, and release. */
const INHERITED_ENV = ["OMP_PROFILE", "PI_PROFILE", "PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "HAISO_PREFIX"] as const;
/** A copy tears down like a closed terminal; this bounds its flush before the supervisor kills it. */
const STOP_TIMEOUT_MS = 10_000;

/** The interactive CLI: compiled Haiso runs the active release through its prefix link, like the service itself. */
function hostCommand(): string[] {
	const prefix = process.env.HAISO_PREFIX;
	if (isCompiledBinary() && prefix) {
		const binary = path.join(prefix, "bin", "haiso");
		try {
			fs.accessSync(binary, fs.constants.X_OK);
			return [binary];
		} catch {}
	}
	return resolveCliEntryCmd();
}

/** The supervisor record for one copy; refuses anything that isn't a journal path, a launch id, or a strict selector. */
export function discordHostDaemonSpec(
	spec: DiscordHostSpec,
	options: { command?: string[]; env?: Record<string, string | undefined> } = {},
): DaemonSpec {
	if (
		!HOST_NAME.test(spec.name) ||
		!UUID.test(spec.launchId) ||
		!path.isAbsolute(spec.projectDir) ||
		(spec.sessionFile !== undefined && !path.isAbsolute(spec.sessionFile)) ||
		(spec.model !== undefined && (spec.sessionFile !== undefined || !MODEL.test(spec.model)))
	)
		throw new Error("Invalid background copy specification.");
	const command = options.command ?? hostCommand();
	const source = options.env ?? process.env;
	const env: Record<string, string> = {};
	for (const key of INHERITED_ENV) {
		const value = source[key];
		if (value) env[key] = value;
	}
	const paths = discordModePaths();
	return {
		name: spec.name,
		application: command[0]!,
		args: [
			...command.slice(1),
			...(spec.sessionFile === undefined ? [] : ["--resume", spec.sessionFile]),
			...(spec.model === undefined ? [] : ["--model", spec.model]),
		],
		env: {
			...env,
			[DISCORD_MODE_ROOT_ENV]: paths.root,
			[DISCORD_MODE_CONFIG_ENV]: paths.configPath,
			[DISCORD_MODE_SOCKET_ENV]: paths.socketPath,
			[DISCORD_HOST_LAUNCH_ENV]: spec.launchId,
		},
		cwd: spec.projectDir,
		pty: true,
		restart: "no",
		persist: true,
		detached: false,
	};
}

/**
 * A short-lived connection per operation: holding one would keep a session-scoped supervisor (keep-online off) alive
 * after its last copy and terminal are gone.
 */
async function connectSupervisor(): Promise<DaemonBrokerClient> {
	const runtimeDir = getGlobalDaemonRuntimeDir(await discordModeSupervisorService(discordModePaths().root));
	await fs.promises.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	const canonical = await fs.promises.realpath(runtimeDir);
	return createDaemonBrokerClient(canonical, { runtimeDir: canonical });
}

/** The Discord service's host port over its process supervisor. */
export class DiscordHostLauncher implements DiscordHostPort {
	readonly #connect: () => Promise<DaemonBrokerClient>;

	constructor(options: { connect?: () => Promise<DaemonBrokerClient> } = {}) {
		this.#connect = options.connect ?? connectSupervisor;
	}

	async #supervisor<T>(run: (client: DaemonBrokerClient) => Promise<T>): Promise<T> {
		const client = await this.#connect();
		try {
			return await run(client);
		} finally {
			client.close();
		}
	}

	async start(spec: DiscordHostSpec): Promise<void> {
		const daemon = discordHostDaemonSpec(spec);
		await this.#supervisor(client => client.request({ op: "start", spec: daemon }));
	}

	async stop(name: string): Promise<void> {
		if (!HOST_NAME.test(name)) throw new Error("Invalid background copy name.");
		await this.#supervisor(client => client.request({ op: "stop", name, timeoutMs: STOP_TIMEOUT_MS }));
	}

	async running(): Promise<string[]> {
		return this.#supervisor(async client => {
			const listed = await client.request({ op: "list" });
			if (listed.op !== "list") throw new Error("The process supervisor returned an invalid response.");
			return listed.daemons
				.filter(daemon => HOST_NAME.test(daemon.name) && daemon.state !== "exited" && daemon.state !== "failed")
				.map(daemon => daemon.name);
		});
	}

	holder(sessionId: string): Promise<"terminal" | "background" | undefined> {
		return discordConversationHolder(sessionId);
	}
}
