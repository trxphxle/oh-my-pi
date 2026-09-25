import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { DISCORD_MODE_MAX_PROGRESS_LABEL } from "@oh-my-pi/pi-wire/discord-mode";
import { DiscordProgressTracker, formatDiscordProgressLine, summarizeDiscordCommand } from "../src/discord-progress";

const cwd = path.resolve("/work/project");
const MINUTE = 60_000;

function tracker(start = 1_000_000) {
	let now = start;
	const progress = new DiscordProgressTracker(() => now);
	let id = 0;
	const emit = (event: { type: string; [key: string]: unknown }) => progress.observe(event, cwd);
	return {
		progress,
		advance(ms: number) {
			now += ms;
		},
		now: () => now,
		emit,
		/** Start and finish one tool call; like the engine, only the start event carries arguments. */
		tool(toolName: string, args: unknown, result: unknown = {}, isError = false) {
			const toolCallId = `call-${++id}`;
			emit({ type: "tool_execution_start", toolCallId, toolName, args, intent: "model intent" });
			emit({ type: "tool_execution_end", toolCallId, toolName, result, isError });
		},
	};
}

describe("summarizeDiscordCommand", () => {
	it("keeps the program and a known subcommand, never arguments", () => {
		expect(summarizeDiscordCommand("FOO=x bun test packages/utils")).toBe("bun test");
		expect(summarizeDiscordCommand("git commit -m 'rotate hunter2'")).toBe("git commit");
		expect(summarizeDiscordCommand("curl -H 'Authorization: Bearer sk-live' https://api")).toBe("curl");
		expect(summarizeDiscordCommand("echo sk-live-secret")).toBe("echo");
		expect(summarizeDiscordCommand("cd packages/utils && sudo /usr/bin/make build | tee log")).toBe("make build");
		expect(summarizeDiscordCommand("TOKEN=abc env time ./scripts/deploy.sh --prod")).toBe("deploy.sh");
		expect(summarizeDiscordCommand("$(cat secret)")).toBe("command");
	});
});

describe("DiscordProgressTracker", () => {
	it("is absent until a run starts and clears on a terminal end, not an async resume", () => {
		const t = tracker();
		expect(t.progress.current()).toBeUndefined();
		t.emit({ type: "agent_start" });
		expect(t.progress.current()).toEqual({ startedAt: t.now(), phase: "thinking", files: 0 });
		t.emit({ type: "agent_end", messages: [], isTerminal: false });
		expect(t.progress.current()).toBeDefined();
		t.emit({ type: "agent_end", messages: [], willContinue: true });
		expect(t.progress.current()).toBeDefined();
		t.emit({ type: "agent_end", messages: [] });
		expect(t.progress.current()).toBeUndefined();
	});

	it("counts distinct successfully edited files across edit, write, and applied ast_edit", () => {
		const t = tracker();
		t.emit({ type: "agent_start" });
		t.tool("edit", { input: "*** patch" }, { details: { path: path.join(cwd, "src/a.ts") } });
		t.tool("edit", { path: "src/a.ts" }, { details: { path: path.join(cwd, "src/a.ts") } });
		t.tool("write", { path: "src/b.ts" }, { details: { resolvedPath: path.join(cwd, "src/b.ts") } });
		t.tool("write", { path: "local://notes.md" }, { details: { resolvedPath: "local://notes.md" } });
		t.tool(
			"edit",
			{ input: "multi" },
			{ details: { perFileResults: [{ path: path.join(cwd, "src/b.ts") }, { path: path.join(cwd, "src/c.ts") }] } },
		);
		// A preview applies nothing; a failed edit changed nothing.
		t.tool("ast_edit", {}, { details: { applied: false, fileReplacements: [{ path: path.join(cwd, "src/d.ts") }] } });
		t.tool("edit", { path: "src/e.ts" }, { details: {} }, true);
		expect(t.progress.current()).toMatchObject({ files: 3, last: { label: "edit src/e.ts", outcome: "fail" } });
		t.tool("ast_edit", {}, { details: { applied: true, fileReplacements: [{ path: path.join(cwd, "src/d.ts") }] } });
		expect(t.progress.current()).toMatchObject({ files: 4, last: { label: "edit src/d.ts", outcome: "pass" } });
	});

	it("maps outcomes and keeps labels project-relative and bounded", () => {
		const t = tracker();
		t.emit({ type: "agent_start" });
		t.tool("bash", { command: "bun test" }, { details: {} });
		expect(t.progress.current()?.last).toEqual({ label: "bun test", outcome: "pass" });
		t.tool("bash", { command: "bun test" }, { details: {} }, true);
		expect(t.progress.current()?.last).toEqual({ label: "bun test", outcome: "fail" });
		t.tool("bash", { command: "make" }, { details: { timedOut: true } }, true);
		expect(t.progress.current()?.last).toEqual({ label: "make", outcome: "timeout" });
		t.tool("bash", { command: "bun run dev" }, { details: { async: { state: "running", jobId: "j" } } });
		expect(t.progress.current()?.last).toEqual({ label: "bun run", outcome: "started" });
		t.tool("edit", {}, { details: { path: "/Users/someone/elsewhere/private/config.json" } });
		expect(t.progress.current()?.last?.label).toBe("edit config.json");
		const deep = `${"nested/".repeat(10)}file.ts`;
		t.tool("edit", {}, { details: { path: path.join(cwd, deep) } });
		const label = t.progress.current()!.last!.label;
		expect(label.length).toBeLessThanOrEqual(DISCORD_MODE_MAX_PROGRESS_LABEL);
		expect(label).toStartWith("edit …");
		expect(label).toEndWith("/file.ts");
	});

	it("reports the running tool's phase, with compaction and retry overriding", () => {
		const t = tracker();
		t.emit({ type: "agent_start" });
		t.emit({ type: "tool_execution_start", toolCallId: "r", toolName: "read", args: { path: "a" } });
		expect(t.progress.current()?.phase).toBe("reading");
		t.emit({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "ls" } });
		expect(t.progress.current()?.phase).toBe("running");
		t.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "x" });
		expect(t.progress.current()?.phase).toBe("retrying");
		t.emit({ type: "auto_retry_end", success: true, attempt: 1 });
		t.emit({ type: "tool_execution_end", toolCallId: "b", toolName: "bash", result: {}, isError: false });
		expect(t.progress.current()?.phase).toBe("reading");
		t.emit({ type: "tool_execution_end", toolCallId: "r", toolName: "read", result: {}, isError: false });
		expect(t.progress.current()?.phase).toBe("thinking");
		t.emit({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
		expect(t.progress.current()?.phase).toBe("compacting");
	});

	it("never carries tool output, reasoning, or model intent", () => {
		const t = tracker();
		t.emit({ type: "agent_start" });
		t.emit({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "thinking", thinking: "SECRET-REASONING" }] },
		});
		t.tool(
			"bash",
			{ command: "curl -H 'Authorization: Bearer SECRET-TOKEN' https://x" },
			{ content: [{ type: "text", text: "SECRET-OUTPUT" }], details: { output: "SECRET-OUTPUT" } },
		);
		t.tool("task", { assignment: "SECRET-PROMPT" }, { content: [{ type: "text", text: "SECRET-OUTPUT" }] });
		const wire = JSON.stringify(t.progress.current());
		expect(wire).not.toContain("SECRET");
		expect(wire).not.toContain("model intent");
		expect(t.progress.current()?.last).toEqual({ label: "task", outcome: "pass" });
	});
});

describe("formatDiscordProgressLine", () => {
	it("renders the card line from events", () => {
		const t = tracker();
		t.emit({ type: "agent_start" });
		for (const file of ["a.ts", "b.ts", "c.ts"])
			t.tool("edit", { path: file }, { details: { path: path.join(cwd, file) } });
		t.emit({ type: "tool_execution_start", toolCallId: "w", toolName: "write", args: { path: "d.ts" } });
		t.tool("bash", { command: "bun test --filter secret" }, { details: {} });
		t.advance(4 * MINUTE + 5_000);
		expect(formatDiscordProgressLine(t.progress.current()!, t.now())).toBe(
			"Working · 4m · editing 3 files · last: bun test (pass)",
		);
	});

	it("uses coarse elapsed buckets and clamps clock steps", () => {
		const base = { startedAt: 10 * MINUTE, phase: "reading" as const, files: 0 };
		expect(formatDiscordProgressLine(base, 10 * MINUTE - 5_000)).toBe("Working · <1m · reading");
		expect(formatDiscordProgressLine({ ...base, files: 1 }, 75 * MINUTE)).toBe(
			"Working · 1h 5m · reading · 1 file edited",
		);
		expect(formatDiscordProgressLine({ ...base, phase: "editing", files: 999 }, 10 * MINUTE)).toBe(
			"Working · <1m · editing 999+ files",
		);
	});
});
