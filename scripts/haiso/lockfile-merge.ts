#!/usr/bin/env bun
/**
 * Git merge driver for bun.lock: `lockfile-merge.ts %O %A %B` (base, ours → result, theirs).
 *
 * A textual merge conflicts whenever upstream and Haiso touch neighbouring
 * lines, which happens on almost every release. This merges by key instead:
 * each workspace field and each `packages` entry takes whichever side changed
 * it. Both sides changing the same key differently is a real conflict: the
 * driver then writes git's textual result with markers and exits 1.
 *
 * Output keeps bun's layout (2-space JSON with trailing commas; one line per
 * package entry, blank-line separated), so `bun install --frozen-lockfile`
 * validates the result without rewriting it.
 */
import { $ } from "bun";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface ParsedLock {
	/** Everything except `packages`, parsed. */
	head: JsonObject;
	/** `packages` entries as the exact value text bun wrote, keyed by package key. */
	packages: Map<string, string>;
}

class MergeConflict extends Error {}

const PACKAGE_ENTRY = /^ {4}("(?:[^"\\]|\\.)*"): (.*),$/;

function parseLock(text: string): ParsedLock {
	const lines = text.split("\n");
	const start = lines.indexOf('  "packages": {');
	if (start < 0) throw new Error("bun.lock has no packages section");
	const end = lines.indexOf("  }", start);
	if (end < 0) throw new Error("bun.lock packages section is not closed");
	const packages = new Map<string, string>();
	for (const line of lines.slice(start + 1, end)) {
		if (line === "") continue;
		const match = PACKAGE_ENTRY.exec(line);
		if (!match) throw new Error(`Unrecognized bun.lock package line: ${line.slice(0, 120)}`);
		packages.set(JSON.parse(match[1]) as string, match[2]);
	}
	const parsed = Bun.JSON5.parse(text) as JsonObject;
	delete parsed.packages;
	return { head: parsed, packages };
}

function isObject(value: Json | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function same(a: Json | string | undefined, b: Json | string | undefined): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Merged key order. Sorted maps (dependency lists) stay sorted; otherwise theirs'
 * order, with ours-only keys placed after their nearest preceding key in ours.
 */
function mergedOrder(ours: string[], theirs: string[], keep: (key: string) => boolean): string[] {
	const sorted = (keys: string[]) => keys.every((key, i) => i === 0 || keys[i - 1] < key);
	if (sorted(ours) && sorted(theirs)) return [...new Set([...ours, ...theirs])].filter(keep).sort();
	const result = theirs.filter(keep);
	const present = new Set(result);
	let anchor = -1;
	for (const key of ours) {
		if (present.has(key)) {
			anchor = result.indexOf(key);
			continue;
		}
		if (!keep(key)) continue;
		result.splice(anchor + 1, 0, key);
		present.add(key);
		anchor++;
	}
	return result;
}

function mergeValue(
	path: string,
	base: Json | undefined,
	ours: Json | undefined,
	theirs: Json | undefined,
): Json | undefined {
	if (same(ours, theirs)) return ours;
	if (same(base, ours)) return theirs;
	if (same(base, theirs)) return ours;
	if (isObject(ours) && isObject(theirs)) {
		const baseObject = isObject(base) ? base : {};
		const merged = new Map<string, Json>();
		for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
			const value = mergeValue(`${path}/${key}`, baseObject[key], ours[key], theirs[key]);
			if (value !== undefined) merged.set(key, value);
		}
		const result: JsonObject = {};
		for (const key of mergedOrder(Object.keys(ours), Object.keys(theirs), key => merged.has(key))) {
			result[key] = merged.get(key) as Json;
		}
		return result;
	}
	throw new MergeConflict(`both sides changed ${path}`);
}

function mergePackages(
	base: Map<string, string>,
	ours: Map<string, string>,
	theirs: Map<string, string>,
): Map<string, string> {
	const merged = new Map<string, string>();
	for (const key of new Set([...ours.keys(), ...theirs.keys()])) {
		const b = base.get(key);
		const o = ours.get(key);
		const t = theirs.get(key);
		const value = o === t ? o : o === b ? t : t === b ? o : undefined;
		if (value === undefined && o !== t && o !== b && t !== b) {
			throw new MergeConflict(`both sides changed packages/${key}`);
		}
		if (value !== undefined) merged.set(key, value);
	}
	const result = new Map<string, string>();
	for (const key of mergedOrder([...ours.keys()], [...theirs.keys()], key => merged.has(key))) {
		result.set(key, merged.get(key) as string);
	}
	return result;
}

function serialize(value: Json, indent: string): string {
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		return `[\n${value.map(item => `${indent}  ${serialize(item, `${indent}  `)},\n`).join("")}${indent}]`;
	}
	if (isObject(value)) {
		const keys = Object.keys(value);
		if (keys.length === 0) return "{}";
		return `{\n${keys.map(key => `${indent}  ${JSON.stringify(key)}: ${serialize(value[key], `${indent}  `)},\n`).join("")}${indent}}`;
	}
	return JSON.stringify(value);
}

export function mergeLockfiles(baseText: string, oursText: string, theirsText: string): string {
	const base = parseLock(baseText);
	const ours = parseLock(oursText);
	const theirs = parseLock(theirsText);
	const head = mergeValue("", base.head, ours.head, theirs.head);
	if (!isObject(head)) throw new MergeConflict("bun.lock root is not an object");
	const packages = mergePackages(base.packages, ours.packages, theirs.packages);
	let out = "{\n";
	for (const key of Object.keys(head)) out += `  ${JSON.stringify(key)}: ${serialize(head[key], "  ")},\n`;
	out += '  "packages": {\n';
	out += [...packages].map(([key, value]) => `    ${JSON.stringify(key)}: ${value},\n`).join("\n");
	out += "  }\n}\n";
	return out;
}

if (import.meta.main) {
	const [basePath, oursPath, theirsPath] = process.argv.slice(2);
	if (!basePath || !oursPath || !theirsPath) {
		console.error("usage: lockfile-merge.ts <base> <ours> <theirs>");
		process.exit(2);
	}
	try {
		const merged = mergeLockfiles(
			await Bun.file(basePath).text(),
			await Bun.file(oursPath).text(),
			await Bun.file(theirsPath).text(),
		);
		await Bun.write(oursPath, merged);
	} catch (error) {
		console.error(`bun.lock merge: ${error instanceof Error ? error.message : String(error)}`);
		// Leave git's usual conflict markers for manual resolution.
		await $`git merge-file -L ours -L base -L theirs ${oursPath} ${basePath} ${theirsPath}`.quiet().nothrow();
		process.exit(1);
	}
}
