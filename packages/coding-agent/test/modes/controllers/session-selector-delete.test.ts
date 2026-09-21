import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { SessionSelectorComponent, type SessionSelectorOptions } from "@oh-my-pi/pi-tui/overlays/session-selector";
import { selectSession } from "@oh-my-pi/pi-tui/apps/session-picker";
import * as standalonePicker from "@oh-my-pi/pi-tui/apps/standalone-picker";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";

beforeAll(() => {
	initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function createSession(id: string, title: string): SessionInfo {
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd: "/tmp",
		title,
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date("2024-01-02T00:00:00Z"),
		messageCount: 1,
		size: 0,
		firstMessage: `${title} first message`,
		allMessagesText: `${title} first message`,
	};
}

function createSelector(
	onDelete: NonNullable<SessionSelectorOptions<SessionInfo>["onDelete"]>,
	options: SessionSelectorOptions<SessionInfo> = {},
): SessionSelectorComponent<SessionInfo> {
	return new SessionSelectorComponent(
		[createSession("session-a", "Alpha"), createSession("session-b", "Beta")],
		() => {},
		() => {},
		() => {},
		{ ...options, onDelete },
	);
}

function renderText(selector: SessionSelectorComponent<SessionInfo>): string {
	return selector.render(120).join("\n");
}

describe("SessionSelectorComponent delete confirmation", () => {
	it("keeps the session visible and shows the error when delete fails after confirmation", async () => {
		const onDelete = vi.fn(async () => {
			throw new Error("disk failed");
		});
		const selector = createSelector(onDelete);

		selector.handleInput("\x1b[3~");
		expect(renderText(selector)).toContain("Delete session?");
		expect(renderText(selector)).toContain("Alpha");

		selector.handleInput("\n");
		await Bun.sleep(0);

		const rendered = renderText(selector);
		expect(onDelete).toHaveBeenCalledTimes(1);
		expect(rendered).toContain("Error: disk failed");
		expect(rendered).toContain("Alpha");
		expect(rendered).toContain("Beta");
		expect(rendered).not.toContain("Delete session?");
	});

	it("keeps the session visible when delete is canceled upstream", async () => {
		const onDelete = vi.fn(async () => false);
		const selector = createSelector(onDelete);

		selector.handleInput("\x1b[3~");
		selector.handleInput("\n");
		await Bun.sleep(0);

		const rendered = renderText(selector);
		expect(onDelete).toHaveBeenCalledTimes(1);
		expect(rendered).toContain("Alpha");
		expect(rendered).toContain("Beta");
		expect(rendered).not.toContain("Error:");
	});

	it("removes the session row after a successful delete", async () => {
		const onDelete = vi.fn(async () => true);
		const selector = createSelector(onDelete);

		selector.handleInput("\x1b[3~");
		selector.handleInput("\n");
		await Bun.sleep(0);

		const rendered = renderText(selector);
		expect(onDelete).toHaveBeenCalledTimes(1);
		expect(rendered).not.toContain("Alpha");
		expect(rendered).toContain("Beta");
	});

	it("Backspace on an empty search query triggers delete confirmation (macOS Fn+Backspace sends \\x7f)", async () => {
		const onDelete = vi.fn(async () => true);
		const selector = createSelector(onDelete);

		// No search query typed yet — Backspace should mean "delete session",
		// not "edit the (empty) search box".
		selector.handleInput("\x7f");
		expect(renderText(selector)).toContain("Delete session?");
		expect(renderText(selector)).toContain("Alpha");

		// Confirm.
		selector.handleInput("\n");
		await Bun.sleep(0);

		expect(onDelete).toHaveBeenCalledTimes(1);
		expect(renderText(selector)).not.toContain("Alpha");
		expect(renderText(selector)).toContain("Beta");
	});

	it("Backspace with a non-empty search query edits the query, not the session", async () => {
		const onDelete = vi.fn(async () => true);
		const selector = createSelector(onDelete);

		// Type a query, then Backspace — must delete a query char, NOT a session.
		selector.handleInput("alpha");
		const beforeBackspace = renderText(selector);
		expect(beforeBackspace).toContain("alpha");

		selector.handleInput("\x7f");
		await Bun.sleep(0);

		const afterBackspace = renderText(selector);
		// Deletion did not fire.
		expect(onDelete).not.toHaveBeenCalled();
		expect(afterBackspace).not.toContain("Delete session?");
		// The query was actually edited: "alpha" lost its trailing "a".
		expect(afterBackspace).toContain("alph");
		expect(afterBackspace).not.toContain("alpha");
	});

	function nextRender(selector: SessionSelectorComponent<SessionInfo>): Promise<void> {
		const next = Promise.withResolvers<void>();
		selector.setOnRequestRender(next.resolve);
		return next.promise;
	}

	async function inputAndRender(selector: SessionSelectorComponent<SessionInfo>, input: string): Promise<void> {
		const rendered = nextRender(selector);
		selector.handleInput(input);
		await rendered;
	}

	const choices = [
		{ value: "retain", label: "Keep external history" },
		{ value: "delete", label: "Erase external history", description: "Cannot be undone." },
	];

	it("uses the first custom deletion choice by default and propagates an explicit second choice", async () => {
		const selected: Array<string | undefined> = [];
		const selector = createSelector(
			async (_session, choice) => {
				selected.push(choice);
				return true;
			},
			{ getDeleteChoices: async () => choices },
		);

		await inputAndRender(selector, "\x1b[3~");
		await inputAndRender(selector, "\n");
		expect(renderText(selector)).not.toContain("Alpha");

		await inputAndRender(selector, "\x1b[3~");
		selector.handleInput("\x1b[B");
		await inputAndRender(selector, "\n");
		expect(selected).toEqual(["retain", "delete"]);
		expect(renderText(selector)).not.toContain("Beta");
	});

	it("cancels both the custom dialog and a pending choice lookup without deleting or reopening it", async () => {
		const onDelete = vi.fn(async () => true);
		const pending = Promise.withResolvers<typeof choices>();
		const lookup = vi.fn(() => pending.promise);
		const selector = createSelector(onDelete, { getDeleteChoices: lookup });
		selector.handleInput("\x1b[3~");
		selector.handleInput("\x1b");
		pending.resolve(choices);
		await pending.promise;
		expect(renderText(selector)).not.toContain("Delete session?");

		await inputAndRender(selector, "\x1b[3~");
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		expect(onDelete).not.toHaveBeenCalled();
		expect(renderText(selector)).toContain("Alpha");
		expect(renderText(selector)).not.toContain("Delete session?");
	});

	it("fails closed when choices cannot be loaded and suppresses repeated approval during deletion", async () => {
		const pending = Promise.withResolvers<boolean>();
		const onDelete = vi.fn(() => pending.promise);
		const lookup = vi.fn(async () => {
			throw new Error("binding unavailable");
		});
		const selector = createSelector(onDelete, { getDeleteChoices: lookup });
		await inputAndRender(selector, "\x1b[3~");
		expect(renderText(selector)).toContain("binding unavailable");
		selector.handleInput("\n");
		expect(onDelete).not.toHaveBeenCalled();

		const retry = createSelector(onDelete, { getDeleteChoices: async () => choices });
		await inputAndRender(retry, "\x1b[3~");
		const deleted = nextRender(retry);
		retry.handleInput("\n");
		retry.handleInput("\n");
		retry.handleInput("\x1b");
		expect(onDelete).toHaveBeenCalledTimes(1);
		pending.resolve(true);
		await deleted;
		expect(renderText(retry)).not.toContain("Alpha");
	});

	it("forwards host choices through the standalone picker before resuming a remaining session", async () => {
		const created = Promise.withResolvers<SessionSelectorComponent<SessionInfo>>();
		vi.spyOn(standalonePicker, "runStandaloneTui").mockImplementation(
			<T>(factory: Parameters<typeof standalonePicker.runStandaloneTui<T>>[0]) => {
				const result = Promise.withResolvers<T>();
				const selector = factory({
					ui: { terminal: { rows: 24 }, requestRender: () => {}, stop: () => {} },
					finish: result.resolve,
				} as Parameters<typeof factory>[0]) as SessionSelectorComponent<SessionInfo>;
				created.resolve(selector);
				return result.promise;
			},
		);
		const deleted: Array<{ id: string; choice?: string }> = [];
		const selection = selectSession(
			[createSession("session-a", "Alpha"), createSession("session-b", "Beta")],
			{ historySearch: false },
			{
				getDeleteChoices: async () => choices,
				deleteSession: async (session, choice) => {
					deleted.push({ id: session.id, choice });
					return true;
				},
			},
		);
		const selector = await created.promise;
		await inputAndRender(selector, "\x1b[3~");
		selector.handleInput("\x1b[B");
		await inputAndRender(selector, "\n");
		selector.handleInput("\n");
		expect((await selection)?.id).toBe("session-b");
		expect(deleted).toEqual([{ id: "session-a", choice: "delete" }]);
	});
});
