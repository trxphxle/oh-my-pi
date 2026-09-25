import { createHash } from "node:crypto";
import * as path from "node:path";
import { getGlobalDaemonRuntimeDir } from "@oh-my-pi/pi-utils";
import { discordModeSocketIsStale } from "@oh-my-pi/pi-utils/discord-client";
import { readPrivateJson, writePrivateJson } from "@oh-my-pi/pi-utils/discord-private-files";
import { type DiscordModeConnector, DISCORD_MODE_DAEMON_NAME } from "@oh-my-pi/pi-wire/discord-mode";
import { daemonClientForGlobal } from "../launch/client";
import { canonicalProjectDir, daemonBrokerEndpoint } from "../launch/paths";
import { discordModePaths } from "./config";

export interface DiscordServiceSettings {
	/** Keep the account service running after the last Haiso/OMP process releases it. */
	keepOnline: boolean;
}

/** Machine-global supervisor scope for one Discord mode root. */
export async function discordModeSupervisorService(root: string): Promise<string> {
	const scope = createHash("sha256")
		.update(await canonicalProjectDir(root))
		.digest("hex")
		.slice(0, 16);
	return `haiso-discord-${scope}`;
}

/** The ping lease a connector publishes so bridges hold a session-scoped service alive. */
export function discordModeSupervisorLease(
	supervisorProjectDir: string,
	runtimeDir: string,
): NonNullable<DiscordModeConnector["supervisor"]> {
	return {
		endpoint: daemonBrokerEndpoint(supervisorProjectDir, runtimeDir),
		tokenPath: path.join(runtimeDir, "broker.token"),
		projectDir: supervisorProjectDir,
	};
}

/** Missing, unreadable, or malformed settings mean the default: keep online. */
export async function readDiscordServiceSettings(): Promise<DiscordServiceSettings> {
	let value: unknown;
	try {
		value = await readPrivateJson(path.join(discordModePaths().root, "service.json"), 4096);
	} catch {
		return { keepOnline: true };
	}
	if (typeof value !== "object" || value === null || !("keepOnline" in value) || typeof value.keepOnline !== "boolean")
		return { keepOnline: true };
	return { keepOnline: value.keepOnline };
}

/**
 * Persist the setting, then apply it to a running supervised service when one exists: its record's persistence and
 * the connector's bridge lease (published only while the service is session-scoped).
 * Returns whether the running service changed now; otherwise the setting applies at next service start.
 */
export async function setDiscordServiceKeepOnline(keepOnline: boolean): Promise<{ live: boolean }> {
	const paths = discordModePaths();
	await writePrivateJson(path.join(paths.root, "service.json"), { version: 1, keepOnline });
	try {
		const service = await discordModeSupervisorService(paths.root);
		const runtimeDir = await canonicalProjectDir(getGlobalDaemonRuntimeDir(service));
		// A shared broker client spawns a supervisor when none is listening; only a live one is worth toggling.
		if (await discordModeSocketIsStale(daemonBrokerEndpoint(runtimeDir, runtimeDir))) return { live: false };
		const supervisor = await daemonClientForGlobal(service);
		const listed = await supervisor.request({ op: "list" });
		if (listed.op !== "list") return { live: false };
		const existing = listed.daemons.find(daemon => daemon.name === DISCORD_MODE_DAEMON_NAME);
		if (!existing || existing.state === "exited" || existing.state === "failed") return { live: false };
		await supervisor.request({
			op: "mode",
			name: DISCORD_MODE_DAEMON_NAME,
			mode: keepOnline ? "persist" : "session",
		});
		const connectorPath = path.join(paths.root, "connector.json");
		const connector = await readPrivateJson(connectorPath, 8192);
		if (
			typeof connector === "object" &&
			connector !== null &&
			"configKey" in connector &&
			typeof connector.configKey === "string"
		)
			await writePrivateJson(connectorPath, {
				version: 1,
				configKey: connector.configKey,
				...(keepOnline ? {} : { supervisor: discordModeSupervisorLease(supervisor.projectDir, runtimeDir) }),
			} satisfies DiscordModeConnector);
		return { live: true };
	} catch {
		return { live: false };
	}
}
