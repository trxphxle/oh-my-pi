import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { acquireFileLock, fetchWithRetry, isEnoent, ptree, withFileLock } from "@oh-my-pi/pi-utils";
import { HAISO_UPDATE_WORKER_ARG } from "../cli/worker-selectors";
import { replaceFileAtomically } from "../utils/atomic-file";
import { computeCompatibility, computeSourceFingerprint } from "./compatibility";
import {
	activateHaiso,
	currentHaisoRelease,
	type InstallReceipt,
	readHaisoRelease,
	rollbackHaiso,
	stageHaiso,
} from "./release";

export { computeCompatibility } from "./compatibility";

export interface HaisoUpdateRequest {
	action: "update" | "check" | "stage" | "apply" | "rollback" | "status" | "auto";
	candidateId?: string;
	enabled?: boolean;
	reviewed?: boolean;
	force?: boolean;
}

interface StableRelease {
	tag: string;
	version: string;
	commit: string;
}
interface Settings {
	schemaVersion: 1;
	enabled: boolean;
}
interface UpdateState {
	lastChecked?: string;
	latest?: StableRelease;
	message?: string;
}
interface Candidate {
	schemaVersion: 1;
	id: string;
	createdAt: string;
	baseRelease: string;
	baseExecutableSha256: string;
	baseForkPatchSha256: string;
	upstream: StableRelease;
	status: "staging" | "failed" | "verified";
	reasons: string[];
	checks: string[];
	sourceSha256?: string;
	patchSha256?: string;
	release?: string;
	executableSha256?: string;
	compatibility?: { state: string; broker: string };
}
interface Context {
	base: InstallReceipt;
	root: string;
	candidates: string;
}

const UPSTREAM = "https://github.com/can1357/oh-my-pi.git";
const API = "https://api.github.com/repos/can1357/oh-my-pi";
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^v\d+\.\d+\.\d+-[a-f0-9]{12}-[a-f0-9]{8}$/;
const MAX_PATCH = 16 * 1024 * 1024;
const MAX_JSON = 1024 * 1024;
const MAX_LOG = 256 * 1024;
const MAX_CANDIDATES = 4;
const MAX_RELEASES = 8;
const CADENCE = 24 * 60 * 60 * 1000;
const SETUP_GUIDANCE =
	"Guarded updates require a compiled Haiso release with a frozen fork.patch and matching standalone Bun. Run the Haiso release installer explicitly; legacy mutable/source installs are never taken over automatically.";

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
	return value as Record<string, unknown>;
}
function disabled(): boolean {
	return !!process.env.HAISO_DISABLE_UPDATES || !!process.env.HAISO_UPDATE_DISABLED;
}
function message(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(-4096);
}
async function hashFile(file: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of Bun.file(file).stream()) hash.update(chunk);
	return hash.digest("hex");
}
async function readJson(file: string): Promise<unknown> {
	const info = await fs.lstat(file);
	if (!info.isFile() || info.size > MAX_JSON) throw new Error(`Unsafe or oversized metadata: ${file}`);
	return JSON.parse(await Bun.file(file).text());
}
async function writeJson(file: string, value: unknown): Promise<void> {
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		await replaceFileAtomically(temporary, file);
	} finally {
		await fs.rm(temporary, { force: true });
	}
}
async function privateDirectory(directory: string, create = true): Promise<void> {
	if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const info = await fs.lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0 || info.uid !== process.getuid?.()) {
		throw new Error(`Updater directory must be owned and not group/world writable: ${directory}`);
	}
	if ((await fs.realpath(directory)) !== path.resolve(directory))
		throw new Error(`Updater directory has symlink ancestors: ${directory}`);
}
async function context(): Promise<Context> {
	let base: InstallReceipt | null;
	try {
		base = await currentHaisoRelease(process.env.HAISO_PREFIX);
	} catch (error) {
		throw new Error(`${message(error)}\n${SETUP_GUIDANCE}`);
	}
	if (!base) throw new Error(SETUP_GUIDANCE);
	const root = path.join(path.dirname(base.prefix), `${path.basename(base.prefix)}-update`);
	await privateDirectory(root);
	const candidates = path.join(root, "candidates");
	await privateDirectory(candidates);
	return { base, root, candidates };
}
async function settings(ctx: Context): Promise<Settings> {
	try {
		const value = object(await readJson(path.join(ctx.root, "settings.json")));
		if (value.schemaVersion !== 1 || typeof value.enabled !== "boolean") throw new Error("Invalid updater settings");
		return { schemaVersion: 1, enabled: value.enabled };
	} catch (error) {
		if (isEnoent(error)) return { schemaVersion: 1, enabled: false };
		throw error;
	}
}
async function state(ctx: Pick<Context, "root">): Promise<UpdateState> {
	try {
		return object(await readJson(path.join(ctx.root, "state.json"))) as UpdateState;
	} catch (error) {
		if (isEnoent(error)) return {};
		throw error;
	}
}
function settingsLock(ctx: Context): string {
	return path.join(ctx.root, "settings-operation");
}

/** Validate GitHub identity and stable semantics before any tag is used as a ref or a path. */
export function parseStableRelease(value: unknown): { tag: string; version: string } {
	const release = object(value);
	if (
		release.draft !== false ||
		release.prerelease !== false ||
		typeof release.tag_name !== "string" ||
		!TAG.test(release.tag_name) ||
		release.html_url !== `https://github.com/can1357/oh-my-pi/releases/tag/${release.tag_name}` ||
		typeof release.url !== "string" ||
		!/^https:\/\/api\.github\.com\/repos\/can1357\/oh-my-pi\/releases\/\d+$/.test(release.url)
	)
		throw new Error("GitHub did not return an official stable OMP release");
	const version = release.tag_name.slice(1);
	if (!Bun.semver.satisfies(version, ">=0.0.0")) throw new Error("Invalid stable OMP version");
	return { tag: release.tag_name, version };
}
async function githubJson(endpoint: string): Promise<unknown> {
	const response = await fetchWithRetry(`${API}${endpoint}`, {
		redirect: "error",
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "haiso-guarded-updater",
		},
		signal: AbortSignal.timeout(30_000),
		maxAttempts: 1,
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Official GitHub release discovery failed: HTTP ${response.status}`);
	}
	if (!response.body) throw new Error("Empty GitHub response");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if ((bytes += value.byteLength) > MAX_JSON) throw new Error("GitHub metadata exceeds updater size limit");
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function discover(): Promise<StableRelease> {
	const release = parseStableRelease(await githubJson("/releases/latest"));
	const ref = object(await githubJson(`/git/ref/tags/${release.tag}`));
	if (ref.ref !== `refs/tags/${release.tag}`) throw new Error("GitHub returned the wrong tag reference");
	let target = object(ref.object);
	for (let depth = 0; target.type === "tag" && depth < 4; depth++) {
		if (typeof target.sha !== "string" || !SHA.test(target.sha)) throw new Error("Invalid annotated tag object");
		const tag = object(await githubJson(`/git/tags/${target.sha}`));
		if (tag.sha !== target.sha) throw new Error("GitHub tag object identity mismatch");
		target = object(tag.object);
	}
	if (target.type !== "commit" || typeof target.sha !== "string" || !SHA.test(target.sha)) {
		throw new Error("Stable release tag does not resolve to a pinned commit");
	}
	return { ...release, commit: target.sha };
}
function transitionReasons(
	base: InstallReceipt,
	target: StableRelease,
	compatibility?: Candidate["compatibility"],
): string[] {
	const reasons: string[] = [];
	if (
		!TAG.test(base.upstream.tag) ||
		base.upstream.tag.split(".").slice(0, 2).join(".") !== target.tag.split(".").slice(0, 2).join(".")
	) {
		reasons.push("Minor/major upstream transition requires review");
	}
	if (compatibility?.state !== undefined && compatibility.state !== base.compatibility.state)
		reasons.push("Shared state/schema fingerprint changed; migration rollback is not provided");
	if (compatibility?.broker !== undefined && compatibility.broker !== base.compatibility.broker)
		reasons.push("Shared broker/wire fingerprint changed; running brokers will not be restarted");
	return reasons;
}
async function candidateIds(ctx: Context): Promise<string[]> {
	const ids: string[] = [];
	const directory = await fs.opendir(ctx.candidates);
	for await (const entry of directory) {
		if (!entry.isDirectory() || !ID.test(entry.name))
			throw new Error(`Unexpected updater candidate entry: ${entry.name}; manual cleanup required`);
		ids.push(entry.name);
		if (ids.length > MAX_CANDIDATES)
			throw new Error(`More than ${MAX_CANDIDATES} retained candidates; manual cleanup required`);
	}
	return ids.sort();
}
function candidatePath(ctx: Context, id: string): string {
	if (!ID.test(id)) throw new Error("Apply requires the exact candidate ID printed by update status");
	return path.join(ctx.candidates, id);
}
async function readCandidate(ctx: Context, id: string): Promise<Candidate> {
	const directory = candidatePath(ctx, id);
	await privateDirectory(directory, false);
	const recordFile = path.join(directory, "candidate.json");
	const seal = object(await readJson(`${recordFile}.sha256`));
	if (typeof seal.sha256 !== "string" || (await hashFile(recordFile)) !== seal.sha256)
		throw new Error(`Candidate metadata changed: ${id}`);
	const value = object(await readJson(recordFile));
	if (
		value.schemaVersion !== 1 ||
		value.id !== id ||
		!["staging", "failed", "verified"].includes(String(value.status)) ||
		!Array.isArray(value.reasons) ||
		!Array.isArray(value.checks)
	) {
		throw new Error(`Invalid candidate record: ${id}`);
	}
	const upstream = object(value.upstream);
	if (
		typeof upstream.tag !== "string" ||
		!TAG.test(upstream.tag) ||
		upstream.version !== upstream.tag.slice(1) ||
		typeof upstream.commit !== "string" ||
		!SHA.test(upstream.commit)
	)
		throw new Error("Invalid candidate upstream pin");
	if (
		typeof value.baseRelease !== "string" ||
		typeof value.baseExecutableSha256 !== "string" ||
		!DIGEST.test(value.baseExecutableSha256) ||
		typeof value.baseForkPatchSha256 !== "string" ||
		!DIGEST.test(value.baseForkPatchSha256)
	)
		throw new Error("Invalid candidate base pin");
	return value as unknown as Candidate;
}
async function saveCandidate(ctx: Context, candidate: Candidate): Promise<void> {
	const file = path.join(candidatePath(ctx, candidate.id), "candidate.json");
	await writeJson(file, candidate);
	await writeJson(`${file}.sha256`, { sha256: await hashFile(file) });
}
async function retainedReleaseLimit(ctx: Context): Promise<void> {
	let count = 0;
	const directory = await fs.opendir(path.dirname(ctx.base.prefix));
	const prefix = `.${path.basename(ctx.base.prefix)}-release-`;
	for await (const entry of directory) {
		if (entry.name.startsWith(prefix) && ++count >= MAX_RELEASES) {
			throw new Error(
				`${MAX_RELEASES} retained releases reached; manually inspect and clean inactive releases before staging. No release was deleted.`,
			);
		}
	}
}
function isolatedEnv(home: string, runtime: string): NodeJS.ProcessEnv {
	// No inherited provider keys, proxy credentials, profile, broker socket, NODE_OPTIONS or BUN_OPTIONS.
	return {
		HOME: home,
		USERPROFILE: home,
		PATH: `${path.dirname(runtime)}${path.delimiter}/usr/bin${path.delimiter}/bin${path.delimiter}/usr/sbin${path.delimiter}/sbin${path.delimiter}/opt/homebrew/bin${path.delimiter}/usr/local/bin`,
		TMPDIR: path.join(home, "tmp"),
		TMP: path.join(home, "tmp"),
		TEMP: path.join(home, "tmp"),
		XDG_CONFIG_HOME: path.join(home, "config"),
		XDG_DATA_HOME: path.join(home, "data"),
		XDG_STATE_HOME: path.join(home, "state"),
		XDG_CACHE_HOME: path.join(home, "cache"),
		PI_CODING_AGENT_DIR: path.join(home, "agent"),
		OMP_AGENT_DIR: path.join(home, "agent"),
		HAISO_DISABLE_UPDATES: "1",
		HAISO_UPDATE_DISABLED: "1",
		CI: "1",
		NO_COLOR: "1",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: os.devNull,
		GIT_TERMINAL_PROMPT: "0",
		BUN_INSTALL_CACHE_DIR: path.join(home, "cache", "bun"),
		npm_config_cache: path.join(home, "cache", "npm"),
		npm_config_userconfig: os.devNull,
	};
}
async function command(
	command: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	log: string,
	signal: AbortSignal,
): Promise<string> {
	using child = ptree.spawn(command, { cwd, env, signal, timeout: 15 * 60 * 1000 });
	const decoder = new TextDecoder();
	let tail = "";
	for await (const chunk of child.stdout) tail = (tail + decoder.decode(chunk, { stream: true })).slice(-MAX_LOG);
	const exitCode = await child.exited;
	tail = `${tail}${decoder.decode()}\n${child.peekStderr()}`.slice(-MAX_LOG);
	await fs.writeFile(log, `${command.join(" ")}\n${tail}`, { mode: 0o600 });
	signal.throwIfAborted();
	if (exitCode !== 0 || child.exitReason)
		throw new Error(`Verification command failed: ${command.join(" ")}\n${tail.slice(-8192)}`);
	return tail;
}
async function assertNoConflicts(source: string): Promise<void> {
	const repo = vcs.requireGit(source);
	const status = await repo.statusPorcelain({ untracked: "no" });
	if (status.split("\n").some(line => /^(?:DD|AU|UD|UA|DU|AA|UU) /.test(line))) {
		throw new Error("Source conflicts remain; reviewed activation cannot bypass conflicts");
	}
}
async function assertBase(ctx: Context, candidate?: Candidate): Promise<InstallReceipt> {
	const current = await currentHaisoRelease(ctx.base.prefix);
	if (
		!current ||
		current.release !== (candidate?.baseRelease ?? ctx.base.release) ||
		current.executableSha256 !== (candidate?.baseExecutableSha256 ?? ctx.base.executableSha256) ||
		current.forkPatchSha256 !== (candidate?.baseForkPatchSha256 ?? ctx.base.forkPatchSha256)
	) {
		throw new Error("Active release changed since this candidate was based; stage a new candidate");
	}
	return current;
}
async function installNative(
	source: string,
	directory: string,
	runtime: string,
	version: string,
	env: NodeJS.ProcessEnv,
	log: string,
	signal: AbortSignal,
): Promise<void> {
	const repo = vcs.requireGit(source);
	const changed = await repo.changedFiles({ cached: true });
	if (
		changed.some(file =>
			/^(?:crates\/|third_party\/|\.cargo\/|Cargo\.(?:toml|lock)$|MODULE\.bazel(?:\.lock)?$)/.test(file),
		)
	) {
		await command([runtime, "run", "build:native"], source, env, log, signal);
		return;
	}
	if (!["darwin", "linux", "win32"].includes(process.platform) || !["arm64", "x64"].includes(process.arch))
		throw new Error("No supported native leaf for this platform");
	const platform = `${process.platform}-${process.arch}`;
	const name = `@oh-my-pi/pi-natives-${platform}`;
	const nativeDir = path.join(directory, "native-package");
	await privateDirectory(nativeDir);
	await writeJson(path.join(nativeDir, "package.json"), {
		private: true,
		name: "haiso-pinned-native",
		dependencies: { [name]: version },
	});
	await command(
		[runtime, "install", "--ignore-scripts", "--registry=https://registry.npmjs.org"],
		nativeDir,
		env,
		log,
		signal,
	);
	const leaf = path.join(nativeDir, "node_modules", name);
	const manifest = object(await readJson(path.join(leaf, "package.json")));
	if (manifest.name !== name || manifest.version !== version) throw new Error("Native leaf identity/version mismatch");
	const entries = await fs.readdir(leaf, { withFileTypes: true });
	let copied = 0;
	for (const entry of entries) {
		if (!entry.name.startsWith(`pi_natives.${platform}`) || !entry.name.endsWith(".node")) continue;
		if (!entry.isFile() || ++copied > 3) throw new Error("Unexpected native leaf payload");
		await fs.copyFile(path.join(leaf, entry.name), path.join(source, "packages/natives/native", entry.name));
	}
	if (copied === 0) throw new Error("Pinned native leaf contains no matching native binary");
}
async function stage(ctx: Context, upstream: StableRelease, output: (line: string) => void): Promise<Candidate> {
	const ids = await candidateIds(ctx);
	if (ids.length >= MAX_CANDIDATES)
		throw new Error(
			`${MAX_CANDIDATES} retained candidates reached; inspect update status and manually clean inactive candidates`,
		);
	await retainedReleaseLimit(ctx);
	await assertBase(ctx);
	const patchInfo = await fs.lstat(ctx.base.forkPatch);
	if (!patchInfo.isFile() || patchInfo.size === 0 || patchInfo.size > MAX_PATCH)
		throw new Error("Frozen fork.patch is missing, empty or exceeds 16 MiB");
	const patch = await Bun.file(ctx.base.forkPatch).text();
	if ((await hashFile(ctx.base.forkPatch)) !== ctx.base.forkPatchSha256)
		throw new Error("Installed fork.patch changed");
	const candidate: Candidate = {
		schemaVersion: 1,
		id: `${upstream.tag}-${upstream.commit.slice(0, 12)}-${randomUUID().slice(0, 8)}`,
		createdAt: new Date().toISOString(),
		baseRelease: ctx.base.release,
		baseExecutableSha256: ctx.base.executableSha256,
		baseForkPatchSha256: ctx.base.forkPatchSha256,
		upstream,
		status: "staging",
		reasons: transitionReasons(ctx.base, upstream),
		checks: [],
	};
	const directory = candidatePath(ctx, candidate.id);
	await privateDirectory(directory);
	await saveCandidate(ctx, candidate);
	const source = path.join(directory, "source");
	let home: string | undefined;
	const log = path.join(directory, "verification.log");
	const signal = AbortSignal.timeout(45 * 60 * 1000);
	const runtime = ctx.base.runtime.installedPath;
	try {
		// Unix-domain worker sockets need a short absolute path, not the deeply nested candidate directory.
		home = await fs.mkdtemp(path.join(await fs.realpath(process.platform === "win32" ? os.tmpdir() : "/tmp"), "hv-"));
		await privateDirectory(home);
		await fs.mkdir(path.join(home, "tmp"), { mode: 0o700 });
		const env = isolatedEnv(home, runtime);
		// Force nested build scripts' plain `bun` invocations to the verified standalone runtime.
		const toolBin = path.join(home, "bin");
		await privateDirectory(toolBin);
		await fs.symlink(runtime, path.join(toolBin, process.platform === "win32" ? "bun.exe" : "bun"));
		env.PATH = `${toolBin}${path.delimiter}${env.PATH}`;
		output(`Staging ${candidate.id} from pinned ${upstream.commit}`);
		// Start at the frozen base so three-way preimages are present. Omitting
		// clone.sha selects the central API's shallow clone; fetching forward
		// retains that boundary instead of downloading all repository history.
		await vcs.clone(UPSTREAM, source, { refName: ctx.base.upstream.tag, timeoutMs: 10 * 60 * 1000 }, signal);
		const repo = vcs.requireGit(source);
		if (
			(await repo.headSha(signal)) !== ctx.base.upstream.commit ||
			(await repo.commitDetails(`refs/tags/${ctx.base.upstream.tag}`, signal)).sha !== ctx.base.upstream.commit
		)
			throw new Error("Frozen upstream base tag moved; no source was executed");
		if (upstream.commit !== ctx.base.upstream.commit) {
			await repo.fetch(UPSTREAM, `refs/tags/${upstream.tag}`, `refs/tags/${upstream.tag}`, 10 * 60 * 1000, signal);
		}
		if ((await repo.commitDetails(`refs/tags/${upstream.tag}`, signal)).sha !== upstream.commit)
			throw new Error("Official release tag moved; no source was executed");
		await repo.checkout(upstream.commit, signal);
		if ((await repo.headSha(signal)) !== upstream.commit) throw new Error("Candidate checkout lost its commit pin");
		await repo.applyPatch(patch, { threeWay: true }, signal);
		await assertNoConflicts(source);
		const changes = await repo.changedFiles({ base: upstream.commit }, signal);
		const additions = await repo.lsFiles(true, true, signal);
		await repo.stageFiles([...new Set([...changes, ...additions])], signal);
		const frozenPatch = await repo.diffText(
			{ cached: true, base: upstream.commit, binary: true, maxBytes: MAX_PATCH },
			signal,
		);
		const frozenPath = path.join(directory, "fork.patch");
		await fs.writeFile(frozenPath, frozenPatch, { flag: "wx", mode: 0o600 });
		const packageManifest = object(await readJson(path.join(source, "packages/coding-agent/package.json")));
		const nativeManifest = object(await readJson(path.join(source, "packages/natives/package.json")));
		if (packageManifest.version !== upstream.version || nativeManifest.version !== upstream.version)
			throw new Error(
				"Fork overlay changes the pinned upstream package version; resolve and freeze a new fork patch manually",
			);
		const rootManifest = object(await readJson(path.join(source, "package.json")));
		const manager = rootManifest.packageManager;
		if (
			typeof manager !== "string" ||
			!manager.startsWith("bun@") ||
			!Bun.semver.satisfies(ctx.base.runtime.version, manager.slice(4))
		)
			throw new Error(
				`Installed standalone Bun ${ctx.base.runtime.version} does not satisfy pinned candidate packageManager ${String(manager)}; install a reviewed matching runtime`,
			);
		const compatibility = await computeCompatibility(source);
		candidate.reasons = transitionReasons(ctx.base, upstream, compatibility);
		candidate.compatibility = compatibility;
		await saveCandidate(ctx, candidate);
		output("Installing the candidate's frozen dependencies (lifecycle scripts disabled)");
		await command([runtime, "install", "--frozen-lockfile", "--ignore-scripts"], source, env, log, signal);
		await installNative(source, directory, runtime, upstream.version, env, log, signal);
		await command([runtime, "run", "gen:tool-views"], path.join(source, "packages/collab-web"), env, log, signal);
		const verifiedSource = await computeSourceFingerprint(source);
		const verifiedPatch = await hashFile(frozenPath);
		const checks: [string, string[], string][] = [
			[
				"Haiso regression tests",
				[
					runtime,
					"test",
					"--timeout",
					"120000",
					"./packages/coding-agent/test/discord-mode",
					"./packages/coding-agent/test/haiso-update",
					"./scripts/install-haiso.test.ts",
				],
				source,
			],
			["Connector regression tests", [runtime, "test", "./test"], path.join(source, "packages/omp-bridge")],
			["Haiso type check", [runtime, "run", "check:types"], path.join(source, "packages/coding-agent")],
			["Connector type check", [runtime, "run", "check:types"], path.join(source, "packages/omp-bridge")],
			["Production binary build", [runtime, "run", "build"], path.join(source, "packages/coding-agent")],
		];
		for (const [label, argv, cwd] of checks) {
			output(label);
			await command(argv, cwd, env, log, signal);
			candidate.checks.push(label);
			await saveCandidate(ctx, candidate);
		}
		const binary = path.join(source, "packages/coding-agent/dist", process.platform === "win32" ? "omp.exe" : "omp");
		const verifiedBinary = await hashFile(binary);
		output("Running compiled native/worker smoke in isolated empty state");
		const version = await command([binary, "--version"], home, env, log, signal);
		if (!version.includes(upstream.version)) throw new Error("Compiled release reports a different version");
		await command([binary, "--help"], home, env, log, signal);
		const smoke = await command([binary, "--smoke-test"], home, env, log, signal);
		if (!smoke.includes("smoke-test: ok")) throw new Error("Compiled worker smoke did not finish successfully");
		candidate.checks.push("Compiled native/worker smoke");
		await assertNoConflicts(source);
		if ((await repo.headSha(signal)) !== upstream.commit)
			throw new Error("Candidate source commit changed during verification");
		const finalCompatibility = await computeCompatibility(source);
		if (finalCompatibility.state !== compatibility.state || finalCompatibility.broker !== compatibility.broker)
			throw new Error("State/broker sources changed during verification");
		candidate.sourceSha256 = await computeSourceFingerprint(source);
		if (candidate.sourceSha256 !== verifiedSource || (await hashFile(frozenPath)) !== verifiedPatch)
			throw new Error("Candidate content changed during verification; no release was staged");
		candidate.patchSha256 = await hashFile(frozenPath);
		await assertBase(ctx, candidate);
		const release = await stageHaiso({
			binary,
			runtime,
			forkPatch: frozenPath,
			upstream: { tag: upstream.tag, commit: upstream.commit },
			compatibility,
			prefix: ctx.base.prefix,
			binDir: path.dirname(ctx.base.launcher),
		});
		if (release.executableSha256 !== verifiedBinary || release.forkPatchSha256 !== verifiedPatch) {
			throw new Error(
				"Compiled executable or frozen patch changed after verification; staged release was not activated",
			);
		}
		candidate.release = release.release;
		candidate.executableSha256 = release.executableSha256;
		candidate.status = "verified";
		await saveCandidate(ctx, candidate);
		output(
			`Verified candidate ${candidate.id}${candidate.reasons.length ? `; held: ${candidate.reasons.join("; ")}` : "; compatible with the active release"}`,
		);
		return candidate;
	} catch (error) {
		candidate.status = "failed";
		candidate.reasons.push(message(error));
		await saveCandidate(ctx, candidate);
		throw new Error(`Candidate ${candidate.id} was held; no activation occurred. ${message(error)}`);
	} finally {
		if (home) {
			try {
				await fs.rm(home, { recursive: true, force: true });
			} catch (error) {
				output(`Verification files remain at ${home}: ${message(error)}. The verification result was retained.`);
			}
		}
	}
}

async function apply(
	ctx: Context,
	candidate: Candidate,
	reviewed: boolean,
	automatic: boolean,
	output: (line: string) => void,
): Promise<void> {
	let activated = false;
	try {
		if (
			candidate.status !== "verified" ||
			!candidate.release ||
			!candidate.sourceSha256 ||
			!candidate.patchSha256 ||
			!candidate.executableSha256 ||
			!candidate.compatibility
		)
			throw new Error("Only a fully verified candidate can be activated; --reviewed never bypasses failed checks");
		await assertBase(ctx, candidate);
		const directory = candidatePath(ctx, candidate.id);
		const source = path.join(directory, "source");
		await assertNoConflicts(source);
		if (
			(await vcs.requireGit(source).headSha()) !== candidate.upstream.commit ||
			(await computeSourceFingerprint(source)) !== candidate.sourceSha256 ||
			(await hashFile(path.join(directory, "fork.patch"))) !== candidate.patchSha256
		)
			throw new Error("Candidate content changed after verification; stage a new candidate");
		const release = await readHaisoRelease(candidate.release);
		if (
			release.prefix !== ctx.base.prefix ||
			release.executableSha256 !== candidate.executableSha256 ||
			release.forkPatchSha256 !== candidate.patchSha256 ||
			release.upstream.commit !== candidate.upstream.commit ||
			release.upstream.tag !== candidate.upstream.tag ||
			release.compatibility.state !== candidate.compatibility.state ||
			release.compatibility.broker !== candidate.compatibility.broker
		)
			throw new Error("Verified candidate release receipt changed");
		const reasons = transitionReasons(ctx.base, candidate.upstream, candidate.compatibility);
		if (reasons.length && !reviewed) {
			candidate.reasons = reasons;
			await saveCandidate(ctx, candidate);
			output(
				`Held ${candidate.id}: ${reasons.join("; ")}. Review it, then use update --apply ${candidate.id} --reviewed.`,
			);
			return;
		}
		// Independent of the long build lease: auto-off stays responsive during a build.
		await withFileLock(
			settingsLock(ctx),
			async () => {
				if (automatic && (disabled() || !(await settings(ctx)).enabled)) {
					candidate.reasons = ["Automatic updates were disabled before activation"];
					await saveCandidate(ctx, candidate);
					output(`Held ${candidate.id}: automatic updates are off`);
					return;
				}
				await assertBase(ctx, candidate);
				await activateHaiso(candidate.release!, { expectedCurrent: candidate.baseRelease, reviewed });
				activated = true;
				candidate.reasons = [];
				await saveCandidate(ctx, candidate);
				output(
					`Activated ${candidate.id} for new Haiso processes. Existing processes and brokers were not restarted.`,
				);
			},
			{ retries: 100, retryDelayMs: 100 },
		);
	} catch (error) {
		if (activated) {
			throw new Error(
				`Release activation succeeded, but saving updater status failed: ${message(error)}. Inspect the current release before retrying.`,
			);
		}
		candidate.reasons = [`Activation refused: ${message(error)}`];
		await saveCandidate(ctx, candidate);
		throw error;
	}
}
async function status(ctx: Context, output: (line: string) => void): Promise<void> {
	output(`Current: ${ctx.base.version} (${ctx.base.upstream.tag}, ${ctx.base.upstream.commit})`);
	output(`Release: ${ctx.base.release}`);
	output(
		`Automatic updates: ${(await settings(ctx)).enabled ? "on" : "off"}${disabled() ? " (disabled by environment)" : ""}`,
	);
	const last = await state(ctx);
	if (last.lastChecked) output(`Last check: ${last.lastChecked}${last.message ? `; ${last.message}` : ""}`);
	for (const id of await candidateIds(ctx)) {
		try {
			const candidate = await readCandidate(ctx, id);
			const activity = candidate.release === ctx.base.release ? "active" : candidate.status;
			output(
				`${id}: ${activity}; base ${candidate.baseRelease}; ${candidate.checks.length} checks passed${candidate.reasons.length ? `; held: ${candidate.reasons.join("; ")}` : ""}`,
			);
		} catch (error) {
			output(`${id}: held: ${message(error)}`);
		}
	}
	output(
		`Updater data: ${ctx.root}. Retention limits: ${MAX_CANDIDATES} candidates / ${MAX_RELEASES} releases; cleanup is manual and must exclude running/active releases.`,
	);
}
async function update(
	ctx: Context,
	request: HaisoUpdateRequest,
	automatic: boolean,
	output: (line: string) => void,
): Promise<void> {
	const previous = await state(ctx);
	if (automatic && Date.now() - Date.parse(previous.lastChecked ?? "") < CADENCE) return;
	if (automatic && !(await settings(ctx)).enabled) return;
	const checkedAt = new Date().toISOString();
	await writeJson(path.join(ctx.root, "state.json"), {
		...previous,
		lastChecked: checkedAt,
		message: "Checking official stable releases",
	});
	try {
		const latest = await discover();
		await writeJson(path.join(ctx.root, "state.json"), {
			lastChecked: checkedAt,
			latest,
			message: `Latest stable: ${latest.tag} (${latest.commit})`,
		});
		output(`Official stable: ${latest.tag} (${latest.commit})`);
		const order = Bun.semver.order(latest.version, ctx.base.upstream.tag.slice(1));
		if (order === 0 && latest.commit !== ctx.base.upstream.commit)
			throw new Error("Official tag changed its commit; refusing retagged release");
		if (order < 0 || (order === 0 && (automatic || !request.force || request.action === "check"))) {
			output("No newer official stable release");
			return;
		}
		if (order === 0) output("Rebuilding the same pinned release; all verification and activation guards still apply");
		if (request.action === "check") {
			const reasons = transitionReasons(ctx.base, latest);
			if (reasons.length) output(`Review required: ${reasons.join("; ")}`);
			return;
		}
		for (const id of await candidateIds(ctx)) {
			const held = await readCandidate(ctx, id);
			if (held.upstream.commit !== latest.commit || held.baseRelease !== ctx.base.release) continue;
			output(`Existing ${held.status} candidate: ${id}${held.reasons.length ? `; ${held.reasons.join("; ")}` : ""}`);
			if (held.status === "verified") {
				if (request.action === "update") await apply(ctx, held, false, automatic, output);
				return;
			}
			// Repeated background attempts never consume another candidate for the same failed base.
			if (!request.force || automatic) return;
		}
		const candidate = await stage(ctx, latest, output);
		if (request.action === "update") await apply(ctx, candidate, false, automatic, output);
	} catch (error) {
		await writeJson(path.join(ctx.root, "state.json"), { lastChecked: checkedAt, message: message(error) });
		throw error;
	}
}

export async function runHaisoUpdate(request: HaisoUpdateRequest, output: (line: string) => void): Promise<void> {
	const ctx = await context();
	if (request.reviewed && (request.action !== "apply" || !request.candidateId) && request.action !== "rollback")
		throw new Error("--reviewed requires apply with an exact candidate ID, or an explicit rollback");
	if (request.action === "auto") {
		if (typeof request.enabled !== "boolean") throw new Error("Specify auto on or auto off");
		await withFileLock(
			settingsLock(ctx),
			() => writeJson(path.join(ctx.root, "settings.json"), { schemaVersion: 1, enabled: request.enabled }),
			{ retries: 100, retryDelayMs: 100 },
		);
		output(
			`Automatic updates ${request.enabled ? "enabled" : "disabled"}; checks run at most daily on managed Haiso launches`,
		);
		return;
	}
	if (request.action === "status") return status(ctx, output);
	const lock = await acquireFileLock(path.join(ctx.root, "worker"), { retries: 1 });
	try {
		if (request.action === "apply") {
			if (!request.candidateId) throw new Error("Apply requires an exact candidate ID");
			await apply(ctx, await readCandidate(ctx, request.candidateId), request.reviewed === true, false, output);
		} else if (request.action === "rollback") {
			await withFileLock(settingsLock(ctx), async () => {
				await assertBase(ctx);
				// An intentional rollback must not be silently undone at the next automatic check.
				await writeJson(path.join(ctx.root, "settings.json"), { schemaVersion: 1, enabled: false });
				const release = await rollbackHaiso({ prefix: ctx.base.prefix, reviewed: request.reviewed });
				output(
					`Rolled back executable for new processes to ${release.release}; auto updates are off, shared state was not restored, and brokers were not restarted`,
				);
			});
		} else await update(ctx, request, false, output);
	} finally {
		lock.release();
	}
}

/** Normal startup scheduling must never write to the TUI or execute a mutable source entrypoint. */
export function scheduleHaisoUpdate(): void {
	if (disabled() || process.env.PI_COMPILED !== "true") return;
	void (async () => {
		// Read the tiny opt-in file before hashing the compiled release on an ordinary launch.
		const prefix = process.env.HAISO_PREFIX ?? path.join(os.homedir(), ".local/share/haiso/fork");
		const updateRoot = path.join(path.dirname(prefix), `${path.basename(prefix)}-update`);
		const optIn = object(await readJson(path.join(updateRoot, "settings.json")));
		if (optIn.schemaVersion !== 1 || optIn.enabled !== true) return;
		const previous = await state({ root: updateRoot });
		if (Date.now() - Date.parse(previous.lastChecked ?? "") < CADENCE) return;
		const ctx = await context();
		if (
			!(await settings(ctx)).enabled ||
			(await fs.realpath(process.execPath)) !== (await fs.realpath(ctx.base.executable))
		)
			return;
		// Every child re-enters the pinned immutable executable; the OS lease arbitrates concurrent launches.
		const child = Bun.spawn([ctx.base.executable, HAISO_UPDATE_WORKER_ARG], {
			cwd: ctx.root,
			env: { ...process.env, HAISO_PREFIX: ctx.base.prefix },
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			detached: true,
		});
		child.unref();
	})().catch(() => {});
}

export async function runHaisoUpdateWorker(): Promise<void> {
	if (disabled() || process.env.PI_COMPILED !== "true") return;
	const ctx = await context();
	if (
		(await fs.realpath(process.execPath)) !== (await fs.realpath(ctx.base.executable)) ||
		!(await settings(ctx)).enabled
	)
		return;
	let lock;
	try {
		lock = await acquireFileLock(path.join(ctx.root, "worker"), { retries: 1 });
	} catch {
		return;
	}
	let log = "";
	try {
		await update(ctx, { action: "update" }, true, line => {
			log = `${log}${line}\n`.slice(-MAX_LOG);
		});
	} catch (error) {
		log = `${log}${message(error)}\n`.slice(-MAX_LOG);
	} finally {
		try {
			await fs.writeFile(path.join(ctx.root, "worker.log"), log, { mode: 0o600 });
		} finally {
			lock.release();
		}
	}
}
