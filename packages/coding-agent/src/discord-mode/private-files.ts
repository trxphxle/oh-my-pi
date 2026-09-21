// Private-file hardening adapted from omp-discord-bridge, Copyright (c) 2026 treearc, MIT License.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as path from "node:path";

const MAX_PRIVATE_BYTES = 64 * 1024 * 1024;

function missing(error: unknown): undefined {
	if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
	throw new Error("Cannot access Discord mode private storage.");
}

function absolute(filePath: string): void {
	if (!path.isAbsolute(filePath) || filePath.includes("\0"))
		throw new Error("Discord mode storage requires an absolute path.");
}

function privateFile(info: nodeFs.Stats): void {
	if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1) {
		throw new Error("Discord mode requires owner-only regular files (0600), without symlinks or hard links.");
	}
}

function privateDirectory(info: nodeFs.Stats): void {
	if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
		throw new Error("Discord mode requires an owned private directory (0700), not a symlink.");
	}
}

export async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
	absolute(directoryPath);
	await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
	privateDirectory(await fs.lstat(directoryPath));
}

/** Bounded, no-follow reads; missing files alone return undefined. */
export async function readPrivateJson(filePath: string, maxBytes = MAX_PRIVATE_BYTES): Promise<unknown | undefined> {
	absolute(filePath);
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PRIVATE_BYTES)
		throw new Error("Invalid private file size limit.");
	const parent = await fs.lstat(path.dirname(filePath)).catch(missing);
	if (!parent) return undefined;
	privateDirectory(parent);
	const file = await fs
		.open(filePath, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_NONBLOCK)
		.catch(missing);
	if (!file) return undefined;
	try {
		const info = await file.stat();
		privateFile(info);
		if (info.size > maxBytes) throw new Error("Discord mode private file exceeds its size limit.");
		const bytes = Buffer.alloc(info.size + 1);
		let length = 0;
		while (length < bytes.length) {
			const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
			if (!bytesRead) break;
			length += bytesRead;
		}
		const after = await file.stat();
		if (length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
			throw new Error("Discord mode private file changed while reading.");
		}
		try {
			return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))) as unknown;
		} catch {
			throw new Error("Discord mode private file contains invalid JSON.");
		}
	} finally {
		await file.close();
	}
}

async function publishPrivateJson(filePath: string, value: unknown, replace: boolean): Promise<boolean> {
	absolute(filePath);
	await ensurePrivateDirectory(path.dirname(filePath));
	const existing = await fs.lstat(filePath).catch(missing);
	if (existing && !replace) return false;
	if (existing) privateFile(existing);
	const json = JSON.stringify(value);
	if (json === undefined) throw new Error("Discord mode private storage requires a JSON value.");
	const encoded = `${json}\n`;
	if (Buffer.byteLength(encoded) > MAX_PRIVATE_BYTES)
		throw new Error("Discord mode private storage capacity reached.");
	const temporary = path.join(path.dirname(filePath), `.discord-${randomUUID()}.tmp`);
	try {
		const file = await fs.open(
			temporary,
			nodeFs.constants.O_WRONLY | nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL | nodeFs.constants.O_NOFOLLOW,
			0o600,
		);
		try {
			await file.writeFile(encoded);
			await file.sync();
		} finally {
			await file.close();
		}
		if (replace) {
			const current = await fs.lstat(filePath).catch(missing);
			if (current) privateFile(current);
			if (
				existing ? !current || existing.dev !== current.dev || existing.ino !== current.ino : current !== undefined
			) {
				throw new Error("Discord mode private file changed before replacement.");
			}
			await fs.rename(temporary, filePath);
		} else {
			try {
				await fs.link(temporary, filePath);
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") return false;
				throw new Error("Cannot publish Discord mode private file exclusively.");
			}
			// Drop the staging link before exposing a successful publication to readers.
			await fs.unlink(temporary);
		}
		const directory = await fs.open(path.dirname(filePath), nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW);
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
		return true;
	} finally {
		await fs.unlink(temporary).catch(missing);
	}
}

/** Atomic replacement with file and directory durability; never follows a destination symlink. */
export async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
	await publishPrivateJson(filePath, value, true);
}

/** Atomic no-overwrite publication. A losing creator never rotates the winner's credentials. */
export async function createPrivateJson(filePath: string, value: unknown): Promise<boolean> {
	return publishPrivateJson(filePath, value, false);
}
