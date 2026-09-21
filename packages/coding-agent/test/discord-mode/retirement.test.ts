import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensurePrivateDirectory, readPrivateJson, writePrivateJson } from "../../src/discord-mode/private-files";
import type { ModeDeletionBinding, ModeDeletionEvent } from "../../src/discord-mode/protocol";
import { deleteSessionWithDiscord, resumeDiscordRetirements } from "../../src/discord-mode/retirement";
import {
	commitDiscordDeletionEvent,
	discardDiscordDeletionEvent,
	isDiscordDeletedSessionFile,
	lookupDiscordDeletionBinding,
	prepareDiscordDeletionEvent,
	readDiscordDeletionEvents,
	withDiscordDeletionLock,
} from "../../src/discord-mode/retirement-events";
import { serializeTitleSlot } from "../../src/session/session-title-slot";

const cleanups: Array<() => Promise<void>> = [];
const offline = async () => {};

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function directory(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-retirement-test-"));
	await fs.chmod(root, 0o700);
	cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
	return fs.realpath(root);
}

function stateFor(binding: ModeDeletionBinding) {
	const groupId = randomUUID();
	return {
		version: 1,
		guildId: binding.guildId,
		ownerId: binding.ownerId,
		groups: [{ id: groupId, projectDir: binding.projectDir }],
		sessions: [
			{
				id: binding.sessionId,
				groupId,
				sessionFile: binding.sessionFile,
				projectDir: binding.projectDir,
				label: binding.label,
				channelId: binding.channelId,
				token: "PRIVATE_LEASE_MUST_NOT_ENTER_OUTBOX",
			},
		],
	};
}

async function fixture() {
	const temporary = await directory();
	const root = path.join(temporary, "private");
	const nativeDir = path.join(temporary, "native");
	await ensurePrivateDirectory(root);
	await fs.mkdir(nativeDir);
	const binding: ModeDeletionBinding = {
		sessionId: randomUUID(),
		sessionFile: path.join(nativeDir, "session.jsonl"),
		projectDir: temporary,
		channelId: "123456789012345680",
		label: "Original session",
		guildId: "123456789012345678",
		ownerId: "123456789012345679",
	};
	const body =
		serializeTitleSlot({ title: "Owner title", updatedAt: "2026-01-01T00:00:00.000Z" }) +
		`${JSON.stringify({ type: "session", id: binding.sessionId, cwd: temporary })}\n`;
	await fs.writeFile(binding.sessionFile, body);
	await writePrivateJson(path.join(root, "state.json"), stateFor(binding));
	return { temporary, root, nativeDir, binding, body };
}

describe("durable native-session retirement", () => {
	it("leaves unbound deletion and its errors unchanged without creating outbox storage", async () => {
		const root = await directory();
		const file = path.join(root, "unbound.jsonl");
		await fs.writeFile(file, "unbound");
		await deleteSessionWithDiscord(file, () => fs.unlink(file), "delete", {
			root,
			notify: async () => {
				throw new Error("Must not notify for an unbound native session");
			},
		});
		expect(await fs.readdir(root)).toEqual([]);
		const error = new Error("original storage failure");
		await expect(
			deleteSessionWithDiscord(
				file,
				async () => {
					throw error;
				},
				"retain",
				{ root, notify: offline },
			),
		).rejects.toBe(error);
		expect(await fs.readdir(root)).toEqual([]);
	});

	it.each(["retain", "delete"] as const)(
		"persists %s consent before unlink and commits before notifying",
		async policy => {
			const { root, binding } = await fixture();
			let preparedId = "";
			const notifications: string[] = [];
			await deleteSessionWithDiscord(
				binding.sessionFile,
				async () => {
					const events = await readDiscordDeletionEvents(root);
					expect(events).toHaveLength(1);
					expect(events[0]).toMatchObject({ binding, policy, phase: "prepared" });
					preparedId = events[0]!.id;
					expect(await isDiscordDeletedSessionFile(binding.sessionFile)).toBe(false);
					await fs.unlink(binding.sessionFile);
				},
				policy === "retain" ? undefined : policy,
				{
					root,
					notify: async eventId => {
						// Also proves notifier runs after releasing the native/broker transaction lock.
						await withDiscordDeletionLock(root, async () => {
							expect(await readDiscordDeletionEvents(root)).toMatchObject([
								{ id: eventId, policy, phase: "committed" },
							]);
						});
						notifications.push(eventId);
					},
				},
			);
			expect(await isDiscordDeletedSessionFile(binding.sessionFile)).toBe(true);
			expect(notifications).toEqual([preparedId]);
			const eventPath = path.join(root, "deletions", `${binding.sessionId}.json`);
			expect((await fs.stat(eventPath)).mode & 0o777).toBe(0o600);
			expect((await fs.stat(path.dirname(eventPath))).mode & 0o777).toBe(0o700);
			expect(await fs.readFile(eventPath, "utf8")).not.toContain("PRIVATE_LEASE_MUST_NOT_ENTER_OUTBOX");
		},
	);

	it("cancels intent when the removal fails before unlink, preserving the original error and native file", async () => {
		const { root, binding, body } = await fixture();
		const error = new Error("native storage refused deletion");
		let notified = false;
		await expect(
			deleteSessionWithDiscord(
				binding.sessionFile,
				async () => {
					throw error;
				},
				"delete",
				{
					root,
					notify: async () => {
						notified = true;
					},
				},
			),
		).rejects.toBe(error);
		expect(await fs.readFile(binding.sessionFile, "utf8")).toBe(body);
		expect(await readDiscordDeletionEvents(root)).toEqual([]);
		expect(notified).toBe(false);
	});

	it("does not retire a successful callback that left the native file intact", async () => {
		const { root, binding, body } = await fixture();
		await expect(
			deleteSessionWithDiscord(binding.sessionFile, async () => {}, "retain", { root, notify: offline }),
		).rejects.toThrow();
		expect(await fs.readFile(binding.sessionFile, "utf8")).toBe(body);
		expect(await readDiscordDeletionEvents(root)).toEqual([]);
	});

	it("commits after unlink even if artifact cleanup fails, while propagating the cleanup error", async () => {
		const { root, binding } = await fixture();
		const error = new Error("artifact cleanup failed");
		let notified = "";
		await expect(
			deleteSessionWithDiscord(
				binding.sessionFile,
				async () => {
					await fs.unlink(binding.sessionFile);
					throw error;
				},
				"retain",
				{
					root,
					notify: async id => {
						notified = id;
					},
				},
			),
		).rejects.toBe(error);
		expect(await readDiscordDeletionEvents(root)).toMatchObject([{ id: notified, binding, phase: "committed" }]);
		expect(await isDiscordDeletedSessionFile(binding.sessionFile)).toBe(true);
	});

	it("retains committed authority after an offline notification without retrying an uncertain request", async () => {
		const { root, binding } = await fixture();
		let attempts = 0;
		await deleteSessionWithDiscord(binding.sessionFile, () => fs.unlink(binding.sessionFile), "delete", {
			root,
			notify: async () => {
				attempts++;
				throw new Error("PRIVATE_TRANSPORT_ERROR");
			},
		});
		expect(attempts).toBe(1);
		expect(await readDiscordDeletionEvents(root)).toMatchObject([{ binding, policy: "delete", phase: "committed" }]);
	});

	it("bounds an unresponsive notifier without discarding committed authority", async () => {
		const { root, binding } = await fixture();
		await deleteSessionWithDiscord(binding.sessionFile, () => fs.unlink(binding.sessionFile), "retain", {
			root,
			notify: () => Promise.withResolvers<void>().promise,
		});
		expect(await readDiscordDeletionEvents(root)).toMatchObject([{ binding, phase: "committed" }]);
	}, 4000);

	it("never invents deletion consent from a missing native file", async () => {
		const { root, binding } = await fixture();
		await fs.unlink(binding.sessionFile);
		expect(await readDiscordDeletionEvents(root)).toEqual([]);
		let removed = false;
		await expect(
			deleteSessionWithDiscord(
				binding.sessionFile,
				async () => {
					removed = true;
				},
				"delete",
				{ root, notify: offline },
			),
		).rejects.toThrow();
		expect(removed).toBe(false);
		expect(await readDiscordDeletionEvents(root)).toEqual([]);
	});

	it("keeps prepared intent recoverable after a crash and refuses commit while native data survives", async () => {
		const { root, binding } = await fixture();
		const event = await prepareDiscordDeletionEvent(binding, "retain", root);
		await expect(commitDiscordDeletionEvent(event, root)).rejects.toThrow();
		expect(await readDiscordDeletionEvents(root)).toEqual([event]);
		await fs.unlink(binding.sessionFile);
		expect(await readDiscordDeletionEvents(root)).toEqual([event]);
		await commitDiscordDeletionEvent(event, root);
		await commitDiscordDeletionEvent(event, root);
		expect(await readDiscordDeletionEvents(root)).toEqual([{ ...event, phase: "committed" }]);
	});

	it("recovers a stale prepared intent only through a same-policy explicit deletion retry", async () => {
		const { root, binding } = await fixture();
		const event = await prepareDiscordDeletionEvent(binding, "retain", root);
		let removed = false;
		await expect(
			deleteSessionWithDiscord(
				binding.sessionFile,
				async () => {
					removed = true;
				},
				"delete",
				{ root, notify: offline },
			),
		).rejects.toThrow();
		expect(removed).toBe(false);
		expect(await readDiscordDeletionEvents(root)).toEqual([event]);
		await deleteSessionWithDiscord(binding.sessionFile, () => fs.unlink(binding.sessionFile), "retain", {
			root,
			notify: offline,
		});
		const [retried] = await readDiscordDeletionEvents(root);
		expect(retried).toMatchObject({ binding, policy: "retain", phase: "committed" });
		expect(retried!.id).not.toBe(event.id);
	});

	it("does not let conflicting concurrent preparations overwrite the winning policy", async () => {
		const { root, binding } = await fixture();
		const results = await Promise.allSettled([
			prepareDiscordDeletionEvent(binding, "retain", root),
			prepareDiscordDeletionEvent(binding, "delete", root),
		]);
		const winners = results.flatMap(result => (result.status === "fulfilled" ? [result.value] : []));
		expect(winners).toHaveLength(1);
		expect(await readDiscordDeletionEvents(root)).toEqual(winners);
		await expect(prepareDiscordDeletionEvent(binding, winners[0]!.policy, root)).rejects.toThrow();
		expect(await readDiscordDeletionEvents(root)).toEqual(winners);
	});

	it("excludes a second callback while the first deletion owns prepared authority", async () => {
		const { root, binding } = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let secondRan = false;
		const first = deleteSessionWithDiscord(
			binding.sessionFile,
			async () => {
				entered.resolve();
				await release.promise;
				await fs.unlink(binding.sessionFile);
			},
			"retain",
			{ root, notify: offline },
		);
		try {
			await entered.promise;
			await expect(
				deleteSessionWithDiscord(
					binding.sessionFile,
					async () => {
						secondRan = true;
					},
					"delete",
					{ root, notify: offline },
				),
			).rejects.toThrow();
			expect(secondRan).toBe(false);
			expect(await readDiscordDeletionEvents(root)).toMatchObject([{ policy: "retain", phase: "prepared" }]);
		} finally {
			release.resolve();
			await first;
		}
		expect(await readDiscordDeletionEvents(root)).toMatchObject([{ policy: "retain", phase: "committed" }]);
	});

	it("never lets stale cancellation or changed authority erase a newer event", async () => {
		const { root, binding } = await fixture();
		const old = await prepareDiscordDeletionEvent(binding, "retain", root);
		await discardDiscordDeletionEvent(old, root);
		const current = await prepareDiscordDeletionEvent(binding, "retain", root);
		await expect(discardDiscordDeletionEvent(old, root)).rejects.toThrow();
		await expect(commitDiscordDeletionEvent(old, root)).rejects.toThrow();
		const changed = { ...current, binding: { ...current.binding, channelId: "999" } };
		await expect(discardDiscordDeletionEvent(changed, root)).rejects.toThrow();
		expect(await readDiscordDeletionEvents(root)).toEqual([current]);
	});

	it("retains prepared authority when the native parent moved instead of proving permanent deletion", async () => {
		const { root, temporary, nativeDir, binding } = await fixture();
		const moved = path.join(temporary, "moved-native");
		const error = new Error("session directory moved");
		await expect(
			deleteSessionWithDiscord(
				binding.sessionFile,
				async () => {
					await fs.rename(nativeDir, moved);
					throw error;
				},
				"retain",
				{ root, notify: offline },
			),
		).rejects.toBe(error);
		expect(await readDiscordDeletionEvents(root)).toMatchObject([{ binding, phase: "prepared" }]);
		await expect(isDiscordDeletedSessionFile(binding.sessionFile)).rejects.toThrow();
		expect(await fs.readFile(path.join(moved, "session.jsonl"), "utf8")).toContain(binding.sessionId);
	});

	it.skipIf(process.getuid?.() === 0)(
		"does not mistake an inaccessible native parent for confirmed absence",
		async () => {
			const { root, nativeDir, binding } = await fixture();
			try {
				await expect(
					deleteSessionWithDiscord(
						binding.sessionFile,
						async () => {
							await fs.unlink(binding.sessionFile);
							await fs.chmod(nativeDir, 0o000);
						},
						"delete",
						{ root, notify: offline },
					),
				).rejects.toThrow();
				expect(await readDiscordDeletionEvents(root)).toMatchObject([{ binding, phase: "prepared" }]);
			} finally {
				await fs.chmod(nativeDir, 0o700);
			}
		},
	);
});

describe("retirement identity and private storage boundaries", () => {
	it("matches canonical parent aliases without following a different native identity", async () => {
		const { root, temporary, nativeDir, binding } = await fixture();
		const alias = path.join(temporary, "alias");
		await fs.symlink(nativeDir, alias);
		expect(await lookupDiscordDeletionBinding(path.join(alias, "session.jsonl"), root)).toEqual(binding);
		await fs.writeFile(binding.sessionFile, `${JSON.stringify({ type: "session", id: randomUUID() })}\n`);
		await expect(prepareDiscordDeletionEvent(binding, "delete", root)).rejects.toThrow();
		expect(await readDiscordDeletionEvents(root)).toEqual([]);
	});

	it("does not reenroll already retired files or leak private journal fields into bindings", async () => {
		const { root, binding } = await fixture();
		expect(await lookupDiscordDeletionBinding(binding.sessionFile, root)).toEqual(binding);
		const state = stateFor(binding);
		await writePrivateJson(path.join(root, "state.json"), {
			...state,
			sessions: state.sessions.map(session => ({
				...session,
				retirement: { eventId: randomUUID(), policy: "retain", state: "done", deletedAt: Date.now() },
			})),
		});
		expect(await lookupDiscordDeletionBinding(binding.sessionFile, root)).toBeUndefined();
		await expect(prepareDiscordDeletionEvent(binding, "delete", root)).rejects.toThrow();
		expect(await readDiscordDeletionEvents(root)).toEqual([]);
	});

	it("rejects foreign ownership, rebound channels, duplicate identities, and oversized binding sets", async () => {
		const { root, binding, body } = await fixture();
		for (const changed of [
			{ ...binding, guildId: "999" },
			{ ...binding, ownerId: "999" },
			{ ...binding, channelId: "999" },
		]) {
			await expect(prepareDiscordDeletionEvent(changed, "delete", root)).rejects.toThrow();
		}
		const state = stateFor(binding);
		await writePrivateJson(path.join(root, "state.json"), {
			...state,
			sessions: [state.sessions[0], state.sessions[0]],
		});
		await expect(lookupDiscordDeletionBinding(binding.sessionFile, root)).rejects.toThrow();
		await writePrivateJson(path.join(root, "state.json"), {
			...state,
			sessions: Array.from({ length: 129 }, () => state.sessions[0]),
		});
		await expect(lookupDiscordDeletionBinding(binding.sessionFile, root)).rejects.toThrow();
		expect(await fs.readFile(binding.sessionFile, "utf8")).toBe(body);
		expect(await readDiscordDeletionEvents(root)).toEqual([]);
	});

	it.each(["symlink", "hardlink", "public"] as const)(
		"rejects %s state without deleting native data",
		async unsafe => {
			const { root, temporary, binding, body } = await fixture();
			const state = path.join(root, "state.json");
			if (unsafe === "public") await fs.chmod(state, 0o644);
			else {
				const target = path.join(temporary, "state-target.json");
				await fs.rename(state, target);
				if (unsafe === "symlink") await fs.symlink(target, state);
				else await fs.link(target, state);
			}
			let removed = false;
			await expect(
				deleteSessionWithDiscord(
					binding.sessionFile,
					async () => {
						removed = true;
					},
					"delete",
					{ root, notify: offline },
				),
			).rejects.toThrow();
			expect(removed).toBe(false);
			expect(await fs.readFile(binding.sessionFile, "utf8")).toBe(body);
		},
	);

	it.each(["symlink", "hardlink"] as const)(
		"rejects a %s native file instead of retiring its target",
		async unsafe => {
			const { root, nativeDir, binding, body } = await fixture();
			const target = path.join(nativeDir, "target.jsonl");
			await fs.rename(binding.sessionFile, target);
			if (unsafe === "symlink") await fs.symlink(target, binding.sessionFile);
			else await fs.link(target, binding.sessionFile);
			await expect(prepareDiscordDeletionEvent(binding, "delete", root)).rejects.toThrow();
			expect(await fs.readFile(target, "utf8")).toBe(body);
			expect(await readDiscordDeletionEvents(root)).toEqual([]);
		},
	);

	it("rejects malformed, oversized, and identity-mismatched private events", async () => {
		const { root, binding } = await fixture();
		const event = await prepareDiscordDeletionEvent(binding, "retain", root);
		const eventPath = path.join(root, "deletions", `${binding.sessionId}.json`);
		await fs.writeFile(eventPath, "PRIVATE_INVALID_JSON", { mode: 0o600 });
		let diagnostic = "";
		try {
			await readDiscordDeletionEvents(root);
		} catch (error) {
			diagnostic = String(error);
		}
		expect(diagnostic).not.toContain("PRIVATE_INVALID_JSON");
		expect(diagnostic).toContain("invalid JSON");
		await fs.truncate(eventPath, 16 * 1024 + 1);
		await expect(readDiscordDeletionEvents(root)).rejects.toThrow();
		await writePrivateJson(eventPath, { ...event, binding: { ...binding, sessionId: randomUUID() } });
		await expect(readDiscordDeletionEvents(root)).rejects.toThrow();
		await writePrivateJson(eventPath, { ...event, binding: { ...binding, botToken: "PRIVATE_CREDENTIAL" } });
		await expect(readDiscordDeletionEvents(root)).rejects.toThrow();
	});

	it("rejects unsafe event directories and lock sidecars without following their targets", async () => {
		const { root, temporary, binding } = await fixture();
		const outside = path.join(temporary, "outside");
		await ensurePrivateDirectory(outside);
		await fs.symlink(outside, path.join(root, "deletions"));
		await expect(prepareDiscordDeletionEvent(binding, "delete", root)).rejects.toThrow();
		expect(await fs.readdir(outside)).toEqual([]);
		await fs.unlink(path.join(root, "deletions"));
		const lockPath = path.join(root, "deletions.lock");
		await fs.unlink(lockPath);
		const target = path.join(outside, "unrelated.json");
		await writePrivateJson(target, { keep: true });
		await fs.symlink(target, lockPath);
		await expect(prepareDiscordDeletionEvent(binding, "delete", root)).rejects.toThrow();
		expect(await readPrivateJson(target)).toEqual({ keep: true });
	});

	it("bounds state reads before parsing and does not expose malformed state content", async () => {
		const { root, binding } = await fixture();
		const statePath = path.join(root, "state.json");
		await fs.truncate(statePath, 24 * 1024 * 1024 + 1);
		await expect(lookupDiscordDeletionBinding(binding.sessionFile, root)).rejects.toThrow();
		await fs.writeFile(statePath, "PRIVATE_INVALID_STATE", { mode: 0o600 });
		let diagnostic = "";
		try {
			await lookupDiscordDeletionBinding(binding.sessionFile, root);
		} catch (error) {
			diagnostic = String(error);
		}
		expect(diagnostic).not.toContain("PRIVATE_INVALID_STATE");
		expect(diagnostic).toContain("invalid JSON");
	});

	it("fails closed at the event capacity instead of evicting a retained decision", async () => {
		const { root, binding } = await fixture();
		const outbox = path.join(root, "deletions");
		await ensurePrivateDirectory(outbox);
		const existing: ModeDeletionEvent[] = [];
		for (let index = 0; index < 128; index++) {
			const sessionId = randomUUID();
			const event: ModeDeletionEvent = {
				version: 1,
				id: randomUUID(),
				binding: { ...binding, sessionId, sessionFile: `${binding.sessionFile}.${index}` },
				policy: "retain",
				phase: "prepared",
				createdAt: Date.now(),
			};
			existing.push(event);
			await writePrivateJson(path.join(outbox, `${sessionId}.json`), event);
		}
		await expect(prepareDiscordDeletionEvent(binding, "delete", root)).rejects.toThrow();
		expect((await readDiscordDeletionEvents(root)).sort((a, b) => a.id.localeCompare(b.id))).toEqual(
			existing.sort((a, b) => a.id.localeCompare(b.id)),
		);
	});

	it("bounds inert atomic-write remnants instead of traversing an unbounded outbox", async () => {
		const { root } = await fixture();
		const outbox = path.join(root, "deletions");
		await ensurePrivateDirectory(outbox);
		await Promise.all(
			Array.from({ length: 257 }, () =>
				fs.writeFile(path.join(outbox, `.discord-${randomUUID()}.tmp`), "", { mode: 0o600 }),
			),
		);
		await expect(readDiscordDeletionEvents(root)).rejects.toThrow();
	});
});

describe("startup retirement replay", () => {
	it("does not wake Discord for missing files without explicit retirement authority", async () => {
		const { root, binding } = await fixture();
		await fs.unlink(binding.sessionFile);
		let notified = false;
		await resumeDiscordRetirements({
			root,
			notify: async () => {
				notified = true;
			},
		});
		expect(notified).toBe(false);
		expect(await readDiscordDeletionEvents(root)).toEqual([]);
	});

	it("wakes the durable outbox after an earlier offline attempt without changing its decision", async () => {
		const { root, binding } = await fixture();
		await deleteSessionWithDiscord(binding.sessionFile, () => fs.unlink(binding.sessionFile), "delete", {
			root,
			notify: async () => {
				throw new Error("offline");
			},
		});
		const saved = await readDiscordDeletionEvents(root);
		const notifications: string[] = [];
		await resumeDiscordRetirements({
			root,
			notify: async id => {
				notifications.push(id);
			},
		});
		expect(notifications).toEqual([saved[0]!.id]);
		expect(await readDiscordDeletionEvents(root)).toEqual(saved);
	});

	it.each(["pending", "attention", "done"] as const)(
		"only resumes unfinished %s tombstones after outbox adoption",
		async status => {
			const { root, binding } = await fixture();
			const state = stateFor(binding);
			const eventId = randomUUID();
			await writePrivateJson(path.join(root, "state.json"), {
				...state,
				sessions: state.sessions.map(session => ({
					...session,
					retirement: {
						eventId,
						policy: "retain",
						state: status,
						deletedAt: Date.now(),
						channelId: binding.channelId,
					},
				})),
			});
			const notifications: string[] = [];
			await resumeDiscordRetirements({
				root,
				notify: async id => {
					notifications.push(id);
				},
			});
			expect(notifications).toEqual(status === "done" ? [] : [eventId]);
			expect(await readDiscordDeletionEvents(root)).toEqual([]);
		},
	);

	it("leaves corrupt private replay state untouched without contacting the broker", async () => {
		const { root } = await fixture();
		const file = path.join(root, "state.json");
		await fs.writeFile(file, "PRIVATE_INVALID_REPLAY_STATE", { mode: 0o600 });
		let notified = false;
		await resumeDiscordRetirements({
			root,
			notify: async () => {
				notified = true;
			},
		});
		expect(notified).toBe(false);
		expect(await fs.readFile(file, "utf8")).toBe("PRIVATE_INVALID_REPLAY_STATE");
	});
});
