import { createHash } from "node:crypto";
import * as path from "node:path";
import { PowerAssertion } from "@oh-my-pi/pi-natives";
import { getGlobalDaemonRuntimeDir, isBunTestRuntime } from "@oh-my-pi/pi-utils";
import { discordModeSocketIsStale } from "@oh-my-pi/pi-utils/discord-client";
import { readPrivateJson, writePrivateJson } from "@oh-my-pi/pi-utils/discord-private-files";
import { type DiscordModeConnector, DISCORD_MODE_DAEMON_NAME } from "@oh-my-pi/pi-wire/discord-mode";
import { daemonClientForGlobal } from "../launch/client";
import { canonicalProjectDir, daemonBrokerEndpoint } from "../launch/paths";
import { discordModePaths } from "./config";

export interface DiscordServiceSettings {
	/** Keep the account service running after the last Haiso/OMP process releases it. */
	keepOnline: boolean;
	/** Keep the Mac from idle-sleeping while a conversation is shared and open (or a background copy runs). */
	keepAwake: boolean;
}

const DEFAULT_SETTINGS: DiscordServiceSettings = { keepOnline: true, keepAwake: false };

function settingsPath(): string {
	return path.join(discordModePaths().root, "service.json");
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

/** Missing, unreadable, or malformed settings mean the defaults: keep online, let the Mac sleep. */
export async function readDiscordServiceSettings(): Promise<DiscordServiceSettings> {
	let value: unknown;
	try {
		value = await readPrivateJson(settingsPath(), 4096);
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
	if (typeof value !== "object" || value === null) return { ...DEFAULT_SETTINGS };
	return {
		keepOnline:
			"keepOnline" in value && typeof value.keepOnline === "boolean"
				? value.keepOnline
				: DEFAULT_SETTINGS.keepOnline,
		keepAwake:
			"keepAwake" in value && typeof value.keepAwake === "boolean" ? value.keepAwake : DEFAULT_SETTINGS.keepAwake,
	};
}

async function writeDiscordServiceSettings(change: Partial<DiscordServiceSettings>): Promise<void> {
	await writePrivateJson(settingsPath(), { version: 1, ...(await readDiscordServiceSettings()), ...change });
}

/** Persist keep-awake; the running service re-reads its settings within DISCORD_SERVICE_SETTINGS_MS. */
export async function setDiscordServiceKeepAwake(keepAwake: boolean): Promise<void> {
	await writeDiscordServiceSettings({ keepAwake });
}

/** How often the running service re-reads its settings file. */
export const DISCORD_SERVICE_SETTINGS_MS = 15_000;

/** A held platform power assertion; `stop` is idempotent. */
export interface DiscordPowerHold {
	stop(): void;
}

/** Idle-sleep prevention (`caffeinate -i`); unsupported platforms get the native no-op handle. Never in tests. */
function holdIdleSleep(): DiscordPowerHold | undefined {
	if (isBunTestRuntime()) return undefined;
	return PowerAssertion.start({ reason: "Haiso Discord: shared conversation open", idle: true });
}

/**
 * Holds the power assertion exactly while keep-awake is on and something is shared: a connected conversation or a
 * background copy. Off by default; releasing never throws.
 */
export class DiscordKeepAwake {
	#enabled = false;
	#sharing = false;
	#hold: DiscordPowerHold | undefined;
	#held = false;
	readonly #start: () => DiscordPowerHold | undefined;

	constructor(start: () => DiscordPowerHold | undefined = holdIdleSleep) {
		this.#start = start;
	}

	/** Whether the assertion is held right now. */
	get holding(): boolean {
		return this.#held;
	}

	setEnabled(enabled: boolean): void {
		this.#enabled = enabled;
		this.#apply();
	}

	setSharing(sharing: boolean): void {
		this.#sharing = sharing;
		this.#apply();
	}

	close(): void {
		this.#enabled = false;
		this.#apply();
	}

	#apply(): void {
		const want = this.#enabled && this.#sharing;
		if (want === this.#held) return;
		this.#held = want;
		if (want) {
			try {
				this.#hold = this.#start();
			} catch {
				this.#hold = undefined;
			}
			return;
		}
		const hold = this.#hold;
		this.#hold = undefined;
		try {
			hold?.stop();
		} catch {
			/* Releasing is best-effort; the OS drops the assertion when the process exits. */
		}
	}
}

/**
 * Persist the setting, then apply it to a running supervised service when one exists: its record's persistence and
 * the connector's bridge lease (published only while the service is session-scoped).
 * Returns whether the running service changed now; otherwise the setting applies at next service start.
 */
export async function setDiscordServiceKeepOnline(keepOnline: boolean): Promise<{ live: boolean }> {
	const paths = discordModePaths();
	await writeDiscordServiceSettings({ keepOnline });
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
