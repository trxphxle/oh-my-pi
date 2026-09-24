#!/usr/bin/env bun
import * as path from "node:path";
import { installHaiso, type InstallOptions } from "../packages/coding-agent/src/haiso-update/release";

const HELP = `Usage: bun scripts/install-haiso.ts --binary PATH --runtime PATH --fork-patch PATH
       --upstream-tag TAG --upstream-commit SHA --state-fingerprint SHA --broker-fingerprint SHA [options]

Install a compiled Haiso release without changing omp or a source checkout.
  --binary PATH             Required compiled Haiso executable
  --runtime PATH            Required matching standalone Bun; never downloaded or inferred
  --fork-patch PATH         Required frozen patch against the pinned upstream commit
  --upstream-tag TAG        Stable upstream version, e.g. v18.3.0
  --upstream-commit SHA     Full 40-character upstream commit
  --state-fingerprint SHA   Conservative shared-state compatibility SHA-256
  --broker-fingerprint SHA  Conservative broker-protocol compatibility SHA-256
  --prefix PATH             Active root (default: ~/.local/share/haiso/fork)
  --bin-dir PATH            Launcher directory (default: ~/.local/bin)
  --replace-legacy          Explicitly replace an unmanaged launcher or mutable v1 install
  --help                    Show this help

Copies and validates immutable release artifacts, then atomically switches the
active root. Existing compiled releases remain available for guarded rollback.
Shared .omp state is intentionally retained; no database rollback or broker restart.
Compatibility changes require separately staged, explicitly reviewed activation.
`;

export function parseInstallArgs(args: string[]): InstallOptions | null {
	if (args.length === 1 && args[0] === "--help") return null;
	const options: InstallOptions = {
		binary: "",
		runtime: "",
		forkPatch: "",
		upstream: { tag: "", commit: "" },
		compatibility: { state: "", broker: "" },
	};
	const seen = new Set<string>();
	for (let index = 0; index < args.length; index++) {
		const flag = args[index]!;
		if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
		seen.add(flag);
		if (flag === "--replace-legacy") {
			options.replaceLegacy = true;
			continue;
		}
		if (
			![
				"--binary",
				"--runtime",
				"--fork-patch",
				"--upstream-tag",
				"--upstream-commit",
				"--state-fingerprint",
				"--broker-fingerprint",
				"--prefix",
				"--bin-dir",
			].includes(flag)
		) {
			throw new Error(`Unknown option: ${flag}. Use --help.`);
		}
		const value = args[++index];
		if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
		switch (flag) {
			case "--binary":
				options.binary = value;
				break;
			case "--runtime":
				options.runtime = value;
				break;
			case "--fork-patch":
				options.forkPatch = value;
				break;
			case "--upstream-tag":
				options.upstream.tag = value;
				break;
			case "--upstream-commit":
				options.upstream.commit = value;
				break;
			case "--state-fingerprint":
				options.compatibility.state = value;
				break;
			case "--broker-fingerprint":
				options.compatibility.broker = value;
				break;
			case "--prefix":
				options.prefix = value;
				break;
			case "--bin-dir":
				options.binDir = value;
				break;
		}
	}
	for (const [flag, value] of [
		["--binary", options.binary],
		["--runtime", options.runtime],
		["--fork-patch", options.forkPatch],
		["--upstream-tag", options.upstream.tag],
		["--upstream-commit", options.upstream.commit],
		["--state-fingerprint", options.compatibility.state],
		["--broker-fingerprint", options.compatibility.broker],
	]) {
		if (!value) throw new Error(`${flag} is required. Use --help.`);
	}
	return options;
}

if (import.meta.main) {
	try {
		const options = parseInstallArgs(process.argv.slice(2));
		if (!options) process.stdout.write(HELP);
		else {
			const receipt = await installHaiso(options);
			console.log(
				`Installed ${receipt.version}: ${receipt.launcher}\nReceipt: ${path.join(receipt.release, "receipt.json")}`,
			);
		}
	} catch (error) {
		console.error(`Haiso installation failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
