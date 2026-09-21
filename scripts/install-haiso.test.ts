import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { installHaiso, type InstallOptions, parseInstallArgs } from "./install-haiso";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

async function fixture(): Promise<{ root: string; source: string; entrypoint: string; options: InstallOptions }> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "haiso-install-' spaces-")));
	temporaryDirectories.push(root);
	const source = path.join(root, "source ' checkout");
	const entrypoint = path.join(source, "packages/coding-agent/src/cli.ts");
	await fs.mkdir(path.dirname(entrypoint), { recursive: true });
	await fs.writeFile(
		entrypoint,
		`if (process.argv[2] === "--version") console.log("haiso/18.2.6");
else console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), runtime: process.execPath, bunBeBun: process.env.BUN_BE_BUN ?? null, compiled: process.env.PI_COMPILED ?? null }));\n`,
	);
	return {
		root,
		source,
		entrypoint,
		options: {
			runtime: process.execPath,
			source,
			prefix: path.join(root, "install ' root", "fork"),
			binDir: path.join(root, "bin ' directory"),
		},
	};
}

async function execute(
	command: string[],
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; stdout: string }> {
	const child = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`Launcher exited ${code}: ${stderr}`);
	return { code, stdout: stdout.trim() };
}

describe("Haiso source installer", () => {
	it("launches with independent Bun, exact arguments and caller cwd through quoted paths", async () => {
		const { root, options } = await fixture();
		const caller = path.join(root, "caller project");
		await fs.mkdir(caller);
		const receipt = await installHaiso(options);
		const args = ["with spaces", "quote'\"", "", "$HOME", "--dash"];
		const result = await execute([receipt.launcher, ...args], caller, {
			...process.env,
			BUN_BE_BUN: "1",
			PI_COMPILED: "1",
		});
		expect(JSON.parse(result.stdout)).toEqual({
			cwd: caller,
			args,
			runtime: receipt.runtime.installedPath,
			bunBeBun: null,
			compiled: null,
		});
		expect((await fs.lstat(receipt.runtime.installedPath)).mode & 0o777).toBe(0o755);
		expect(await fs.readlink(receipt.prefix)).toBe(receipt.release);
		expect((await execute([receipt.launcher, "--version"], caller)).stdout).toBe("haiso/18.2.6");
		expect(JSON.parse(await fs.readFile(path.join(receipt.prefix, "receipt.json"), "utf8"))).toEqual(receipt);
	});

	it("requires explicit replacement and preserves the previous file when source validation fails", async () => {
		const { root, entrypoint, options } = await fixture();
		await fs.mkdir(options.binDir!, { recursive: true });
		const launcher = path.join(options.binDir!, "haiso");
		const original = "#!/bin/sh\nprintf 'legacy-0.2.0\\n'\n";
		await fs.writeFile(launcher, original, { mode: 0o755 });
		await expect(installHaiso(options)).rejects.toThrow("--replace-legacy");
		await fs.writeFile(entrypoint, 'console.log("omp/18.2.6");\n');
		await expect(installHaiso({ ...options, replaceLegacy: true })).rejects.toThrow("Source validation expected");
		expect(await fs.readFile(launcher, "utf8")).toBe(original);
		expect((await execute([launcher], root)).stdout).toBe("legacy-0.2.0");
		await expect(fs.lstat(options.prefix!)).rejects.toHaveProperty("code", "ENOENT");
	});

	it("replaces the legacy launcher without retaining a copy, leaving unrelated application data and omp untouched", async () => {
		const { root, options } = await fixture();
		await fs.mkdir(options.binDir!, { recursive: true });
		const legacy = path.join(root, "application", "active", "bin", "haiso");
		await fs.mkdir(path.dirname(legacy), { recursive: true });
		await fs.writeFile(legacy, "#!/bin/sh\nprintf 'old-app\\n'\n", { mode: 0o755 });
		const omp = path.join(options.binDir!, "omp");
		await fs.writeFile(omp, "official-omp-untouched\n");
		const data = path.join(root, "legacy-data");
		await fs.writeFile(data, "private-user-state\n");
		const launcher = path.join(options.binDir!, "haiso");
		const target = path.relative(options.binDir!, legacy);
		await fs.symlink(target, launcher);
		const receipt = await installHaiso({ ...options, replaceLegacy: true });
		expect((await execute([launcher, "--version"], root)).stdout).toBe("haiso/18.2.6");
		expect((await execute([legacy], root)).stdout).toBe("old-app");
		expect(await fs.readFile(omp, "utf8")).toBe("official-omp-untouched\n");
		expect(await fs.readFile(data, "utf8")).toBe("private-user-state\n");
		await expect(fs.lstat(path.join(receipt.release, "previous-launcher"))).rejects.toHaveProperty("code", "ENOENT");
	});

	it("keeps the old release launchable until explicit verified reinstall and retains a rollback target", async () => {
		const { root, options } = await fixture();
		const first = await installHaiso(options);
		await expect(installHaiso(options)).rejects.toThrow("--replace-legacy");
		const second = await installHaiso({ ...options, replaceLegacy: true });
		expect(second.previousRelease).toBe(first.release);
		expect((await execute([path.join(first.release, "bin", "haiso"), "--version"], root)).stdout).toBe(
			"haiso/18.2.6",
		);
		expect(await fs.readlink(second.launcher)).toBe(path.join(second.release, "bin", "haiso"));
	});

	it("rejects shell runtime impostors without changing an existing launcher", async () => {
		const { root, options } = await fixture();
		const runtime = path.join(root, "fake-bun");
		await fs.writeFile(runtime, "#!/bin/sh\nprintf '1.4.2\\n'\n", { mode: 0o755 });
		await fs.mkdir(options.binDir!, { recursive: true });
		const launcher = path.join(options.binDir!, "haiso");
		await fs.symlink("missing-legacy-target", launcher);
		await expect(installHaiso({ ...options, runtime, replaceLegacy: true })).rejects.toThrow("not a native binary");
		expect(await fs.readlink(launcher)).toBe("missing-legacy-target");
	});

	it("refuses symlink parents, unknown root symlinks and group-writable install parents", async () => {
		const { root, options } = await fixture();
		const actual = path.join(root, "actual");
		await fs.mkdir(actual);
		const parentLink = path.join(root, "linked-parent");
		await fs.symlink(actual, parentLink);
		await expect(installHaiso({ ...options, prefix: path.join(parentLink, "fork") })).rejects.toThrow(
			"symlink directory",
		);
		await fs.mkdir(path.dirname(options.prefix!), { recursive: true });
		await fs.symlink(actual, options.prefix!);
		await expect(installHaiso(options)).rejects.toThrow("unrecognized install root target");
		await fs.chmod(actual, 0o770);
		await expect(installHaiso({ ...options, prefix: path.join(actual, "fork") })).rejects.toThrow(
			"writable by other users",
		);
	});

	it.skipIf(process.getuid?.() === 0)("rolls back the root if final launcher publication fails", async () => {
		const { root, entrypoint, options } = await fixture();
		const first = await installHaiso(options);
		const countFile = path.join(root, "validation-count");
		await fs.writeFile(countFile, "0");
		await fs.writeFile(
			entrypoint,
			`import { chmodSync, readFileSync, writeFileSync } from "node:fs";
const count = Number(readFileSync(${JSON.stringify(countFile)}, "utf8")) + 1;
writeFileSync(${JSON.stringify(countFile)}, String(count));
if (count === 2) chmodSync(${JSON.stringify(options.binDir)}, 0o500);
console.log("haiso/18.2.6");\n`,
		);
		try {
			await expect(installHaiso({ ...options, replaceLegacy: true })).rejects.toHaveProperty("code", "EACCES");
			expect(await fs.readlink(first.prefix)).toBe(first.release);
			expect(await fs.readlink(first.launcher)).toBe(path.join(first.release, "bin", "haiso"));
		} finally {
			await fs.chmod(options.binDir!, 0o700);
		}
	});

	it("does not overwrite a launcher created during staged validation", async () => {
		const { entrypoint, options } = await fixture();
		const launcher = path.join(options.binDir!, "haiso");
		await fs.writeFile(
			entrypoint,
			`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(launcher)}, "concurrent-owner\\n");
console.log("haiso/18.2.6");\n`,
		);
		await expect(installHaiso(options)).rejects.toThrow("Path changed during installation");
		expect(await fs.readFile(launcher, "utf8")).toBe("concurrent-owner\n");
		await expect(fs.lstat(options.prefix!)).rejects.toHaveProperty("code", "ENOENT");
	});
});

it("requires an explicit runtime and rejects ambiguous installer arguments", () => {
	expect(() => parseInstallArgs([])).toThrow("--runtime is required");
	expect(() => parseInstallArgs(["--runtime", "--source"])).toThrow("requires a path");
	expect(() => parseInstallArgs(["--runtime", "bun", "--runtime", "other"])).toThrow("Duplicate option");
	expect(() => parseInstallArgs(["--runtime", "bun", "--unknown"])).toThrow("Unknown option");
	expect(parseInstallArgs(["--help"])).toBeNull();
});
