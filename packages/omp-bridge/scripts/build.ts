import { isBuiltin } from "node:module";
import * as path from "node:path";

const packageDir = path.resolve(import.meta.dir, "..");
const repositoryDir = path.resolve(packageDir, "../..");
const outdir = path.resolve(packageDir, "dist");
const allowedInputs: Record<string, true> = {
	"packages/omp-bridge/src/index.ts": true,
	"packages/omp-bridge/src/host.ts": true,
	"packages/omp-bridge/src/session.ts": true,
	"packages/omp-bridge/prompts/bridge.md": true,
	"packages/omp-bridge/prompts/peer.md": true,
	"packages/utils/src/discord-client.ts": true,
	"packages/utils/src/discord-private-files.ts": true,
	"packages/wire/src/discord-mode.ts": true,
};

// Keep cwd-relative and root-relative metafile paths identical across invocation locations.
process.chdir(repositoryDir);
const result = await Bun.build({
	entrypoints: [path.resolve(packageDir, "src/index.ts")],
	root: repositoryDir,
	outdir,
	naming: "index.js",
	target: "bun",
	format: "esm",
	packages: "bundle",
	loader: { ".md": "text" },
	metafile: true,
	throw: false,
});
if (!result.success || !result.metafile) {
	throw new Error(`Bridge bundle failed:\n${result.logs.map(log => log.message).join("\n")}`);
}

const inputs = Object.keys(result.metafile.inputs)
	.map(input => path.relative(repositoryDir, path.resolve(repositoryDir, input)))
	.sort();
await Bun.write(path.resolve(outdir, "metafile.json"), `${JSON.stringify(result.metafile, null, 2)}\n`);
await Bun.write(path.resolve(outdir, "inputs.json"), `${JSON.stringify(inputs, null, 2)}\n`);
for (const input of inputs) {
	if (!allowedInputs[input]) throw new Error(`Bridge runtime boundary violation: unexpected input ${input}`);
}
for (const output of Object.values(result.metafile.outputs)) {
	for (const dependency of output.imports) {
		if (!isBuiltin(dependency.path) && dependency.path !== "bun" && !dependency.path.startsWith("bun:")) {
			throw new Error(`Bridge runtime boundary violation: external import ${dependency.path}`);
		}
	}
}
console.log(
	`Built ${path.relative(repositoryDir, path.resolve(outdir, "index.js"))}; ${inputs.length} protocol-only inputs. Boundary evidence: dist/metafile.json and dist/inputs.json.`,
);
