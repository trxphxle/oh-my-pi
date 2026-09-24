import { logger } from "@oh-my-pi/pi-utils";
import type { DiscordModeClient } from "@oh-my-pi/pi-utils/discord-client";
import { connectDiscordMode } from "./client";
import { discordModePaths } from "./config";
import type { ModeRetirementPolicy } from "@oh-my-pi/pi-wire/discord-mode";
import {
	assertDiscordDeletionNativeIdentity,
	commitDiscordDeletionEvent,
	discardDiscordDeletionEvent,
	isDiscordDeletedSessionFile,
	lookupDiscordDeletionBinding,
	pendingDiscordRetirementEventId,
	prepareDiscordDeletionEvent,
	readDiscordDeletionEvents,
	withDiscordDeletionLock,
} from "./retirement-events";

const NOTIFY_TIMEOUT_MS = 1500;

async function notifyRetirement(eventId: string, notify?: (eventId: string) => Promise<void>): Promise<void> {
	let client: DiscordModeClient | undefined;
	let expired = false;
	let timer: NodeJS.Timeout | undefined;
	try {
		const deadline = Promise.withResolvers<never>();
		timer = setTimeout(
			() => deadline.reject(new Error("Discord retirement notification timed out.")),
			NOTIFY_TIMEOUT_MS,
		);
		await Promise.race([
			(async () => {
				if (notify) return notify(eventId);
				client = await connectDiscordMode();
				try {
					// A late connection must not start new work after the local deadline.
					if (!expired) await client.request({ op: "retire", eventId });
				} finally {
					await client.close();
				}
			})(),
			deadline.promise,
		]);
	} catch {
		// No exception text: connection/callback errors may contain credentials or private transcript text.
		logger.warn("Discord retirement remains durably queued; broker notification was not confirmed.");
	} finally {
		expired = true;
		clearTimeout(timer);
		await client?.close();
	}
}

/** Normal native startup only; never enroll sessions or contact Discord without explicit durable retirement work. */
export async function resumeDiscordRetirements(options?: {
	root?: string;
	notify?: (eventId: string) => Promise<void>;
}): Promise<void> {
	try {
		const eventId = await pendingDiscordRetirementEventId(options?.root ?? discordModePaths().root);
		if (eventId) await notifyRetirement(eventId, options?.notify);
	} catch {
		logger.warn("Pending Discord retirements could not be inspected; private state was left unchanged.");
	}
}

/** Wrap only an explicit, owner-approved native filesystem deletion, never a cancellable session transition. */
export async function deleteSessionWithDiscord(
	sessionFile: string,
	remove: () => Promise<void>,
	policy: ModeRetirementPolicy = "retain",
	options?: { root?: string; notify?: (eventId: string) => Promise<void> },
): Promise<void> {
	const root = options?.root ?? discordModePaths().root;
	if (!(await lookupDiscordDeletionBinding(sessionFile, root))) {
		await remove();
		return;
	}
	let committedId: string | undefined;
	try {
		await withDiscordDeletionLock(root, async () => {
			const binding = await lookupDiscordDeletionBinding(sessionFile, root);
			if (!binding) throw new Error("Discord deletion binding changed; nothing was deleted.");
			const prior = (await readDiscordDeletionEvents(root)).find(
				event => event.binding.sessionId === binding.sessionId || event.binding.sessionFile === binding.sessionFile,
			);
			if (prior) {
				if (
					prior.phase !== "prepared" ||
					prior.policy !== policy ||
					JSON.stringify(prior.binding) !== JSON.stringify(binding)
				) {
					throw new Error("Discord deletion already has a different or committed decision; nothing was replaced.");
				}
				// An explicit same-policy retry recovers a crash before unlink. The transaction lock excludes
				// any surviving deletion callback and broker adoption; absence or identity drift cannot cancel intent.
				await assertDiscordDeletionNativeIdentity(binding);
				await discardDiscordDeletionEvent(prior, root);
			}
			const event = await prepareDiscordDeletionEvent(binding, policy, root);
			let failed = false;
			let failure: unknown;
			try {
				await remove();
			} catch (error) {
				failed = true;
				failure = error;
			}
			let deleted: boolean;
			try {
				deleted = await isDiscordDeletedSessionFile(binding.sessionFile);
			} catch (error) {
				// An inaccessible/moved parent is not proof. Keep prepared authority for later inspection.
				logger.warn("Native deletion could not be verified; the prepared Discord retirement intent was preserved.");
				throw failed ? failure : error;
			}
			try {
				if (deleted) {
					await commitDiscordDeletionEvent(event, root);
					committedId = event.id;
				} else {
					await discardDiscordDeletionEvent(event, root);
				}
			} catch (error) {
				logger.warn(
					"Discord retirement persistence was not confirmed; inspect the durable intent before retrying.",
				);
				throw failed ? failure : error;
			}
			if (failed) throw failure;
			if (!deleted)
				throw new Error("Native deletion did not remove the saved session; Discord retirement was cancelled.");
		});
	} finally {
		// Local intent is already durable, and the transaction lock is released before any network request.
		if (committedId) await notifyRetirement(committedId, options?.notify);
	}
}
