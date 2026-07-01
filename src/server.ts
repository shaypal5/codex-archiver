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
  const codexHome = options.codexHome ?? defaultCodexHome();

  async function getScan(): Promise<ScanResult> {
    lastScan ??= await scanCodexStorage(codexHome);
    return lastScan;
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      if (url.pathname === "/api/diagnostics") {
        return sendJson(response, await getScan());
      }

      if (url.pathname === "/api/index/rebuild" && request.method === "POST") {
        lastScan = await scanCodexStorage(codexHome);
        return sendJson(response, lastScan);
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

      return sendStatic(request, response, url.pathname);
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
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<void> {
  const safePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(WEB_ROOT, safePath);
  if (!filePath.startsWith(WEB_ROOT)) {
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
