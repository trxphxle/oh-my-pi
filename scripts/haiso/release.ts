/**
 * Immutable compiled Haiso releases: freeze a built binary plus its standalone Bun runtime into a
 * sealed, read-only release directory, then publish it by atomically swapping the prefix symlink.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import * as logger from "@oh-my-pi/pi-utils/logger";
import * as ptree from "@oh-my-pi/pi-utils/ptree";

const OWNER = "haiso-release-installer";
const LEGACY_OWNER = "haiso-source-installer";
const DIGEST = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const TAG = /^v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

/** The updater the launcher routes `haiso update` to, relative to the source repository. */
export const UPDATER_ENTRY = "scripts/haiso/update.ts";
/** Frozen OMP bridge bundle inside a release; OMP loads it through the stable prefix. */
const BRIDGE_ENTRY = "omp-bridge/index.js";
/** First line of the OMP extension file the installer maintains; a file without it is never touched. */
export const BRIDGE_LOADER_MARKER =
	"// Haiso OMP bridge loader, maintained by `haiso update`. Delete this file to stop loading it.";
/** Current launcher template: 2 routes `haiso discord doctor`. Receipts without it keep the original template. */
const LAUNCHER_VERSION = 2;
/** The CLI's hidden doctor selector (`DISCORD_MODE_DOCTOR_WORKER_ARG` in packages/coding-agent/src/cli/worker-selectors.ts). */
const DOCTOR_SELECTOR = "__omp_worker_discord_doctor";

export interface InstallOptions {
	binary: string;
	runtime: string;
	upstream: { tag: string; commit: string };
	/** Repository root, the built commit and the `haiso` branch tip it was built from. */
	source: { repo: string; commit: string; haisoCommit: string };
	prefix?: string;
	binDir?: string;
	stateDir?: string;
	replaceLegacy?: boolean;
	/** Built OMP bridge bundle (packages/omp-bridge/dist/index.js), frozen into the release when given. */
	bridge?: string;
}

interface ReceiptCommon {
	owner: typeof OWNER;
	id: string;
	installedAt: string;
	version: string;
	prefix: string;
	launcher: string;
	release: string;
	executable: string;
	executableSha256: string;
	upstream: { tag: string; commit: string };
	runtime: { suppliedPath: string; installedPath: string; version: string; sha256: string };
	previousRelease: string | null;
	/** Compare-and-switch baseline; a legacy baseline is never a rollback target. */
	activationBaseline: string | null;
}

/** A release built from the `haiso` git branch. */
export interface ReleaseReceipt extends ReceiptCommon {
	schemaVersion: 3;
	source: InstallOptions["source"];
	stateDir: string;
	/** Frozen OMP bridge bundle; absent from releases built before it was shipped. */
	bridge?: { path: string; sha256: string };
	/** Launcher template revision; absent from releases whose launcher predates `haiso discord doctor` routing. */
	launcherVersion?: typeof LAUNCHER_VERSION;
}

/** A release rebuilt from a frozen fork.patch; still readable and a rollback target, never produced again. */
export interface LegacyReleaseReceipt extends ReceiptCommon {
	schemaVersion: 2;
	source?: undefined;
	forkPatch: string;
	forkPatchSha256: string;
	compatibility: { state: string; broker: string };
}

export type InstallReceipt = ReleaseReceipt | LegacyReleaseReceipt;

export function defaultPrefix(): string {
	return path.join(os.homedir(), ".local/share/haiso/fork");
}

export function defaultStateDir(prefix: string): string {
	return path.join(path.dirname(prefix), `${path.basename(prefix)}-update`);
}

/** POSIX single-quote a value for `sh`. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
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

// Walk every ancestor, tolerating only macOS's root-owned /var and /tmp aliases as symlinks.
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

function isNormalAbsolute(value: unknown): value is string {
	return typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value;
}

function isReleasePath(release: string, prefix: string): boolean {
	return (
		isNormalAbsolute(release) &&
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
		throw new Error("The launcher directory must be outside the prefix and every release directory.");
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

interface LauncherInputs {
	prefix: string;
	runtime: string;
	repo: string;
	stateDir: string;
	executable: string;
	launcherVersion?: typeof LAUNCHER_VERSION;
}

/**
 * `haiso update …` runs the repository updater on the release's own runtime (plugin updates stay
 * in the binary); other launches schedule at most one daily background check and print any held-update
 * notice before replacing the shell with the frozen executable. Launcher version 2 also routes `haiso discord doctor`
 * straight to the doctor selector.
 */
function launcherText(inputs: LauncherInputs): string {
	return `#!/bin/sh
unset BUN_BE_BUN PI_COMPILED
HAISO_PREFIX=${shellQuote(inputs.prefix)}
export HAISO_PREFIX
runtime=${shellQuote(inputs.runtime)}
updater=${shellQuote(path.join(inputs.repo, UPDATER_ENTRY))}
state=${shellQuote(inputs.stateDir)}
if [ "$1" = update ]; then
	case " $* " in
	*" --plugins "* | *" -l "*) ;;
	*)
		shift
		[ -f "$updater" ] || { echo "haiso: updater not found: $updater" >&2; exit 1; }
		exec "$runtime" "$updater" "$@"
		;;
	esac
fi
${inputs.launcherVersion === LAUNCHER_VERSION ? `[ "$1" = discord ] && [ "$2" = doctor ] && exec ${shellQuote(inputs.executable)} ${DOCTOR_SELECTOR}\n` : ""}if [ -z "$HAISO_UPDATE_DISABLED" ] && [ -f "$updater" ] && grep -q '"enabled": *true' "$state/settings.json" 2>/dev/null && [ -z "$(find "$state/last-check" -mmin -1440 2>/dev/null)" ]; then
	: >"$state/last-check" 2>/dev/null && { nohup "$runtime" "$updater" --background >/dev/null 2>&1 & }
fi
[ -f "$state/notice" ] && cat "$state/notice" >&2
exec ${shellQuote(inputs.executable)} "$@"
`;
}

function legacyLauncherText(executable: string, prefix: string): string {
	return `#!/bin/sh\nunset BUN_BE_BUN PI_COMPILED\nHAISO_PREFIX=${shellQuote(prefix)}\nexport HAISO_PREFIX\nexec ${shellQuote(executable)} "$@"\n`;
}

function validatePins(upstream: InstallOptions["upstream"] | undefined): string {
	const version = TAG.exec(upstream?.tag ?? "")?.[1];
	if (!version || !COMMIT.test(upstream?.commit ?? ""))
		throw new Error("Pinned upstream tag and full commit are required.");
	return `haiso/${version}`;
}

function validSource(source: InstallOptions["source"] | undefined): boolean {
	return !!source && isNormalAbsolute(source.repo) && COMMIT.test(source.commit) && COMMIT.test(source.haisoCommit);
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
	if (!isNormalAbsolute(release)) throw new Error(`Unsafe release path: ${release}`);
	const parent = await ownedParent(path.dirname(release), false);
	if (parent !== path.dirname(release)) throw new Error(`Non-canonical release path: ${release}`);
	const info = await fs.promises.lstat(release);
	assertOwner(release, info);
	if (!info.isDirectory() || (info.mode & 0o222) !== 0)
		throw new Error(`Unsafe or mutable release directory: ${release}`);
	const value = await readReceiptFile(release);
	const schemaVersion = typeof value === "object" && value !== null && "schemaVersion" in value && value.schemaVersion;
	if (schemaVersion !== 2 && schemaVersion !== 3) {
		throw new Error("Mutable v1 installations are not eligible for activation or rollback.");
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
		!isNormalAbsolute(receipt.prefix) ||
		receipt.release !== release ||
		!isReleasePath(release, receipt.prefix) ||
		receipt.id !== path.basename(release) ||
		typeof receipt.installedAt !== "string" ||
		!Number.isFinite(Date.parse(receipt.installedAt)) ||
		!isNormalAbsolute(receipt.launcher) ||
		receipt.executable !== path.join(release, "bin/haiso") ||
		receipt.runtime?.installedPath !== path.join(release, "runtime/bun") ||
		!isNormalAbsolute(receipt.runtime.suppliedPath) ||
		!SEMVER.test(receipt.runtime.version) ||
		!DIGEST.test(receipt.executableSha256) ||
		!DIGEST.test(receipt.runtime.sha256) ||
		(receipt.schemaVersion === 3
			? !validSource(receipt.source) ||
				!isNormalAbsolute(receipt.stateDir) ||
				(receipt.launcherVersion !== undefined && receipt.launcherVersion !== LAUNCHER_VERSION) ||
				(receipt.bridge !== undefined &&
					(receipt.bridge.path !== path.join(release, BRIDGE_ENTRY) || !DIGEST.test(receipt.bridge.sha256)))
			: receipt.forkPatch !== path.join(release, "fork.patch") ||
				!DIGEST.test(receipt.forkPatchSha256) ||
				!DIGEST.test(receipt.compatibility?.state) ||
				!DIGEST.test(receipt.compatibility?.broker)) ||
		(receipt.previousRelease !== null &&
			(!isReleasePath(receipt.previousRelease, receipt.prefix) || receipt.previousRelease === release)) ||
		(receipt.activationBaseline !== null &&
			(!isReleasePath(receipt.activationBaseline, receipt.prefix) || receipt.activationBaseline === release))
	) {
		throw new Error(`Invalid release ownership receipt: ${receiptPath}`);
	}
	if (receipt.version !== validatePins(receipt.upstream))
		throw new Error(`Release version does not match pinned upstream: ${release}`);
	checkLayout(receipt.prefix, receipt.launcher, release);
	const directories = [path.join(release, "bin"), path.join(release, "runtime")];
	if (receipt.schemaVersion === 3 && receipt.bridge) directories.push(path.dirname(receipt.bridge.path));
	for (const directory of directories) {
		const directoryInfo = await fs.promises.lstat(directory);
		assertOwner(directory, directoryInfo);
		if (!directoryInfo.isDirectory() || (directoryInfo.mode & 0o222) !== 0)
			throw new Error(`Unsafe release directory: ${directory}`);
	}
	const frozen: [string, string, boolean][] = [
		[receipt.executable, receipt.executableSha256, true],
		[receipt.runtime.installedPath, receipt.runtime.sha256, true],
	];
	if (receipt.schemaVersion === 2) frozen.push([receipt.forkPatch, receipt.forkPatchSha256, false]);
	else if (receipt.bridge) frozen.push([receipt.bridge.path, receipt.bridge.sha256, false]);
	for (const [file, expected, executable] of frozen) {
		await ownedFile(file, executable);
		if ((await fileHash(file)) !== expected) throw new Error(`Release hash mismatch: ${file}`);
	}
	const wrapper = path.join(release, "bin/launch");
	await ownedFile(wrapper, true);
	const expectedLauncher =
		receipt.schemaVersion === 3
			? launcherText({
					prefix: receipt.prefix,
					runtime: receipt.runtime.installedPath,
					repo: receipt.source.repo,
					stateDir: receipt.stateDir,
					executable: receipt.executable,
					launcherVersion: receipt.launcherVersion,
				})
			: legacyLauncherText(receipt.executable, receipt.prefix);
	if ((await fs.promises.readFile(wrapper, "utf8")) !== expectedLauncher)
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
		if (!allowLegacy) throw new Error("Mutable v1 installation requires replaceLegacy and is not rollback-eligible.");
		return { target, receipt: null };
	}
	const receipt = await readHaisoRelease(target);
	if (receipt.prefix !== prefix) throw new Error(`Install root has no matching ownership receipt: ${prefix}`);
	return { target, receipt };
}

export async function currentHaisoRelease(prefix = defaultPrefix()): Promise<InstallReceipt | null> {
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
		throw new Error(`${launcher} already exists and is not managed; replaceLegacy must authorize replacing it.`);
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

/** Both the version and the isolated worker smoke must pass before a launcher is trusted. */
async function probeLauncher(launcher: string, expectedVersion: string, home: string, env: NodeJS.ProcessEnv) {
	const version = await probe([launcher, "--version"], home, env);
	if (version !== expectedVersion)
		throw new Error(`Compiled Haiso validation expected ${expectedVersion}, got ${JSON.stringify(version)}.`);
	const smoke = await probe([launcher, "--smoke-test"], home, env, 120_000);
	if (!smoke.includes("smoke-test: ok"))
		throw new Error(`Compiled Haiso smoke test did not report success: ${JSON.stringify(smoke.slice(-200))}`);
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

async function copyFrozen(source: string, destination: string): Promise<string> {
	const info = await fs.promises.lstat(source);
	if (!info.isFile() || (info.mode & 0o022) !== 0 || (info.uid !== 0 && info.uid !== process.getuid?.()))
		throw new Error(`Unsafe supplied artifact: ${source}`);
	const before = await fingerprint(source);
	const expected = await fileHash(source);
	await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
	await fs.promises.chmod(destination, 0o500);
	await unchanged(source, before);
	if ((await fileHash(destination)) !== expected) throw new Error(`Artifact changed while copying: ${source}`);
	return expected;
}

/** Freeze and validate a release without modifying either public installation name. */
export async function stageHaiso(options: InstallOptions): Promise<ReleaseReceipt> {
	requirePlatform();
	if (!options.binary || !options.runtime) throw new Error("A compiled binary and a standalone runtime are required.");
	const expectedVersion = validatePins(options.upstream);
	if (!validSource(options.source))
		throw new Error("Source repository must be an absolute path with full built and haiso commits.");
	const binary = await fs.promises.realpath(path.resolve(options.binary));
	const suppliedRuntime = await fs.promises.realpath(path.resolve(options.runtime));
	const suppliedBridge = options.bridge ? await fs.promises.realpath(path.resolve(options.bridge)) : undefined;
	await assertNative(binary, "binary");
	await assertNative(suppliedRuntime, "runtime");
	const requestedPrefix = path.resolve(options.prefix ?? defaultPrefix());
	const requestedBinDir = path.resolve(options.binDir ?? path.join(os.homedir(), ".local/bin"));
	checkLayout(requestedPrefix, path.join(requestedBinDir, "haiso"));
	const prefix = await canonicalPrefix(requestedPrefix, true);
	const binDir = await ownedParent(requestedBinDir, true);
	const launcher = path.join(binDir, "haiso");
	const stateDir = path.resolve(options.stateDir ?? defaultStateDir(prefix));
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
			const executableSha256 = await copyFrozen(binary, executable);
			const runtimeSha256 = await copyFrozen(suppliedRuntime, runtime);
			let bridge: ReleaseReceipt["bridge"];
			if (suppliedBridge) {
				const bundle = path.join(release, BRIDGE_ENTRY);
				await fs.promises.mkdir(path.dirname(bundle), { mode: 0o700 });
				bridge = { path: bundle, sha256: await copyFrozen(suppliedBridge, bundle) };
				await fs.promises.chmod(bundle, 0o400);
			}
			const source = { ...options.source };
			const wrapper = path.join(release, "bin/launch");
			await fs.promises.writeFile(
				wrapper,
				launcherText({
					prefix,
					runtime,
					repo: source.repo,
					stateDir,
					executable,
					launcherVersion: LAUNCHER_VERSION,
				}),
				{ mode: 0o500, flag: "wx" },
			);
			const runtimeVersion = await withProbeHome(async (home, env) => {
				const version = await probe([runtime, "--version"], home, env);
				if (!SEMVER.test(version)) throw new Error(`Unexpected Bun --version output: ${version}`);
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
				await probeLauncher(wrapper, expectedVersion, home, env);
				return version;
			});
			const receipt: ReleaseReceipt = {
				schemaVersion: 3,
				owner: OWNER,
				id: path.basename(release),
				installedAt: new Date().toISOString(),
				version: expectedVersion,
				prefix,
				launcher,
				release,
				executable,
				executableSha256,
				upstream: { tag: options.upstream.tag, commit: options.upstream.commit },
				source,
				stateDir,
				launcherVersion: LAUNCHER_VERSION,
				runtime: {
					suppliedPath: suppliedRuntime,
					installedPath: runtime,
					version: runtimeVersion,
					sha256: runtimeSha256,
				},
				previousRelease: active?.receipt?.release ?? null,
				activationBaseline: active?.target ?? null,
				...(bridge ? { bridge } : {}),
			};
			const receiptPath = path.join(release, "receipt.json");
			await fs.promises.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o400, flag: "wx" });
			await fs.promises.writeFile(path.join(release, "receipt.sha256"), `${await fileHash(receiptPath)}\n`, {
				mode: 0o400,
				flag: "wx",
			});
			for (const directory of [
				path.join(release, "bin"),
				path.join(release, "runtime"),
				...(bridge ? [path.dirname(bridge.path)] : []),
				release,
			])
				await fs.promises.chmod(directory, 0o500);
			await unchanged(prefix, prefixBefore);
			await unchanged(launcher, launcherBefore);
			await readHaisoRelease(release);
			retained = true;
			return receipt;
		} finally {
			if (!retained) {
				for (const directory of [
					release,
					path.join(release, "bin"),
					path.join(release, "runtime"),
					path.join(release, path.dirname(BRIDGE_ENTRY)),
				]) {
					if ((await inspect(directory))?.isDirectory()) await fs.promises.chmod(directory, 0o700);
				}
				await cleanup(release);
			}
		}
	});
}

/** Publish a staged release, refusing if the active release is no longer `expectedCurrent`. */
export async function activateHaiso(
	release: string,
	options: { expectedCurrent?: string | null; replaceLegacy?: boolean },
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
		if (current?.receipt && current.receipt.launcher !== receipt.launcher)
			throw new Error("An update must retain the current managed launcher path.");
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
			await withProbeHome((home, env) => probeLauncher(stagedLauncher, receipt.version, home, env));
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

/** Re-activate the release the current one replaced. Shared ~/.omp state is never rolled back. */
export async function rollbackHaiso(options: { prefix?: string }): Promise<InstallReceipt> {
	const current = await currentHaisoRelease(options.prefix);
	if (!current?.previousRelease)
		throw new Error(
			"No retained compiled release is eligible for rollback; mutable v1 installations cannot be restored.",
		);
	const previous = await readHaisoRelease(current.previousRelease);
	if (previous.prefix !== current.prefix || previous.launcher !== current.launcher)
		throw new Error("Rollback receipt does not belong to this installation.");
	return activateHaiso(previous.release, { expectedCurrent: current.release });
}

/**
 * What `ensureHaisoBridgeLoader` did: `declined` means the user deleted the managed file (never recreated), `foreign`
 * a file without the marker (never touched), `paused` the active release ships no bridge (managed file removed until
 * one does), `unavailable` neither a bridge nor a managed file.
 */
export type BridgeLoaderOutcome = "created" | "updated" | "current" | "declined" | "foreign" | "paused" | "unavailable";

/**
 * Keeps OMP's `extensions/haiso-bridge.ts` re-exporting the bridge through the stable prefix, so updates and
 * rollbacks flow without rewriting it. Deleting the file turns the bridge off for good.
 */
export async function ensureHaisoBridgeLoader(options: {
	prefix: string;
	stateDir: string;
	agentDir?: string;
}): Promise<BridgeLoaderOutcome> {
	const loader = path.join(options.agentDir ?? getAgentDir(), "extensions", "haiso-bridge.ts");
	const bundle = path.join(options.prefix, BRIDGE_ENTRY);
	const statePath = path.join(options.stateDir, "bridge-loader.json");
	const available = (await inspect(bundle))?.isFile() === true;
	const content = `${BRIDGE_LOADER_MARKER}\nexport { default } from ${JSON.stringify(pathToFileURL(bundle).href)};\n`;
	const remember = async (installed: boolean) => {
		await fs.promises.mkdir(options.stateDir, { recursive: true, mode: 0o700 });
		await fs.promises.writeFile(statePath, `${JSON.stringify({ loader, installed })}\n`, { mode: 0o600 });
	};
	const info = await inspect(loader);
	if (info) {
		const existing = info.isFile() ? await fs.promises.readFile(loader, "utf8") : "";
		if (!existing.startsWith(`${BRIDGE_LOADER_MARKER}\n`)) return "foreign";
		if (!available) {
			await fs.promises.unlink(loader);
			await remember(false);
			return "paused";
		}
		await remember(true);
		if (existing === content) return "current";
		const staged = `${loader}.${process.pid}.tmp`;
		await fs.promises.writeFile(staged, content, { mode: 0o600, flag: "wx" });
		await fs.promises.rename(staged, loader);
		return "updated";
	}
	if (!available) return "unavailable";
	let state: unknown;
	try {
		state = JSON.parse(await fs.promises.readFile(statePath, "utf8"));
	} catch {}
	if (
		typeof state === "object" &&
		state !== null &&
		"loader" in state &&
		state.loader === loader &&
		"installed" in state &&
		state.installed === true
	)
		return "declined";
	await fs.promises.mkdir(path.dirname(loader), { recursive: true, mode: 0o700 });
	await fs.promises.writeFile(loader, content, { mode: 0o600, flag: "wx" });
	await remember(true);
	return "created";
}
