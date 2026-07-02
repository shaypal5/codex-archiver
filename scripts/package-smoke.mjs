#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const tempRoot = await mkdtemp(path.join(tmpdir(), "codex-archiver-package-smoke-"));

try {
  const packDirectory = path.join(tempRoot, "pack");
  const installDirectory = path.join(tempRoot, "consumer");
  await mkdir(packDirectory, { recursive: true });
  await mkdir(installDirectory, { recursive: true });

  const { stdout: packStdout } = await execFileAsync("npm", ["pack", "--json", "--pack-destination", packDirectory], {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024 * 10,
  });
  const [packResult] = JSON.parse(packStdout);
  const tarballPath = path.join(packDirectory, packResult.filename);

  const files = new Set(packResult.files.map((file) => file.path));
  const requiredFiles = [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/cli.js",
    "dist/server.js",
    "web/index.html",
    "web/app.js",
    "web/styles.css",
    "docs/restore-planning.md",
    "docs/search-index.md",
    "docs/visibility-diagnostics.md",
  ];
  const forbiddenPrefixes = ["src/", ".github/", "scripts/", "worktrees/"];
  const forbiddenFiles = ["package-lock.json"];
  const forbiddenSuffixes = [".test.js", ".test.d.ts", ".test.ts", ".log"];

  for (const requiredFile of requiredFiles) {
    assert(files.has(requiredFile), `Packed artifact is missing ${requiredFile}`);
  }
  for (const file of files) {
    assert(!forbiddenPrefixes.some((prefix) => file.startsWith(prefix)), `Packed artifact includes ${file}`);
    assert(!forbiddenFiles.includes(file), `Packed artifact includes ${file}`);
    assert(!forbiddenSuffixes.some((suffix) => file.endsWith(suffix)), `Packed artifact includes ${file}`);
  }

  await execFileAsync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], {
    cwd: installDirectory,
    maxBuffer: 1024 * 1024 * 10,
  });

  const binPath = path.join(installDirectory, "node_modules", ".bin", "codex-archiver");
  await stat(binPath);

  const { stdout: helpStdout } = await execFileAsync(binPath, ["--help"], { cwd: installDirectory });
  assert(helpStdout.includes("codex-archiver"), "CLI help does not include the command name.");
  assert(helpStdout.includes("restore apply"), "CLI help does not document restore apply.");
  assert(helpStdout.includes("restore undo"), "CLI help does not document restore undo.");

  const { stdout: versionStdout } = await execFileAsync(binPath, ["--version"], { cwd: installDirectory });
  assert(versionStdout.trim() === packageJson.version, `CLI version ${versionStdout.trim()} does not match package ${packageJson.version}.`);

  console.log(`Package smoke passed for ${packResult.filename} (${packResult.files.length} files).`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
