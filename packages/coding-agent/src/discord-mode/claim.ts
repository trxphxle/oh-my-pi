/**
 * Opening a shared Discord conversation: a background copy waits for the conversation's lock; a terminal takes it, or
 * asks the background copy holding it to leave at its next idle point and waits. Unshared conversations and a second
 * terminal on the same conversation proceed exactly as before.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ModeDeletionBinding } from "@oh-my-pi/pi-wire/discord-mode";
import { canonicalProjectDir } from "../launch/paths";
import { SessionManager } from "../session/session-manager";
import { connectDiscordMode } from "./client";
import { discordModePaths } from "./config";
import {
	becomeDiscordBackgroundHost,
	DISCORD_HOST_LAUNCH_ENV,
	discordConversationHolder,
	holdDiscordConversation,
} from "./hosts";
import { readDiscordSharedSessions } from "./retirement-events";

/** A background copy waits this long for the terminal that asked to keep the conversation running to exit. */
const BACKGROUND_WAIT_MS = 120_000;
/** A terminal waits this long for a background copy to finish its turn and leave. */
export const DISCORD_TAKEOVER_WAIT_MS = 10 * 60_000;
const POLL_MS = 250;
/** The step-aside request repeats while waiting: a restarted service forgets it until the copy reconnects. */
const STEP_ASIDE_RETRY_MS = 10_000;

/** Offline: the saved broker state shares this exact conversation. Never connects. */
async function sharedBinding(file: string, root: string, sessionId?: string): Promise<ModeDeletionBinding | undefined> {
	const canonical = await canonicalProjectDir(path.dirname(file)).then(
		dir => path.join(dir, path.basename(file)),
		() => undefined,
	);
	if (!canonical) return undefined;
	return (await readDiscordSharedSessions(root)).find(
		binding => binding.sessionFile === canonical && (sessionId === undefined || binding.sessionId === sessionId),
	);
}

/** Ask the background copy to leave at its next idle point; the service checks the native identity. */
async function requestStepAside(binding: ModeDeletionBinding): Promise<void> {
	const client = await connectDiscordMode();
	try {
		await client.request({
			op: "step-aside",
			sessionId: binding.sessionId,
			sessionFile: binding.sessionFile,
			projectDir: binding.projectDir,
		});
	} finally {
		await client.close();
	}
}

export interface DiscordTakeoverOptions {
	root?: string;
	/** Shown once before waiting on a background copy. */
	notify?: (text: string) => void;
	/** Seam for tests; production asks the running Discord service. */
	stepAside?: (binding: ModeDeletionBinding) => Promise<void>;
	waitMs?: number;
	pollMs?: number;
}

/** Hold the conversation once the background copy leaves, repeating the request; throws a plain error on timeout. */
async function takeOver(binding: ModeDeletionBinding, root: string, options: DiscordTakeoverOptions): Promise<void> {
	options.notify?.(
		"Taking over from the background copy on Discord: it closes after its current turn. Ctrl+C cancels; nothing is written until then.",
	);
	const stepAside = options.stepAside ?? requestStepAside;
	const waitMs = options.waitMs ?? DISCORD_TAKEOVER_WAIT_MS;
	const deadline = Date.now() + waitMs;
	let asked = 0;
	while (Date.now() < deadline) {
		if (await holdDiscordConversation(binding.sessionId, "terminal", root)) return;
		if (Date.now() - asked >= STEP_ASIDE_RETRY_MS) {
			asked = Date.now();
			// An unreachable service is retried; its restart brings the copy back to hear the request.
			await stepAside(binding).catch(() => {});
		}
		await Bun.sleep(options.pollMs ?? POLL_MS);
	}
	throw new Error(
		`The background copy on Discord did not close within ${Math.max(1, Math.round(waitMs / 60_000))} minute(s): a turn or a question is still open. Answer or stop it on Discord, or use /session close there, then try again.`,
	);
}

export interface DiscordClaimOptions extends DiscordTakeoverOptions {
	interactive: boolean;
	/** Startup watchdog hooks around a wait on another process. */
	pause?: () => void;
	resume?: () => void;
	/** Environment carrying the launch id; the id is removed once read. */
	env?: Record<string, string | undefined>;
	/** The session file was loaded no earlier than this (epoch ms); a later change reopens it. Default: process start. */
	loadedAt?: number;
}

/**
 * Startup claim, after the session file is resolved and before the session is built. Returns the manager to use:
 * reopened whenever another writer may have changed the file since it was loaded.
 */
export async function claimDiscordConversation(
	manager: SessionManager,
	options: DiscordClaimOptions,
): Promise<SessionManager> {
	const env = options.env ?? process.env;
	const launchId = env[DISCORD_HOST_LAUNCH_ENV];
	delete env[DISCORD_HOST_LAUNCH_ENV];
	const root = options.root ?? discordModePaths().root;
	const file = manager.getSessionFile();
	const sessionId = manager.getSessionId();
	let loadedAt = options.loadedAt ?? Date.now() - process.uptime() * 1000;
	if (launchId && options.interactive) {
		becomeDiscordBackgroundHost(launchId);
		// The terminal that asked to keep this conversation running flushes it before it exits.
		const deadline = Date.now() + (options.waitMs ?? BACKGROUND_WAIT_MS);
		while (!(await holdDiscordConversation(sessionId, "background", root))) {
			if (Date.now() >= deadline)
				throw new Error("The conversation stayed open in another process; the background copy did not start.");
			loadedAt = 0;
			await Bun.sleep(options.pollMs ?? POLL_MS);
		}
	} else {
		if (!file) return manager;
		const binding = await sharedBinding(file, root, sessionId);
		if (!binding) return manager;
		if (!(await holdDiscordConversation(sessionId, "terminal", root))) {
			// Two terminals on one conversation keep today's behavior.
			if ((await discordConversationHolder(sessionId, root)) !== "background") return manager;
			if (!options.interactive)
				throw new Error(
					"This conversation is running in the background on Discord. Close it there with /session close, or open it interactively to take over.",
				);
			options.pause?.();
			try {
				await takeOver(binding, root, options);
			} finally {
				options.resume?.();
			}
			loadedAt = 0;
		}
	}
	const stat = file ? await fs.stat(file).catch(() => undefined) : undefined;
	return file && stat && stat.mtimeMs >= loadedAt ? SessionManager.open(file, manager.getSessionDir()) : manager;
}

/**
 * In-session switch to `targetFile`: the same claim, before the target is loaded, so nothing needs reopening. Throws
 * before anything changes when a background copy does not leave in time.
 */
export async function claimDiscordConversationFile(
	targetFile: string,
	options: DiscordTakeoverOptions = {},
): Promise<void> {
	const root = options.root ?? discordModePaths().root;
	const binding = await sharedBinding(targetFile, root);
	if (!binding || (await holdDiscordConversation(binding.sessionId, "terminal", root))) return;
	if ((await discordConversationHolder(binding.sessionId, root)) !== "background") return;
	await takeOver(binding, root, options);
}
