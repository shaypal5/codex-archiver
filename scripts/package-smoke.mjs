#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
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
    assert(!/^docs\/pr-\d+-review-remediation\.md$/.test(file), `Packed artifact includes process-only doc ${file}`);
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

  await smokeServe(binPath, installDirectory, tempRoot);

  console.log(`Package smoke passed for ${packResult.filename} (${packResult.files.length} files).`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function smokeServe(binPath, installDirectory, tempRoot) {
  const codexHome = path.join(tempRoot, "codex-home");
  const indexPath = path.join(tempRoot, "index.sqlite");
  await mkdir(codexHome, { recursive: true });

  const server = spawn(
    binPath,
    ["serve", "--host", "127.0.0.1", "--port", "0", "--codex-home", codexHome, "--index-path", indexPath],
    { cwd: installDirectory, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";

  try {
    const serverUrl = await waitForServerUrl(server, (chunk) => {
      output += chunk;
    });
    const indexResponse = await fetch(serverUrl);
    const indexBody = await indexResponse.text();
    assert(indexResponse.status === 200, `Packaged server returned ${indexResponse.status} for /.`);
    assert(indexBody.includes("Codex Archiver"), "Packaged server did not return the web UI shell.");

    const stylesResponse = await fetch(new URL("/styles.css", serverUrl));
    const stylesBody = await stylesResponse.text();
    assert(stylesResponse.status === 200, `Packaged server returned ${stylesResponse.status} for /styles.css.`);
    assert(stylesBody.includes(".shell"), "Packaged server did not return expected stylesheet content.");
  } finally {
    server.kill("SIGTERM");
    await waitForExit(server, output);
  }
}

function waitForServerUrl(server, appendOutput) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for packaged server to start."));
    }, 10_000);

    function cleanup() {
      clearTimeout(timeout);
      server.stdout.off("data", onStdout);
      server.stderr.off("data", onStderr);
      server.off("error", onError);
      server.off("exit", onExit);
    }

    function onStdout(data) {
      const text = data.toString("utf8");
      stdout += text;
      appendOutput(text);
      const match = stdout.match(/codex-archiver listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        cleanup();
        resolve(match[1]);
      }
    }

    function onStderr(data) {
      appendOutput(data.toString("utf8"));
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    function onExit(code, signal) {
      cleanup();
      reject(new Error(`Packaged server exited before readiness with code ${code ?? "null"} and signal ${signal ?? "null"}.`));
    }

    server.stdout.on("data", onStdout);
    server.stderr.on("data", onStderr);
    server.once("error", onError);
    server.once("exit", onExit);
  });
}

function waitForExit(server, output) {
  return new Promise((resolve, reject) => {
    if (server.exitCode !== null || server.signalCode !== null) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      server.kill("SIGKILL");
      reject(new Error(`Packaged server did not stop after SIGTERM. Output:\n${output}`));
    }, 5_000);

    server.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
