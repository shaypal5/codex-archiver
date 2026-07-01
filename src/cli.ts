#!/usr/bin/env node
import {
  clearSearchIndex,
  readSearchIndexMeta,
  rebuildSearchIndex,
  searchThreads,
} from "./indexer.js";
import { defaultCodexHome, defaultIndexPath } from "./paths.js";
import { scanCodexStorage } from "./scanner.js";
import { serve } from "./server.js";
import type { RestoreStatus } from "./types.js";

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

class UsageError extends Error {}

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
    const indexPath = stringFlag(args, "index-path") ?? defaultIndexPath();
    await serve({ host, port, codexHome, indexPath });
    return;
  }

  if (args.command === "index") {
    const action = args.positionals[0] ?? "status";
    const codexHome = stringFlag(args, "codex-home") ?? defaultCodexHome();
    const indexPath = stringFlag(args, "index-path") ?? defaultIndexPath();

    if (action === "rebuild") {
      console.log(JSON.stringify(await rebuildSearchIndex({ codexHome, indexPath }), null, 2));
      return;
    }

    if (action === "status") {
      console.log(JSON.stringify(await readSearchIndexMeta({ codexHome, indexPath }), null, 2));
      return;
    }

    if (action === "search") {
      const result = await searchThreads(
        { codexHome, indexPath },
        {
          title: stringFlag(args, "title") ?? undefined,
          content: stringFlag(args, "content") ?? undefined,
          cwd: stringFlag(args, "cwd") ?? undefined,
          status: parseStatusFlag(stringFlag(args, "status")),
          limit: numberFlag(args, "limit") ?? undefined,
          offset: numberFlag(args, "offset") ?? undefined,
        },
      );
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (action === "clear") {
      console.log(JSON.stringify(await clearSearchIndex({ codexHome, indexPath }), null, 2));
      return;
    }

    console.error(`Unknown index action: ${action}`);
    printHelp();
    process.exit(1);
    return;
  }

  printHelp();
  process.exit(args.command === "help" ? 0 : 1);
}

function parseArgs(values: string[]): ParsedArgs {
  const [command = "help", ...rest] = values;
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
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

  return { command, positionals, flags };
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

function parseStatusFlag(value: string | null): RestoreStatus | "all" {
  if (value === null || value === "all") {
    return "all";
  }
  if (
    value === "active" ||
    value === "archived" ||
    value === "hidden" ||
    value === "orphaned" ||
    value === "restorable" ||
    value === "unknown"
  ) {
    return value;
  }
  throw new UsageError(`Invalid status: ${value}`);
}

function printHelp(): void {
  console.log(`codex-archiver

Usage:
  codex-archiver serve [--host 127.0.0.1] [--port 8976] [--codex-home ~/.codex] [--index-path ~/.cache/codex-archiver/index.sqlite]
  codex-archiver scan [--codex-home ~/.codex]
  codex-archiver index rebuild [--codex-home ~/.codex] [--index-path ~/.cache/codex-archiver/index.sqlite]
  codex-archiver index status [--index-path ~/.cache/codex-archiver/index.sqlite]
  codex-archiver index search [--title text] [--content text] [--cwd path] [--status active] [--limit 100] [--offset 0]
  codex-archiver index clear [--index-path ~/.cache/codex-archiver/index.sqlite]

Commands:
  serve   Start the local read-only browser.
  scan    Print a read-only JSON scan of Codex thread storage.
  index   Manage and query the persistent local search index.
`);
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(error.message);
    process.exit(2);
  }
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
