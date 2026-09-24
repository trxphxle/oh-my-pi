import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { computeCompatibility, computeSourceFingerprint } from "../../src/haiso-update/compatibility";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(files: Record<string, string>): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "haiso-fingerprint-"));
	roots.push(root);
	for (const [name, content] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
		await fs.writeFile(path.join(root, name), content);
	}
	return root;
}

describe("conservative shared-state compatibility", () => {
	it("detects new persistence code even outside known state directories", async () => {
		const root = await fixture({ "packages/widget/src/render.ts": "export const color = 'red';" });
		const before = await computeCompatibility(root);
		await fs.writeFile(
			path.join(root, "packages/widget/src/cache.ts"),
			"import { Database } from 'bun:sqlite';\nconst db = new Database('state.db');",
		);
		expect((await computeCompatibility(root)).state).not.toBe(before.state);
	});

	it("streams large inputs and detects persistence declarations near the end", async () => {
		const name = "packages/widget/src/large.ts";
		const root = await fixture({ [name]: "" });
		await fs.writeFile(path.join(root, name), Buffer.alloc(9 * 1024 * 1024, 32));
		const before = await computeCompatibility(root);
		await fs.appendFile(path.join(root, name), '\nconst ddl = "CREATE TABLE marker(value TEXT)";\n');
		const after = await computeCompatibility(root);
		expect(after.state).not.toBe(before.state);
		expect(after.broker).toBe(before.broker);
	});

	it("detects renames and removals of directory/sqlite helpers", async () => {
		const root = await fixture({ "packages/utils/src/dirs.ts": "export const storage = '.omp';" });
		const before = await computeCompatibility(root);
		await fs.rename(
			path.join(root, "packages/utils/src/dirs.ts"),
			path.join(root, "packages/utils/src/locations.ts"),
		);
		const renamed = await computeCompatibility(root);
		expect(renamed.state).not.toBe(before.state);
		await fs.unlink(path.join(root, "packages/utils/src/locations.ts"));
		expect((await computeCompatibility(root)).state).not.toBe(renamed.state);
	});

	it("holds protocol-only changes in both shared broker families", async () => {
		const root = await fixture({
			"packages/ai/src/auth-broker/client.ts": "export const wire = 1;",
			"packages/coding-agent/src/launch/protocol.ts": "export const mode = false;",
		});
		const before = await computeCompatibility(root);
		await fs.writeFile(path.join(root, "packages/ai/src/auth-broker/client.ts"), "export const wire = 2;");
		const authChanged = await computeCompatibility(root);
		expect(authChanged.broker).not.toBe(before.broker);
		await fs.writeFile(path.join(root, "packages/coding-agent/src/launch/protocol.ts"), "export const mode = true;");
		expect((await computeCompatibility(root)).broker).not.toBe(authChanged.broker);
	});

	it("does not hold an update only for a process-local native version sentinel", async () => {
		const name = "packages/natives/native/index.js";
		const root = await fixture({
			[name]:
				"export const __piNativesV18_3_9 = native.__piNativesV18_3_9;\nexport const protocol = native.protocol;",
		});
		const before = await computeCompatibility(root);
		await fs.writeFile(
			path.join(root, name),
			"export const __piNativesV18_3_10 = native.__piNativesV18_3_10;\nexport const protocol = native.protocol;",
		);
		expect(await computeCompatibility(root)).toEqual(before);
		await fs.writeFile(
			path.join(root, name),
			"export const __piNativesV18_3_10 = native.__piNativesV18_3_10;\nexport const protocol = native.changedProtocol;",
		);
		expect((await computeCompatibility(root)).broker).not.toBe(before.broker);
	});

	it("seals candidate source changes independently of compatibility gates", async () => {
		const root = await fixture({ "packages/widget/src/render.ts": "export const color = 'red';" });
		const compatible = await computeCompatibility(root);
		const verified = await computeSourceFingerprint(root);
		await fs.writeFile(path.join(root, ".runtime.bun-build"), "compiler intermediate");
		expect(await computeSourceFingerprint(root)).toBe(verified);
		await fs.writeFile(path.join(root, "packages/widget/src/render.ts"), "export const color = 'blue';");
		expect(await computeCompatibility(root)).toEqual(compatible);
		expect(await computeSourceFingerprint(root)).not.toBe(verified);
	});

	it("refuses symlinked source rather than sealing an unverified external file", async () => {
		const root = await fixture({ "packages/widget/src/render.ts": "export const color = 'red';" });
		await fs.symlink(path.join(root, "packages/widget/src/render.ts"), path.join(root, "external.ts"));
		await expect(computeSourceFingerprint(root)).rejects.toThrow("symlinks");
	});
});
