#!/usr/bin/env node
import { defaultCodexHome } from "./paths.js";
import { scanCodexStorage } from "./scanner.js";
import { serve } from "./server.js";

interface ParsedArgs {
  command: string;
  flags: Map<string, string | boolean>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "scan") {
    const codexHome = stringFlag(args, "codex-home") ?? defaultCodexHome();
    const result = await scanCodexStorage(codexHome);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.command === "serve") {
    const host = stringFlag(args, "host") ?? "127.0.0.1";
    const port = numberFlag(args, "port") ?? 8976;
    const codexHome = stringFlag(args, "codex-home") ?? defaultCodexHome();
    await serve({ host, port, codexHome });
    return;
  }

  printHelp();
  process.exit(args.command === "help" ? 0 : 1);
}

function parseArgs(values: string[]): ParsedArgs {
  const [command = "help", ...rest] = values;
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) {
      continue;
    }
    const withoutPrefix = value.slice(2);
    const [key, inlineValue] = withoutPrefix.split("=", 2);
    if (inlineValue !== undefined) {
      flags.set(key, inlineValue);
      continue;
    }
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }

  return { command, flags };
}

function stringFlag(args: ParsedArgs, name: string): string | null {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : null;
}

function numberFlag(args: ParsedArgs, name: string): number | null {
  const value = stringFlag(args, name);
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function printHelp(): void {
  console.log(`codex-archiver

Usage:
  codex-archiver serve [--host 127.0.0.1] [--port 8976] [--codex-home ~/.codex]
  codex-archiver scan [--codex-home ~/.codex]

Commands:
  serve   Start the local read-only browser.
  scan    Print a read-only JSON scan of Codex thread storage.
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
