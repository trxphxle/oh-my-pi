import { describe, expect, it } from "bun:test";
import { parseStableRelease } from "../../src/haiso-update/engine";

const official = {
	draft: false,
	prerelease: false,
	tag_name: "v18.3.0",
	html_url: "https://github.com/can1357/oh-my-pi/releases/tag/v18.3.0",
	url: "https://api.github.com/repos/can1357/oh-my-pi/releases/123456",
};

describe("official stable update discovery", () => {
	it("accepts a stable release without interpreting target_commitish as a commit pin", () => {
		expect(parseStableRelease({ ...official, target_commitish: "main" })).toEqual({
			tag: "v18.3.0",
			version: "18.3.0",
		});
	});

	it("rejects prerelease metadata even when the tag looks stable", () => {
		expect(() => parseStableRelease({ ...official, prerelease: true })).toThrow();
	});

	it("rejects a fork release with an otherwise identical version", () => {
		expect(() =>
			parseStableRelease({ ...official, url: "https://api.github.com/repos/another/oh-my-pi/releases/123456" }),
		).toThrow();
	});

	it("rejects a tag that can escape a ref or candidate path", () => {
		expect(() => parseStableRelease({ ...official, tag_name: "v18.3.0/../../main" })).toThrow();
	});

	it("rejects draft releases and release candidates", () => {
		expect(() => parseStableRelease({ ...official, draft: true })).toThrow();
		expect(() => parseStableRelease({ ...official, tag_name: "v18.3.1-rc.1" })).toThrow();
	});
});
