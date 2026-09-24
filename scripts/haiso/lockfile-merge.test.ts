import { describe, expect, it } from "bun:test";
import { mergeLockfiles } from "./lockfile-merge";

function lock(deps: Record<string, string>, packages: Record<string, string>): string {
	const depLines = Object.entries(deps)
		.map(([name, spec]) => `        ${JSON.stringify(name)}: ${JSON.stringify(spec)},\n`)
		.join("");
	const packageLines = Object.entries(packages)
		.map(([key, value]) => `    ${JSON.stringify(key)}: ${value},\n`)
		.join("\n");
	return `{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "packages/app": {\n      "name": "app",\n      "dependencies": {\n${depLines}      },\n    },\n  },\n  "packages": {\n${packageLines}  }\n}\n`;
}

const entry = (name: string, version: string) => `["${name}@${version}", "", {}, "sha512-${name}${version}"]`;

describe("bun.lock merge driver", () => {
	it("merges neighbouring fork and upstream changes that conflict textually", () => {
		const base = lock({ a: "1", z: "1" }, { a: entry("a", "1"), z: entry("z", "1") });
		// Upstream bumps `a` and adds `b`; Haiso adds `discord.js` between them.
		const theirs = lock({ a: "2", b: "1", z: "1" }, { a: entry("a", "2"), b: entry("b", "1"), z: entry("z", "1") });
		const ours = lock(
			{ a: "1", "discord.js": "14", z: "1" },
			{ a: entry("a", "1"), "discord.js": entry("discord.js", "14"), z: entry("z", "1") },
		);
		expect(mergeLockfiles(base, ours, theirs)).toBe(
			lock(
				{ a: "2", b: "1", "discord.js": "14", z: "1" },
				{ a: entry("a", "2"), b: entry("b", "1"), "discord.js": entry("discord.js", "14"), z: entry("z", "1") },
			),
		);
	});

	it("drops entries upstream removed and keeps ones only the fork added", () => {
		const base = lock({ a: "1", old: "1" }, { a: entry("a", "1"), old: entry("old", "1") });
		const theirs = lock({ a: "1" }, { a: entry("a", "1") });
		const ours = lock(
			{ a: "1", old: "1", x: "1" },
			{ a: entry("a", "1"), old: entry("old", "1"), x: entry("x", "1") },
		);
		expect(mergeLockfiles(base, ours, theirs)).toBe(
			lock({ a: "1", x: "1" }, { a: entry("a", "1"), x: entry("x", "1") }),
		);
	});

	it("refuses when both sides pin the same package differently", () => {
		const base = lock({ a: "1" }, { a: entry("a", "1") });
		expect(() =>
			mergeLockfiles(base, lock({ a: "2" }, { a: entry("a", "2") }), lock({ a: "3" }, { a: entry("a", "3") })),
		).toThrow("both sides changed");
	});
});
