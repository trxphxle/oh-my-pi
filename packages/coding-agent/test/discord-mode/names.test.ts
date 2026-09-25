import { describe, expect, it } from "bun:test";
import { discordChannelName, sessionChannelName, sessionLabel } from "../../src/discord-mode/names";

describe("Discord session channel names", () => {
	it("marks channels per app and strips markers back to clean labels", () => {
		expect(sessionChannelName("Backend Work")).toBe("🟣-backend-work");
		expect(sessionChannelName("🟣 Backend", "omp")).toBe("🔵-backend");
		expect(sessionLabel("🟣-backend")).toBe("backend");
		expect(sessionLabel("🔵🟣 api")).toBe("api");
		expect(sessionLabel("🟣")).toBeUndefined();
		expect(() => sessionChannelName("🟣 !!")).toThrow();
		// Adapter normalization keeps a known marker and still drops other emoji.
		expect(discordChannelName("🔵 API Dev")).toBe("🔵-api-dev");
		expect(discordChannelName("⭐ API")).toBe("api");
	});

	it("keeps marked names within Discord's 100-character limit", () => {
		expect(sessionChannelName("x".repeat(100), "omp")).toBe(`🔵-${"x".repeat(97)}`);
		expect(sessionChannelName(`${"a".repeat(96)} b`)).toBe(`🟣-${"a".repeat(96)}`);
		expect(() => discordChannelName(`🟣-${"x".repeat(98)}`)).toThrow();
	});
});
