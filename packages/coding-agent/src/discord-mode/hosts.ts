/**
 * One writer per shared Discord conversation: a terminal or a background copy started from Discord holds a
 * process-owned lock (the OS drops it however the process ends), with a sidecar naming the holder's kind. Kept free of
 * session and client imports: the Discord service reads holders through it too.
 */
import * as path from "node:path";
import { FileLock } from "@oh-my-pi/pi-natives";
import { ensurePrivateDirectory, readPrivateJson, writePrivateJson } from "@oh-my-pi/pi-utils/discord-private-files";
import { discordModePaths } from "./config";

/** Set by the Discord service on a background copy it starts; a random single-use launch id, never a name or text. */
export const DISCORD_HOST_LAUNCH_ENV = "HAISO_DISCORD_LAUNCH";
export type DiscordHostKind = "terminal" | "background";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Locks this process holds, by conversation id. */
const held = new Map<string, FileLock>();
/** This process is a background copy started by the Discord service. */
let backgroundHost = false;
/** Its launch id until the first registration claims it. */
let pendingLaunch: string | undefined;

export function isDiscordBackgroundHost(): boolean {
	return backgroundHost;
}

/** Mark this process as the background copy for `launchId`; only the startup claim does this. */
export function becomeDiscordBackgroundHost(launchId: string): void {
	if (!UUID.test(launchId)) throw new Error("Invalid Discord launch identity.");
	backgroundHost = true;
	pendingLaunch = launchId;
}

/** The launch this background copy was started for; returned once, for its first registration. */
export function takeDiscordLaunch(): string | undefined {
	const launch = pendingLaunch;
	pendingLaunch = undefined;
	return launch;
}

function lockFiles(root: string, sessionId: string): { dir: string; lock: string; info: string } {
	if (!UUID.test(sessionId)) throw new Error("Invalid conversation identity.");
	const dir = path.join(root, "hosts");
	return { dir, lock: path.join(dir, `${sessionId}.lock`), info: path.join(dir, `${sessionId}.json`) };
}

/**
 * Try to become the conversation's single writer; undefined while another process holds it. The sidecar only names
 * the holder's kind; the lock alone decides.
 */
export async function acquireDiscordConversation(
	sessionId: string,
	kind: DiscordHostKind,
	root = discordModePaths().root,
): Promise<FileLock | undefined> {
	const files = lockFiles(root, sessionId);
	await ensurePrivateDirectory(files.dir);
	const lock = FileLock.tryAcquire(files.lock);
	if (!lock.acquired) {
		lock.release();
		return undefined;
	}
	try {
		await writePrivateJson(files.info, { version: 1, pid: process.pid, kind, startedAt: Date.now() });
	} catch {
		/* Without a sidecar a waiting terminal assumes another terminal and proceeds as before. */
	}
	return lock;
}

/** Hold the conversation for this process (idempotent); false while another process holds it. */
export async function holdDiscordConversation(
	sessionId: string,
	kind: DiscordHostKind,
	root = discordModePaths().root,
): Promise<boolean> {
	if (held.has(sessionId)) return true;
	const lock = await acquireDiscordConversation(sessionId, kind, root);
	if (!lock) return false;
	held.set(sessionId, lock);
	return true;
}

/** Who holds the conversation right now; undefined when nobody does. Never keeps the lock. */
export async function discordConversationHolder(
	sessionId: string,
	root = discordModePaths().root,
): Promise<DiscordHostKind | undefined> {
	if (held.has(sessionId)) return backgroundHost ? "background" : "terminal";
	const files = lockFiles(root, sessionId);
	let lock: FileLock;
	try {
		lock = FileLock.tryAcquire(files.lock);
	} catch {
		return undefined; // No hosts directory yet: nobody ever held it.
	}
	const free = lock.acquired;
	lock.release();
	if (free) return undefined;
	const info = await readPrivateJson(files.info, 4096).catch(() => undefined);
	return typeof info === "object" && info !== null && "kind" in info && info.kind === "background"
		? "background"
		: "terminal";
}

/** Release every conversation this process holds except `keep` (the one its interactive session shows now). */
export function releaseDiscordConversations(keep?: string): void {
	for (const [sessionId, lock] of held)
		if (sessionId !== keep) {
			lock.release();
			held.delete(sessionId);
		}
}
