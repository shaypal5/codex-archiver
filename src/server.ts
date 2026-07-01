import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureSearchIndex,
  readSearchIndexMeta,
  rebuildSearchIndex,
  searchThreads,
} from "./indexer.js";
import { defaultCodexHome, defaultIndexPath } from "./paths.js";
import type { ScanResult, SearchIndexMeta, ThreadQuery } from "./types.js";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

export interface ServeOptions {
  host: string;
  port: number;
  codexHome?: string;
  indexPath?: string;
}

export async function serve(options: ServeOptions): Promise<void> {
  const codexHome = options.codexHome ?? defaultCodexHome();
  const indexPath = options.indexPath ?? defaultIndexPath();
  let indexInFlight: Promise<SearchIndexMeta> | null = null;

  async function ensureIndex(): Promise<SearchIndexMeta> {
    indexInFlight ??= ensureSearchIndex({ codexHome, indexPath }).finally(() => {
      indexInFlight = null;
    });
    return indexInFlight;
  }

  async function rebuildIndex(): Promise<SearchIndexMeta> {
    indexInFlight ??= rebuildSearchIndex({ codexHome, indexPath }).finally(() => {
      indexInFlight = null;
    });
    return indexInFlight;
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      if (url.pathname.startsWith("/api/") && !authorizeApiRequest(request)) {
        return sendJson(response, { error: "Forbidden" }, 403);
      }

      if (url.pathname === "/api/diagnostics") {
        await ensureIndex();
        return sendJson(response, metaToResponse(await readSearchIndexMeta({ codexHome, indexPath })));
      }

      if (url.pathname === "/api/index/rebuild" && request.method === "POST") {
        return sendJson(response, metaToResponse(await rebuildIndex()));
      }

      if (url.pathname === "/api/threads") {
        await ensureIndex();
        const status = parseStatusParam(url.searchParams.get("status"));
        if (status === "invalid") {
          return sendJson(response, { error: "Invalid status filter" }, 400);
        }
        const query: ThreadQuery = {
          title: url.searchParams.get("title") ?? undefined,
          content: url.searchParams.get("content") ?? undefined,
          cwd: url.searchParams.get("cwd") ?? undefined,
          status,
          limit: parseIntegerParam(url.searchParams.get("limit")),
          offset: parseIntegerParam(url.searchParams.get("offset")),
        };
        const result = await searchThreads({ codexHome, indexPath }, query);
        return sendJson(response, {
          stats: result.stats,
          threads: result.threads,
          totalMatches: result.totalMatches,
          limit: result.limit,
          offset: result.offset,
        });
      }

      return sendStatic(response, url.pathname);
    } catch (error) {
      return sendJson(
        response,
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port, options.host, resolve);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  console.log(`codex-archiver listening on http://${options.host}:${port}`);
  console.log(`Codex home: ${codexHome}`);
  console.log(`search index: ${indexPath}`);
}

async function sendStatic(
  response: ServerResponse,
  pathname: string,
): Promise<void> {
  const safePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(WEB_ROOT, safePath);
  if (!isPathInside(WEB_ROOT, filePath)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, { "Content-Type": contentType(filePath) });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value, null, 2));
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }
  return "application/octet-stream";
}

function authorizeApiRequest(request: IncomingMessage): boolean {
  if (request.method === "GET" || request.method === "HEAD") {
    return true;
  }

  if (request.headers["x-codex-archiver-intent"] !== "local-api") {
    return false;
  }

  const origin = request.headers.origin;
  if (typeof origin !== "string") {
    return true;
  }

  try {
    const parsed = new URL(origin);
    return ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function metaToResponse(
  meta: SearchIndexMeta,
): ScanResult & { indexPath: string; sourceFingerprint: string | null } {
  return {
    codexHome: meta.codexHome,
    indexPath: meta.indexPath,
    scannedAt: meta.rebuiltAt ?? new Date().toISOString(),
    sourceFingerprint: meta.sourceFingerprint,
    stats: meta.stats,
    diagnostics: meta.diagnostics,
    threads: [],
  };
}

function parseStatusParam(value: string | null): ThreadQuery["status"] | "invalid" {
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
  return "invalid";
}

function parseIntegerParam(value: string | null): number | undefined {
  if (value === null || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
