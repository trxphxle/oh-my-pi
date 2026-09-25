import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discordModeSocketIsStale } from "@oh-my-pi/pi-utils/discord-client";
import { DISCORD_MODE_ENSURE_WORKER_ARG, DISCORD_MODE_READY } from "@oh-my-pi/pi-wire/discord-mode";

/** The Haiso installer's default prefix under the home directory. */
const DEFAULT_PREFIX = [".local", "share", "haiso", "fork"];
const RECEIPT_OWNER = "haiso-release-installer";
/** Startup includes Discord login; the service's own readiness bound is 60 s. */
const START_TIMEOUT_MS = 90_000;
/** After a failed start, automatic attempts pause this long. */
const START_COOLDOWN_MS = 5 * 60_000;
/** Environment the started service must not inherit from this OMP process. */
const DROPPED_ENV = [
	"BUN_BE_BUN",
	"PI_COMPILED",
	"OMP_DISCORD_MODE_CONFIG_PATH",
	"OMP_DISCORD_MODE_SOCKET_PATH",
	"HAISO_DISCORD_REPLACES",
];

export interface HaisoInstall {
	/** The release's frozen binary, as the installer receipt names it. */
	binary: string;
	prefix: string;
}

/**
 * Installed Haiso: `$HAISO_PREFIX`, else the installer's default prefix under `home`. Its `bin/haiso` must resolve to
 * an owned executable that is not group/world-writable, and be the executable of the release its receipt describes.
 */
export async function findHaisoInstall(
	env: NodeJS.ProcessEnv = process.env,
	home: string = os.homedir(),
): Promise<HaisoInstall | undefined> {
	const prefix =
		env.HAISO_PREFIX && path.isAbsolute(env.HAISO_PREFIX) ? env.HAISO_PREFIX : path.join(home, ...DEFAULT_PREFIX);
	try {
		const binary = await fs.realpath(path.join(prefix, "bin", "haiso"));
		const receiptPath = path.join(path.dirname(path.dirname(binary)), "receipt.json");
		const [binaryInfo, receiptInfo] = await Promise.all([fs.stat(binary), fs.stat(receiptPath)]);
		const uid = process.getuid?.();
		if (
			!binaryInfo.isFile() ||
			(binaryInfo.mode & 0o100) === 0 ||
			[binaryInfo, receiptInfo].some(info => info.uid !== uid || (info.mode & 0o022) !== 0)
		)
			return undefined;
		const receipt: unknown = JSON.parse(await fs.readFile(receiptPath, "utf8"));
		if (
			typeof receipt !== "object" ||
			receipt === null ||
			!("owner" in receipt) ||
			receipt.owner !== RECEIPT_OWNER ||
			!("executable" in receipt) ||
			receipt.executable !== binary
		)
			return undefined;
		return { binary, prefix };
	} catch {
		return undefined;
	}
}

export interface HaisoProcess {
	stdout: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	kill(): void;
}

export interface HaisoServiceStarterOptions {
	find?: () => Promise<HaisoInstall | undefined>;
	spawn?: (command: string[], env: Record<string, string | undefined>) => HaisoProcess;
	/** Whether the service socket under `root` is down (missing or refusing). */
	down?: (root: string) => Promise<boolean>;
	now?: () => number;
}

/** Starts Haiso's Discord service for `root`; resolves whether it now runs. `starting` fires just before the spawn. */
export type HaisoServiceStarter = (root: string, starting?: () => void) => Promise<boolean>;

/**
 * Only when the service socket is down and Haiso is installed: runs its ensure selector (the only argument), which
 * starts the persisted service and prints DISCORD_MODE_READY. One attempt at a time; a failure pauses attempts.
 */
export function createHaisoServiceStarter(options: HaisoServiceStarterOptions = {}): HaisoServiceStarter {
	const now = options.now ?? Date.now;
	let pending: Promise<boolean> | undefined;
	let failedAt: number | undefined;
	return (root, starting) => {
		if (pending) return pending;
		if (failedAt !== undefined && now() - failedAt < START_COOLDOWN_MS) return Promise.resolve(false);
		pending = (async () => {
			const down = options.down ?? (dir => discordModeSocketIsStale(path.join(dir, "ipc.sock")));
			if (!(await down(root).catch(() => false))) return false;
			const install = await (options.find ?? findHaisoInstall)();
			if (!install) return false;
			starting?.();
			const env: Record<string, string | undefined> = {
				...process.env,
				HAISO_PREFIX: install.prefix,
				OMP_DISCORD_MODE_ROOT: root,
			};
			for (const key of DROPPED_ENV) delete env[key];
			let started = false;
			try {
				const child = (options.spawn ?? spawnHaiso)([install.binary, DISCORD_MODE_ENSURE_WORKER_ARG], env);
				const timer = setTimeout(() => child.kill(), START_TIMEOUT_MS);
				try {
					const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
					started = code === 0 && output.split("\n").includes(DISCORD_MODE_READY);
				} finally {
					clearTimeout(timer);
				}
			} catch {}
			if (!started) failedAt = now();
			return started;
		})().finally(() => {
			pending = undefined;
		});
		return pending;
	};
}

function spawnHaiso(command: string[], env: Record<string, string | undefined>): HaisoProcess {
	return Bun.spawn(command, { env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
}

/** Process-wide starter used with the default connector. */
export const startHaisoService: HaisoServiceStarter = createHaisoServiceStarter();
