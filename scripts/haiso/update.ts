#!/usr/bin/env bun
/**
 * Haiso updater: rebuilds the `haiso` branch merged with the installed official omp version,
 * verifies the candidate end to end, then atomically activates it as a new immutable release.
 *
 *   bun scripts/haiso/update.ts [--check | --status | --rollback | --auto on|off | --background] [--force]
 *
 * The release launcher routes `haiso update …` here and schedules `--background` at most daily.
 */
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { $which, acquireFileLock, type FileLockHandle, isEnoent, ptree } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { containsVersionSentinel, versionSentinelFor } from "../../packages/natives/native/version-sentinel.js";
import {
	activateHaiso,
	currentHaisoRelease,
	defaultPrefix,
	defaultStateDir,
	ensureHaisoBridgeLoader,
	type InstallReceipt,
	rollbackHaiso,
	shellQuote,
	stageHaiso,
} from "./release";

const REPO = path.resolve(import.meta.dir, "../..");
const UPSTREAM_URL = "https://github.com/can1357/oh-my-pi.git";
const BRANCH = "haiso";
const NEXT_BRANCH = "haiso-next";
const MERGE_DRIVER = "haiso-bunlock";
const MINUTE = 60_000;
const MAX_LOG = 2 * 1024 * 1024;
const MAX_TAIL = 256 * 1024;
/** Paths whose changes invalidate a prebuilt native addon. */
const NATIVE_INPUT = /^(?:crates\/|third_party\/|\.cargo\/|Cargo\.(?:toml|lock)$|MODULE\.bazel(?:\.lock)?$)/;
const NATIVE_PATHSPECS = [
	"crates",
	"third_party",
	".cargo",
	"Cargo.toml",
	"Cargo.lock",
	"MODULE.bazel",
	"MODULE.bazel.lock",
];
/** Machine-local or bulky ~/.omp entries the real-data sandbox never copies. */
const SANDBOX_SKIP: Record<string, true> = {
	natives: true,
	puppeteer: true,
	run: true,
	logs: true,
	"discord-bridge": true,
	collab: true,
	"agent-coordination": true,
	"agent/discord-mode": true,
};
const SANDBOX_DESCEND: Record<string, true> = { agent: true };

const USAGE = `Usage: haiso update [--check | --status | --rollback | --auto on|off] [--force]

  (no option)     Merge the installed official omp version into the haiso branch, verify, build and activate.
  --check         Show what an update would do; changes nothing.
  --status        Show the installed release, automatic-update setting and last update result.
  --rollback      Re-activate the previous release and turn automatic updates off.
  --auto on|off   Toggle the daily background check (it only builds new upstream versions).
  --force         Rebuild even when the installed release is current.`;

type Action =
	| { kind: "update" | "check"; force: boolean }
	| { kind: "status" | "rollback" | "background" | "help" }
	| { kind: "auto"; enabled: boolean };

interface Status {
	result: "ok" | "up-to-date" | "conflict" | "failed";
	message: string;
	at: string;
	tag: string;
	haisoCommit?: string;
	commit?: string;
	worktree?: string;
}

interface Target {
	omp: string;
	version: string;
	tag: string;
}

interface Plan {
	state: "run" | "current" | "downgrade";
	/** Background checks only build upstream version changes, never new haiso commits. */
	background: boolean;
	reason: string;
}

interface RunResult {
	code: number | null;
	output: string;
	stdout: string;
	stderr: string;
}

interface Context {
	session: Session;
	repo: string;
	prefix: string;
	stateDir: string;
	current: InstallReceipt | null;
	target: Target;
	tip: string;
	force: boolean;
	previous: Status | null;
}

/** Refusals leave the recorded update status untouched. */
class Refusal extends Error {}

/** Merge conflicts keep the candidate worktree for manual resolution. */
class MergeConflict extends Error {
	constructor(
		message: string,
		readonly worktree: string,
	) {
		super(message);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function tailLines(text: string, count: number): string {
	return text.trimEnd().split("\n").slice(-count).join("\n");
}

/** One update attempt: prints progress when verbose and keeps a bounded log of every command. */
class Session {
	#log = "";
	readonly logFile: string;
	readonly verbose: boolean;

	constructor(stateDir: string, verbose: boolean) {
		this.logFile = path.join(stateDir, "last-update.log");
		this.verbose = verbose;
	}

	say(line: string): void {
		this.record(`${line}\n`);
		if (this.verbose) console.log(line);
	}

	record(text: string): void {
		this.#log += text;
		if (this.#log.length > MAX_LOG) this.#log = `[earlier output truncated]\n${this.#log.slice(-MAX_LOG)}`;
	}

	async flush(): Promise<void> {
		await fs.writeFile(this.logFile, this.#log, { mode: 0o600 });
	}

	async git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
		const result = await $`git ${args}`.cwd(cwd).quiet().nothrow();
		const stdout = result.stdout.toString();
		const stderr = result.stderr.toString();
		this.record(`\n$ git ${args.join(" ")}  (in ${cwd})\n${stdout}${stderr}[exit ${result.exitCode}]\n`);
		return { code: result.exitCode, stdout, stderr };
	}

	async run(
		argv: string[],
		cwd: string,
		env: NodeJS.ProcessEnv,
		timeoutMs: number,
		options: { onLine?: (line: string) => void; logOutput?: boolean } = {},
	): Promise<RunResult> {
		this.record(`\n$ ${argv.join(" ")}  (in ${cwd})\n`);
		using child = ptree.spawn(argv, { cwd, env, timeout: timeoutMs, detached: true, stderr: "full" });
		const tails = { output: "", stdout: "", stderr: "" };
		const pump = async (stream: ReadableStream<Uint8Array>, channel: "stdout" | "stderr") => {
			const decoder = new TextDecoder();
			let partial = "";
			const take = (text: string) => {
				tails.output = (tails.output + text).slice(-MAX_TAIL);
				tails[channel] = (tails[channel] + text).slice(-MAX_TAIL);
				if (!options.onLine) return;
				const lines = (partial + text).split("\n");
				partial = lines.pop() ?? "";
				for (const line of lines) options.onLine(line);
			};
			for await (const chunk of stream) take(decoder.decode(chunk, { stream: true }));
			take(decoder.decode());
			if (partial) options.onLine?.(partial);
		};
		const reading = Promise.all([pump(child.stdout, "stdout"), pump(child.stderr!, "stderr")]);
		let code: number | null;
		try {
			code = await child.exited;
		} catch {
			code = null;
		}
		// A leaked descendant holding the pipes open must not stall the updater.
		const drained = await Promise.race([reading.then(() => true), Bun.sleep(5_000).then(() => false)]);
		if (!drained) child.kill();
		await reading.catch(() => {});
		if (options.logOutput !== false) this.record(tails.output.endsWith("\n") ? tails.output : `${tails.output}\n`);
		this.record(`[${code === null ? `killed: ${child.exitReason?.message ?? "timeout"}` : `exit ${code}`}]\n`);
		await this.flush();
		return { code, ...tails };
	}

	async step(
		label: string,
		argv: string[],
		cwd: string,
		env: NodeJS.ProcessEnv,
		timeoutMs: number,
	): Promise<RunResult> {
		this.say(`• ${label}`);
		const result = await this.run(argv, cwd, env, timeoutMs);
		if (result.code !== 0) {
			throw new Error(
				`${label} failed (${result.code === null ? "timed out or killed" : `exit ${result.code}`}):\n${tailLines(result.output, 25)}`,
			);
		}
		return result;
	}
}

function parseArgs(argv: string[]): Action {
	let action: Action | undefined;
	let force = false;
	const set = (next: Action) => {
		if (action) throw new Error("Only one action may be given.");
		action = next;
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		switch (arg) {
			case "--force":
				force = true;
				break;
			case "--check":
				set({ kind: "check", force: false });
				break;
			case "--status":
			case "--rollback":
			case "--background":
				set({ kind: arg.slice(2) as "status" | "rollback" | "background" });
				break;
			case "--help":
			case "-h":
				set({ kind: "help" });
				break;
			case "--auto": {
				const value = argv[++index];
				if (value !== "on" && value !== "off") throw new Error("--auto requires on or off.");
				set({ kind: "auto", enabled: value === "on" });
				break;
			}
			default:
				throw new Error(`Unknown option: ${arg}`);
		}
	}
	const chosen: Action = action ?? { kind: "update", force: false };
	if (force) {
		if (chosen.kind !== "update" && chosen.kind !== "check")
			throw new Error("--force applies only to an update or --check.");
		return { kind: chosen.kind, force };
	}
	return chosen;
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.lstat(file);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

async function readObject(file: string): Promise<Record<string, unknown>> {
	const value: unknown = JSON.parse(await Bun.file(file).text());
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`Expected a JSON object: ${file}`);
	return value as Record<string, unknown>;
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
	const temporary = `${file}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		await fs.rename(temporary, file);
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

async function ensureStateDir(stateDir: string): Promise<void> {
	await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
	const info = await fs.lstat(stateDir);
	if (!info.isDirectory() || (info.mode & 0o022) !== 0 || info.uid !== process.getuid?.())
		throw new Error(`Updater state directory must be a private directory owned by you: ${stateDir}`);
}

async function autoEnabled(stateDir: string): Promise<boolean> {
	try {
		return (await readObject(path.join(stateDir, "settings.json"))).enabled === true;
	} catch {
		return false;
	}
}

async function readStatus(stateDir: string): Promise<Status | null> {
	try {
		const value = await readObject(path.join(stateDir, "status.json"));
		return typeof value.result === "string" && typeof value.tag === "string" ? (value as unknown as Status) : null;
	} catch {
		return null;
	}
}

/** Record the outcome; held results leave a one-line notice the launcher prints on every start. */
async function finish(stateDir: string, status: Status): Promise<void> {
	await writeJsonAtomic(path.join(stateDir, "status.json"), status);
	const notice = path.join(stateDir, "notice");
	if (status.result === "conflict" || status.result === "failed") {
		await fs.writeFile(
			notice,
			`haiso: update to ${status.tag} held (${status.result}) — run: haiso update --status\n`,
			{
				mode: 0o600,
			},
		);
	} else await fs.rm(notice, { force: true });
}

async function makeWritable(directory: string): Promise<void> {
	await fs.chmod(directory, 0o700).catch(() => {});
	let entries: Dirent[] = [];
	try {
		entries = await fs.readdir(directory, { withFileTypes: true });
	} catch {}
	for (const entry of entries) if (entry.isDirectory()) await makeWritable(path.join(directory, entry.name));
}

async function forceRemove(target: string): Promise<void> {
	try {
		await fs.rm(target, { recursive: true, force: true });
	} catch {
		await makeWritable(target);
		await fs.rm(target, { recursive: true, force: true });
	}
}

/** The installed official omp decides the upstream version Haiso tracks. */
async function officialOmp(prefix: string): Promise<Target> {
	const found = $which("omp");
	if (!found)
		throw new Error("official omp is not on PATH; Haiso tracks the installed omp version, so install omp first.");
	const real = await fs.realpath(found);
	const haisoRoot = await fs.realpath(path.dirname(prefix)).catch(() => path.dirname(prefix));
	if (real === haisoRoot || real.startsWith(`${haisoRoot}${path.sep}`))
		throw new Error(`${found} resolves into the Haiso install (${real}); it must be the official omp.`);
	let stdout = "";
	try {
		stdout = (await ptree.exec([real, "--version"], { timeout: 30_000, allowNonZero: true })).stdout.trim();
	} catch (error) {
		throw new Error(`\`${real} --version\` failed: ${errorMessage(error)}`);
	}
	const version = /^omp\/(\d+\.\d+\.\d+)$/m.exec(stdout)?.[1];
	if (!version)
		throw new Error(`\`${real} --version\` did not report omp/X.Y.Z: ${JSON.stringify(stdout.slice(-200))}`);
	return { omp: real, version, tag: `v${version}` };
}

async function haisoTip(repo: string): Promise<string> {
	const tip = await vcs.requireGit(repo).resolveRef(BRANCH);
	if (!tip) throw new Error(`branch ${BRANCH} does not exist in ${repo}`);
	return tip;
}

function planUpdate(current: InstallReceipt | null, target: Target, tip: string, force: boolean): Plan {
	if (!current)
		return { state: "run", background: false, reason: `no Haiso release installed; building ${target.tag}` };
	const installed = current.upstream.tag.replace(/^v/, "");
	if (Bun.semver.order(target.version, installed) < 0) {
		return {
			state: "downgrade",
			background: false,
			reason: `official omp ${target.tag} is older than Haiso's ${current.upstream.tag}; Haiso never downgrades`,
		};
	}
	if (current.upstream.tag !== target.tag)
		return { state: "run", background: true, reason: `upstream ${current.upstream.tag} → ${target.tag}` };
	if (!current.source)
		return { state: "run", background: false, reason: "the installed release predates branch builds (v2 receipt)" };
	if (current.source.haisoCommit !== tip && current.source.commit !== tip) {
		return {
			state: "run",
			background: false,
			reason: `haiso moved from ${current.source.haisoCommit.slice(0, 12)} to ${tip.slice(0, 12)}`,
		};
	}
	if (force) return { state: "run", background: false, reason: `forced rebuild of ${target.tag}` };
	return { state: "current", background: false, reason: `${target.tag} with haiso ${tip.slice(0, 12)} is installed` };
}

/**
 * Route `bun.lock` merges through the Haiso key-level 3-way driver for every worktree of `repo`.
 * Idempotent; refreshes the driver command when the runtime or repository path changes.
 */
export async function ensureLockfileMergeDriver(repo: string, bun: string): Promise<void> {
	const git = vcs.requireGit(repo);
	const attributes = path.join(git.info().commonDir, "info", "attributes");
	const line = `bun.lock merge=${MERGE_DRIVER}`;
	let text = "";
	try {
		text = await Bun.file(attributes).text();
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	if (!text.split("\n").some(existing => existing.trim() === line)) {
		await fs.mkdir(path.dirname(attributes), { recursive: true });
		await fs.writeFile(attributes, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`);
	}
	const settings: [string, string][] = [
		[`merge.${MERGE_DRIVER}.name`, "Haiso bun.lock 3-way merge"],
		[
			`merge.${MERGE_DRIVER}.driver`,
			`${shellQuote(bun)} ${shellQuote(path.join(repo, "scripts/haiso/lockfile-merge.ts"))} %O %A %B`,
		],
	];
	for (const [key, value] of settings) if ((await git.configGet(key)) !== value) await git.configSet(key, value);
}

/** Nested `bun` invocations resolve to the runtime running this updater. */
function toolEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
	};
	delete env.BUN_BE_BUN;
	delete env.PI_COMPILED;
	return env;
}

/** Tests, type checks and the build run against an empty HOME, never the user's profile or keys. */
function isolatedEnv(home: string): NodeJS.ProcessEnv {
	return {
		HOME: home,
		PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
		TMPDIR: path.join(home, "tmp"),
		LANG: process.env.LANG ?? "en_US.UTF-8",
		CI: "1",
		HAISO_UPDATE_DISABLED: "1",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: "Haiso Update",
		GIT_AUTHOR_EMAIL: "haiso-update@localhost",
		GIT_COMMITTER_NAME: "Haiso Update",
		GIT_COMMITTER_EMAIL: "haiso-update@localhost",
	};
}

async function ensureTag(session: Session, repo: string, tag: string): Promise<string> {
	const git = vcs.requireGit(repo);
	if (!(await git.refExists(`refs/tags/${tag}`))) {
		const remote = (await git.remoteList()).includes("upstream") ? "upstream" : UPSTREAM_URL;
		session.say(`• Fetching ${tag} from ${remote}`);
		await git.fetch(remote, `refs/tags/${tag}`, `refs/tags/${tag}`, 10 * MINUTE);
	}
	return (await git.commitDetails(`refs/tags/${tag}`)).sha;
}

async function removeCandidate(repo: string, worktree: string): Promise<void> {
	await forceRemove(path.dirname(worktree));
	await vcs
		.requireGit(repo)
		.worktreePrune()
		.catch(() => {});
}

/**
 * Resume a committed conflict resolution, or start a fresh detached worktree at the haiso tip.
 * A held merge is dropped automatically once the user merged the tag into `haiso` directly.
 */
async function openCandidate(ctx: Context, tagCommit: string): Promise<string> {
	const candidates = path.join(ctx.stateDir, "candidates");
	const held = ctx.previous?.result === "conflict" ? ctx.previous.worktree : undefined;
	if (held && path.dirname(path.dirname(held)) === candidates && (await exists(held))) {
		const git = vcs.requireGit(held);
		const head = await git.headSha();
		const merging = await exists(path.join(git.info().gitDir, "MERGE_HEAD"));
		const dirty = await git.isDirty();
		if (!merging && !dirty && head && (await git.mergeBase(ctx.tip, head)) === ctx.tip) {
			ctx.session.say(`• Resuming the resolved merge in ${held}`);
			return held;
		}
		const resolvedOnBranch = (await vcs.requireGit(ctx.repo).mergeBase(tagCommit, ctx.tip)) === tagCommit;
		if (!ctx.force && !resolvedOnBranch) {
			throw new Refusal(
				merging || dirty
					? `the held merge in ${held} is not committed. Resolve and \`git add\` the conflicted files there, run \`git -C ${held} commit --no-edit\`, then rerun \`haiso update\` (or \`haiso update --force\` to discard it).`
					: `the held merge in ${held} does not contain the current haiso tip; run \`haiso update --force\` to discard it and merge again.`,
			);
		}
		ctx.session.say(`• Discarding the held merge in ${held}`);
		await removeCandidate(ctx.repo, held);
	}
	await fs.mkdir(candidates, { recursive: true, mode: 0o700 });
	const source = path.join(await fs.mkdtemp(path.join(candidates, `${ctx.target.tag}-`)), "source");
	ctx.session.say(`• Creating candidate worktree ${source}`);
	await vcs.requireGit(ctx.repo).worktreeAdd(source, ctx.tip, { detach: true, clone: false });
	return source;
}

async function mergeUpstream(ctx: Context, worktree: string, tagCommit: string): Promise<string> {
	const { session, target } = ctx;
	const git = vcs.requireGit(worktree);
	const contains = async () => {
		const head = await git.headSha();
		return head && (await git.mergeBase(tagCommit, head)) === tagCommit ? head : undefined;
	};
	const already = await contains();
	if (already) return already;
	session.say(`• Merging ${target.tag} into haiso`);
	await session.git(worktree, [
		"merge",
		"--no-ff",
		"--no-edit",
		"-m",
		`Merge upstream OMP ${target.tag} into haiso`,
		target.tag,
	]);
	const unmerged = (await session.git(worktree, ["diff", "--name-only", "--diff-filter=U"])).stdout
		.split("\n")
		.filter(Boolean);
	if (unmerged.length) {
		throw new MergeConflict(
			`merging ${target.tag} conflicted in ${unmerged.join(", ")}. Resolve and \`git add\` them in ${worktree}, run \`git -C ${worktree} commit --no-edit\`, then rerun \`haiso update\`.`,
			worktree,
		);
	}
	// rerere may have resolved every conflict, leaving the merge staged but uncommitted.
	if (await exists(path.join(git.info().gitDir, "MERGE_HEAD"))) {
		const commit = await session.git(worktree, ["commit", "--no-edit"]);
		if (commit.code !== 0) throw new Error(`committing the rerere-resolved merge failed: ${commit.stderr.trim()}`);
	}
	const merged = await contains();
	if (!merged) throw new Error(`merging ${target.tag} into haiso did not complete; see ${session.logFile}`);
	return merged;
}

async function addonFiles(directory: string): Promise<string[]> {
	const prefix = `pi_natives.${process.platform}-${process.arch}`;
	let entries: Dirent[];
	try {
		entries = await fs.readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	return entries
		.filter(entry => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".node"))
		.map(entry => path.join(directory, entry.name));
}

async function carriesSentinel(files: string[], sentinel: string): Promise<boolean> {
	for (const file of files) {
		if (!containsVersionSentinel(Buffer.from(await Bun.file(file).arrayBuffer()), sentinel)) return false;
	}
	return true;
}

async function copyAddons(files: string[], directory: string): Promise<void> {
	for (const file of files) await fs.copyFile(file, path.join(directory, path.basename(file)));
}

/** Reuse a prebuilt addon when native sources are unchanged; build only when the fork changes them. */
async function installNative(ctx: Context, worktree: string, tagCommit: string, env: NodeJS.ProcessEnv): Promise<void> {
	const { session } = ctx;
	const destination = path.join(worktree, "packages/natives/native");
	const version = (await readObject(path.join(worktree, "packages/natives/package.json"))).version;
	if (typeof version !== "string") throw new Error("packages/natives/package.json has no version");
	const sentinel = versionSentinelFor(version);
	const candidate = vcs.requireGit(worktree);
	const mainHead = await vcs.requireGit(ctx.repo).headSha();
	const local = await addonFiles(path.join(ctx.repo, "packages/natives/native"));
	if (local.length && mainHead) {
		const drift = (await candidate.changedFiles({ base: mainHead, head: "HEAD" })).some(file =>
			NATIVE_INPUT.test(file),
		);
		const dirty = (await session.git(ctx.repo, ["status", "--porcelain", "--", ...NATIVE_PATHSPECS])).stdout.trim();
		if (!drift && !dirty && (await carriesSentinel(local, sentinel))) {
			session.say("• Reusing the main checkout's native addon (native sources unchanged)");
			await copyAddons(local, destination);
			return;
		}
	}
	if ((await candidate.changedFiles({ base: tagCommit, head: "HEAD" })).some(file => NATIVE_INPUT.test(file))) {
		await session.step(
			"Building the native addon (the fork changes native sources)",
			[process.execPath, "run", "build:native"],
			worktree,
			env,
			90 * MINUTE,
		);
		return;
	}
	const name = `@oh-my-pi/pi-natives-${process.platform}-${process.arch}`;
	const directory = path.join(path.dirname(worktree), "native-package");
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	await Bun.write(
		path.join(directory, "package.json"),
		JSON.stringify({ private: true, name: "haiso-native-addon", dependencies: { [name]: version } }),
	);
	await session.step(
		`Fetching the published ${name}@${version}`,
		[process.execPath, "install", "--ignore-scripts", "--registry=https://registry.npmjs.org"],
		directory,
		env,
		10 * MINUTE,
	);
	const leaf = path.join(directory, "node_modules", name);
	const manifest = await readObject(path.join(leaf, "package.json"));
	const files = await addonFiles(leaf);
	if (
		manifest.name !== name ||
		manifest.version !== version ||
		!files.length ||
		!(await carriesSentinel(files, sentinel))
	)
		throw new Error(`the published ${name}@${version} does not contain a matching native addon`);
	await copyAddons(files, destination);
}

async function prepare(ctx: Context, worktree: string, tagCommit: string): Promise<void> {
	const manager = (await readObject(path.join(worktree, "package.json"))).packageManager;
	if (
		typeof manager !== "string" ||
		!manager.startsWith("bun@") ||
		!Bun.semver.satisfies(Bun.version, manager.slice(4))
	) {
		throw new Error(
			`this runtime (Bun ${Bun.version}) does not satisfy the candidate's packageManager ${String(manager)}; rerun the updater with a matching bun`,
		);
	}
	const env = toolEnv();
	await ctx.session.step(
		"Installing dependencies (frozen lockfile)",
		[process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"],
		worktree,
		env,
		20 * MINUTE,
	);
	await installNative(ctx, worktree, tagCommit, env);
	await ctx.session.step(
		"Generating tool views",
		[process.execPath, "run", "gen:tool-views"],
		path.join(worktree, "packages/collab-web"),
		env,
		10 * MINUTE,
	);
}

const XML_ENTITIES: Record<string, string> = { quot: '"', apos: "'", lt: "<", gt: ">", amp: "&" };

function decodeXml(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#\d+|quot|apos|lt|gt|amp);/gi, (match, entity: string) => {
		if (entity[0] !== "#") return XML_ENTITIES[entity.toLowerCase()] ?? match;
		const hex = entity[1] === "x" || entity[1] === "X";
		return String.fromCodePoint(hex ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
	});
}

/** Failing test keys (`file\0classname\0name`) from a bun JUnit report; crashed workers report as testcases. */
function junitFailures(xml: string): Set<string> {
	const failures = new Set<string>();
	for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
		if (!match[2] || !/<(?:failure|error)\b/.test(match[2])) continue;
		const attributes: Record<string, string> = {};
		for (const [, key, value] of match[1]!.matchAll(/([\w:-]+)="([^"]*)"/g)) attributes[key!] = decodeXml(value!);
		failures.add(`${attributes.file ?? ""}\0${attributes.classname ?? ""}\0${attributes.name ?? ""}`);
	}
	return failures;
}

/**
 * Run a package's bun tests and return failing test keys; throws when failures cannot be attributed.
 * A whole suite runs in one low-priority process: bun's `--parallel` workers each grew to several GB and pushed a
 * 32 GB Mac into swap, so a slower serial run is the better trade. Re-runs (`wholeSuite: false`) run each file in its own process, so
 * neither contention nor state leaking between files decides the verdict for candidate or baseline.
 */
async function runSuite(
	session: Session,
	label: string,
	cwd: string,
	targets: string[],
	env: NodeJS.ProcessEnv,
	wholeSuite: boolean,
): Promise<Set<string>> {
	session.say(`• ${label}`);
	const failures = new Set<string>();
	// `nice` execs the command in place, so timeouts still stop the test process itself.
	const lowPriority = process.platform === "win32" ? [] : ["nice", "-n", "10"];
	for (const batch of wholeSuite ? [targets] : targets.map(target => [target])) {
		const report = path.join(env.TMPDIR ?? os.tmpdir(), `junit-${crypto.randomUUID()}.xml`);
		const found = new Set<string>();
		let file: string | undefined;
		const result = await session.run(
			[
				...lowPriority,
				process.execPath,
				"test",
				...(wholeSuite ? ["--only-failures"] : []),
				"--reporter=junit",
				`--reporter-outfile=${report}`,
				...batch,
			],
			cwd,
			env,
			60 * MINUTE,
			{
				// Files that fail to load are absent from the JUnit report; bun prints them under their header.
				onLine: line => {
					const header = /^(\S.*\.(?:test|spec)\.[cm]?[jt]sx?):$/.exec(line);
					if (header) file = header[1];
					else if (file && line.startsWith("# Unhandled error between tests"))
						found.add(`${file}\0\0(unhandled error)`);
				},
			},
		);
		try {
			for (const key of junitFailures(await Bun.file(report).text())) found.add(key);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		} finally {
			await fs.rm(report, { force: true });
		}
		if (result.code === null) throw new Error(`${label} timed out:\n${tailLines(result.output, 25)}`);
		if (result.code !== 0 && found.size === 0)
			throw new Error(
				`${label} failed without attributable test failures (exit ${result.code}):\n${tailLines(result.output, 25)}`,
			);
		// JUnit reports some files by absolute path; keys stay cwd-relative so re-runs and the baseline worktree match.
		for (const key of found) {
			const [file = "", ...rest] = key.split("\0");
			failures.add([path.isAbsolute(file) ? path.relative(cwd, file) : file, ...rest].join("\0"));
		}
	}
	if (failures.size) session.say(`  ${failures.size} failing`);
	return failures;
}

/** `./file` targets for the test files named in failure keys (`file\0describe\0test`). */
function testFiles(keys: Set<string>): string[] {
	return [...new Set([...keys].map(key => `./${key.split("\0")[0]}`))];
}

/**
 * Run upstream suites of every package the fork touches; failures block only when they do not also
 * fail on the pure upstream tag.
 */
async function upstreamSuites(
	ctx: Context,
	worktree: string,
	tagCommit: string,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	const { session, target } = ctx;
	const changed = await vcs.requireGit(worktree).changedFiles({ base: tagCommit, head: "HEAD" });
	const names = [...new Set(changed.map(file => /^packages\/([^/]+)\//.exec(file)?.[1]))]
		.filter((name): name is string => !!name && name !== "omp-bridge")
		.sort();
	const failing: { pkg: string; keys: Set<string> }[] = [];
	for (const pkg of names) {
		const root = path.join(worktree, "packages", pkg);
		if (
			!(await fs.stat(path.join(root, "test")).then(
				info => info.isDirectory(),
				() => false,
			))
		)
			continue;
		const keys = await runSuite(session, `Upstream suite: packages/${pkg}`, root, ["./test"], env, true);
		if (!keys.size) continue;
		// Parallel runs flake under contention; keep only failures that reproduce when run alone.
		const again = await runSuite(session, `Re-run failing: packages/${pkg}`, root, testFiles(keys), env, false);
		const confirmed = new Set([...keys].filter(key => again.has(key)));
		if (confirmed.size) failing.push({ pkg, keys: confirmed });
	}
	if (!failing.length) return;
	const total = failing.reduce((sum, entry) => sum + entry.keys.size, 0);
	session.say(`• Comparing ${total} failing upstream test(s) against pure ${target.tag}`);
	const baseline = path.join(path.dirname(worktree), "baseline");
	await vcs.requireGit(ctx.repo).worktreeAdd(baseline, tagCommit, { detach: true, clone: false });
	try {
		const tools = toolEnv();
		await session.step(
			"Baseline: installing dependencies",
			[process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"],
			baseline,
			tools,
			20 * MINUTE,
		);
		await copyAddons(
			await addonFiles(path.join(worktree, "packages/natives/native")),
			path.join(baseline, "packages/natives/native"),
		);
		await session.step(
			"Baseline: generating tool views",
			[process.execPath, "run", "gen:tool-views"],
			path.join(baseline, "packages/collab-web"),
			tools,
			10 * MINUTE,
		);
		const blocking: string[] = [];
		for (const { pkg, keys } of failing) {
			const root = path.join(baseline, "packages", pkg);
			const files: string[] = [];
			for (const file of testFiles(keys)) if (await exists(path.join(root, file))) files.push(file);
			const upstream = files.length
				? await runSuite(session, `Baseline suite: packages/${pkg}`, root, files, env, false)
				: new Set<string>();
			for (const key of keys) {
				if (!upstream.has(key)) blocking.push(`packages/${pkg}/${key.split("\0").filter(Boolean).join(" › ")}`);
			}
		}
		if (blocking.length) {
			const shown = blocking.slice(0, 30).map(line => `  ${line}`);
			if (blocking.length > shown.length) shown.push(`  … ${blocking.length - shown.length} more`);
			throw new Error(`upstream tests fail with the fork but pass on pure ${target.tag}:\n${shown.join("\n")}`);
		}
		session.say(`  All ${total} failure(s) also fail on pure ${target.tag}; not blocking`);
	} finally {
		await forceRemove(baseline);
		await vcs
			.requireGit(ctx.repo)
			.worktreePrune()
			.catch(() => {});
	}
}

async function copyTree(session: Session, source: string, destination: string): Promise<void> {
	if (process.platform === "darwin") {
		// APFS clones: a multi-GB profile copies in moments without doubling disk use.
		const result = await $`cp -cR ${source} ${destination}`.quiet().nothrow();
		if (result.exitCode !== 0)
			session.say(`  warning: copy of ${source} was incomplete: ${result.stderr.toString().trim()}`);
		return;
	}
	try {
		await fs.cp(source, destination, { recursive: true, verbatimSymlinks: true });
	} catch (error) {
		session.say(`  warning: copy of ${source} was incomplete: ${errorMessage(error)}`);
	}
}

async function seedSandbox(session: Session, source: string, destination: string, relative = ""): Promise<void> {
	await fs.mkdir(destination, { mode: 0o700 });
	for (const entry of await fs.readdir(source, { withFileTypes: true })) {
		const key = relative ? `${relative}/${entry.name}` : entry.name;
		if (SANDBOX_SKIP[key]) continue;
		const from = path.join(source, entry.name);
		const to = path.join(destination, entry.name);
		if (entry.isDirectory() && SANDBOX_DESCEND[key]) await seedSandbox(session, from, to, key);
		else await copyTree(session, from, to);
	}
}

/** Exercise the built binary against a private copy of the real ~/.omp; the copy is always deleted. */
async function sandboxChecks(ctx: Context, binary: string): Promise<void> {
	const { session } = ctx;
	const sandbox = await fs.mkdtemp(path.join(ctx.stateDir, "sandbox-"));
	try {
		await fs.chmod(sandbox, 0o700);
		await fs.mkdir(path.join(sandbox, "tmp"), { mode: 0o700 });
		const profile = path.join(os.homedir(), ".omp");
		session.say(`• Copying ${profile} into a private sandbox`);
		if (await exists(profile)) await seedSandbox(session, profile, path.join(sandbox, ".omp"));
		const env: NodeJS.ProcessEnv = {
			HOME: sandbox,
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			TMPDIR: path.join(sandbox, "tmp"),
			LANG: process.env.LANG ?? "en_US.UTF-8",
			HAISO_UPDATE_DISABLED: "1",
			NO_COLOR: "1",
			TERM: "dumb",
		};
		const commands: [string[], string][] = [
			[["config", "list", "--json"], sandbox],
			[["__complete", "sessions"], ctx.repo],
			[["gc", "--wal", "--apply", "--json"], sandbox],
		];
		for (const [args, cwd] of commands) {
			const label = `Sandbox: haiso ${args.join(" ")}`;
			session.say(`• ${label}`);
			// Output may contain configured secrets; only failures are logged, and only stderr.
			const result = await session.run([binary, ...args], cwd, env, 2 * MINUTE, { logOutput: false });
			if (result.code !== 0) {
				const detail = tailLines(result.stderr, 25);
				session.record(`${detail}\n`);
				throw new Error(
					`${label} failed against a copy of your data (${result.code === null ? "timed out" : `exit ${result.code}`}):\n${detail}`,
				);
			}
		}
	} finally {
		await forceRemove(sandbox);
	}
}

async function verify(ctx: Context, worktree: string, tagCommit: string): Promise<{ binary: string; bridge: string }> {
	const { session } = ctx;
	// Unix-domain sockets need a short path, so the empty HOME lives in /tmp rather than the state dir.
	const home = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "hu-"));
	try {
		await fs.chmod(home, 0o700);
		await fs.mkdir(path.join(home, "tmp"), { mode: 0o700 });
		const env = isolatedEnv(home);
		const bun = process.execPath;
		await session.step(
			"Haiso tests",
			[bun, "test", "--timeout", "120000", "./packages/coding-agent/test/discord-mode", "./scripts/haiso"],
			worktree,
			env,
			30 * MINUTE,
		);
		await session.step(
			"Connector tests",
			[bun, "test", "./test"],
			path.join(worktree, "packages/omp-bridge"),
			env,
			15 * MINUTE,
		);
		for (const pkg of ["coding-agent", "omp-bridge"]) {
			await session.step(
				`Type check: packages/${pkg}`,
				[bun, "run", "check:types"],
				path.join(worktree, "packages", pkg),
				env,
				15 * MINUTE,
			);
		}
		await upstreamSuites(ctx, worktree, tagCommit, env);
		await session.step(
			"Building the Haiso binary",
			[bun, "run", "build"],
			path.join(worktree, "packages/coding-agent"),
			env,
			30 * MINUTE,
		);
		const binary = path.join(worktree, "packages/coding-agent/dist/omp");
		const expected = `haiso/${ctx.target.version}`;
		const version = (await session.step("Binary: --version", [binary, "--version"], home, env, MINUTE)).stdout.trim();
		if (version !== expected)
			throw new Error(`the built binary reports ${JSON.stringify(version)}, expected ${expected}`);
		const smoke = await session.step("Binary: --smoke-test", [binary, "--smoke-test"], home, env, 2 * MINUTE);
		if (!smoke.stdout.includes("smoke-test: ok"))
			throw new Error("the built binary's smoke test did not report success");
		await sandboxChecks(ctx, binary);
		await session.step(
			"Building the OMP bridge",
			[bun, "scripts/build.ts"],
			path.join(worktree, "packages/omp-bridge"),
			env,
			5 * MINUTE,
		);
		return { binary, bridge: path.join(worktree, "packages/omp-bridge/dist/index.js") };
	} finally {
		await forceRemove(home);
	}
}

async function pipeline(ctx: Context, reason: string): Promise<number> {
	const { session, target } = ctx;
	session.say(`Updating Haiso to ${target.tag}: ${reason}`);
	let worktree: string | undefined;
	let commit: string | undefined;
	try {
		const tagCommit = await ensureTag(session, ctx.repo, target.tag);
		await ensureLockfileMergeDriver(ctx.repo, process.execPath);
		worktree = await openCandidate(ctx, tagCommit);
		commit = await mergeUpstream(ctx, worktree, tagCommit);
		await prepare(ctx, worktree, tagCommit);
		const { binary, bridge } = await verify(ctx, worktree, tagCommit);
		session.say("• Installing the verified release");
		const staged = await stageHaiso({
			binary,
			runtime: process.execPath,
			upstream: { tag: target.tag, commit: tagCommit },
			source: { repo: ctx.repo, commit, haisoCommit: ctx.tip },
			prefix: ctx.prefix,
			binDir: ctx.current ? path.dirname(ctx.current.launcher) : undefined,
			stateDir: ctx.stateDir,
			bridge,
		});
		const active = await activateHaiso(staged.release, { expectedCurrent: ctx.current?.release ?? null });
		const loader = await syncBridgeLoader(active.prefix, ctx.stateDir);
		let adopt = "";
		if (commit !== ctx.tip) {
			try {
				await vcs.requireGit(ctx.repo).createBranch(NEXT_BRANCH, commit, true);
				adopt = `The merge is on ${NEXT_BRANCH}; adopt it with: git -C ${ctx.repo} merge --ff-only ${NEXT_BRANCH}`;
			} catch (error) {
				adopt = `Could not point ${NEXT_BRANCH} at ${commit}: ${errorMessage(error)}`;
			}
		}
		// The release is live; a leftover worktree must not turn success into a held update.
		await removeCandidate(ctx.repo, worktree).catch(error =>
			session.say(`warning: could not remove ${worktree}: ${errorMessage(error)}`),
		);
		const message = `Activated ${active.version} built from ${commit.slice(0, 12)} (${active.release}). New launches use it; running sessions keep their release; the Discord service switches once every session is idle.`;
		await finish(ctx.stateDir, {
			result: "ok",
			message,
			at: new Date().toISOString(),
			tag: target.tag,
			haisoCommit: ctx.tip,
			commit,
		});
		session.say(message);
		if (adopt) session.say(adopt);
		if (loader) session.say(loader);
		await session.flush();
		return 0;
	} catch (error) {
		if (error instanceof Refusal) throw error;
		const conflict = error instanceof MergeConflict;
		if (worktree && !conflict) await removeCandidate(ctx.repo, worktree).catch(() => {});
		const message = errorMessage(error);
		await finish(ctx.stateDir, {
			result: conflict ? "conflict" : "failed",
			message: message.slice(0, 8192),
			at: new Date().toISOString(),
			tag: target.tag,
			haisoCommit: ctx.tip,
			commit,
			worktree: conflict ? error.worktree : undefined,
		});
		session.record(`\nUpdate held: ${message}\n`);
		await session.flush();
		if (session.verbose)
			console.error(
				`Update to ${target.tag} held (${conflict ? "conflict" : "failed"}): ${message}\nLog: ${session.logFile}`,
			);
		return 1;
	}
}

async function update(prefix: string, stateDir: string, force: boolean, background: boolean): Promise<number> {
	if (background && (process.env.HAISO_UPDATE_DISABLED || !(await autoEnabled(stateDir)))) return 0;
	await ensureStateDir(stateDir);
	let lock: FileLockHandle;
	try {
		lock = await acquireFileLock(path.join(stateDir, "update"), { retries: 1 });
	} catch {
		if (background) return 0;
		throw new Error(`another Haiso update is running (lock: ${path.join(stateDir, "update.lock")})`);
	}
	try {
		const repo = await fs.realpath(REPO);
		const current = await currentHaisoRelease(prefix);
		const target = await officialOmp(prefix);
		const tip = await haisoTip(repo);
		const plan = planUpdate(current, target, tip, force);
		const previous = await readStatus(stateDir);
		if (background) {
			// A held result waits for the user; retrying unattended would rebuild the same failure daily.
			const held =
				previous?.result === "conflict" ||
				(previous?.result === "failed" && previous.tag === target.tag && previous.haisoCommit === tip);
			if (!plan.background || held) return 0;
		} else if (plan.state !== "run") {
			console.log(`Haiso is ${plan.state === "current" ? "up to date" : "not updated"}: ${plan.reason}.`);
			if (plan.state === "current") {
				await finish(stateDir, {
					result: "up-to-date",
					message: plan.reason,
					at: new Date().toISOString(),
					tag: target.tag,
					haisoCommit: tip,
					commit: current?.source?.commit,
				});
			}
			return 0;
		}
		const session = new Session(stateDir, !background);
		return await pipeline({ session, repo, prefix, stateDir, current, target, tip, force, previous }, plan.reason);
	} finally {
		lock.release();
	}
}

function describeRelease(receipt: InstallReceipt): string[] {
	return [
		`Release:       ${receipt.version} — upstream ${receipt.upstream.tag} (${receipt.upstream.commit.slice(0, 12)})`,
		`Source:        ${
			receipt.source
				? `${receipt.source.commit.slice(0, 12)} built from haiso ${receipt.source.haisoCommit.slice(0, 12)} in ${receipt.source.repo}`
				: "legacy v2 receipt (frozen fork.patch, no branch commit)"
		}`,
		`Installed:     ${receipt.installedAt} at ${receipt.release}`,
		`Rollback:      ${receipt.previousRelease ?? "none"}`,
	];
}

async function check(prefix: string, force: boolean): Promise<number> {
	const current = await currentHaisoRelease(prefix);
	const target = await officialOmp(prefix);
	const tip = await haisoTip(await fs.realpath(REPO));
	const plan = planUpdate(current, target, tip, force);
	const installed = current
		? `${current.version} (${current.upstream.tag}; ${current.source ? `built ${current.source.commit.slice(0, 12)} from haiso ${current.source.haisoCommit.slice(0, 12)}` : "legacy v2 receipt, no source commit"})`
		: "none";
	console.log(
		[
			`Installed:     ${installed}`,
			`Official omp:  ${target.tag} (${target.omp})`,
			`haiso branch:  ${tip.slice(0, 12)}`,
			`Update:        ${plan.state === "run" ? "would run" : "nothing to do"} — ${plan.reason}`,
			`Background:    ${plan.background ? "would build" : "would skip (it builds only new upstream versions)"}`,
		].join("\n"),
	);
	return 0;
}

async function status(prefix: string, stateDir: string): Promise<number> {
	const lines: string[] = [];
	try {
		const current = await currentHaisoRelease(prefix);
		lines.push(...(current ? describeRelease(current) : [`Release:       none installed at ${prefix}`]));
	} catch (error) {
		lines.push(`Release:       unreadable — ${errorMessage(error)}`);
	}
	const suspended = process.env.HAISO_UPDATE_DISABLED ? " (suspended: HAISO_UPDATE_DISABLED is set)" : "";
	lines.push(`Auto updates:  ${(await autoEnabled(stateDir)) ? "on" : "off"}${suspended}`);
	const lastCheck = await fs.stat(path.join(stateDir, "last-check")).catch(() => undefined);
	lines.push(`Last check:    ${lastCheck ? lastCheck.mtime.toISOString() : "never"}`);
	const last = await readStatus(stateDir);
	if (last) {
		lines.push(`Last update:   ${last.result} — ${last.tag} at ${last.at}`);
		lines.push(...last.message.split("\n").map(line => `               ${line}`));
		if (last.worktree) lines.push(`Worktree:      ${last.worktree}`);
	} else lines.push("Last update:   none recorded");
	const notice = await Bun.file(path.join(stateDir, "notice"))
		.text()
		.catch(() => "");
	lines.push(`Notice:        ${notice.trim() || "none"}`);
	const log = path.join(stateDir, "last-update.log");
	lines.push(`Log:           ${log}${(await exists(log)) ? "" : " (none yet)"}`);
	console.log(lines.join("\n"));
	return 0;
}

async function rollback(prefix: string, stateDir: string): Promise<number> {
	await ensureStateDir(stateDir);
	let lock: FileLockHandle;
	try {
		lock = await acquireFileLock(path.join(stateDir, "update"), { retries: 1 });
	} catch {
		throw new Error(
			`a Haiso update is running (lock: ${path.join(stateDir, "update.lock")}); retry when it finishes`,
		);
	}
	try {
		const restored = await rollbackHaiso({ prefix });
		const loader = await syncBridgeLoader(restored.prefix, stateDir);
		// Otherwise the next automatic check would immediately rebuild what was rolled back.
		await writeJsonAtomic(path.join(stateDir, "settings.json"), { schemaVersion: 1, enabled: false });
		console.log(
			[
				`Rolled back to ${restored.version} (${restored.release}) for new launches.`,
				"Automatic updates are now off; re-enable them with `haiso update --auto on`.",
				"Shared ~/.omp data was not rolled back.",
				...(loader ? [loader] : []),
			].join("\n"),
		);
		return 0;
	} finally {
		lock.release();
	}
}

/** Keeps OMP's bridge loader in step with the active release; never fails the activation it follows. */
async function syncBridgeLoader(prefix: string, stateDir: string): Promise<string> {
	try {
		switch (await ensureHaisoBridgeLoader({ prefix, stateDir })) {
			case "created":
				return "Official OMP now loads the Haiso bridge (~/.omp/agent/extensions/haiso-bridge.ts; delete that file to stop).";
			case "foreign":
				return "OMP bridge loader left alone: ~/.omp/agent/extensions/haiso-bridge.ts was not created by Haiso.";
			case "paused":
				return "This release ships no OMP bridge; its loader was removed until a release does.";
			default:
				return "";
		}
	} catch (error) {
		return `warning: could not maintain the OMP bridge loader: ${errorMessage(error)}`;
	}
}

async function main(argv: string[]): Promise<number> {
	let action: Action;
	try {
		action = parseArgs(argv);
	} catch (error) {
		console.error(`${errorMessage(error)}\n\n${USAGE}`);
		return 2;
	}
	const prefix = path.resolve(process.env.HAISO_PREFIX || defaultPrefix());
	const stateDir = defaultStateDir(prefix);
	try {
		switch (action.kind) {
			case "help":
				console.log(USAGE);
				return 0;
			case "status":
				return await status(prefix, stateDir);
			case "check":
				return await check(prefix, action.force);
			case "rollback":
				return await rollback(prefix, stateDir);
			case "auto":
				await ensureStateDir(stateDir);
				await writeJsonAtomic(path.join(stateDir, "settings.json"), { schemaVersion: 1, enabled: action.enabled });
				console.log(
					action.enabled
						? "Automatic updates on: launches check at most daily and build only new official omp versions."
						: "Automatic updates off.",
				);
				return 0;
			case "background":
				return await update(prefix, stateDir, false, true);
			case "update":
				return await update(prefix, stateDir, action.force, false);
		}
	} catch (error) {
		if (action.kind === "background") return 0;
		console.error(`haiso update: ${errorMessage(error)}`);
		return 1;
	}
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
