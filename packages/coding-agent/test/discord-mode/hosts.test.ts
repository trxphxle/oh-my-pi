import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ensurePrivateDirectory, writePrivateJson } from "@oh-my-pi/pi-utils/discord-private-files";
import type { ModeDeletionBinding } from "@oh-my-pi/pi-wire/discord-mode";
import { claimDiscordConversation, claimDiscordConversationFile } from "../../src/discord-mode/claim";
import {
	acquireDiscordConversation,
	DISCORD_HOST_LAUNCH_ENV,
	discordConversationHolder,
	isDiscordBackgroundHost,
	releaseDiscordConversations,
} from "../../src/discord-mode/hosts";
import { discordHostDaemonSpec } from "../../src/discord-mode/launcher";
import { SessionManager } from "../../src/session/session-manager";

afterEach(() => {
	releaseDiscordConversations();
});

/** A saved conversation on disk, listed as shared (or not) in the broker's offline state. */
async function conversation(root: string, shared = true) {
	const project = path.join(root, "project");
	await fs.mkdir(project, { recursive: true });
	const manager = SessionManager.create(await fs.realpath(project), await fs.realpath(project));
	manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile()!;
	const discordRoot = path.join(root, "discord");
	await ensurePrivateDirectory(discordRoot);
	const groupId = crypto.randomUUID();
	const projectDir = await fs.realpath(project);
	await writePrivateJson(path.join(discordRoot, "state.json"), {
		version: 1,
		guildId: "100",
		ownerId: "200",
		groups: [{ id: groupId, projectDir }],
		sessions: shared
			? [
					{
						id: manager.getSessionId(),
						groupId,
						sessionFile: path.join(await fs.realpath(path.dirname(file)), path.basename(file)),
						projectDir,
						label: "shared",
						channelId: "300",
						enabled: true,
					},
				]
			: [],
	});
	return { manager, file, discordRoot, sessionId: manager.getSessionId() };
}

describe("single writer per shared Discord conversation", () => {
	it("holds a conversation for one process-owned lock at a time and names the holder's kind", async () => {
		using temporary = TempDir.createSync("@discord-hosts-lock-");
		const root = temporary.path();
		const sessionId = crypto.randomUUID();
		expect(await discordConversationHolder(sessionId, root)).toBeUndefined();
		const copy = await acquireDiscordConversation(sessionId, "background", root);
		expect(copy?.acquired).toBe(true);
		expect(await acquireDiscordConversation(sessionId, "terminal", root)).toBeUndefined();
		expect(await discordConversationHolder(sessionId, root)).toBe("background");
		copy!.release();
		expect(await discordConversationHolder(sessionId, root)).toBeUndefined();
		const desk = await acquireDiscordConversation(sessionId, "terminal", root);
		expect(await discordConversationHolder(sessionId, root)).toBe("terminal");
		desk!.release();
	});

	it("leaves unshared conversations, a second terminal, and non-interactive launch ids exactly as before", async () => {
		using temporary = TempDir.createSync("@discord-hosts-unchanged-");
		const root = temporary.path();
		const unshared = await conversation(path.join(root, "unshared"), false);
		const env: Record<string, string | undefined> = { [DISCORD_HOST_LAUNCH_ENV]: crypto.randomUUID() };
		expect(
			await claimDiscordConversation(unshared.manager, { interactive: false, root: unshared.discordRoot, env }),
		).toBe(unshared.manager);
		expect(env[DISCORD_HOST_LAUNCH_ENV]).toBeUndefined();
		expect(isDiscordBackgroundHost()).toBe(false);
		expect(await discordConversationHolder(unshared.sessionId, unshared.discordRoot)).toBeUndefined();

		const shared = await conversation(path.join(root, "shared"));
		const other = await acquireDiscordConversation(shared.sessionId, "terminal", shared.discordRoot);
		let asked = 0;
		const claimed = await claimDiscordConversation(shared.manager, {
			interactive: true,
			root: shared.discordRoot,
			stepAside: async () => {
				asked++;
			},
		});
		expect(claimed).toBe(shared.manager);
		expect(asked).toBe(0);
		other!.release();
	});

	it("takes the lock of a shared conversation, reopening the file only when it may have changed since loading", async () => {
		using temporary = TempDir.createSync("@discord-hosts-claim-");
		const f = await conversation(temporary.path());
		const kept = await claimDiscordConversation(f.manager, {
			interactive: true,
			root: f.discordRoot,
			loadedAt: Date.now() + 60_000,
		});
		expect(kept).toBe(f.manager);
		expect(await acquireDiscordConversation(f.sessionId, "background", f.discordRoot)).toBeUndefined();
		releaseDiscordConversations();
		const reopened = await claimDiscordConversation(f.manager, {
			interactive: true,
			root: f.discordRoot,
			loadedAt: 0,
		});
		expect(reopened).not.toBe(f.manager);
		expect(reopened.getSessionId()).toBe(f.sessionId);
	});

	it("takes over from a background copy: asks it to step aside, waits for its lock, then reopens", async () => {
		using temporary = TempDir.createSync("@discord-hosts-takeover-");
		const f = await conversation(temporary.path());
		const copy = await acquireDiscordConversation(f.sessionId, "background", f.discordRoot);
		const asked: ModeDeletionBinding[] = [];
		const notices: string[] = [];
		const watchdog: string[] = [];
		const claimed = await claimDiscordConversation(f.manager, {
			interactive: true,
			root: f.discordRoot,
			loadedAt: Date.now() + 60_000,
			pollMs: 1,
			waitMs: 5_000,
			notify: text => notices.push(text),
			pause: () => watchdog.push("pause"),
			resume: () => watchdog.push("resume"),
			stepAside: async binding => {
				asked.push(binding);
				// The copy leaves at its next idle point; its process exit drops the lock.
				copy!.release();
			},
		});
		expect(asked).toEqual([expect.objectContaining({ sessionId: f.sessionId, label: "shared", channelId: "300" })]);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("Taking over from the background copy");
		expect(watchdog).toEqual(["pause", "resume"]);
		// The copy wrote until it left: the file is always read again.
		expect(claimed).not.toBe(f.manager);
		expect(claimed.getSessionId()).toBe(f.sessionId);
		expect(await discordConversationHolder(f.sessionId, f.discordRoot)).toBe("terminal");
	});

	it("fails plainly without waiting outside interactive mode, and after the takeover timeout", async () => {
		using temporary = TempDir.createSync("@discord-hosts-timeout-");
		const f = await conversation(temporary.path());
		const copy = await acquireDiscordConversation(f.sessionId, "background", f.discordRoot);
		let asked = 0;
		const stepAside = async () => {
			asked++;
		};
		await expect(
			claimDiscordConversation(f.manager, { interactive: false, root: f.discordRoot, stepAside }),
		).rejects.toThrow("running in the background on Discord");
		expect(asked).toBe(0);
		// The takeover deadline is wall-clock by design; keep it tiny.
		await expect(
			claimDiscordConversation(f.manager, {
				interactive: true,
				root: f.discordRoot,
				stepAside,
				waitMs: 30,
				pollMs: 1,
			}),
		).rejects.toThrow("did not close within");
		expect(asked).toBe(1);
		expect(await discordConversationHolder(f.sessionId, f.discordRoot)).toBe("background");
		copy!.release();
	});

	it("claims a switched-to conversation before it loads, and ignores unshared targets", async () => {
		using temporary = TempDir.createSync("@discord-hosts-switch-");
		const root = temporary.path();
		const f = await conversation(path.join(root, "shared"));
		const copy = await acquireDiscordConversation(f.sessionId, "background", f.discordRoot);
		await claimDiscordConversationFile(f.file, {
			root: f.discordRoot,
			pollMs: 1,
			waitMs: 5_000,
			stepAside: async () => {
				copy!.release();
			},
		});
		expect(await discordConversationHolder(f.sessionId, f.discordRoot)).toBe("terminal");
		const unshared = await conversation(path.join(root, "unshared"), false);
		await claimDiscordConversationFile(unshared.file, { root: unshared.discordRoot });
		expect(await discordConversationHolder(unshared.sessionId, unshared.discordRoot)).toBeUndefined();
	});
});

describe("background copy launch specification", () => {
	const launchId = crypto.randomUUID();
	const sessionId = crypto.randomUUID();
	const options = {
		command: ["/opt/haiso/bin/haiso"],
		env: { OMP_PROFILE: "work", HAISO_PREFIX: "/opt/haiso", SECRET_TOKEN: "private", PATH: "/usr/bin" },
	};

	it("runs the interactive CLI with fixed arguments in a supervised PTY and an allowlisted environment", () => {
		const resume = discordHostDaemonSpec(
			{ launchId, name: `haiso-s-${sessionId}`, projectDir: "/work/project", sessionFile: "/work/project/s.jsonl" },
			options,
		);
		expect(resume).toMatchObject({
			name: `haiso-s-${sessionId}`,
			application: "/opt/haiso/bin/haiso",
			args: ["--resume", "/work/project/s.jsonl"],
			cwd: "/work/project",
			pty: true,
			restart: "no",
			persist: true,
			detached: false,
		});
		expect(resume.env[DISCORD_HOST_LAUNCH_ENV]).toBe(launchId);
		expect(resume.env).toMatchObject({ OMP_PROFILE: "work", HAISO_PREFIX: "/opt/haiso" });
		expect(resume.env.SECRET_TOKEN).toBeUndefined();
		expect(resume.env.PATH).toBeUndefined();
		const created = discordHostDaemonSpec(
			{ launchId, name: `haiso-n-${launchId}`, projectDir: "/work/project", model: "anthropic/claude-sonnet" },
			options,
		);
		expect(created.args).toEqual(["--model", "anthropic/claude-sonnet"]);
	});

	it("refuses options, whitespace, relative paths, foreign names, and non-UUID launch ids", () => {
		const base = { launchId, name: `haiso-n-${launchId}`, projectDir: "/work/project" };
		for (const spec of [
			{ ...base, model: "--x" },
			{ ...base, model: "-a/b" },
			{ ...base, model: "a/b c" },
			{ ...base, model: "anthropic/claude", sessionFile: "/work/s.jsonl" },
			{ ...base, name: "haiso-discord" },
			{ ...base, projectDir: "work/project" },
			{ ...base, sessionFile: "s.jsonl" },
			{ ...base, launchId: "not-a-launch" },
		])
			expect(() => discordHostDaemonSpec(spec, options)).toThrow("Invalid background copy specification");
	});
});
