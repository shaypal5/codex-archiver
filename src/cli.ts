#!/usr/bin/env node
import {
  clearSearchIndex,
  readSearchIndexMeta,
  rebuildSearchIndex,
  searchThreads,
} from "./indexer.js";
import { defaultCodexHome, defaultIndexPath } from "./paths.js";
import { createRestorePlan } from "./restore.js";
import { scanCodexStorage } from "./scanner.js";
import { serve } from "./server.js";
import { diagnoseVisibility } from "./visibility.js";
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

  if (args.command === "diagnose") {
    const action = args.positionals[0] ?? "help";
    const codexHome = stringFlag(args, "codex-home") ?? defaultCodexHome();
    const indexPath = stringFlag(args, "index-path") ?? defaultIndexPath();

    if (action === "visibility") {
      console.log(
        JSON.stringify(
          await diagnoseVisibility({
            codexHome,
            indexPath,
            timeoutMs: numberFlag(args, "timeout-ms") ?? undefined,
            includeCodexResume: !booleanFlag(args, "no-codex-resume"),
            includeAppServer: !booleanFlag(args, "no-app-server"),
            appServerUrl: stringFlag(args, "app-server-url") ?? undefined,
            codexCommand: stringFlag(args, "codex-command") ?? undefined,
          }),
          null,
          2,
        ),
      );
      return;
    }

    console.error(`Unknown diagnose action: ${action}`);
    printHelp();
    process.exit(1);
    return;
  }

  if (args.command === "restore") {
    const action = args.positionals[0] ?? "help";
    const codexHome = stringFlag(args, "codex-home") ?? defaultCodexHome();
    const indexPath = stringFlag(args, "index-path") ?? defaultIndexPath();

    if (action === "plan") {
      const selectedThreadIds = selectedIdsFromArgs(args);
      if (selectedThreadIds.length === 0) {
        throw new UsageError("restore plan requires at least one selected thread id.");
      }
      console.log(
        JSON.stringify(
          await createRestorePlan({
            codexHome,
            indexPath,
            selectedThreadIds,
          }),
          null,
          2,
        ),
      );
      return;
    }

    console.error(`Unknown restore action: ${action}`);
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

function booleanFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true;
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

function selectedIdsFromArgs(args: ParsedArgs): string[] {
  const positionalIds = args.positionals.slice(1);
  const idsFlag = stringFlag(args, "ids")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? [];
  const threadIdFlag = stringFlag(args, "thread-id");
  return [...positionalIds, ...idsFlag, ...(threadIdFlag ? [threadIdFlag] : [])];
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
  codex-archiver diagnose visibility [--timeout-ms 2500] [--no-codex-resume] [--app-server-url http://127.0.0.1:PORT]
  codex-archiver restore plan THREAD_ID... [--ids id-a,id-b] [--codex-home ~/.codex] [--index-path ~/.cache/codex-archiver/index.sqlite] [--json]

Commands:
  serve   Start the local read-only browser.
  scan    Print a read-only JSON scan of Codex thread storage.
  index   Manage and query the persistent local search index.
  diagnose
          Run read-only diagnostics that compare local/indexed threads with best-effort Codex visibility surfaces.
  restore
          Create explicit dry-run restore plans. Planning is read-only and never mutates ~/.codex.
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
