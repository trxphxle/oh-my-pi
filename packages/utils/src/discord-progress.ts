// Live run summary for the Discord session card. Allowlist-only: tool names, sanitized arguments, and outcome flags.
import * as path from "node:path";
import {
	DISCORD_MODE_MAX_PROGRESS_FILES,
	DISCORD_MODE_MAX_PROGRESS_LABEL,
	type ModeProgress,
	type ModeProgressPhase,
} from "@oh-my-pi/pi-wire/discord-mode";

type Outcome = NonNullable<ModeProgress["last"]>["outcome"];

const EDIT_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true };
const PHASES: Record<string, ModeProgressPhase> = {
	edit: "editing",
	write: "editing",
	ast_edit: "editing",
	bash: "running",
	eval: "running",
	read: "reading",
	grep: "reading",
	glob: "reading",
	find: "reading",
	ast_grep: "reading",
	lsp: "reading",
	web_search: "searching",
	fetch: "searching",
	browser: "searching",
	task: "delegating",
};
/** Launchers skipped before the real program name. */
const WRAPPERS: Record<string, true> = {
	sudo: true,
	env: true,
	time: true,
	nice: true,
	command: true,
	exec: true,
	nohup: true,
};
/**
 * Programs whose next word is a subcommand, never data. Any other program shows its name alone, so arguments that may
 * be secrets (`echo`, `curl -H`, `mysql -p`) never reach Discord.
 */
const SUBCOMMAND_TOOLS: Record<string, true> = {
	bun: true,
	bunx: true,
	npm: true,
	npx: true,
	pnpm: true,
	yarn: true,
	deno: true,
	node: true,
	git: true,
	gh: true,
	cargo: true,
	go: true,
	uv: true,
	pip: true,
	pip3: true,
	poetry: true,
	docker: true,
	kubectl: true,
	make: true,
	just: true,
	swift: true,
	xcodebuild: true,
	dotnet: true,
	mvn: true,
	gradle: true,
	brew: true,
	rustup: true,
	terraform: true,
};

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Program name plus a known subcommand, from the first real segment of a shell command:
 * `FOO=x bun test pkg` → `bun test`, `git commit -m 'secret'` → `git commit`, `curl -H 'Authorization: …'` → `curl`.
 */
export function summarizeDiscordCommand(command: string): string {
	const segments = command
		.split(/&&|\|\||[;|\n]/)
		.map(segment => segment.trim())
		.filter(Boolean);
	let segment = segments[0] ?? "";
	if (/^cd(\s|$)/.test(segment) && segments.length > 1) segment = segments[1]!;
	const words = segment.split(/\s+/);
	let index = 0;
	while (
		index < words.length &&
		(/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!) || Object.hasOwn(WRAPPERS, words[index]!))
	)
		index++;
	const program =
		(words[index] ?? "")
			.replace(/^["']|["']$/g, "")
			.split("/")
			.pop() ?? "";
	if (!/^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,22}$/.test(program)) return "command";
	const next = words[index + 1];
	// Both parts already match printable-ASCII patterns and fit the label bound.
	return Object.hasOwn(SUBCOMMAND_TOOLS, program) && next && /^[a-z][a-z0-9:-]{0,23}$/.test(next)
		? `${program} ${next}`
		: program;
}

/** Filesystem paths only; internal URLs (`local://`, `skill://`, …) are not project files. */
function filePath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !/^[a-z][a-z0-9+.-]*:/i.test(value);
}

/** Project-relative with `/` separators; anything outside the project shows only its file name. */
function displayPath(absolute: string, cwd: string): string {
	const relative = path.relative(cwd, absolute);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return path.basename(absolute);
	return relative.split(path.sep).join("/");
}

/** Left-truncated so the file name survives. */
function editLabel(display: string): string {
	const clean = display.replace(/[^\x20-\x7e]/g, "");
	const room = DISCORD_MODE_MAX_PROGRESS_LABEL - "edit ".length;
	return `edit ${clean.length > room ? `…${clean.slice(-(room - 1))}` : clean}`;
}

/** Edited paths from whitelisted result details, falling back to the path argument. */
function editedPaths(tool: string, argPath: string | undefined, details: unknown, isError: boolean): string[] {
	const fromArgs = argPath ? [argPath] : [];
	if (isError || !record(details)) return fromArgs;
	if (tool === "ast_edit") {
		if (details.applied !== true || !Array.isArray(details.fileReplacements)) return [];
		return details.fileReplacements.flatMap(item => (record(item) && filePath(item.path) ? [item.path] : []));
	}
	if (tool === "write") return filePath(details.resolvedPath) ? [details.resolvedPath] : fromArgs;
	if (Array.isArray(details.perFileResults)) {
		const paths = details.perFileResults.flatMap(item => (record(item) && filePath(item.path) ? [item.path] : []));
		if (paths.length) return paths;
	}
	return filePath(details.path) ? [details.path] : fromArgs;
}

function outcome(details: unknown, isError: boolean): Outcome {
	if (record(details)) {
		if (details.timedOut === true) return "timeout";
		if (record(details.async) && details.async.state === "running") return "started";
	}
	return isError ? "fail" : "pass";
}

/**
 * Follows one engine's event stream. Accepts Haiso `AgentSessionEvent`s and extension events alike; reads only the
 * allowlisted fields and ignores everything else (streamed text, tool output, updates).
 */
export class DiscordProgressTracker {
	#startedAt: number | undefined;
	#files = new Set<string>();
	/** Running calls with the only argument facts kept: a summarized command or an edit path. */
	#running = new Map<string, { phase?: ModeProgressPhase; command?: string; path?: string }>();
	#override: "compacting" | "retrying" | undefined;
	#last: ModeProgress["last"];

	constructor(readonly now: () => number = Date.now) {}

	/** O(1) for ignored events, so per-token updates cost nothing. */
	observe(event: { readonly type: string }, cwd: string): void {
		const fields = event as unknown as Record<string, unknown>;
		switch (event.type) {
			case "agent_start":
				this.reset();
				this.#startedAt = this.now();
				return;
			case "agent_end":
				// An async resume keeps the run going.
				if (fields.isTerminal !== false && fields.willContinue !== true) this.reset();
				return;
			case "auto_compaction_start":
				this.#override = "compacting";
				return;
			case "auto_retry_start":
				this.#override = "retrying";
				return;
			case "auto_compaction_end":
			case "auto_retry_end":
				this.#override = undefined;
				return;
			case "tool_execution_start": {
				if (typeof fields.toolCallId !== "string" || typeof fields.toolName !== "string") return;
				// Attached mid-run: count from the first observed tool.
				this.#startedAt ??= this.now();
				const tool = fields.toolName;
				const args = record(fields.args) ? fields.args : {};
				this.#running.delete(fields.toolCallId);
				this.#running.set(fields.toolCallId, {
					phase: Object.hasOwn(PHASES, tool) ? PHASES[tool] : undefined,
					command:
						tool === "bash" && typeof args.command === "string"
							? summarizeDiscordCommand(args.command)
							: undefined,
					path: Object.hasOwn(EDIT_TOOLS, tool) && filePath(args.path) ? args.path : undefined,
				});
				return;
			}
			case "tool_execution_end": {
				if (typeof fields.toolCallId !== "string" || typeof fields.toolName !== "string") return;
				const call = this.#running.get(fields.toolCallId);
				this.#running.delete(fields.toolCallId);
				if (this.#startedAt !== undefined) this.#finish(fields.toolName, call, fields, cwd);
				return;
			}
		}
	}

	#finish(
		tool: string,
		call: { command?: string; path?: string } | undefined,
		fields: Record<string, unknown>,
		cwd: string,
	): void {
		const isError = fields.isError === true;
		const details = record(fields.result) ? fields.result.details : undefined;
		const result = outcome(details, isError);
		if (tool === "bash") {
			this.#last = { label: call?.command ?? "command", outcome: result };
		} else if (Object.hasOwn(EDIT_TOOLS, tool)) {
			const paths = editedPaths(tool, call?.path, details, isError).map(item => path.resolve(cwd, item));
			if (!isError)
				for (const item of paths) {
					if (this.#files.size >= DISCORD_MODE_MAX_PROGRESS_FILES) break;
					this.#files.add(item);
				}
			const label =
				paths.length === 1
					? editLabel(displayPath(paths[0]!, cwd))
					: paths.length
						? `edit ${paths.length} files`
						: "edit";
			this.#last = { label, outcome: result };
		} else if (tool === "task") this.#last = { label: "task", outcome: result };
	}

	/** Undefined while no run is active. */
	current(): ModeProgress | undefined {
		if (this.#startedAt === undefined) return undefined;
		let phase: ModeProgressPhase = "thinking";
		for (const call of this.#running.values()) if (call.phase) phase = call.phase;
		return {
			startedAt: this.#startedAt,
			phase: this.#override ?? phase,
			files: this.#files.size,
			...(this.#last ? { last: { ...this.#last } } : {}),
		};
	}

	reset(): void {
		this.#startedAt = undefined;
		this.#files.clear();
		this.#running.clear();
		this.#override = undefined;
		this.#last = undefined;
	}
}

/** Coarse minutes, so the card text changes at most once a minute from time alone. */
function elapsed(ms: number): string {
	const minutes = Math.floor(Math.max(0, ms) / 60_000);
	if (minutes < 1) return "<1m";
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** `Working · 4m · editing 3 files · last: bun test (pass)`. */
export function formatDiscordProgressLine(progress: ModeProgress, now: number): string {
	const count = progress.files >= DISCORD_MODE_MAX_PROGRESS_FILES ? `${progress.files}+` : String(progress.files);
	const files = `${count} ${progress.files === 1 ? "file" : "files"}`;
	const activity =
		progress.phase === "editing"
			? progress.files
				? `editing ${files}`
				: "editing"
			: progress.files
				? `${progress.phase} · ${files} edited`
				: progress.phase;
	const last = progress.last ? ` · last: ${progress.last.label} (${progress.last.outcome})` : "";
	return `Working · ${elapsed(now - progress.startedAt)} · ${activity}${last}`;
}
