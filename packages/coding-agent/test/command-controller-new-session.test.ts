import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as deletionEvents from "@oh-my-pi/pi-coding-agent/discord-mode/retirement-events";
import type { ModeDeletionBinding } from "@oh-my-pi/pi-coding-agent/discord-mode/protocol";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	vi.restoreAllMocks();
});

const binding: ModeDeletionBinding = {
	sessionId: "67ca5796-de61-4aa5-94fa-8ea64332dc31",
	sessionFile: "/tmp/local-deletion-test.jsonl",
	projectDir: "/tmp",
	channelId: "3",
	label: "Local conversation",
	guildId: "1",
	ownerId: "2",
};

function localChoice(keys: string[]): InteractiveModeContext["showHookCustom"] {
	return async <T>(factory: Parameters<InteractiveModeContext["showHookCustom"]>[0]): Promise<T> => {
		const result = Promise.withResolvers<unknown>();
		const component = await factory({} as never, {} as never, {} as never, result.resolve);
		for (const key of keys) component.handleInput?.(key);
		return (await result.promise) as T;
	};
}

interface NewSessionHarness {
	ctx: InteractiveModeContext;
	controller: CommandController;
	counts: {
		newSession: () => number;
		unfocusSession: () => number;
		resetTranscriptAnchors: () => number;
		resetTranscript: () => number;
		presented: () => number;
	};
	setFocused: (id: string | undefined) => void;
}

function makeHarness(): NewSessionHarness {
	let newSession = 0;
	let unfocusSession = 0;
	let resetTranscriptAnchors = 0;
	let resetTranscript = 0;
	let presented = 0;
	let focusedAgentId: string | undefined = "subagent-1";

	const ctx = {
		session: {
			isCompacting: false,
			newSession: async () => {
				newSession++;
				return true;
			},
		},
		sessionManager: {
			getSessionName: () => undefined,
			getCwd: () => "/tmp",
			getSessionFile: () => binding.sessionFile,
		},
		get focusedAgentId() {
			return focusedAgentId;
		},
		unfocusSession: async () => {
			unfocusSession++;
			focusedAgentId = undefined;
		},
		eventController: {
			resetTranscriptAnchors: () => {
				resetTranscriptAnchors++;
			},
		},
		resetObserverRegistry: () => {},
		showError: vi.fn(),
		statusLine: {
			invalidate: () => {},
			resetActiveTime: () => {},
		},
		updateEditorBorderColor: () => {},
		clearTransientSessionUi: () => {},
		resetTranscript: () => {
			resetTranscript++;
		},
		present: () => {
			presented++;
		},
		reloadTodos: async () => {},
		ui: { requestRender: () => {} },
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		controller: new CommandController(ctx),
		counts: {
			newSession: () => newSession,
			unfocusSession: () => unfocusSession,
			resetTranscriptAnchors: () => resetTranscriptAnchors,
			resetTranscript: () => resetTranscript,
			presented: () => presented,
		},
		setFocused: id => {
			focusedAgentId = id;
		},
	};
}

describe("CommandController new-session teardown", () => {
	it("returns a focused subagent view to main and purges transcript anchors on /new", async () => {
		const harness = makeHarness();

		await harness.controller.handleClearCommand();

		expect(harness.counts.newSession()).toBe(1);
		expect(harness.counts.unfocusSession()).toBe(1);
		expect(harness.ctx.focusedAgentId).toBeUndefined();
		expect(harness.counts.resetTranscriptAnchors()).toBe(1);
		expect(harness.counts.resetTranscript()).toBe(1);
		expect(harness.counts.presented()).toBe(1);
	});

	it("skips the unfocus round-trip when already on the main session", async () => {
		const harness = makeHarness();
		harness.setFocused(undefined);

		await harness.controller.handleClearCommand();

		expect(harness.counts.newSession()).toBe(1);
		expect(harness.counts.unfocusSession()).toBe(0);
		expect(harness.counts.resetTranscriptAnchors()).toBe(1);
		expect(harness.counts.resetTranscript()).toBe(1);
	});

	it("keeps history by default and requires an explicit local choice to erase Discord", async () => {
		vi.spyOn(deletionEvents, "lookupDiscordDeletionBinding").mockResolvedValue(binding);
		for (const [keys, policy] of [
			[["\n"], "retain"],
			[["\x1b[B", "\n"], "delete"],
		] as const) {
			const harness = makeHarness();
			harness.ctx.showHookCustom = localChoice([...keys]);
			harness.ctx.showHookSelector = vi.fn(async () => {
				throw new Error("Remote-mirrored selector used");
			});
			const transition = vi.spyOn(harness.ctx.session, "newSession");

			await harness.controller.handleDeleteCommand();

			expect(transition).toHaveBeenCalledWith({ drop: true, discordRetirement: policy });
			expect(harness.counts.presented()).toBe(1);
			expect(harness.ctx.showHookSelector).not.toHaveBeenCalled();
		}
	});

	it("leaves the active conversation untouched when local deletion is cancelled", async () => {
		vi.spyOn(deletionEvents, "lookupDiscordDeletionBinding").mockResolvedValue(binding);
		const harness = makeHarness();
		harness.ctx.showHookCustom = localChoice(["\x1b"]);

		await harness.controller.handleDeleteCommand();

		expect(harness.counts.newSession()).toBe(0);
		expect(harness.counts.resetTranscript()).toBe(0);
		expect(harness.counts.presented()).toBe(0);
	});

	it("redraws a committed transition after failed deletion without displaying success", async () => {
		vi.spyOn(deletionEvents, "lookupDiscordDeletionBinding").mockResolvedValue(undefined);
		const harness = makeHarness();
		vi.spyOn(harness.ctx.session, "newSession").mockImplementation(async () => {
			Object.defineProperty(harness.ctx.session, "sessionId", { value: "replacement" });
			throw new Error("Native deletion failed");
		});

		await harness.controller.handleDeleteCommand();

		expect(harness.counts.resetTranscript()).toBe(1);
		expect(harness.counts.presented()).toBe(0);
		expect(harness.ctx.showError).toHaveBeenCalledWith("Native deletion failed");
	});
});
