import * as fs from "node:fs";
import * as path from "node:path";
import { VERSION } from "@oh-my-pi/pi-utils";
import type { ModeServiceInfo } from "@oh-my-pi/pi-wire/discord-mode";
import { DISCORD_MODE_ENSURE_WORKER_ARG } from "../cli/worker-selectors";

/** How often the service checks the prefix link, and while an update is pending, whether it is quiet. */
export const DISCORD_SWITCH_POLL_MS = 30_000;
/** One wait for a quiet moment lasts at most this long, then pauses for DISCORD_SWITCH_RETRY_MS. */
export const DISCORD_SWITCH_WAIT_MS = 2 * 60 * 60_000;
export const DISCORD_SWITCH_RETRY_MS = 30 * 60_000;
/** Set for the replacement `ensure` process: the pid of the service it replaces, which must exit first. */
export const DISCORD_REPLACES_ENV = "HAISO_DISCORD_REPLACES";
const RECEIPT_OWNER = "haiso-release-installer";

export interface DiscordServiceRelease {
	info: ModeServiceInfo;
	/** Installed release directory this process runs from; absent outside an installed release. */
	release?: string;
}

/** The running build: upstream version, plus source commit and release directory from its installer receipt. */
export function readDiscordServiceRelease(execPath: string = process.execPath): DiscordServiceRelease {
	try {
		const binary = fs.realpathSync(execPath);
		const release = path.dirname(path.dirname(binary));
		if (path.basename(binary) !== "haiso" || path.basename(path.dirname(binary)) !== "bin") throw new Error();
		const receipt: unknown = JSON.parse(fs.readFileSync(path.join(release, "receipt.json"), "utf8"));
		if (
			typeof receipt !== "object" ||
			receipt === null ||
			!("owner" in receipt) ||
			receipt.owner !== RECEIPT_OWNER ||
			!("release" in receipt) ||
			receipt.release !== release ||
			!("executable" in receipt) ||
			receipt.executable !== binary
		)
			throw new Error();
		const source = "source" in receipt ? receipt.source : undefined;
		const commit =
			typeof source === "object" && source !== null && "commit" in source && typeof source.commit === "string"
				? source.commit
				: undefined;
		return {
			info: {
				version: VERSION,
				...(commit && /^[a-f0-9]{40}$/.test(commit) ? { commit: commit.slice(0, 12) } : {}),
				release,
			},
			release,
		};
	} catch {
		// Development runs and unreadable receipts report the version alone and never switch.
		return { info: { version: VERSION } };
	}
}

/** Current target of the prefix link, when it is a release with a runnable launcher binary. */
export function discordServiceTarget(prefix: string): string | undefined {
	try {
		fs.accessSync(path.join(prefix, "bin", "haiso"), fs.constants.X_OK);
		return fs.realpathSync(prefix);
	} catch {
		return undefined;
	}
}

/** Whether the installed prefix now points at a different release than the one `service` runs. */
export function discordServiceUpdateReady(
	service: ModeServiceInfo | undefined,
	prefix: string | undefined = process.env.HAISO_PREFIX,
): boolean {
	if (!service?.release || !prefix) return false;
	const target = discordServiceTarget(prefix);
	return target !== undefined && target !== service.release;
}

export type DiscordSwitchState = "current" | "deferred" | "waiting" | "paused" | "switched";

export interface DiscordSwitchoverOptions {
	/** Release directory this service runs from. */
	running: string;
	/** Release the prefix points at now, or undefined when unknown. */
	target(): string | undefined;
	/** Only a persisted service switches; a session-scoped one picks up the release at its next start. */
	keepOnline(): Promise<boolean>;
	broker: { stopIfQuiescent(): Promise<boolean> };
	/** The broker stopped for the update; close the service and hand over to the new release. */
	switched(): void;
	now?: () => number;
}

/**
 * Watches the prefix link and, once it points at another release, waits for a quiet broker (never mid-turn) before
 * handing over. A wait that stays busy for DISCORD_SWITCH_WAIT_MS pauses, then tries again.
 */
export class DiscordServiceSwitchover {
	#pendingSince: number | undefined;
	#pausedUntil: number | undefined;
	#switched = false;
	#ticking = false;
	#timer: NodeJS.Timeout | undefined;

	constructor(readonly options: DiscordSwitchoverOptions) {}

	start(intervalMs = DISCORD_SWITCH_POLL_MS): void {
		this.#timer = setInterval(() => {
			if (!this.#ticking) void this.tick().catch(() => {});
		}, intervalMs);
		this.#timer.unref();
	}

	stop(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	async tick(): Promise<DiscordSwitchState> {
		if (this.#switched) return "switched";
		this.#ticking = true;
		try {
			const now = (this.options.now ?? Date.now)();
			const target = this.options.target();
			if (target === undefined || target === this.options.running || !(await this.options.keepOnline())) {
				this.#pendingSince = undefined;
				this.#pausedUntil = undefined;
				return target === undefined || target === this.options.running ? "current" : "deferred";
			}
			if (this.#pausedUntil !== undefined) {
				if (now < this.#pausedUntil) return "paused";
				this.#pausedUntil = undefined;
				this.#pendingSince = undefined;
			}
			this.#pendingSince ??= now;
			if (now - this.#pendingSince >= DISCORD_SWITCH_WAIT_MS) {
				this.#pausedUntil = now + DISCORD_SWITCH_RETRY_MS;
				return "paused";
			}
			if (!(await this.options.broker.stopIfQuiescent())) return "waiting";
			this.#switched = true;
			this.stop();
			this.options.switched();
			return "switched";
		} finally {
			this.#ticking = false;
		}
	}
}

/**
 * Starts `<prefix>/bin/haiso` with the ensure selector, detached: once this process has exited it starts (or adopts)
 * the service through the normal path, so the new release takes over. Only the selector and this pid are passed.
 */
export function spawnDiscordServiceReplacement(prefix: string): void {
	const env: Record<string, string | undefined> = { ...process.env, [DISCORD_REPLACES_ENV]: String(process.pid) };
	delete env.BUN_BE_BUN;
	delete env.PI_COMPILED;
	Bun.spawn([path.join(prefix, "bin", "haiso"), DISCORD_MODE_ENSURE_WORKER_ARG], {
		env,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		detached: true,
	}).unref();
}
