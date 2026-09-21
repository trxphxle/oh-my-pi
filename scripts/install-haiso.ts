#!/usr/bin/env bun
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { quotePosixPath } from "../packages/coding-agent/src/ssh/utils";
import { version as upstreamVersion } from "../packages/utils/package.json" with { type: "json" };

const OWNER = "haiso-source-installer";
const SOURCE_VERSION = `haiso/${upstreamVersion}`;

export interface InstallOptions {
	runtime: string;
	source?: string;
	prefix?: string;
	binDir?: string;
	replaceLegacy?: boolean;
}

export interface InstallReceipt {
	schemaVersion: 1;
	owner: typeof OWNER;
	installedAt: string;
	source: string;
	entrypoint: string;
	version: string;
	prefix: string;
	launcher: string;
	release: string;
	runtime: { suppliedPath: string; installedPath: string; version: string };
	previousRelease: string | null;
}

async function inspect(file: string): Promise<fs.Stats | undefined> {
	try {
		return await fs.promises.lstat(file);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function assertOwner(file: string, info: fs.Stats): void {
	if (info.uid !== process.getuid?.()) throw new Error(`Refusing path not owned by this user: ${file}`);
}

// Reject writable or user-controlled symlink ancestors; permit macOS's root-owned /var and /tmp aliases.
async function safeDirectory(directory: string, create: boolean): Promise<string> {
	const parent = path.dirname(directory);
	if (parent === directory) return directory;
	const safeParent = await safeDirectory(parent, create);
	const candidate = path.join(safeParent, path.basename(directory));
	let info = await inspect(candidate);
	if (!info && create) {
		await fs.promises.mkdir(candidate, { mode: 0o700 });
		info = await fs.promises.lstat(candidate);
	}
	if (!info) throw new Error(`Directory does not exist: ${candidate}`);
	if (info.isSymbolicLink()) {
		const parentInfo = await fs.promises.lstat(safeParent);
		if (info.uid !== 0 || parentInfo.uid !== 0 || (parentInfo.mode & 0o022) !== 0) {
			throw new Error(`Refusing symlink directory: ${candidate}`);
		}
		return safeDirectory(await fs.promises.realpath(candidate), false);
	}
	if (!info.isDirectory()) throw new Error(`Not a directory: ${candidate}`);
	if (info.uid !== 0 && info.uid !== process.getuid?.()) throw new Error(`Untrusted directory owner: ${candidate}`);
	if ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000) !== 0)) {
		throw new Error(`Directory is writable by other users; fix permissions first: ${candidate}`);
	}
	return candidate;
}

async function ownedParent(directory: string): Promise<string> {
	const canonical = await safeDirectory(path.resolve(directory), true);
	const info = await fs.promises.lstat(canonical);
	assertOwner(canonical, info);
	if ((info.mode & 0o022) !== 0) throw new Error(`Install parent must not be writable by others: ${canonical}`);
	return canonical;
}

async function fingerprint(file: string): Promise<string | null> {
	const info = await inspect(file);
	if (!info) return null;
	return JSON.stringify([
		info.dev,
		info.ino,
		info.mode,
		info.size,
		info.mtimeMs,
		info.ctimeMs,
		info.isSymbolicLink() ? await fs.promises.readlink(file) : null,
	]);
}

async function unchanged(file: string, expected: string | null): Promise<void> {
	if ((await fingerprint(file)) !== expected)
		throw new Error(`Path changed during installation; refusing to overwrite: ${file}`);
}

async function probe(command: string[], cwd: string): Promise<string> {
	const env = { ...process.env };
	delete env.BUN_BE_BUN;
	delete env.PI_COMPILED;
	const child = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== 0) throw new Error(`Validation failed (${code}): ${command.join(" ")}\n${stderr.trim()}`);
		return stdout.trim();
	} finally {
		clearTimeout(timer);
	}
}

async function assertNativeRuntime(runtime: string): Promise<void> {
	const info = await fs.promises.lstat(runtime);
	if (!info.isFile() || (info.mode & 0o111) === 0)
		throw new Error(`--runtime must name an executable standalone Bun binary: ${runtime}`);
	const file = await fs.promises.open(runtime, "r");
	try {
		const header = Buffer.alloc(4);
		await file.read(header, 0, 4, 0);
		if (
			!["7f454c46", "cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", "bebafeca"].includes(
				header.toString("hex"),
			)
		) {
			throw new Error(`--runtime is not a native binary (shell wrappers and omp are not supported): ${runtime}`);
		}
	} finally {
		await file.close();
	}
}

async function ownedRelease(prefix: string): Promise<string | null> {
	const info = await inspect(prefix);
	if (!info) return null;
	assertOwner(prefix, info);
	if (!info.isSymbolicLink())
		throw new Error(`Install root already exists and is not an installer-owned symlink: ${prefix}`);
	const target = path.resolve(path.dirname(prefix), await fs.promises.readlink(prefix));
	if (
		path.dirname(target) !== path.dirname(prefix) ||
		!path.basename(target).startsWith(`.${path.basename(prefix)}-release-`)
	) {
		throw new Error(`Refusing unrecognized install root target: ${target}`);
	}
	const targetInfo = await fs.promises.lstat(target);
	assertOwner(target, targetInfo);
	if (!targetInfo.isDirectory() || (targetInfo.mode & 0o022) !== 0)
		throw new Error(`Unsafe release directory: ${target}`);
	const receiptPath = path.join(target, "receipt.json");
	const receiptInfo = await fs.promises.lstat(receiptPath);
	assertOwner(receiptPath, receiptInfo);
	if (!receiptInfo.isFile()) throw new Error(`Not a regular install receipt: ${receiptPath}`);
	const receipt: unknown = JSON.parse(await fs.promises.readFile(receiptPath, "utf8"));
	if (
		typeof receipt !== "object" ||
		receipt === null ||
		!("owner" in receipt) ||
		receipt.owner !== OWNER ||
		!("prefix" in receipt) ||
		receipt.prefix !== prefix ||
		!("release" in receipt) ||
		receipt.release !== target
	) {
		throw new Error(`Install root has no matching ownership receipt: ${prefix}`);
	}
	return target;
}

export async function installHaiso(options: InstallOptions): Promise<InstallReceipt> {
	if (process.platform === "win32" || !process.getuid) throw new Error("This installer requires macOS or Linux.");
	if (!options.runtime)
		throw new Error("--runtime is required; supply a separately staged standalone Bun executable.");
	const source = await fs.promises.realpath(path.resolve(options.source ?? path.join(import.meta.dir, "..")));
	const entrypoint = path.join(source, "packages/coding-agent/src/cli.ts");
	if (!(await fs.promises.lstat(entrypoint)).isFile())
		throw new Error(`Source entrypoint is not a regular file: ${entrypoint}`);
	const suppliedRuntime = await fs.promises.realpath(path.resolve(options.runtime));
	await assertNativeRuntime(suppliedRuntime);
	const requestedPrefix = path.resolve(options.prefix ?? path.join(os.homedir(), ".local/share/haiso/fork"));
	const parent = await ownedParent(path.dirname(requestedPrefix));
	const prefix = path.join(parent, path.basename(requestedPrefix));
	const binDir = await ownedParent(options.binDir ?? path.join(os.homedir(), ".local/bin"));
	const launcher = path.join(binDir, "haiso");
	if (prefix === launcher || binDir === prefix || binDir.startsWith(`${prefix}${path.sep}`))
		throw new Error("--bin-dir must be outside --prefix.");
	const lock = path.join(parent, `.${path.basename(prefix)}-install.lock`);
	try {
		await fs.promises.mkdir(lock, { mode: 0o700 });
	} catch (error) {
		throw new Error(
			`Cannot acquire install lock ${lock}; another install may be running. Remove only a stale lock after checking.`,
			{ cause: error },
		);
	}
	let stage: string | undefined;
	let linkStage: string | undefined;
	let prefixSwitched = false;
	let published = false;
	let previousRelease: string | null = null;
	try {
		previousRelease = await ownedRelease(prefix);
		const prefixBefore = await fingerprint(prefix);
		const launcherInfo = await inspect(launcher);
		if (launcherInfo) {
			assertOwner(launcher, launcherInfo);
			if (!launcherInfo.isFile() && !launcherInfo.isSymbolicLink())
				throw new Error(`Refusing non-file launcher: ${launcher}`);
			if (!options.replaceLegacy)
				throw new Error(
					`${launcher} already exists. Use --replace-legacy to authorize replacement (including reinstall).`,
				);
		}
		const launcherBefore = await fingerprint(launcher);
		stage = await fs.promises.mkdtemp(path.join(parent, `.${path.basename(prefix)}-release-`));
		await fs.promises.chmod(stage, 0o700);
		const runtimeDir = path.join(stage, "runtime");
		const wrapperDir = path.join(stage, "bin");
		await fs.promises.mkdir(runtimeDir, { mode: 0o700 });
		await fs.promises.mkdir(wrapperDir, { mode: 0o700 });
		const runtime = path.join(runtimeDir, "bun");
		await fs.promises.copyFile(suppliedRuntime, runtime, fs.constants.COPYFILE_EXCL);
		await fs.promises.chmod(runtime, 0o755);
		const runtimeVersion = await probe([runtime, "--version"], stage);
		if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(runtimeVersion))
			throw new Error(`Unexpected Bun --version output: ${runtimeVersion}`);
		const marker = `haiso-runtime-${crypto.randomUUID()}`;
		const runtimeProof = await probe(
			[runtime, "-e", `console.log(${JSON.stringify(marker)} + ":" + Bun.version)`],
			stage,
		);
		if (runtimeProof !== `${marker}:${runtimeVersion}`)
			throw new Error(
				"Runtime cannot evaluate Bun source independently; supply standalone Bun, not a compiled application.",
			);
		const wrapper = path.join(wrapperDir, "haiso");
		await fs.promises.writeFile(
			wrapper,
			`#!/bin/sh\nunset BUN_BE_BUN PI_COMPILED\nexec ${quotePosixPath(runtime)} ${quotePosixPath(entrypoint)} "$@"\n`,
			{ mode: 0o755, flag: "wx" },
		);
		const version = await probe([wrapper, "--version"], stage);
		if (version !== SOURCE_VERSION)
			throw new Error(
				`Source validation expected ${SOURCE_VERSION}, got ${JSON.stringify(version)}. Check source branding and dependencies.`,
			);
		await unchanged(launcher, launcherBefore);
		const receipt: InstallReceipt = {
			schemaVersion: 1,
			owner: OWNER,
			installedAt: new Date().toISOString(),
			source,
			entrypoint,
			version,
			prefix,
			launcher,
			release: stage,
			runtime: { suppliedPath: suppliedRuntime, installedPath: runtime, version: runtimeVersion },
			previousRelease,
		};
		await fs.promises.writeFile(path.join(stage, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		linkStage = await fs.promises.mkdtemp(path.join(binDir, ".haiso-publish-"));
		await fs.promises.chmod(linkStage, 0o700);
		const stagedLauncher = path.join(linkStage, "haiso");
		await fs.promises.symlink(wrapper, stagedLauncher);
		// Exercise the actual symlink path before either public name changes.
		if ((await probe([stagedLauncher, "--version"], stage)) !== SOURCE_VERSION)
			throw new Error("Staged launcher version changed during verification.");
		await safeDirectory(parent, false);
		await safeDirectory(binDir, false);
		await unchanged(prefix, prefixBefore);
		await unchanged(launcher, launcherBefore);
		const stagedPrefix = path.join(lock, "prefix");
		await fs.promises.symlink(stage, stagedPrefix);
		await fs.promises.rename(stagedPrefix, prefix);
		prefixSwitched = true;
		if (launcherBefore === null) {
			// symlink(2) creates without replacing a launcher published by another process.
			await fs.promises.symlink(wrapper, launcher);
		} else {
			await unchanged(launcher, launcherBefore);
			await fs.promises.rename(stagedLauncher, launcher);
		}
		published = true;
		return receipt;
	} catch (error) {
		if (prefixSwitched && !published) {
			try {
				if (previousRelease) {
					const rollback = path.join(lock, "rollback");
					await fs.promises.symlink(previousRelease, rollback);
					await fs.promises.rename(rollback, prefix);
				} else await fs.promises.unlink(prefix);
			} catch (rollbackError) {
				// Retain the verified release if rollback itself fails; never leave a dangling root.
				stage = undefined;
				throw new AggregateError(
					[error, rollbackError],
					`Publication failed and root rollback failed; inspect ${prefix}. The previous launcher was not replaced.`,
				);
			}
		}
		throw error;
	} finally {
		// Only remove private paths created by this invocation, never previous releases or applications.
		const cleanupPaths = [lock];
		if (linkStage) cleanupPaths.push(linkStage);
		if (stage && !published) cleanupPaths.push(stage);
		const cleanupResults = await Promise.allSettled(
			cleanupPaths.map(file => fs.promises.rm(file, { recursive: true, force: true })),
		);
		for (let index = 0; index < cleanupResults.length; index++) {
			const result = cleanupResults[index]!;
			if (result.status === "rejected") {
				console.warn(
					`Installer cleanup could not remove ${cleanupPaths[index]}: ${String(result.reason)}. Remove this private temporary path after checking permissions.`,
				);
			}
		}
	}
}

const HELP = `Usage: bun scripts/install-haiso.ts --runtime /absolute/path/to/bun [options]

Install this Haiso source checkout using a separately provided standalone Bun.
  --runtime PATH       Required native Bun executable; never downloaded or inferred
  --source PATH        Checkout root (default: this script's repository)
  --prefix PATH        Install root (default: ~/.local/share/haiso/fork)
  --bin-dir PATH       Launcher directory (default: ~/.local/bin)
  --replace-legacy     Authorize replacing an existing haiso file/symlink, also on reinstall
  --help               Show this help

The root points to an immutable sibling release. Older releases and a launcher
backup are retained. Only haiso is published; omp, legacy apps and user data are
never modified. Keep the source checkout available after installation.
`;

export function parseInstallArgs(args: string[]): InstallOptions | null {
	if (args.includes("--help")) return null;
	const options: InstallOptions = { runtime: "" };
	const seen = new Set<string>();
	for (let index = 0; index < args.length; index++) {
		const flag = args[index]!;
		if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
		seen.add(flag);
		if (flag === "--replace-legacy") {
			options.replaceLegacy = true;
			continue;
		}
		if (!["--runtime", "--source", "--prefix", "--bin-dir"].includes(flag))
			throw new Error(`Unknown option: ${flag}. Use --help.`);
		const value = args[++index];
		if (!value || value.startsWith("--")) throw new Error(`${flag} requires a path.`);
		if (flag === "--runtime") options.runtime = value;
		else if (flag === "--source") options.source = value;
		else if (flag === "--prefix") options.prefix = value;
		else options.binDir = value;
	}
	if (!options.runtime) throw new Error("--runtime is required. Use --help.");
	return options;
}

if (import.meta.main) {
	try {
		const options = parseInstallArgs(process.argv.slice(2));
		if (!options) process.stdout.write(HELP);
		else {
			const receipt = await installHaiso(options);
			console.log(
				`Installed ${receipt.version}: ${receipt.launcher}\nReceipt: ${path.join(receipt.prefix, "receipt.json")}`,
			);
		}
	} catch (error) {
		console.error(`Haiso installation failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
