import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Writable } from "node:stream";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runSql(dbPath: string, sql: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("sqlite3", [dbPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `sqlite3 exited with code ${code}`));
      }
    });

    child.stdin.end(sql);
  });
}

export async function runSqlStream(
  dbPath: string,
  writeScript: (writer: SqlWriter) => Promise<void>,
): Promise<void> {
  const child = spawn("sqlite3", [dbPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const closePromise = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `sqlite3 exited with code ${code}`));
      }
    });
  });

  try {
    const writer = new SqlWriter(child.stdin);
    await writeScript(writer);
    child.stdin.end();
    await closePromise;
  } catch (error) {
    child.stdin.destroy();
    child.kill();
    await closePromise.catch(() => undefined);
    throw error;
  }
}

export async function queryJson<T>(dbPath: string, sql: string): Promise<T[]> {
  const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql], {
    maxBuffer: 1024 * 1024 * 128,
  });
  return JSON.parse(stdout || "[]") as T[];
}

export function sqlValue(value: string | number | boolean | null): string {
  if (value === null) {
    return "NULL";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  return `'${value.replaceAll("'", "''")}'`;
}

export function sqlLikePattern(value: string): string {
  return `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

export class SqlWriter {
  constructor(private readonly stream: Writable) {}

  async write(statement: string): Promise<void> {
    if (!this.stream.write(`${statement}\n`)) {
      await once(this.stream, "drain");
    }
  }
}
