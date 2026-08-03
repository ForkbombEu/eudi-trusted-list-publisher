#!/usr/bin/env node
/**
 * Copies the vendored XML Schemas into the TypeScript build output.
 *
 * `tsc` copies `schemas/**\/*.json` because `resolveJsonModule` is on, but it
 * has no reason to copy `.xsd` files. `src/core/tsl612/schema.ts` resolves
 * `schemas/etsi/119612/` relative to its own location, so the same relative
 * path has to exist beside the compiled output as well as in the source tree.
 *
 * The destination is read from the compiler's `outDir` rather than written
 * here, so the build output moves in one place.
 */
import { cp, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsconfigPath = resolve(projectRoot, "tsconfig.json");

const tsconfig = JSON.parse(await readFile(tsconfigPath, "utf-8"));
const outDir = tsconfig.compilerOptions?.outDir;
if (!outDir) {
  console.error(`No compilerOptions.outDir in ${tsconfigPath}`);
  process.exit(1);
}

const relativeSchemaDir = "schemas/etsi/119612";
const source = resolve(projectRoot, relativeSchemaDir);
const destination = resolve(projectRoot, outDir, relativeSchemaDir);

await mkdir(dirname(destination), { recursive: true });
await cp(source, destination, { recursive: true });
console.log(`Copied ${relativeSchemaDir} to ${resolve(projectRoot, outDir)}`);
