import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DISCORD_MODE_READY } from "@oh-my-pi/pi-wire/discord-mode";
import { createHaisoServiceStarter, findHaisoInstall, type HaisoInstall } from "../src/service";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function temporary(): Promise<string> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-bridge-service-")));
	cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
	return root;
}

/** An installed-looking release behind a prefix link: `bin/haiso` plus the receipt naming it. */
async function install(prefix: string, owner = "haiso-release-installer"): Promise<string> {
	const release = path.join(path.dirname(prefix), `.${path.basename(prefix)}-release-x`);
	const binary = path.join(release, "bin", "haiso");
	await fs.mkdir(path.dirname(binary), { recursive: true });
	await fs.writeFile(binary, "#!/bin/sh\n", { mode: 0o700 });
	await fs.writeFile(path.join(release, "receipt.json"), JSON.stringify({ owner, executable: binary }), {
		mode: 0o600,
	});
	await fs.symlink(release, prefix);
	return binary;
}

function spawned(output: string, code: number) {
	const calls: Array<{ command: string[]; env: Record<string, string | undefined> }> = [];
	return {
		calls,
		spawn(command: string[], env: Record<string, string | undefined>) {
			calls.push({ command, env });
			return {
				stdout: new Response(output).body!,
				exited: Promise.resolve(code),
				kill() {},
			};
		},
	};
}

describe("Haiso service start from the OMP bridge", () => {
	test("finds the installed binary via HAISO_PREFIX or the default prefix, only when the receipt vouches for it", async () => {
		const root = await temporary();
		const prefix = path.join(root, "custom", "fork");
		await fs.mkdir(path.dirname(prefix), { recursive: true });
		const binary = await install(prefix);
		expect(await findHaisoInstall({ HAISO_PREFIX: prefix }, root)).toEqual({ binary, prefix });
		expect(await findHaisoInstall({}, root)).toBeUndefined();
		const home = path.join(root, "home");
		const standard = path.join(home, ".local", "share", "haiso", "fork");
		await fs.mkdir(path.dirname(standard), { recursive: true });
		const standardBinary = await install(standard);
		expect(await findHaisoInstall({}, home)).toEqual({ binary: standardBinary, prefix: standard });
		await fs.chmod(standardBinary, 0o720);
		expect(await findHaisoInstall({}, home)).toBeUndefined();
		const foreign = path.join(root, "foreign", "fork");
		await fs.mkdir(path.dirname(foreign), { recursive: true });
		await install(foreign, "someone-else");
		expect(await findHaisoInstall({ HAISO_PREFIX: foreign }, root)).toBeUndefined();
	});

	test("runs only the ensure selector, with the bridge root and prefix, and waits for readiness", async () => {
		const installed: HaisoInstall = { binary: "/opt/haiso/release/bin/haiso", prefix: "/opt/haiso/fork" };
		const child = spawned(`booting\n${DISCORD_MODE_READY}\n`, 0);
		const events: string[] = [];
		const previous = process.env.PI_COMPILED;
		process.env.PI_COMPILED = "true";
		try {
			const start = createHaisoServiceStarter({
				down: async () => true,
				find: async () => installed,
				spawn: (command, env) => {
					events.push("spawn");
					return child.spawn(command, env);
				},
			});
			const [first, second] = await Promise.all([
				start("/private/discord-mode", () => events.push("starting")),
				start("/private/discord-mode"),
			]);
			expect([first, second]).toEqual([true, true]);
		} finally {
			if (previous === undefined) delete process.env.PI_COMPILED;
			else process.env.PI_COMPILED = previous;
		}
		expect(events).toEqual(["starting", "spawn"]);
		expect(child.calls).toHaveLength(1);
		const [call] = child.calls;
		expect(call!.command).toEqual([installed.binary, "__omp_worker_discord_ensure"]);
		expect(call!.env).toMatchObject({
			HAISO_PREFIX: installed.prefix,
			OMP_DISCORD_MODE_ROOT: "/private/discord-mode",
		});
		expect(call!.env.PI_COMPILED).toBeUndefined();
	});

	test("never starts a live or uninstalled service, and pauses after a failed start", async () => {
		let now = 0;
		let down = false;
		let installed: HaisoInstall | undefined;
		const failing = spawned("", 1);
		const start = createHaisoServiceStarter({
			down: async () => down,
			find: async () => installed,
			spawn: failing.spawn,
			now: () => now,
		});
		expect(await start("/root")).toBe(false);
		down = true;
		expect(await start("/root")).toBe(false);
		expect(failing.calls).toHaveLength(0);
		installed = { binary: "/opt/haiso/bin/haiso", prefix: "/opt/haiso" };
		expect(await start("/root")).toBe(false);
		expect(failing.calls).toHaveLength(1);
		now = 5 * 60_000 - 1;
		expect(await start("/root")).toBe(false);
		expect(failing.calls).toHaveLength(1);
		now = 5 * 60_000;
		expect(await start("/root")).toBe(false);
		expect(failing.calls).toHaveLength(2);
	});
});
