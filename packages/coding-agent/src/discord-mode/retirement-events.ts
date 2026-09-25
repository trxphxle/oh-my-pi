import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { canonicalProjectDir } from "../launch/paths";
import { parseTitleSlotLine } from "../session/session-title-slot";
import { discordModePaths } from "./config";
import {
	createPrivateJson,
	ensurePrivateDirectory,
	readPrivateJson,
	writePrivateJson,
} from "@oh-my-pi/pi-utils/discord-private-files";
import {
	DISCORD_MODE_MAX_SESSIONS,
	type ModeDeletionBinding,
	type ModeDeletionEvent,
	type ModeRetirementPolicy,
} from "@oh-my-pi/pi-wire/discord-mode";

const MAX_STATE_BYTES = 24 * 1024 * 1024;
const MAX_EVENT_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REMOTE_ID = /^\d{1,22}$/;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
	return typeof value === "string" && UUID.test(value);
}

function remoteId(value: unknown): value is string {
	return typeof value === "string" && REMOTE_ID.test(value);
}

function safePath(value: unknown): value is string {
	return typeof value === "string" && value.length <= 4096 && path.isAbsolute(value) && !/[\x00-\x1f]/.test(value);
}

function binding(value: unknown): ModeDeletionBinding {
	if (
		!record(value) ||
		!identifier(value.sessionId) ||
		!safePath(value.sessionFile) ||
		!safePath(value.projectDir) ||
		(value.channelId !== undefined && !remoteId(value.channelId)) ||
		typeof value.label !== "string" ||
		value.label.length > 100 ||
		!value.label.trim() ||
		/[\x00-\x1f\x7f]/.test(value.label) ||
		!remoteId(value.guildId) ||
		!remoteId(value.ownerId)
	)
		throw new Error("Invalid Discord deletion binding.");
	return {
		sessionId: value.sessionId,
		sessionFile: value.sessionFile,
		projectDir: value.projectDir,
		...(value.channelId === undefined ? {} : { channelId: value.channelId }),
		label: value.label,
		guildId: value.guildId,
		ownerId: value.ownerId,
	};
}

function deletionEvent(value: unknown): ModeDeletionEvent {
	if (
		!record(value) ||
		Object.keys(value).some(key => !["version", "id", "binding", "policy", "phase", "createdAt"].includes(key)) ||
		value.version !== 1 ||
		!identifier(value.id) ||
		(value.policy !== "retain" && value.policy !== "delete") ||
		(value.phase !== "prepared" && value.phase !== "committed") ||
		typeof value.createdAt !== "number" ||
		!Number.isSafeInteger(value.createdAt) ||
		value.createdAt < 0 ||
		!record(value.binding) ||
		Object.keys(value.binding).some(
			key => !["sessionId", "sessionFile", "projectDir", "channelId", "label", "guildId", "ownerId"].includes(key),
		)
	)
		throw new Error("Invalid Discord deletion event.");
	return {
		version: 1,
		id: value.id,
		binding: binding(value.binding),
		policy: value.policy,
		phase: value.phase,
		createdAt: value.createdAt,
	};
}

async function canonicalSessionFile(sessionFile: string): Promise<string> {
	if (!safePath(sessionFile)) throw new Error("Discord deletion requires an absolute saved session path.");
	return path.join(await canonicalProjectDir(path.dirname(sessionFile)), path.basename(sessionFile));
}

interface DeletionStateProjection {
	binding: ModeDeletionBinding;
	retired: boolean;
	/** Sharing remembered by the broker; closed conversations stay enabled until an explicit off. */
	enabled: boolean;
	pendingEventId?: string;
}

/** Bound and validate the credential-free projection without importing the broker. */
async function readDeletionState(root: string): Promise<DeletionStateProjection[]> {
	const saved = await readPrivateJson(path.join(root, "state.json"), MAX_STATE_BYTES);
	if (saved === undefined) return [];
	if (
		!record(saved) ||
		saved.version !== 1 ||
		!remoteId(saved.guildId) ||
		!remoteId(saved.ownerId) ||
		!Array.isArray(saved.groups) ||
		saved.groups.length > DISCORD_MODE_MAX_SESSIONS ||
		!Array.isArray(saved.sessions) ||
		saved.sessions.length > DISCORD_MODE_MAX_SESSIONS
	)
		throw new Error("Invalid Discord deletion state projection.");
	const groups = new Map<string, string>();
	const projects = new Set<string>();
	const channels = new Set<string>();
	const claimChannel = (id: unknown) => {
		if (id === undefined) return;
		if (!remoteId(id) || channels.has(id)) throw new Error("Discord deletion state has competing channel bindings.");
		channels.add(id);
	};
	for (const group of saved.groups) {
		if (
			!record(group) ||
			!identifier(group.id) ||
			!safePath(group.projectDir) ||
			groups.has(group.id) ||
			projects.has(group.projectDir)
		) {
			throw new Error("Invalid Discord deletion project identity.");
		}
		groups.set(group.id, group.projectDir);
		projects.add(group.projectDir);
		claimChannel(group.categoryId);
		claimChannel(group.overviewId);
	}
	const identities = new Set<string>();
	const files = new Set<string>();
	const result: DeletionStateProjection[] = [];
	for (const session of saved.sessions) {
		if (!record(session)) throw new Error("Invalid Discord deletion session identity.");
		const projected = binding({
			sessionId: session.id,
			sessionFile: session.sessionFile,
			projectDir: session.projectDir,
			channelId: session.channelId,
			label: session.label,
			guildId: saved.guildId,
			ownerId: saved.ownerId,
		});
		if (
			identities.has(projected.sessionId) ||
			files.has(projected.sessionFile) ||
			typeof session.groupId !== "string" ||
			groups.get(session.groupId) !== projected.projectDir
		)
			throw new Error("Discord deletion state has competing native identities.");
		identities.add(projected.sessionId);
		files.add(projected.sessionFile);
		claimChannel(projected.channelId);
		const retirement = session.retirement;
		if (
			retirement !== undefined &&
			(!record(retirement) ||
				!identifier(retirement.eventId) ||
				(retirement.policy !== "retain" && retirement.policy !== "delete") ||
				(retirement.state !== "pending" && retirement.state !== "attention" && retirement.state !== "done") ||
				typeof retirement.deletedAt !== "number" ||
				!Number.isSafeInteger(retirement.deletedAt) ||
				retirement.deletedAt < 0 ||
				(retirement.channelId !== undefined && !remoteId(retirement.channelId)))
		)
			throw new Error("Invalid Discord retirement state projection.");
		result.push({
			binding: projected,
			retired: retirement !== undefined,
			enabled: session.enabled === true,
			...(record(retirement) && retirement.state !== "done" && identifier(retirement.eventId)
				? { pendingEventId: retirement.eventId }
				: {}),
		});
	}
	return result;
}

/** Read only saved bindings; a missing native file never grants new deletion authority. */
export async function lookupDiscordDeletionBinding(
	sessionFile: string,
	root = discordModePaths().root,
): Promise<ModeDeletionBinding | undefined> {
	const saved = await readDeletionState(root);
	if (!saved.length) return undefined;
	const canonical = await canonicalSessionFile(sessionFile);
	const found = saved.find(session => !session.retired && session.binding.sessionFile === canonical)?.binding;
	if (found && (await canonicalProjectDir(found.projectDir)) !== found.projectDir) {
		throw new Error("Discord deletion project identity changed.");
	}
	return found;
}

/**
 * Offline, credential-free view of conversations the broker still shares (enabled, not deleted). Never connects to or
 * starts the broker; any unreadable or invalid state reads as nothing shared.
 */
export async function readDiscordSharedSessions(root = discordModePaths().root): Promise<ModeDeletionBinding[]> {
	try {
		return (await readDeletionState(root))
			.filter(session => session.enabled && !session.retired)
			.map(session => session.binding);
	} catch {
		return [];
	}
}

/** Picker badges keyed by native session UUID for conversations shared with Discord. */
export async function loadDiscordSessionBadges(root = discordModePaths().root): Promise<ReadonlyMap<string, string>> {
	return new Map((await readDiscordSharedSessions(root)).map(session => [session.sessionId, "Discord"]));
}

async function privateDirectoryExists(directory: string): Promise<boolean> {
	if (!safePath(directory)) throw new Error("Invalid Discord deletion storage path.");
	let info: nodeFs.Stats;
	try {
		info = await fs.lstat(directory);
	} catch (error) {
		if (isEnoent(error)) return false;
		throw new Error("Cannot inspect Discord deletion storage.");
	}
	if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
		throw new Error("Discord deletion storage requires an owned private directory.");
	}
	return true;
}

async function withStorageLock<T>(root: string, name: string, operation: () => Promise<T>): Promise<T> {
	await ensurePrivateDirectory(root);
	// The shared OS-backed lock is crash-released. Prepublication rejects unsafe sidecars.
	const lockTarget = path.join(await canonicalProjectDir(root), name);
	await createPrivateJson(`${lockTarget}.lock`, { version: 1 });
	const lock = await readPrivateJson(`${lockTarget}.lock`, 128);
	if (!record(lock) || lock.version !== 1) throw new Error("Invalid Discord deletion storage lock.");
	return withFileLock(lockTarget, operation, { retries: 50, retryDelayMs: 20 });
}

/** Serialize explicit native deletion and broker adoption. Never hold this lock across network effects. */
export async function withDiscordDeletionLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
	return withStorageLock(root, "deletion-transaction", operation);
}

async function withOutbox<T>(root: string, operation: (directory: string) => Promise<T>): Promise<T> {
	return withStorageLock(root, "deletions", async () => {
		const directory = path.join(root, "deletions");
		await ensurePrivateDirectory(directory);
		return operation(directory);
	});
}

async function eventsIn(directory: string, reserve = 0): Promise<ModeDeletionEvent[]> {
	const events: ModeDeletionEvent[] = [];
	const ids = new Set<string>();
	let entries = 0;
	const files = await fs.opendir(directory, { bufferSize: 16 });
	for await (const entry of files) {
		// Atomic-write remnants are inert but bounded too; do not guess whether a writer is still alive.
		if (++entries + reserve > DISCORD_MODE_MAX_SESSIONS * 2)
			throw new Error("Discord deletion outbox exceeds capacity.");
		if (/^\.discord-[0-9a-f-]{36}\.tmp$/.test(entry.name)) continue;
		const sessionId = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
		if (!identifier(sessionId) || !entry.isFile()) throw new Error("Invalid Discord deletion outbox entry.");
		const saved = await readPrivateJson(path.join(directory, entry.name), MAX_EVENT_BYTES);
		if (saved === undefined) continue;
		const event = deletionEvent(saved);
		if (event.binding.sessionId !== sessionId || ids.has(event.id))
			throw new Error("Discord deletion outbox identity mismatch.");
		ids.add(event.id);
		events.push(event);
		if (events.length > DISCORD_MODE_MAX_SESSIONS) throw new Error("Discord deletion outbox exceeds capacity.");
	}
	return events;
}

/** Missing native files alone never produce retirement authority. */
export async function readDiscordDeletionEvents(root: string): Promise<ModeDeletionEvent[]> {
	if (!(await privateDirectoryExists(root)) || !(await privateDirectoryExists(path.join(root, "deletions"))))
		return [];
	return withOutbox(root, eventsIn);
}

/** Startup wake hint only: the broker still validates and adopts all durable authority itself. */
export async function pendingDiscordRetirementEventId(root: string): Promise<string | undefined> {
	const [event] = await readDiscordDeletionEvents(root);
	if (event) return event.id;
	return (await readDeletionState(root)).find(session => session.pendingEventId !== undefined)?.pendingEventId;
}

/** Verify the persisted native UUID, including the optional fixed-width title slot. */
export async function assertDiscordDeletionNativeIdentity(input: ModeDeletionBinding): Promise<void> {
	const expected = binding(input);
	if ((await canonicalSessionFile(expected.sessionFile)) !== expected.sessionFile) {
		throw new Error("Discord deletion native session path changed.");
	}
	const file = await fs.open(
		expected.sessionFile,
		nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_NONBLOCK,
	);
	try {
		const info = await file.stat();
		if (!info.isFile() || info.nlink !== 1)
			throw new Error("Discord deletion requires the original regular session file.");
		const bytes = Buffer.alloc(Math.min(info.size, MAX_EVENT_BYTES));
		let length = 0;
		while (length < bytes.length) {
			const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
			if (!bytesRead) break;
			length += bytesRead;
		}
		let header: unknown;
		try {
			const prefix = bytes.subarray(0, length);
			const decoder = new TextDecoder("utf-8", { fatal: true });
			const firstEnd = prefix.indexOf(10);
			const firstLine = decoder.decode(prefix.subarray(0, firstEnd < 0 ? length : firstEnd));
			const start = parseTitleSlotLine(firstLine) ? firstEnd + 1 : 0;
			const end = prefix.indexOf(10, start);
			if (end < 0 && info.size > MAX_EVENT_BYTES) {
				throw new Error("Discord deletion session header exceeds its size limit.");
			}
			header = JSON.parse(decoder.decode(prefix.subarray(start, end < 0 ? length : end)));
		} catch {
			throw new Error("Cannot verify Discord deletion native session identity.");
		}
		if (!record(header) || header.type !== "session" || header.id !== expected.sessionId) {
			throw new Error("Discord deletion native session identity changed.");
		}
		const current = await fs.lstat(expected.sessionFile);
		if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino) {
			throw new Error("Discord deletion native session file changed during inspection.");
		}
	} finally {
		await file.close();
	}
}

/** ENOENT is authoritative only while the original canonical parent remains accessible and unchanged. */
export async function isDiscordDeletedSessionFile(sessionFile: string): Promise<boolean> {
	if ((await canonicalSessionFile(sessionFile)) !== sessionFile)
		throw new Error("Discord deletion session path changed.");
	const parent = path.dirname(sessionFile);
	const directory = await fs.open(
		parent,
		nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_DIRECTORY,
	);
	try {
		const before = await directory.stat();
		if (!before.isDirectory()) throw new Error("Cannot verify Discord deletion parent directory.");
		try {
			await fs.lstat(sessionFile);
			return false;
		} catch (error) {
			if (!isEnoent(error)) throw new Error("Cannot verify Discord deletion native file absence.");
		}
		const after = await fs.lstat(parent);
		if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) {
			throw new Error("Discord deletion parent directory changed.");
		}
		await fs.access(parent, nodeFs.constants.R_OK | nodeFs.constants.X_OK);
		return true;
	} finally {
		await directory.close();
	}
}

export async function prepareDiscordDeletionEvent(
	input: ModeDeletionBinding,
	policy: ModeRetirementPolicy,
	root = discordModePaths().root,
): Promise<ModeDeletionEvent> {
	const expected = binding(input);
	if (policy !== "retain" && policy !== "delete") throw new Error("Invalid Discord retirement policy.");
	return withOutbox(root, async directory => {
		const saved = await lookupDiscordDeletionBinding(expected.sessionFile, root);
		if (!saved || JSON.stringify(saved) !== JSON.stringify(expected))
			throw new Error("Discord deletion binding changed; nothing was deleted.");
		const events = await eventsIn(directory, 1);
		if (
			events.some(
				event =>
					event.binding.sessionId === expected.sessionId || event.binding.sessionFile === expected.sessionFile,
			)
		) {
			throw new Error(
				"Discord deletion intent already exists; inspect the saved intent and native file before retrying.",
			);
		}
		if (events.length >= DISCORD_MODE_MAX_SESSIONS) throw new Error("Discord deletion outbox is full.");
		await assertDiscordDeletionNativeIdentity(expected);
		const event: ModeDeletionEvent = {
			version: 1,
			id: randomUUID(),
			binding: expected,
			policy,
			phase: "prepared",
			createdAt: Date.now(),
		};
		if (Buffer.byteLength(JSON.stringify(event)) + 1 > MAX_EVENT_BYTES)
			throw new Error("Discord deletion event exceeds its size limit.");
		if (!(await createPrivateJson(path.join(directory, `${expected.sessionId}.json`), event))) {
			throw new Error("Discord deletion intent already exists; nothing was replaced.");
		}
		return event;
	});
}

function sameAuthority(left: ModeDeletionEvent, right: ModeDeletionEvent): boolean {
	return (
		left.id === right.id &&
		left.policy === right.policy &&
		left.createdAt === right.createdAt &&
		JSON.stringify(left.binding) === JSON.stringify(right.binding)
	);
}

export async function commitDiscordDeletionEvent(
	event: ModeDeletionEvent,
	root = discordModePaths().root,
): Promise<void> {
	const expected = deletionEvent(event);
	await withOutbox(root, async directory => {
		const file = path.join(directory, `${expected.binding.sessionId}.json`);
		const value = await readPrivateJson(file, MAX_EVENT_BYTES);
		// A broker may already have durably adopted and removed the prepared intent after unlink.
		if (value === undefined) return;
		const current = deletionEvent(value);
		if (!sameAuthority(current, expected)) throw new Error("Discord deletion intent changed; nothing was committed.");
		if (!(await isDiscordDeletedSessionFile(expected.binding.sessionFile)))
			throw new Error("Native session still exists; Discord deletion was not committed.");
		if (current.phase !== "committed") await writePrivateJson(file, { ...current, phase: "committed" });
	});
}

/** Compare immutable authority under the same cross-process lock; stale cancellation cannot erase a successor. */
export async function discardDiscordDeletionEvent(
	event: ModeDeletionEvent,
	root = discordModePaths().root,
): Promise<void> {
	const expected = deletionEvent(event);
	await withOutbox(root, async directory => {
		const file = path.join(directory, `${expected.binding.sessionId}.json`);
		const value = await readPrivateJson(file, MAX_EVENT_BYTES);
		if (value === undefined) return;
		if (!sameAuthority(deletionEvent(value), expected))
			throw new Error("Discord deletion intent changed; nothing was discarded.");
		await fs.unlink(file);
		const handle = await fs.open(directory, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW);
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	});
}
