import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readLines } from "@oh-my-pi/pi-utils/stream";
import {
	activateHaiso,
	currentHaisoRelease,
	installHaiso,
	type InstallOptions,
	readHaisoRelease,
	rollbackHaiso,
	stageHaiso,
} from "../packages/coding-agent/src/haiso-update/release";
import { parseInstallArgs } from "./install-haiso";

const temporaryDirectories: string[] = [];
let fixtureRoot: string;
let compiledFixture: string;
let brokerFixture: string;

async function removeFixture(directory: string): Promise<void> {
	// Only our private fixture directories are thawed; never follow the active-prefix symlink.
	await fs.chmod(directory, 0o700);
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) await removeFixture(path.join(directory, entry.name));
	}
	await fs.rm(directory, { recursive: true, force: true });
}

beforeAll(async () => {
	fixtureRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "haiso-compiled-fixture-")));
	const entrypoint = path.join(fixtureRoot, "fixture.ts");
	compiledFixture = path.join(fixtureRoot, "haiso");
	brokerFixture = path.join(fixtureRoot, "haiso-next-broker");
	await fs.writeFile(
		entrypoint,
		`import * as fs from "node:fs";
import * as path from "node:path";
const selector = process.argv[2];
const prefix = process.env.HAISO_PREFIX;
const controlFile = prefix && path.join(path.dirname(prefix), "smoke-control.json");
const control = controlFile && fs.existsSync(controlFile) ? JSON.parse(fs.readFileSync(controlFile, "utf8")) : {};
if (selector === "--version") console.log("haiso/18.3.0");
else if (selector === "__omp_worker_haiso_release_probe") console.log(JSON.stringify({
  bunVersion: control.wrongRuntime ? "0.0.0" : Bun.version,
  executable: process.execPath,
  compiled: import.meta.url.includes("$bunfs"),
  brokerNamespace: process.env.HAISO_DAEMON_NAMESPACE,
}));
else if (selector === "--smoke-test") {
  if (!process.env.HOME || !process.env.PI_CODING_AGENT_DIR?.startsWith(process.env.HOME + "/") ||
      !process.env.XDG_CONFIG_HOME?.startsWith(process.env.HOME + "/") ||
      process.cwd() !== process.env.HOME || process.env.HAISO_UPDATE_DISABLED !== "1" ||
      process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.SSH_AUTH_SOCK ||
      process.env.PI_PROFILE || process.env.BUN_BE_BUN || process.env.PI_COMPILED) process.exit(71);
  if (control.failSmoke) process.exit(72);
  if (control.denyPublication) fs.chmodSync(control.binDir, 0o500);
  if (control.raceLauncher) fs.writeFileSync(control.launcher, "concurrent-owner\\n");
  console.log("isolated smoke passed");
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
	for (const [binary, namespace] of [
		[compiledFixture, "2"],
		[brokerFixture, "4"],
	] as const) {
		await execute(
			[
				process.execPath,
				"build",
				"--compile",
				entrypoint,
				"--outfile",
				binary,
				"--define",
				`process.env.HAISO_DAEMON_NAMESPACE=${JSON.stringify(namespace.repeat(64))}`,
			],
			fixtureRoot,
		);
	}
}, 120_000);

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await removeFixture(directory);
});

afterAll(async () => {
	if (fixtureRoot) await removeFixture(fixtureRoot);
});

async function fixture(): Promise<{ root: string; options: InstallOptions; control: string }> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "haiso-install-' spaces-")));
	temporaryDirectories.push(root);
	const binary = path.join(root, "build output ' haiso");
	const runtime = path.join(root, "standalone bun");
	const forkPatch = path.join(root, "fork.patch");
	await fs.copyFile(compiledFixture, binary);
	await fs.copyFile(process.execPath, runtime);
	await fs.chmod(binary, 0o700);
	await fs.chmod(runtime, 0o700);
	await fs.writeFile(forkPatch, "frozen fork patch\n", { mode: 0o600 });
	const prefix = path.join(root, "install ' root", "fork");
	return {
		root,
		control: path.join(path.dirname(prefix), "smoke-control.json"),
		options: {
			binary,
			runtime,
			forkPatch,
			upstream: { tag: "v18.3.0", commit: "62bc57be1b03ef0802a33cf7f5f530e534527531" },
			compatibility: { state: "1".repeat(64), broker: "2".repeat(64) },
			prefix,
			binDir: path.join(root, "bin ' directory"),
		},
	};
}

async function execute(command: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const child = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`Command exited ${code}: ${stderr}`);
	return stdout.trim();
}

describe("Haiso compiled releases", () => {
	it("freezes the build, patch and standalone runtime while preserving exact arguments and caller cwd", async () => {
		const { root, options } = await fixture();
		const caller = path.join(root, "caller project");
		await fs.mkdir(caller);
		const receipt = await installHaiso(options);
		await fs.writeFile(options.binary, "replaced build output\n");
		await fs.writeFile(options.runtime, "replaced build runtime\n");
		await fs.writeFile(options.forkPatch, "changed source patch\n");
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
		expect(await fs.readFile(receipt.forkPatch, "utf8")).toBe("frozen fork patch\n");
		expect((await readHaisoRelease(receipt.release)).executableSha256).toBe(receipt.executableSha256);
		expect((await fs.lstat(receipt.executable)).mode & 0o222).toBe(0);
	}, 120_000);

	it("keeps running processes and their later workers pinned while new launches switch atomically", async () => {
		const { root, options } = await fixture();
		const first = await installHaiso(options);
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
			const second = await installHaiso(options);
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

	it("rolls back only to a retained compatible release and leaves official omp untouched", async () => {
		const { root, options } = await fixture();
		await fs.mkdir(options.binDir!, { recursive: true });
		const omp = path.join(options.binDir!, "omp");
		await fs.writeFile(omp, "official omp\n");
		const first = await installHaiso(options);
		const second = await installHaiso(options);
		expect((await rollbackHaiso({ prefix: options.prefix })).release).toBe(first.release);
		expect(JSON.parse(await execute([first.launcher], root)).executable).toBe(first.executable);
		expect(await execute([second.executable, "--version"], root)).toBe("haiso/18.3.0");
		expect(await fs.readFile(omp, "utf8")).toBe("official omp\n");
	}, 120_000);

	it("requires explicit review for state and broker drift in both activation and rollback", async () => {
		const { options } = await fixture();
		const first = await installHaiso(options);
		const second = await stageHaiso({
			...options,
			compatibility: { ...options.compatibility, state: "3".repeat(64) },
		});
		await expect(activateHaiso(second.release, { expectedCurrent: first.release })).rejects.toThrow(
			"reviewed activation",
		);
		expect((await currentHaisoRelease(options.prefix))?.release).toBe(first.release);
		await activateHaiso(second.release, { expectedCurrent: first.release, reviewed: true });
		await expect(rollbackHaiso({ prefix: options.prefix })).rejects.toThrow("reviewed activation");
		await rollbackHaiso({ prefix: options.prefix, reviewed: true });
		const brokerChange = await stageHaiso({
			...options,
			binary: brokerFixture,
			compatibility: { ...options.compatibility, broker: "4".repeat(64) },
		});
		await expect(activateHaiso(brokerChange.release, {})).rejects.toThrow("reviewed activation");
	}, 120_000);

	it("rejects stale activation even when the caller authorizes compatibility review", async () => {
		const { options } = await fixture();
		const first = await installHaiso(options);
		const stale = await stageHaiso(options);
		const current = await installHaiso(options);
		await expect(activateHaiso(stale.release, { expectedCurrent: first.release, reviewed: true })).rejects.toThrow(
			"active-release drift",
		);
		await expect(activateHaiso(stale.release, {})).rejects.toThrow("active-release drift");
		expect((await currentHaisoRelease(options.prefix))?.release).toBe(current.release);
	}, 120_000);

	it("rejects receipt and retained artifact tampering without replacing the launchable release", async () => {
		const { root, options } = await fixture();
		const first = await installHaiso(options);
		const candidate = await stageHaiso(options);
		const receiptPath = path.join(candidate.release, "receipt.json");
		await fs.chmod(receiptPath, 0o600);
		await fs.writeFile(
			receiptPath,
			JSON.stringify({ ...candidate, compatibility: { ...candidate.compatibility, state: "0".repeat(64) } }),
		);
		await fs.chmod(receiptPath, 0o400);
		await expect(activateHaiso(candidate.release, {})).rejects.toThrow("Tampered install receipt");
		const changedPatch = await stageHaiso(options);
		await fs.chmod(changedPatch.forkPatch, 0o600);
		await fs.writeFile(changedPatch.forkPatch, "substituted patch\n");
		await fs.chmod(changedPatch.forkPatch, 0o400);
		await expect(activateHaiso(changedPatch.release, {})).rejects.toThrow("hash mismatch");
		const changedBinary = await stageHaiso(options);
		await fs.chmod(changedBinary.executable, 0o700);
		await fs.appendFile(changedBinary.executable, "tampered executable");
		await fs.chmod(changedBinary.executable, 0o500);
		await expect(activateHaiso(changedBinary.release, {})).rejects.toThrow("hash mismatch");
		const changedRuntime = await stageHaiso(options);
		await fs.chmod(changedRuntime.runtime.installedPath, 0o700);
		await fs.appendFile(changedRuntime.runtime.installedPath, "tampered runtime");
		await fs.chmod(changedRuntime.runtime.installedPath, 0o500);
		await expect(activateHaiso(changedRuntime.release, {})).rejects.toThrow("hash mismatch");
		expect(JSON.parse(await execute([first.launcher], root)).executable).toBe(first.executable);
	}, 120_000);

	it("rejects executable symlink substitution and symlink/writable installation boundaries", async () => {
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
		const first = await installHaiso(options);
		const candidate = await stageHaiso(options);
		await fs.chmod(path.dirname(candidate.executable), 0o700);
		await fs.unlink(candidate.executable);
		await fs.symlink(first.executable, candidate.executable);
		await fs.chmod(path.dirname(candidate.executable), 0o500);
		await expect(activateHaiso(candidate.release, {})).rejects.toThrow("Unsafe or mutable release file");
		expect((await currentHaisoRelease(options.prefix))?.release).toBe(first.release);
	}, 120_000);

	it("rejects shell runtimes, mismatched embedded Bun, bad pins and failed isolated smoke without publication", async () => {
		const { root, options, control } = await fixture();
		const fakeRuntime = path.join(root, "fake-bun");
		await fs.writeFile(fakeRuntime, "#!/bin/sh\nprintf '1.4.2\\n'\n", { mode: 0o700 });
		await expect(installHaiso({ ...options, runtime: fakeRuntime })).rejects.toThrow("not a native binary");
		await expect(stageHaiso({ ...options, runtime: options.binary })).rejects.toThrow("Unexpected Bun --version");
		await expect(stageHaiso({ ...options, upstream: { ...options.upstream, tag: "v18.3.1" } })).rejects.toThrow(
			"Compiled Haiso validation expected haiso/18.3.1",
		);
		await expect(
			stageHaiso({ ...options, compatibility: { ...options.compatibility, broker: "4".repeat(64) } }),
		).rejects.toThrow("pinned broker namespace");
		await expect(stageHaiso({ ...options, upstream: { ...options.upstream, commit: "main" } })).rejects.toThrow(
			"full commit",
		);
		await fs.mkdir(path.dirname(options.prefix!), { recursive: true });
		await fs.writeFile(control, JSON.stringify({ wrongRuntime: true }));
		await expect(installHaiso(options)).rejects.toThrow("supplied standalone Bun version");
		await fs.writeFile(control, JSON.stringify({ failSmoke: true }));
		await expect(installHaiso(options)).rejects.toThrow();
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
		await expect(installHaiso(options)).rejects.toThrow("--replace-legacy");
		expect(await execute([launcher], root)).toBe("mutable legacy");
		const release = await installHaiso({ ...options, replaceLegacy: true });
		expect(release.previousRelease).toBeNull();
		await expect(rollbackHaiso({ prefix: options.prefix })).rejects.toThrow("mutable v1");
		await expect(activateHaiso(legacy, { expectedCurrent: release.release, reviewed: true })).rejects.toThrow(
			"Unsafe or mutable release directory",
		);
		expect(await execute([legacyLauncher], root)).toBe("mutable legacy");
		expect(await execute([launcher, "--version"], root)).toBe("haiso/18.3.0");
	}, 120_000);

	it.skipIf(process.getuid?.() === 0)(
		"restores the old root when the first stable-launcher publication fails",
		async () => {
			const { root, options, control } = await fixture();
			const first = await installHaiso(options);
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
		await expect(installHaiso(options)).rejects.toThrow("Path changed during installation");
		expect(await fs.readFile(launcher, "utf8")).toBe("concurrent-owner\n");
		await expect(fs.lstat(options.prefix!)).rejects.toHaveProperty("code", "ENOENT");
	}, 120_000);

	it("runs the standalone CLI with explicit release inputs and leaves official omp untouched", async () => {
		const { root, options } = await fixture();
		await fs.mkdir(options.binDir!, { recursive: true });
		const omp = path.join(options.binDir!, "omp");
		await fs.writeFile(omp, "official omp\n");
		await execute(
			[
				process.execPath,
				path.join(import.meta.dir, "install-haiso.ts"),
				"--binary",
				options.binary,
				"--runtime",
				options.runtime,
				"--fork-patch",
				options.forkPatch,
				"--upstream-tag",
				options.upstream.tag,
				"--upstream-commit",
				options.upstream.commit,
				"--state-fingerprint",
				options.compatibility.state,
				"--broker-fingerprint",
				options.compatibility.broker,
				"--prefix",
				options.prefix!,
				"--bin-dir",
				options.binDir!,
			],
			root,
			{ ...process.env, OPENAI_API_KEY: "never-forward-this-synthetic-secret", PI_PROFILE: "private-fixture" },
		);
		expect(await execute([path.join(options.binDir!, "haiso"), "--version"], root)).toBe("haiso/18.3.0");
		expect(await fs.readFile(omp, "utf8")).toBe("official omp\n");
	}, 120_000);
});

it("rejects missing, duplicate, ambiguous and obsolete source installer arguments", () => {
	expect(() => parseInstallArgs([])).toThrow("--binary is required");
	expect(() => parseInstallArgs(["--runtime", "--source"])).toThrow("requires a value");
	expect(() => parseInstallArgs(["--source", "/checkout"])).toThrow("Unknown option");
	expect(() => parseInstallArgs(["--binary", "one", "--binary", "two"])).toThrow("Duplicate option");
	expect(() => parseInstallArgs(["--unknown"])).toThrow("Unknown option");
	expect(() => parseInstallArgs(["--help", "--unknown"])).toThrow("Unknown option");
	expect(parseInstallArgs(["--help"])).toBeNull();
});
