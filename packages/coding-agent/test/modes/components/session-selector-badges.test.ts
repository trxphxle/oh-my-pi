import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SessionSelectorComponent } from "@oh-my-pi/pi-tui/overlays/session-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";

beforeAll(async () => {
	await initTheme();
});

afterAll(async () => {
	await initTheme();
});

function createSession(id: string): SessionInfo {
	return {
		path: `/work/${id}.jsonl`,
		id,
		cwd: "/work",
		title: `Session ${id}`,
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date("2024-01-02T00:00:00Z"),
		messageCount: 1,
		size: 2048,
		firstMessage: `first message ${id}`,
		allMessagesText: `first message ${id}`,
	};
}

/** Each row's metadata line, keyed by the title line above it, without ANSI styling. */
function metadataByTitle(badges?: ReadonlyMap<string, string>): Map<string, string> {
	const selector = new SessionSelectorComponent(
		[createSession("shared"), createSession("private")],
		() => {},
		() => {},
		() => {},
		{ getTerminalRows: () => 100, badges },
	);
	const lines = selector
		.render(120)
		.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""))
		.map(line => line.replace(/^│|│$/g, "").trim());
	const rows = new Map<string, string>();
	for (const [index, line] of lines.entries()) {
		const title = line.match(/Session (shared|private)$/)?.[1];
		// Title, dim preview, then the metadata line.
		if (title) rows.set(title, lines[index + 2] ?? "");
	}
	return rows;
}

describe("SessionSelectorComponent badges", () => {
	it("shows a host badge only on the matching session's metadata line", () => {
		const rows = metadataByTitle(new Map([["shared", "Discord"]]));
		expect(rows.get("shared")).toContain("Discord");
		expect(rows.get("private")).toBeDefined();
		expect(rows.get("private")).not.toContain("Discord");
	});

	it("renders no badge when the host supplies none", () => {
		const rows = metadataByTitle();
		expect(rows.size).toBe(2);
		for (const metadata of rows.values()) expect(metadata).not.toContain("Discord");
	});
});
