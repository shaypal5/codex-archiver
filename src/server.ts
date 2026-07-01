import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultCodexHome } from "./paths.js";
import { filterThreads, scanCodexStorage } from "./scanner.js";
import type { ScanResult, ThreadQuery } from "./types.js";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

export interface ServeOptions {
  host: string;
  port: number;
  codexHome?: string;
}

export async function serve(options: ServeOptions): Promise<void> {
  let lastScan: ScanResult | null = null;
  let scanInFlight: Promise<ScanResult> | null = null;
  const codexHome = options.codexHome ?? defaultCodexHome();

  async function getScan(): Promise<ScanResult> {
    if (lastScan) {
      return lastScan;
    }
    scanInFlight ??= scanCodexStorage(codexHome).finally(() => {
      scanInFlight = null;
    });
    lastScan = await scanInFlight;
    return lastScan;
  }

  async function rebuildScan(): Promise<ScanResult> {
    scanInFlight ??= scanCodexStorage(codexHome).finally(() => {
      scanInFlight = null;
    });
    lastScan = await scanInFlight;
    return lastScan;
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      if (url.pathname.startsWith("/api/") && !authorizeApiRequest(request)) {
        return sendJson(response, { error: "Forbidden" }, 403);
      }

      if (url.pathname === "/api/diagnostics") {
        return sendJson(response, await getScan());
      }

      if (url.pathname === "/api/index/rebuild" && request.method === "POST") {
        return sendJson(response, await rebuildScan());
      }

      if (url.pathname === "/api/threads") {
        const scan = await getScan();
        const query: ThreadQuery = {
          title: url.searchParams.get("title") ?? undefined,
          content: url.searchParams.get("content") ?? undefined,
          cwd: url.searchParams.get("cwd") ?? undefined,
          status: (url.searchParams.get("status") as ThreadQuery["status"]) ?? "all",
        };
        return sendJson(response, {
          stats: scan.stats,
          threads: filterThreads(scan.threads, query),
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
  console.log(`scanning Codex home: ${codexHome}`);
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
