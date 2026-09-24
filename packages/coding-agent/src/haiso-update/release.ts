import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as ptree from "@oh-my-pi/pi-utils/ptree";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { quotePosixPath } from "../ssh/utils";

const OWNER = "haiso-release-installer";
const LEGACY_OWNER = "haiso-source-installer";
const DIGEST = /^[a-f0-9]{64}$/;
const TAG = /^v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/;

export interface InstallOptions {
	binary: string;
	runtime: string;
	forkPatch: string;
	upstream: { tag: string; commit: string };
	compatibility: { state: string; broker: string };
	prefix?: string;
	binDir?: string;
	replaceLegacy?: boolean;
}

export interface InstallReceipt {
	schemaVersion: 2;
	owner: typeof OWNER;
	id: string;
	installedAt: string;
	version: string;
	prefix: string;
	launcher: string;
	release: string;
	executable: string;
	executableSha256: string;
	forkPatch: string;
	forkPatchSha256: string;
	upstream: { tag: string; commit: string };
	compatibility: { state: string; broker: string };
	runtime: { suppliedPath: string; installedPath: string; version: string; sha256: string };
	previousRelease: string | null;
	/** Compare-and-switch baseline; a legacy baseline is never a rollback target. */
	activationBaseline: string | null;
}

function requirePlatform(): void {
	if (process.platform === "win32" || !process.getuid) throw new Error("This installer requires macOS or Linux.");
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

// Preserve the source installer's ancestor checks, including macOS's root-owned /var and /tmp aliases.
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

async function ownedParent(directory: string, create: boolean): Promise<string> {
	const canonical = await safeDirectory(path.resolve(directory), create);
	const info = await fs.promises.lstat(canonical);
	assertOwner(canonical, info);
	if ((info.mode & 0o022) !== 0) throw new Error(`Install parent must not be writable by others: ${canonical}`);
	return canonical;
}

async function canonicalPrefix(requested: string, create: boolean): Promise<string> {
	const resolved = path.resolve(requested);
	if (resolved === path.dirname(resolved) || path.basename(resolved) === "omp") {
		throw new Error(`Unsafe install prefix: ${resolved}`);
	}
	return path.join(await ownedParent(path.dirname(resolved), create), path.basename(resolved));
}

function isReleasePath(release: string, prefix: string): boolean {
	return (
		path.isAbsolute(release) &&
		path.normalize(release) === release &&
		path.dirname(release) === path.dirname(prefix) &&
		path.basename(release).startsWith(`.${path.basename(prefix)}-release-`) &&
		path.basename(release).length > `.${path.basename(prefix)}-release-`.length
	);
}

function checkLayout(prefix: string, launcher: string, release?: string): void {
	const binDir = path.dirname(launcher);
	if (
		path.basename(launcher) !== "haiso" ||
		prefix === launcher ||
		binDir === prefix ||
		binDir.startsWith(`${prefix}${path.sep}`) ||
		(release && (binDir === release || binDir.startsWith(`${release}${path.sep}`)))
	) {
		throw new Error("--bin-dir must be outside --prefix and every release directory.");
	}
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

async function ownedFile(file: string, executable: boolean): Promise<void> {
	const info = await fs.promises.lstat(file);
	assertOwner(file, info);
	if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o222) !== 0 || (executable && (info.mode & 0o111) === 0)) {
		throw new Error(`Unsafe or mutable release file: ${file}`);
	}
}

async function fileHash(file: string): Promise<string> {
	const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const hash = createHash("sha256");
		for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
		return hash.digest("hex");
	} finally {
		await handle.close();
	}
}

function launcherText(executable: string, prefix: string): string {
	return `#!/bin/sh\nunset BUN_BE_BUN PI_COMPILED\nHAISO_PREFIX=${quotePosixPath(prefix)}\nexport HAISO_PREFIX\nexec ${quotePosixPath(executable)} "$@"\n`;
}

function validatePins(upstream: InstallOptions["upstream"], compatibility: InstallOptions["compatibility"]): string {
	const version = TAG.exec(upstream?.tag)?.[1];
	if (!version || !/^[a-f0-9]{40}$/.test(upstream?.commit))
		throw new Error("Pinned upstream tag and full commit are required.");
	if (!DIGEST.test(compatibility?.state) || !DIGEST.test(compatibility?.broker)) {
		throw new Error("State and broker compatibility fingerprints must be SHA-256 digests.");
	}
	return `haiso/${version}`;
}

async function readReceiptFile(release: string): Promise<unknown> {
	const file = path.join(release, "receipt.json");
	const info = await fs.promises.lstat(file);
	assertOwner(file, info);
	if (!info.isFile() || (info.mode & 0o022) !== 0 || info.size > 65_536)
		throw new Error(`Unsafe install receipt: ${file}`);
	return JSON.parse(await fs.promises.readFile(file, "utf8"));
}

/** Validate the retained bytes, ownership, layout and receipt before trusting any metadata. */
export async function readHaisoRelease(release: string): Promise<InstallReceipt> {
	requirePlatform();
	if (!path.isAbsolute(release) || path.normalize(release) !== release)
		throw new Error(`Unsafe release path: ${release}`);
	const parent = await ownedParent(path.dirname(release), false);
	if (parent !== path.dirname(release)) throw new Error(`Non-canonical release path: ${release}`);
	const info = await fs.promises.lstat(release);
	assertOwner(release, info);
	if (!info.isDirectory() || (info.mode & 0o222) !== 0)
		throw new Error(`Unsafe or mutable release directory: ${release}`);
	const value = await readReceiptFile(release);
	if (typeof value !== "object" || value === null || !("schemaVersion" in value) || value.schemaVersion !== 2) {
		throw new Error("Mutable v1 installations are not eligible for activation or rollback; use --replace-legacy.");
	}
	const receipt = value as InstallReceipt;
	const receiptPath = path.join(release, "receipt.json");
	const sealPath = path.join(release, "receipt.sha256");
	await ownedFile(receiptPath, false);
	await ownedFile(sealPath, false);
	const seal = (await fs.promises.readFile(sealPath, "utf8")).trim();
	if (!DIGEST.test(seal) || seal !== (await fileHash(receiptPath)))
		throw new Error(`Tampered install receipt: ${receiptPath}`);
	if (
		receipt.owner !== OWNER ||
		typeof receipt.prefix !== "string" ||
		!path.isAbsolute(receipt.prefix) ||
		path.normalize(receipt.prefix) !== receipt.prefix ||
		receipt.release !== release ||
		!isReleasePath(release, receipt.prefix) ||
		receipt.id !== path.basename(release) ||
		typeof receipt.installedAt !== "string" ||
		!Number.isFinite(Date.parse(receipt.installedAt)) ||
		typeof receipt.launcher !== "string" ||
		!path.isAbsolute(receipt.launcher) ||
		path.normalize(receipt.launcher) !== receipt.launcher ||
		receipt.executable !== path.join(release, "bin/haiso") ||
		receipt.forkPatch !== path.join(release, "fork.patch") ||
		receipt.runtime?.installedPath !== path.join(release, "runtime/bun") ||
		typeof receipt.runtime.suppliedPath !== "string" ||
		!path.isAbsolute(receipt.runtime.suppliedPath) ||
		!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(receipt.runtime.version) ||
		![receipt.executableSha256, receipt.forkPatchSha256, receipt.runtime.sha256].every(hash => DIGEST.test(hash)) ||
		(receipt.previousRelease !== null &&
			(typeof receipt.previousRelease !== "string" ||
				!isReleasePath(receipt.previousRelease, receipt.prefix) ||
				receipt.previousRelease === release)) ||
		(receipt.activationBaseline !== null &&
			(typeof receipt.activationBaseline !== "string" ||
				!isReleasePath(receipt.activationBaseline, receipt.prefix) ||
				receipt.activationBaseline === release))
	) {
		throw new Error(`Invalid release ownership receipt: ${receiptPath}`);
	}
	if (receipt.version !== validatePins(receipt.upstream, receipt.compatibility))
		throw new Error(`Release version does not match pinned upstream: ${release}`);
	checkLayout(receipt.prefix, receipt.launcher, release);
	for (const directory of [path.join(release, "bin"), path.join(release, "runtime")]) {
		const directoryInfo = await fs.promises.lstat(directory);
		assertOwner(directory, directoryInfo);
		if (!directoryInfo.isDirectory() || (directoryInfo.mode & 0o222) !== 0)
			throw new Error(`Unsafe release directory: ${directory}`);
	}
	for (const [file, expected, executable] of [
		[receipt.executable, receipt.executableSha256, true],
		[receipt.forkPatch, receipt.forkPatchSha256, false],
		[receipt.runtime.installedPath, receipt.runtime.sha256, true],
	] as const) {
		await ownedFile(file, executable);
		if ((await fileHash(file)) !== expected) throw new Error(`Release hash mismatch: ${file}`);
	}
	const wrapper = path.join(release, "bin/launch");
	await ownedFile(wrapper, true);
	if ((await fs.promises.readFile(wrapper, "utf8")) !== launcherText(receipt.executable, receipt.prefix))
		throw new Error(`Tampered release launcher: ${wrapper}`);
	return receipt;
}

interface ActiveRelease {
	target: string;
	receipt: InstallReceipt | null;
}

async function activeRelease(prefix: string, allowLegacy: boolean): Promise<ActiveRelease | null> {
	const info = await inspect(prefix);
	if (!info) return null;
	assertOwner(prefix, info);
	if (!info.isSymbolicLink())
		throw new Error(`Install root already exists and is not an installer-owned symlink: ${prefix}`);
	const target = path.resolve(path.dirname(prefix), await fs.promises.readlink(prefix));
	if (!isReleasePath(target, prefix)) throw new Error(`Refusing unrecognized install root target: ${target}`);
	const targetInfo = await fs.promises.lstat(target);
	assertOwner(target, targetInfo);
	if (!targetInfo.isDirectory() || (targetInfo.mode & 0o022) !== 0)
		throw new Error(`Unsafe release directory: ${target}`);
	const raw = await readReceiptFile(target);
	if (typeof raw === "object" && raw !== null && "schemaVersion" in raw && raw.schemaVersion === 1) {
		if (
			!("owner" in raw) ||
			raw.owner !== LEGACY_OWNER ||
			!("prefix" in raw) ||
			raw.prefix !== prefix ||
			!("release" in raw) ||
			raw.release !== target
		) {
			throw new Error(`Install root has no matching ownership receipt: ${prefix}`);
		}
		if (!allowLegacy)
			throw new Error("Mutable v1 installation requires --replace-legacy and is not rollback-eligible.");
		return { target, receipt: null };
	}
	const receipt = await readHaisoRelease(target);
	if (receipt.prefix !== prefix) throw new Error(`Install root has no matching ownership receipt: ${prefix}`);
	return { target, receipt };
}

export async function currentHaisoRelease(
	prefix = path.join(os.homedir(), ".local/share/haiso/fork"),
): Promise<InstallReceipt | null> {
	requirePlatform();
	// A clean machine need not have the install parent yet; do not create it for status.
	const requested = path.resolve(prefix);
	if (!(await inspect(path.dirname(requested)))) return null;
	return (await activeRelease(await canonicalPrefix(requested, false), false))?.receipt ?? null;
}

async function launcherState(launcher: string, prefix: string, replaceLegacy: boolean): Promise<boolean> {
	const info = await inspect(launcher);
	if (!info) return false;
	assertOwner(launcher, info);
	if (!info.isFile() && !info.isSymbolicLink()) throw new Error(`Refusing non-file launcher: ${launcher}`);
	if (info.isSymbolicLink() && (await fs.promises.readlink(launcher)) === path.join(prefix, "bin/launch")) return true;
	if (!replaceLegacy)
		throw new Error(
			`${launcher} already exists. Use --replace-legacy to authorize replacing this unmanaged launcher.`,
		);
	return false;
}

async function withLock<T>(prefix: string, operation: (lock: string) => Promise<T>): Promise<T> {
	const lock = path.join(path.dirname(prefix), `.${path.basename(prefix)}-install.lock`);
	try {
		await fs.promises.mkdir(lock, { mode: 0o700 });
	} catch (error) {
		throw new Error(
			`Cannot acquire install lock ${lock}; another install may be running. Remove only a stale lock after checking.`,
			{ cause: error },
		);
	}
	try {
		return await operation(lock);
	} finally {
		await cleanup(lock);
	}
}

async function cleanup(directory: string): Promise<void> {
	try {
		await fs.promises.rm(directory, { recursive: true, force: true });
	} catch (error) {
		logger.warn("Installer cleanup could not remove a private temporary path", {
			path: directory,
			error: String(error),
		});
	}
}

async function withProbeHome<T>(operation: (home: string, env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
	const home = await fs.promises.mkdtemp(path.join(await fs.promises.realpath("/tmp"), "hp-"));
	await fs.promises.chmod(home, 0o700);
	try {
		const env: NodeJS.ProcessEnv = {
			PATH: "/usr/bin:/bin",
			HOME: home,
			TMPDIR: path.join(home, "tmp"),
			XDG_CONFIG_HOME: path.join(home, "config"),
			XDG_CACHE_HOME: path.join(home, "cache"),
			XDG_DATA_HOME: path.join(home, "data"),
			XDG_STATE_HOME: path.join(home, "state"),
			XDG_RUNTIME_DIR: path.join(home, "run"),
			PI_CODING_AGENT_DIR: path.join(home, "agent"),
			OMP_AGENT_DIR: path.join(home, "agent"),
			HAISO_UPDATE_DISABLED: "1",
			HAISO_DISABLE_UPDATES: "1",
			NO_COLOR: "1",
			TERM: "dumb",
		};
		for (const directory of new Set(
			Object.values(env).filter((value): value is string => !!value?.startsWith(`${home}${path.sep}`)),
		)) {
			await fs.promises.mkdir(directory, { mode: 0o700 });
		}
		return await operation(home, env);
	} finally {
		await cleanup(home);
	}
}

async function probe(command: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 30_000): Promise<string> {
	using child = ptree.spawn(command, { cwd, env, stdin: "ignore", timeout });
	const decoder = new TextDecoder();
	let stdout = "";
	let bytes = 0;
	for await (const chunk of child.stdout) {
		if ((bytes += chunk.byteLength) > 1024 * 1024) throw new Error("Release probe output exceeded 1 MiB.");
		stdout += decoder.decode(chunk, { stream: true });
	}
	stdout += decoder.decode();
	const code = await child.exited;
	if (code !== 0 || child.exitReason)
		throw new Error(
			`Validation failed (${child.exitReason ?? code}): ${command.join(" ")}\n${child.peekStderr().trim()}`,
		);
	return stdout.trim();
}

async function assertNative(file: string, label: string): Promise<void> {
	const info = await fs.promises.lstat(file);
	if (
		!info.isFile() ||
		(info.mode & 0o111) === 0 ||
		(info.mode & 0o022) !== 0 ||
		(info.uid !== 0 && info.uid !== process.getuid?.())
	) {
		throw new Error(`${label} must name a safely owned native executable: ${file}`);
	}
	const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const header = Buffer.alloc(4);
		await handle.read(header, 0, 4, 0);
		if (
			!["7f454c46", "cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", "bebafeca"].includes(
				header.toString("hex"),
			)
		) {
			throw new Error(`${label} is not a native binary (shell wrappers are not supported): ${file}`);
		}
	} finally {
		await handle.close();
	}
}

async function copyFrozen(source: string, destination: string, executable: boolean): Promise<string> {
	const info = await fs.promises.lstat(source);
	if (!info.isFile() || (info.mode & 0o022) !== 0 || (info.uid !== 0 && info.uid !== process.getuid?.()))
		throw new Error(`Unsafe supplied artifact: ${source}`);
	const before = await fingerprint(source);
	const expected = await fileHash(source);
	await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
	await fs.promises.chmod(destination, executable ? 0o500 : 0o400);
	await unchanged(source, before);
	if ((await fileHash(destination)) !== expected) throw new Error(`Artifact changed while copying: ${source}`);
	return expected;
}

/** Freeze and validate a release without modifying either public installation name. */
export async function stageHaiso(options: InstallOptions): Promise<InstallReceipt> {
	requirePlatform();
	if (!options.binary || !options.runtime || !options.forkPatch)
		throw new Error("--binary, --runtime and --fork-patch are required.");
	const expectedVersion = validatePins(options.upstream, options.compatibility);
	const binary = await fs.promises.realpath(path.resolve(options.binary));
	const suppliedRuntime = await fs.promises.realpath(path.resolve(options.runtime));
	const suppliedPatch = await fs.promises.realpath(path.resolve(options.forkPatch));
	await assertNative(binary, "--binary");
	await assertNative(suppliedRuntime, "--runtime");
	const requestedPrefix = path.resolve(options.prefix ?? path.join(os.homedir(), ".local/share/haiso/fork"));
	const requestedBinDir = path.resolve(options.binDir ?? path.join(os.homedir(), ".local/bin"));
	checkLayout(requestedPrefix, path.join(requestedBinDir, "haiso"));
	const prefix = await canonicalPrefix(requestedPrefix, true);
	const binDir = await ownedParent(requestedBinDir, true);
	const launcher = path.join(binDir, "haiso");
	checkLayout(prefix, launcher);
	return withLock(prefix, async () => {
		const prefixBefore = await fingerprint(prefix);
		const launcherBefore = await fingerprint(launcher);
		const active = await activeRelease(prefix, options.replaceLegacy === true);
		await launcherState(launcher, prefix, options.replaceLegacy === true);
		if (active?.receipt && active.receipt.launcher !== launcher)
			throw new Error("An update must retain the current managed launcher path.");
		const release = await fs.promises.mkdtemp(path.join(path.dirname(prefix), `.${path.basename(prefix)}-release-`));
		let retained = false;
		try {
			await fs.promises.chmod(release, 0o700);
			await fs.promises.mkdir(path.join(release, "bin"), { mode: 0o700 });
			await fs.promises.mkdir(path.join(release, "runtime"), { mode: 0o700 });
			const executable = path.join(release, "bin/haiso");
			const runtime = path.join(release, "runtime/bun");
			const forkPatch = path.join(release, "fork.patch");
			const executableSha256 = await copyFrozen(binary, executable, true);
			const runtimeSha256 = await copyFrozen(suppliedRuntime, runtime, true);
			const forkPatchSha256 = await copyFrozen(suppliedPatch, forkPatch, false);
			const wrapper = path.join(release, "bin/launch");
			await fs.promises.writeFile(wrapper, launcherText(executable, prefix), { mode: 0o500, flag: "wx" });
			const runtimeVersion = await withProbeHome(async (home, env) => {
				const version = await probe([runtime, "--version"], home, env);
				if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version))
					throw new Error(`Unexpected Bun --version output: ${version}`);
				const marker = `haiso-runtime-${crypto.randomUUID()}`;
				const proof = await probe(
					[runtime, "-e", `console.log(${JSON.stringify(marker)} + ":" + Bun.version)`],
					home,
					env,
				);
				if (proof !== `${marker}:${version}`)
					throw new Error(
						"Runtime cannot evaluate Bun source independently; supply standalone Bun, not a compiled application.",
					);
				const binaryVersion = await probe([wrapper, "--version"], home, env);
				if (binaryVersion !== expectedVersion)
					throw new Error(
						`Compiled Haiso validation expected ${expectedVersion}, got ${JSON.stringify(binaryVersion)}.`,
					);
				const compiled: unknown = JSON.parse(await probe([wrapper, "__omp_worker_haiso_release_probe"], home, env));
				if (
					typeof compiled !== "object" ||
					compiled === null ||
					!("compiled" in compiled) ||
					compiled.compiled !== true ||
					!("bunVersion" in compiled) ||
					compiled.bunVersion !== version ||
					!("executable" in compiled) ||
					compiled.executable !== executable ||
					!("brokerNamespace" in compiled) ||
					compiled.brokerNamespace !== options.compatibility.broker
				)
					throw new Error(
						"Compiled Haiso must use the supplied standalone Bun version, its immutable executable path and the pinned broker namespace.",
					);
				await probe([wrapper, "--smoke-test"], home, env, 120_000);
				return version;
			});
			const receipt: InstallReceipt = {
				schemaVersion: 2,
				owner: OWNER,
				id: path.basename(release),
				installedAt: new Date().toISOString(),
				version: expectedVersion,
				prefix,
				launcher,
				release,
				executable,
				executableSha256,
				forkPatch,
				forkPatchSha256,
				upstream: { ...options.upstream },
				compatibility: { ...options.compatibility },
				runtime: {
					suppliedPath: suppliedRuntime,
					installedPath: runtime,
					version: runtimeVersion,
					sha256: runtimeSha256,
				},
				previousRelease: active?.receipt?.release ?? null,
				activationBaseline: active?.target ?? null,
			};
			const receiptPath = path.join(release, "receipt.json");
			await fs.promises.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o400, flag: "wx" });
			await fs.promises.writeFile(path.join(release, "receipt.sha256"), `${await fileHash(receiptPath)}\n`, {
				mode: 0o400,
				flag: "wx",
			});
			for (const directory of [path.join(release, "bin"), path.join(release, "runtime"), release])
				await fs.promises.chmod(directory, 0o500);
			await unchanged(prefix, prefixBefore);
			await unchanged(launcher, launcherBefore);
			await readHaisoRelease(release);
			retained = true;
			return receipt;
		} finally {
			if (!retained) {
				for (const directory of [release, path.join(release, "bin"), path.join(release, "runtime")]) {
					if ((await inspect(directory))?.isDirectory()) await fs.promises.chmod(directory, 0o700);
				}
				await cleanup(release);
			}
		}
	});
}

export async function activateHaiso(
	release: string,
	options: { expectedCurrent?: string | null; reviewed?: boolean; replaceLegacy?: boolean },
): Promise<InstallReceipt> {
	const initial = await readHaisoRelease(release);
	const prefix = await canonicalPrefix(initial.prefix, false);
	if (prefix !== initial.prefix) throw new Error("Release prefix is not canonical.");
	return withLock(prefix, async lock => {
		const receipt = await readHaisoRelease(release);
		const prefixBefore = await fingerprint(prefix);
		const current = await activeRelease(prefix, options.replaceLegacy === true);
		const expected = options.expectedCurrent === undefined ? receipt.activationBaseline : options.expectedCurrent;
		if ((current?.target ?? null) !== expected)
			throw new Error("Active release changed since staging; refusing activation after active-release drift.");
		if (current?.receipt) {
			if (current.receipt.launcher !== receipt.launcher)
				throw new Error("An update must retain the current managed launcher path.");
			if (
				!options.reviewed &&
				(current.receipt.compatibility.state !== receipt.compatibility.state ||
					current.receipt.compatibility.broker !== receipt.compatibility.broker)
			) {
				throw new Error(
					"State or broker compatibility changed; explicit reviewed activation is required. Shared state is never rolled back.",
				);
			}
		}
		const binDir = await ownedParent(path.dirname(receipt.launcher), false);
		const launcherBefore = await fingerprint(receipt.launcher);
		const managedLauncher = await launcherState(receipt.launcher, prefix, options.replaceLegacy === true);
		let linkStage: string | undefined;
		let prefixSwitched = false;
		let published = false;
		try {
			linkStage = await fs.promises.mkdtemp(path.join(binDir, ".haiso-publish-"));
			await fs.promises.chmod(linkStage, 0o700);
			const stagedLauncher = path.join(linkStage, "haiso");
			await fs.promises.symlink(path.join(release, "bin/launch"), stagedLauncher);
			await withProbeHome(async (home, env) => {
				if ((await probe([stagedLauncher, "--version"], home, env)) !== receipt.version)
					throw new Error("Staged launcher version changed during verification.");
				await probe([stagedLauncher, "--smoke-test"], home, env, 120_000);
			});
			await readHaisoRelease(release);
			await safeDirectory(path.dirname(prefix), false);
			await safeDirectory(binDir, false);
			await unchanged(prefix, prefixBefore);
			await unchanged(receipt.launcher, launcherBefore);
			// Once the stable launcher exists, this rename is the only publication mutation.
			const stagedPrefix = path.join(lock, "prefix");
			await fs.promises.symlink(release, stagedPrefix);
			await fs.promises.rename(stagedPrefix, prefix);
			prefixSwitched = true;
			if (!managedLauncher) {
				const stableTarget = path.join(prefix, "bin/launch");
				if (launcherBefore === null) await fs.promises.symlink(stableTarget, receipt.launcher);
				else {
					await unchanged(receipt.launcher, launcherBefore);
					const stableLink = path.join(linkStage, "stable");
					await fs.promises.symlink(stableTarget, stableLink);
					await fs.promises.rename(stableLink, receipt.launcher);
				}
			}
			published = true;
			return receipt;
		} catch (error) {
			if (prefixSwitched && !published) {
				try {
					// Do not overwrite a concurrently changed public root during recovery either.
					if ((await fs.promises.readlink(prefix)) !== release)
						throw new Error("Active prefix changed during publication recovery.");
					if (current) {
						const rollback = path.join(lock, "rollback");
						await fs.promises.symlink(current.target, rollback);
						await fs.promises.rename(rollback, prefix);
					} else await fs.promises.unlink(prefix);
				} catch (rollbackError) {
					throw new AggregateError(
						[error, rollbackError],
						`Publication and root recovery failed; inspect ${prefix}. Both releases were retained.`,
					);
				}
			}
			throw error;
		} finally {
			if (linkStage) await cleanup(linkStage);
		}
	});
}

export async function installHaiso(options: InstallOptions): Promise<InstallReceipt> {
	const receipt = await stageHaiso(options);
	return activateHaiso(receipt.release, {
		expectedCurrent: receipt.activationBaseline,
		replaceLegacy: options.replaceLegacy,
	});
}

export async function rollbackHaiso(options: { prefix?: string; reviewed?: boolean }): Promise<InstallReceipt> {
	const current = await currentHaisoRelease(options.prefix);
	if (!current?.previousRelease)
		throw new Error(
			"No retained compiled release is eligible for rollback; mutable v1 installations cannot be restored.",
		);
	const previous = await readHaisoRelease(current.previousRelease);
	if (previous.prefix !== current.prefix || previous.launcher !== current.launcher)
		throw new Error("Rollback receipt does not belong to this installation.");
	return activateHaiso(previous.release, { expectedCurrent: current.release, reviewed: options.reviewed });
}
