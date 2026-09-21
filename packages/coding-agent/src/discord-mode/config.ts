import { createHash } from "node:crypto";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { readPrivateJson, writePrivateJson } from "./private-files";
import type { DiscordModeConfig } from "./protocol";

export const DISCORD_MODE_ROOT_ENV = "OMP_DISCORD_MODE_ROOT";
export const DISCORD_MODE_CONFIG_ENV = "OMP_DISCORD_MODE_CONFIG_PATH";
export const DISCORD_MODE_SOCKET_ENV = "OMP_DISCORD_MODE_SOCKET_PATH";

export function discordModePaths(): {
	root: string;
	configPath: string;
	socketPath: string;
	tokenPath: string;
	statePath: string;
} {
	const root = process.env[DISCORD_MODE_ROOT_ENV] ?? path.join(getAgentDir(), "discord-mode");
	return {
		root,
		configPath: process.env[DISCORD_MODE_CONFIG_ENV] ?? path.join(root, "config.json"),
		socketPath: process.env[DISCORD_MODE_SOCKET_ENV] ?? path.join(root, "ipc.sock"),
		tokenPath: path.join(root, "ipc-token.json"),
		statePath: path.join(root, "state.json"),
	};
}

export function parseDiscordModeConfig(value: unknown): DiscordModeConfig {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Invalid Discord mode configuration; run /discord setup.");
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).some(key => key !== "botToken" && key !== "guildId" && key !== "ownerId") ||
		typeof record.botToken !== "string" ||
		!/^[\x21-\x7e]{20,512}$/.test(record.botToken) ||
		typeof record.guildId !== "string" ||
		!/^\d{17,20}$/.test(record.guildId) ||
		typeof record.ownerId !== "string" ||
		!/^\d{17,20}$/.test(record.ownerId)
	) {
		throw new Error(
			"Invalid Discord mode configuration; supply a bot token and numeric guild/owner IDs through /discord setup.",
		);
	}
	return { botToken: record.botToken, guildId: record.guildId, ownerId: record.ownerId };
}

export async function loadDiscordModeConfig(): Promise<DiscordModeConfig> {
	const value = await readPrivateJson(discordModePaths().configPath, 8192);
	if (value === undefined)
		throw new Error(
			"Discord mode is not configured. Run /discord setup in the local TUI; credentials stay in private config.json, never tool arguments or settings.",
		);
	return parseDiscordModeConfig(value);
}

export async function saveDiscordModeConfig(config: DiscordModeConfig): Promise<void> {
	await writePrivateJson(discordModePaths().configPath, parseDiscordModeConfig(config));
}

/** Opaque private control-plane identity; do not print it or include credentials in launch specifications. */
export function discordModeConfigKey(config: DiscordModeConfig): string {
	return createHash("sha256")
		.update(JSON.stringify([config.botToken, config.guildId, config.ownerId]))
		.digest("hex");
}
