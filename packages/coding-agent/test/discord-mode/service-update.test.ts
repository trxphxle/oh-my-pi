import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir, VERSION } from "@oh-my-pi/pi-utils";
import { sessionCommandGuide } from "../../src/discord-mode/discord";
import { DISCORD_GUIDE_MAX_LENGTH, discordGuideWhatsNew, renderDiscordGuide } from "../../src/discord-mode/guide";
import {
	DISCORD_SWITCH_RETRY_MS,
	DISCORD_SWITCH_WAIT_MS,
	DiscordServiceSwitchover,
	discordServiceUpdateReady,
	readDiscordServiceRelease,
} from "../../src/discord-mode/switchover";

function switchover(options: { target: string | undefined; keepOnline?: boolean; quiet?: boolean[] }) {
	let now = 0;
	const state = { target: options.target, keepOnline: options.keepOnline ?? true };
	const quiet = [...(options.quiet ?? [])];
	const broker = { stopIfQuiescent: vi.fn(async () => quiet.shift() ?? false) };
	const switched = vi.fn();
	const watcher = new DiscordServiceSwitchover({
		running: "/releases/current",
		target: () => state.target,
		keepOnline: async () => state.keepOnline,
		broker,
		switched,
		now: () => now,
	});
	return {
		watcher,
		broker,
		switched,
		state,
		at(time: number) {
			now = time;
		},
	};
}

/** A sealed-looking release: `bin/haiso` plus the receipt fields the service reads. */
async function release(root: string, name: string, commit = "a".repeat(40)): Promise<string> {
	const directory = path.join(root, name);
	await fs.mkdir(path.join(directory, "bin"), { recursive: true });
	const binary = path.join(directory, "bin", "haiso");
	await fs.writeFile(binary, "#!/bin/sh\n", { mode: 0o700 });
	await fs.writeFile(
		path.join(directory, "receipt.json"),
		JSON.stringify({ owner: "haiso-release-installer", release: directory, executable: binary, source: { commit } }),
	);
	return directory;
}

describe("Discord service switchover", () => {
	it("hands over only after the prefix moved to another release and the broker stopped while quiet", async () => {
		const s = switchover({ target: "/releases/current", quiet: [false, false, true] });
		expect(await s.watcher.tick()).toBe("current");
		s.state.target = "/releases/next";
		s.state.keepOnline = false;
		expect(await s.watcher.tick()).toBe("deferred");
		expect(s.broker.stopIfQuiescent).not.toHaveBeenCalled();
		s.state.keepOnline = true;
		expect(await s.watcher.tick()).toBe("waiting");
		expect(await s.watcher.tick()).toBe("waiting");
		expect(s.switched).not.toHaveBeenCalled();
		expect(await s.watcher.tick()).toBe("switched");
		expect(await s.watcher.tick()).toBe("switched");
		expect(s.switched).toHaveBeenCalledTimes(1);
		expect(s.broker.stopIfQuiescent).toHaveBeenCalledTimes(3);
	});

	it("pauses a wait that stays busy, resumes it later, and forgets it when the prefix moves back", async () => {
		const s = switchover({ target: "/releases/next" });
		expect(await s.watcher.tick()).toBe("waiting");
		s.at(DISCORD_SWITCH_WAIT_MS - 1);
		expect(await s.watcher.tick()).toBe("waiting");
		s.at(DISCORD_SWITCH_WAIT_MS);
		expect(await s.watcher.tick()).toBe("paused");
		s.at(DISCORD_SWITCH_WAIT_MS + DISCORD_SWITCH_RETRY_MS - 1);
		expect(await s.watcher.tick()).toBe("paused");
		expect(s.broker.stopIfQuiescent).toHaveBeenCalledTimes(2);
		s.at(DISCORD_SWITCH_WAIT_MS + DISCORD_SWITCH_RETRY_MS);
		expect(await s.watcher.tick()).toBe("waiting");
		// A fresh wait window started with the resumed attempt.
		s.at(2 * DISCORD_SWITCH_WAIT_MS + DISCORD_SWITCH_RETRY_MS - 1);
		expect(await s.watcher.tick()).toBe("waiting");
		s.state.target = "/releases/current";
		expect(await s.watcher.tick()).toBe("current");
		s.state.target = "/releases/next";
		expect(await s.watcher.tick()).toBe("waiting");
		expect(s.switched).not.toHaveBeenCalled();
	});

	it("reads its version, commit, and release from the installer receipt, and spots a moved prefix", async () => {
		using temporary = TempDir.createSync("@discord-service-release-");
		const root = await fs.realpath(temporary.path());
		const current = await release(root, ".fork-release-one", "b".repeat(40));
		const next = await release(root, ".fork-release-two");
		expect(readDiscordServiceRelease(path.join(current, "bin", "haiso"))).toEqual({
			info: { version: VERSION, commit: "b".repeat(12), release: current },
			release: current,
		});
		// Development runs and foreign binaries report the version alone.
		expect(readDiscordServiceRelease(process.execPath)).toEqual({ info: { version: VERSION } });
		const prefix = path.join(root, "fork");
		await fs.symlink(current, prefix);
		// Through the prefix link the running binary still resolves to its own release.
		expect(readDiscordServiceRelease(path.join(prefix, "bin", "haiso")).release).toBe(current);
		const service = readDiscordServiceRelease(path.join(current, "bin", "haiso")).info;
		expect(discordServiceUpdateReady(service, prefix)).toBe(false);
		await fs.unlink(prefix);
		await fs.symlink(next, prefix);
		expect(discordServiceUpdateReady(service, prefix)).toBe(true);
		expect(discordServiceUpdateReady({ version: VERSION }, prefix)).toBe(false);
		expect(discordServiceUpdateReady(service, undefined)).toBe(false);
	});
});

describe("Discord pinned guide", () => {
	it("renders the registered /session subcommands into one Discord message", () => {
		const commands = sessionCommandGuide();
		const guide = renderDiscordGuide(commands);
		expect(guide.text.length).toBeLessThanOrEqual(DISCORD_GUIDE_MAX_LENGTH);
		expect(guide.text.split("\n", 1)[0]).toBe("**Haiso — Discord guide**");
		expect(guide.commands).toEqual(commands.map(command => command.name));
		for (const command of commands) expect(guide.text).toContain(`\`/session ${command.name}`);
		expect(guide.text).toContain("`/session notify all|needs-you|off`");
		expect(guide.sections).toContain("In a session channel");
		expect(guide.text).not.toContain("{{commands}}");
	});

	it("names only additions in the what's-new note", () => {
		const guide = renderDiscordGuide(
			[
				{ name: "status", description: "Show it", choices: [] },
				{ name: "resume", description: "Resume it", choices: [] },
			],
			"**Haiso — Discord guide**\n**Channels**\n{{commands}}\n**Sessions**\nMore.",
		);
		expect(discordGuideWhatsNew({ commands: ["status"], sections: ["Channels"] }, guide)).toBe(
			"Haiso updated · new: `/session resume`, Sessions",
		);
		expect(discordGuideWhatsNew({ commands: guide.commands, sections: guide.sections }, guide)).toBe(
			"Haiso updated · the pinned guide was revised",
		);
		expect(() =>
			renderDiscordGuide([], `**Haiso — Discord guide**\n${"x".repeat(DISCORD_GUIDE_MAX_LENGTH)}`),
		).toThrow("exceeds one message");
	});
});
