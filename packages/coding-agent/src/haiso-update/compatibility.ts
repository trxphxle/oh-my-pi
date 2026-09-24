import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const IGNORED_DIRECTORIES: Record<string, true> = {
	".git": true,
	node_modules: true,
	dist: true,
	target: true,
	".cache": true,
	".venv": true,
	__pycache__: true,
};
const MAX_FILES = 40_000;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
const CODE = /\.(?:[cm]?[jt]sx?|rs|py|sql|json|toml)$/;
const STATE_PATH =
	/(?:^|[/_.-])(?:auth|oauth|credential|session|config|settings|storage|store|state|persist\w*|schema|migration\w*|database|sqlite|dirs|history|memory|memories|secrets)(?:[/_.-]|$)/i;
const STATE_CODE =
	/(?:bun:sqlite|better-sqlite|rusqlite|\b(?:sqlite3|CREATE|ALTER|PRAGMA|AuthStorage|SessionManager|DirResolver|Database|Sqlite|SQLite|getAgentDir|getConfigDir|getSessionsDir)\b)/;
const BROKER_PATH =
	/^(?:packages\/(?:wire|omp-bridge)\/src\/|packages\/ai\/src\/(?:auth|auth-broker)\/|packages\/coding-agent\/src\/(?:discord-mode|launch|blob-broker|collab|live|stream|subprocess|lsp\/mux)\/|packages\/tui\/src\/tools\/(?:daemon|hub)(?:[/.])|packages\/natives\/native\/)|(?:^|\/)(?:broker|protocol|wire|private|client)(?:[./-])/;

async function* sourceFiles(root: string): AsyncGenerator<string> {
	let count = 0;
	async function* walk(relative: string): AsyncGenerator<string> {
		const directory = await fs.opendir(path.join(root, relative));
		for await (const entry of directory) {
			if (IGNORED_DIRECTORIES[entry.name]) continue;
			// Repository-ignored compiler intermediates are outputs, not verified source inputs.
			if (entry.isFile() && /\.(?:bun-build|tsbuildinfo)$/.test(entry.name)) continue;
			if (++count > MAX_FILES) throw new Error("Source file limit exceeded; review this release manually");
			const name = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				yield* walk(name);
			} else if (entry.isSymbolicLink()) {
				// Never fingerprint the name of a link while compiling unsealed external content.
				throw new Error(`Source symlinks require manual review: ${name}`);
			} else if (entry.isFile()) yield name;
		}
	}
	yield* walk("");
}

/** Hash names as well as bytes: additions, removals and renamed persistence code change the contract. */
export async function computeCompatibility(sourceRoot: string): Promise<{ state: string; broker: string }> {
	const state = createHash("sha256").update("haiso-state-v2\0");
	const broker = createHash("sha256").update("haiso-broker-v2\0");
	const files: string[] = [];
	for await (const name of sourceFiles(sourceRoot)) {
		// Build embeds temporary native bytes and regenerates presentation JS; neither is a wire/schema contract.
		if (
			name === "packages/natives/native/embedded-addon.js" ||
			name === "packages/coding-agent/src/export/html/tool-views.generated.js"
		)
			continue;
		if (CODE.test(name) && !/(?:^|\/)(?:test|tests|bench|fixtures|examples)\/|\.test\./.test(name)) files.push(name);
	}
	let total = 0;
	for (const name of files.sort()) {
		const file = Bun.file(path.join(sourceRoot, name));
		if ((total += file.size) > 256 * 1024 * 1024)
			throw new Error(`Compatibility source size limit exceeded at ${name}; review this release manually`);
		const content = createHash("sha256");
		let bytes = file.size;
		// Known state paths need hashing, not another text scan.
		let persistence =
			STATE_PATH.test(name) ||
			/^(?:packages\/(?:utils|ai|agent)\/src\/|packages\/coding-agent\/src\/(?:session|config|extensibility\/extensions)\/)/.test(
				name,
			) ||
			name === "packages/coding-agent/src/utils/atomic-file.ts";
		if (name.startsWith("packages/natives/native/")) {
			if (bytes > 8 * 1024 * 1024) throw new Error(`Native binding source is oversized: ${name}`);
			// Only the generated process-local version symbol is normalized.
			const text = (await file.text()).replace(/\b__piNativesV\d+_\d+_\d+\b/g, "__piNativesVersion");
			bytes = Buffer.byteLength(text);
			content.update(text);
			persistence ||= STATE_CODE.test(text);
		} else {
			const decoder = new TextDecoder();
			let overlap = "";
			let readBytes = 0;
			for await (const chunk of file.stream()) {
				if ((readBytes += chunk.byteLength) > bytes)
					throw new Error(`Source changed while fingerprinting: ${name}`);
				content.update(chunk);
				if (!persistence) {
					const text = overlap + decoder.decode(chunk, { stream: true });
					persistence = STATE_CODE.test(text);
					// Every detection token is shorter than this bounded carry.
					overlap = text.slice(-64);
				}
			}
			if (readBytes !== bytes) throw new Error(`Source changed while fingerprinting: ${name}`);
			if (!persistence) persistence = STATE_CODE.test(overlap + decoder.decode());
		}
		const digest = content.digest();
		const frame = `${name}\0${bytes}\0`;
		if (persistence) {
			state.update(frame).update(digest);
		}
		if (
			BROKER_PATH.test(name) ||
			/discord|broker|file[_-]lock|oauth_callback/i.test(name) ||
			name.startsWith("packages/utils/src/") ||
			name === "packages/coding-agent/src/cli/worker-selectors.ts" ||
			name === "packages/ai/src/types.ts" ||
			name === "packages/ai/src/usage.ts"
		) {
			broker.update(frame).update(digest);
		}
	}
	return { state: state.digest("hex"), broker: broker.digest("hex") };
}

/** Seal verified source and native payloads, excluding build/dependency outputs and compiler caches. */
export async function computeSourceFingerprint(sourceRoot: string): Promise<string> {
	const files: string[] = [];
	for await (const name of sourceFiles(sourceRoot)) files.push(name);
	const hash = createHash("sha256").update("haiso-source-v1\0");
	let total = 0;
	for (const name of files.sort()) {
		const file = Bun.file(path.join(sourceRoot, name));
		if ((total += file.size) > MAX_SOURCE_BYTES)
			throw new Error("Source size limit exceeded; manual cleanup required");
		hash.update(`${name}\0${file.size}\0`);
		for await (const chunk of file.stream()) hash.update(chunk);
	}
	return hash.digest("hex");
}
