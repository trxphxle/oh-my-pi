import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, isEnoent, VERSION } from "@oh-my-pi/pi-utils";
import {
	connectDiscordModeAt,
	discordModeSocketIsStale,
	inspectDiscordModeSocket,
	readDiscordModeToken,
} from "@oh-my-pi/pi-utils/discord-client";
import { readPrivateJson, readPrivateText } from "@oh-my-pi/pi-utils/discord-private-files";
import type { DiscordModeConfig, ModeServiceInfo } from "@oh-my-pi/pi-wire/discord-mode";
import { discordModeConfigKey, discordModePaths, parseDiscordModeConfig } from "./config";
import { readDiscordServiceSettings } from "./service";
import { discordServiceTarget, discordServiceUpdateReady, readDiscordServiceRelease } from "./switchover";

export type DiscordDoctorStatus = "pass" | "warn" | "fail";

export interface DiscordDoctorCheck {
	id: string;
	label: string;
	status: DiscordDoctorStatus;
	detail: string;
	/** One-line remedy; present on every non-pass item. */
	fix?: string;
}

/** The only network seam: a `fetch`-compatible function. Tests pass a fake; nothing else reaches Discord. */
export type DiscordDoctorFetch = (
	url: string,
	init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

export interface DiscordDoctorOptions {
	fetch?: DiscordDoctorFetch;
	/** Per-request bound for Discord REST calls. */
	timeoutMs?: number;
	/** Haiso install prefix; defaults to `$HAISO_PREFIX`, then `~/.local/share/haiso/fork`. */
	prefix?: string;
	/** OMP agent directory holding `extensions/haiso-bridge.ts`; defaults to `getAgentDir()`. */
	agentDir?: string;
}

const API = "https://discord.com/api/v10";
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_STATE_BYTES = 24 * 1024 * 1024;
/** First line of the loader `haiso update` maintains; mirrors `BRIDGE_LOADER_MARKER` in scripts/haiso/release.ts. */
const BRIDGE_LOADER_MARKER =
	"// Haiso OMP bridge loader, maintained by `haiso update`. Delete this file to stop loading it.";
const ADMINISTRATOR = 1n << 3n;
const REQUIRED_PERMISSIONS: ReadonlyArray<readonly [string, bigint]> = [
	["Manage Channels", 1n << 4n],
	["Send Messages", 1n << 11n],
	["Read Message History", 1n << 16n],
	["Attach Files", 1n << 15n],
	["Embed Links", 1n << 14n],
];
const SETUP_FIX = "Run /discord setup in Haiso.";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Remote strings are displayed on one line, bounded and free of control characters. */
function plain(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const cleaned = value.replace(/[\x00-\x1f\x7f]/g, " ").trim();
	return cleaned ? cleaned.slice(0, 80) : fallback;
}

function pass(id: string, label: string, detail: string): DiscordDoctorCheck {
	return { id, label, status: "pass", detail };
}
function warn(id: string, label: string, detail: string, fix: string): DiscordDoctorCheck {
	return { id, label, status: "warn", detail, fix };
}
function fail(id: string, label: string, detail: string, fix: string): DiscordDoctorCheck {
	return { id, label, status: "fail", detail, fix };
}
function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function lstat(file: string): Promise<nodeFs.Stats | undefined> {
	try {
		return await fs.lstat(file);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

type RestResult =
	| { kind: "ok"; body: unknown }
	| { kind: "status"; status: number }
	| { kind: "unreachable"; reason: string };

/** One bounded authenticated GET. Errors carry only a status or a fixed reason, never request details. */
async function rest(fetcher: DiscordDoctorFetch, token: string, route: string, timeoutMs: number): Promise<RestResult> {
	const signal = AbortSignal.timeout(timeoutMs);
	const deadline = Promise.withResolvers<never>();
	const onAbort = () => deadline.reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([
			(async (): Promise<RestResult> => {
				const response = await fetcher(`${API}${route}`, {
					headers: {
						Authorization: `Bot ${token}`,
						"User-Agent": `DiscordBot (https://github.com/can1357/oh-my-pi, ${VERSION})`,
					},
					signal,
				});
				if (!response.ok) {
					await response.body?.cancel().catch(() => {});
					return { kind: "status", status: response.status };
				}
				return { kind: "ok", body: await response.json() };
			})(),
			deadline.promise,
		]);
	} catch (error) {
		if (signal.aborted) return { kind: "unreachable", reason: `timed out after ${timeoutMs / 1000}s` };
		return { kind: "unreachable", reason: error instanceof SyntaxError ? "invalid response" : "network error" };
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function unreachable(id: string, label: string, result: RestResult): DiscordDoctorCheck {
	const detail =
		result.kind === "unreachable"
			? `Discord unreachable (${result.reason}).`
			: `Discord answered HTTP ${result.kind === "status" ? result.status : 200}.`;
	return warn(id, label, detail, "Check the network connection, then run /discord doctor again.");
}

async function checkStorage(root: string, files: string[]): Promise<DiscordDoctorCheck> {
	const label = "Private storage";
	const uid = process.getuid?.();
	const directory = await lstat(root);
	if (!directory) return fail("storage", label, `${root} does not exist.`, SETUP_FIX);
	if (!directory.isDirectory() || directory.uid !== uid)
		return fail(
			"storage",
			label,
			`${root} is not a directory you own (symlinks are refused).`,
			`Move it aside and run /discord setup.`,
		);
	const problems: string[] = [];
	const chmodFiles: string[] = [];
	let linked = false;
	if ((directory.mode & 0o077) !== 0)
		problems.push(`${path.basename(root)}/ is ${(directory.mode & 0o777).toString(8)}`);
	for (const file of files) {
		const info = await lstat(file);
		if (!info) continue;
		const name = path.basename(file);
		if (!info.isFile() || info.uid !== uid) {
			problems.push(`${name} is not a regular file you own`);
			linked = true;
		} else if (info.nlink !== 1) {
			problems.push(`${name} has ${info.nlink} hard links`);
			linked = true;
		} else if ((info.mode & 0o777) !== 0o600) {
			problems.push(`${name} is ${(info.mode & 0o777).toString(8)}`);
			chmodFiles.push(file);
		}
	}
	if (!problems.length) return pass("storage", label, `${root} is owner-only (0700, files 0600).`);
	const commands = [
		...((directory.mode & 0o077) !== 0 ? [`chmod 700 '${root}'`] : []),
		...(chmodFiles.length ? [`chmod 600 ${chmodFiles.map(file => `'${file}'`).join(" ")}`] : []),
	];
	const fix = linked
		? "Replace linked or foreign files with regular copies you own (0600), then run /discord doctor again."
		: `Run: ${commands.join(" && ")}`;
	return fail("storage", label, `${problems.join("; ")}.`, fix);
}

async function checkConfig(configPath: string): Promise<{ check: DiscordDoctorCheck; config?: DiscordModeConfig }> {
	const label = "Configuration";
	let value: unknown;
	try {
		value = await readPrivateJson(configPath, 8192);
	} catch (error) {
		return {
			check: fail(
				"config",
				label,
				`config.json cannot be read safely: ${message(error)}`,
				"Fix Private storage first.",
			),
		};
	}
	if (value === undefined) return { check: fail("config", label, "Discord mode is not configured.", SETUP_FIX) };
	try {
		const config = parseDiscordModeConfig(value);
		return {
			check: pass("config", label, `Server ${config.guildId}, owner ${config.ownerId}.`),
			config,
		};
	} catch {
		return { check: fail("config", label, "config.json is invalid.", SETUP_FIX) };
	}
}

async function checkDiscord(
	config: DiscordModeConfig | undefined,
	fetcher: DiscordDoctorFetch,
	timeoutMs: number,
): Promise<DiscordDoctorCheck[]> {
	const labels = { token: "Bot token", guild: "Server", permissions: "Bot permissions", commands: "/session command" };
	const skipped = (ids: Array<keyof typeof labels>, reason: string, fix: string) =>
		ids.map(id => warn(id, labels[id], `Skipped: ${reason}.`, fix));
	if (!config)
		return skipped(
			["token", "guild", "permissions", "commands"],
			"no valid configuration",
			"Fix the configuration first.",
		);
	const { botToken: token, guildId } = config;
	const me = await rest(fetcher, token, "/users/@me", timeoutMs);
	if (me.kind === "status" && me.status === 401)
		return [
			fail(
				"token",
				labels.token,
				"Discord rejected the bot token (token invalid).",
				"Reset the token in the Discord Developer Portal (Bot tab), then run /discord setup.",
			),
			...skipped(["guild", "permissions", "commands"], "the bot token is invalid", "Fix the bot token first."),
		];
	if (me.kind !== "ok" || !record(me.body) || typeof me.body.id !== "string")
		return [
			unreachable("token", labels.token, me),
			...skipped(["guild", "permissions", "commands"], "Discord is unreachable", "Run /discord doctor again later."),
		];
	const botId = me.body.id;
	const checks = [pass("token", labels.token, `Signed in as ${plain(me.body.username, "the bot")} (${botId}).`)];

	const guild = await rest(fetcher, token, `/guilds/${guildId}`, timeoutMs);
	if (guild.kind === "status" && (guild.status === 403 || guild.status === 404)) {
		checks.push(
			fail(
				"guild",
				labels.guild,
				`The bot cannot see server ${guildId}.`,
				"Invite the bot to the server, or run /discord setup with the right server ID.",
			),
			...skipped(["permissions", "commands"], "the server is unreachable", "Fix the server check first."),
		);
		return checks;
	}
	if (guild.kind !== "ok" || !record(guild.body)) {
		checks.push(
			unreachable("guild", labels.guild, guild),
			...skipped(["permissions", "commands"], "the server is unreachable", "Run /discord doctor again later."),
		);
		return checks;
	}
	checks.push(pass("guild", labels.guild, `Reachable: ${plain(guild.body.name, guildId)}.`));
	checks.push(await checkPermissions(guild.body, guildId, botId, fetcher, token, timeoutMs, labels.permissions));
	checks.push(await checkCommands(guildId, botId, fetcher, token, timeoutMs, labels.commands));
	return checks;
}

async function checkPermissions(
	guild: Record<string, unknown>,
	guildId: string,
	botId: string,
	fetcher: DiscordDoctorFetch,
	token: string,
	timeoutMs: number,
	label: string,
): Promise<DiscordDoctorCheck> {
	let granted = 0n;
	if (guild.owner_id === botId) granted = ADMINISTRATOR;
	else {
		const member = await rest(fetcher, token, `/guilds/${guildId}/members/${botId}`, timeoutMs);
		if (member.kind !== "ok" || !record(member.body) || !Array.isArray(member.body.roles))
			return unreachable("permissions", label, member);
		const held = new Set<unknown>([guildId, ...member.body.roles]);
		for (const role of Array.isArray(guild.roles) ? guild.roles : []) {
			if (!record(role) || !held.has(role.id) || typeof role.permissions !== "string") continue;
			try {
				granted |= BigInt(role.permissions);
			} catch {}
		}
	}
	if ((granted & ADMINISTRATOR) !== 0n) return pass("permissions", label, "Administrator (all permissions).");
	const missing = REQUIRED_PERMISSIONS.filter(([, bit]) => (granted & bit) === 0n).map(([name]) => name);
	if (!missing.length) return pass("permissions", label, REQUIRED_PERMISSIONS.map(([name]) => name).join(", ") + ".");
	return fail(
		"permissions",
		label,
		`Missing: ${missing.join(", ")}.`,
		"Grant them to the bot's role in Server Settings → Roles.",
	);
}

async function checkCommands(
	guildId: string,
	botId: string,
	fetcher: DiscordDoctorFetch,
	token: string,
	timeoutMs: number,
	label: string,
): Promise<DiscordDoctorCheck> {
	const application = await rest(fetcher, token, "/oauth2/applications/@me", timeoutMs);
	const appId =
		application.kind === "ok" && record(application.body) && typeof application.body.id === "string"
			? application.body.id
			: botId;
	const commands = await rest(fetcher, token, `/applications/${appId}/guilds/${guildId}/commands`, timeoutMs);
	if (commands.kind !== "ok" || !Array.isArray(commands.body)) return unreachable("commands", label, commands);
	if (commands.body.some(command => record(command) && command.name === "session"))
		return pass("commands", label, "Registered in the server.");
	return warn(
		"commands",
		label,
		"/session is not registered in the server.",
		"Turn Discord on (/discord on); the service registers /session when it starts.",
	);
}

async function checkService(
	socketPath: string,
	tokenPath: string,
	config: DiscordModeConfig | undefined,
	prefix: string,
): Promise<DiscordDoctorCheck> {
	const label = "Discord service";
	const { keepOnline, keepAwake } = await readDiscordServiceSettings();
	const settings = `keep online ${keepOnline ? "on" : "off"}, keep awake ${keepAwake ? "on" : "off"}`;
	try {
		await inspectDiscordModeSocket(socketPath);
	} catch (error) {
		return fail("service", label, message(error), `Stop the Discord service and remove '${socketPath}'.`);
	}
	let stale: boolean;
	try {
		stale = await discordModeSocketIsStale(socketPath);
	} catch {
		return warn("service", label, `Not answering; ${settings}.`, "Run /discord doctor again in a moment.");
	}
	if (stale)
		return warn(
			"service",
			label,
			`Not running (it starts on demand); ${settings}.`,
			"Turn Discord on with /discord on; the service starts then.",
		);
	let service: ModeServiceInfo | undefined;
	let configKey: string;
	try {
		const token = await readDiscordModeToken(tokenPath);
		if (!token) throw new Error("Discord IPC credentials are missing.");
		const client = await connectDiscordModeAt(socketPath, token);
		try {
			const info = await client.probe();
			service = info.service;
			configKey = info.configKey;
		} finally {
			await client.close();
		}
	} catch (error) {
		return warn("service", label, `Running but not reachable: ${message(error)}`, "Restart the Discord service.");
	}
	if (config && configKey !== discordModeConfigKey(config))
		return warn(
			"service",
			label,
			"Running with a different configuration than config.json.",
			"Restart the Discord service so it loads the current configuration.",
		);
	const build = service
		? `version ${service.version}${service.commit ? ` (${service.commit})` : ""}${
				discordServiceUpdateReady(service, prefix) ? ", switches to the installed update when quiet" : ""
			}`
		: "version unknown (older service)";
	return pass("service", label, `Running, ${build}; ${settings}.`);
}

async function checkConnector(root: string, config: DiscordModeConfig | undefined): Promise<DiscordDoctorCheck> {
	const label = "Connector";
	const restart = "Restart the Discord service; it republishes connector.json.";
	let value: unknown;
	try {
		value = await readPrivateJson(path.join(root, "connector.json"), 8192);
	} catch (error) {
		return fail(
			"connector",
			label,
			`connector.json cannot be read safely: ${message(error)}`,
			"Fix Private storage first.",
		);
	}
	if (value === undefined)
		return warn(
			"connector",
			label,
			"connector.json is not published yet; OMP sessions cannot attach.",
			"Turn Discord on with /discord on; the service publishes it.",
		);
	if (!record(value) || value.version !== 1 || typeof value.configKey !== "string")
		return fail("connector", label, "connector.json is malformed.", restart);
	if (config && value.configKey !== discordModeConfigKey(config))
		return warn("connector", label, "connector.json belongs to a different configuration.", restart);
	return pass("connector", label, "connector.json matches the configuration.");
}

async function checkState(statePath: string): Promise<DiscordDoctorCheck> {
	const label = "Journal";
	let text: string | undefined;
	try {
		text = await readPrivateText(statePath, MAX_STATE_BYTES);
	} catch (error) {
		return fail(
			"state",
			label,
			`state.json cannot be read: ${message(error)}`,
			"Fix Private storage, or move state.json aside.",
		);
	}
	if (text === undefined) return pass("state", label, "No journal yet.");
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return fail(
			"state",
			label,
			"state.json is not valid JSON.",
			"Restore state.json from a backup, or move it aside.",
		);
	}
	if (!record(value))
		return fail(
			"state",
			label,
			"state.json is not a JSON object.",
			"Restore state.json from a backup, or move it aside.",
		);
	const count = (key: string) => (Array.isArray(value[key]) ? (value[key] as unknown[]).length : 0);
	return pass("state", label, `${count("groups")} projects, ${count("sessions")} sessions.`);
}

function checkRelease(prefix: string): DiscordDoctorCheck {
	const label = "Installed release";
	const target = discordServiceTarget(prefix);
	if (!target)
		return warn("release", label, `No runnable Haiso release at ${prefix}.`, "Install one with haiso update.");
	const release = readDiscordServiceRelease(path.join(prefix, "bin", "haiso"));
	if (release.release !== target)
		return fail("release", label, `${target} has no valid installer receipt.`, "Reinstall with haiso update.");
	const commit = release.info.commit ? `, commit ${release.info.commit}` : "";
	return pass("release", label, `${path.basename(target)}${commit}.`);
}

async function checkBridge(agentDir: string, prefix: string): Promise<DiscordDoctorCheck> {
	const label = "OMP bridge";
	const loader = path.join(agentDir, "extensions", "haiso-bridge.ts");
	let content: string;
	try {
		content = await Bun.file(loader).text();
	} catch (error) {
		if (!isEnoent(error))
			return warn("bridge", label, `${loader} is unreadable.`, "Delete it, then run haiso update.");
		// `haiso update` records a loader the user deleted and never recreates it (release.ts ensureHaisoBridgeLoader).
		const stateFile = path.join(path.dirname(prefix), `${path.basename(prefix)}-update`, "bridge-loader.json");
		let declined = false;
		try {
			const state: unknown = await Bun.file(stateFile).json();
			declined = record(state) && state.loader === loader && state.installed === true;
		} catch {}
		return declined
			? warn(
					"bridge",
					label,
					"Turned off (the loader was deleted); OMP sessions cannot share to Discord.",
					`Delete '${stateFile}', then run haiso update.`,
				)
			: warn(
					"bridge",
					label,
					"Loader not installed; OMP sessions cannot share to Discord.",
					"Run haiso update to install it.",
				);
	}
	if (!content.startsWith(`${BRIDGE_LOADER_MARKER}\n`))
		return warn("bridge", label, `${loader} is not managed by Haiso.`, "Delete it, then run haiso update.");
	if (!(await lstat(path.join(prefix, "omp-bridge", "index.js")))?.isFile())
		return warn(
			"bridge",
			label,
			"The installed release ships no bridge bundle.",
			"Run haiso update to install a release with the bridge.",
		);
	return pass("bridge", label, "Loader installed; OMP loads the bridge from the release.");
}

/** Read-only diagnostics; never starts a service, writes a file, or prints credentials. */
export async function runDiscordDoctor(options: DiscordDoctorOptions = {}): Promise<DiscordDoctorCheck[]> {
	const paths = discordModePaths();
	const prefix = options.prefix ?? process.env.HAISO_PREFIX ?? path.join(os.homedir(), ".local/share/haiso/fork");
	const connectorPath = path.join(paths.root, "connector.json");
	const storage = await checkStorage(paths.root, [
		paths.configPath,
		paths.tokenPath,
		connectorPath,
		paths.statePath,
		path.join(paths.root, "service.json"),
	]);
	const { check: configCheck, config } = await checkConfig(paths.configPath);
	const discord = await checkDiscord(config, options.fetch ?? fetch, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	return [
		storage,
		configCheck,
		...discord,
		await checkService(paths.socketPath, paths.tokenPath, config, prefix),
		await checkConnector(paths.root, config),
		await checkState(paths.statePath),
		checkRelease(prefix),
		await checkBridge(options.agentDir ?? getAgentDir(), prefix),
	];
}

const MARKS: Record<DiscordDoctorStatus, string> = { pass: "PASS", warn: "WARN", fail: "FAIL" };

export function formatDiscordDoctor(checks: readonly DiscordDoctorCheck[]): string {
	const lines = ["Discord doctor"];
	for (const check of checks) {
		lines.push(`[${MARKS[check.status]}] ${check.label}: ${check.detail}`);
		if (check.fix) lines.push(`       Fix: ${check.fix}`);
	}
	const total = (status: DiscordDoctorStatus) => checks.filter(check => check.status === status).length;
	lines.push(`${total("fail")} failed, ${total("warn")} warnings, ${total("pass")} passed.`);
	return lines.join("\n");
}

/** 0 when nothing failed (warnings allowed), 1 otherwise. */
export function discordDoctorExitCode(checks: readonly DiscordDoctorCheck[]): 0 | 1 {
	return checks.some(check => check.status === "fail") ? 1 : 0;
}

/** Hidden `__omp_worker_discord_doctor` entry (`haiso discord doctor`): print the checklist, exit 1 on any FAIL. */
export async function runDiscordDoctorCommand(): Promise<never> {
	const checks = await runDiscordDoctor();
	process.stdout.write(`${formatDiscordDoctor(checks)}\n`);
	process.exit(discordDoctorExitCode(checks));
}
