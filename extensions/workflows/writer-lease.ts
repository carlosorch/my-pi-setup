import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function repositoryRoot(cwd: string): string {
  let current = fs.realpathSync(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return fs.realpathSync(cwd);
    current = parent;
  }
}

function processStart(pid: number): string | undefined {
  try {
    return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[21];
  } catch {
    return undefined;
  }
}

function ownerIsLive(owner: {
  pid?: unknown;
  host?: unknown;
  start?: unknown;
}): boolean {
  if (owner.host !== os.hostname() || !Number.isSafeInteger(owner.pid))
    return true;
  try {
    process.kill(owner.pid as number, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
  const start = processStart(owner.pid as number);
  return !start || owner.start === start;
}

export interface WriterLease {
  root: string;
  release(): void;
}

export function acquireWriterLease(
  cwd: string,
  leaseBase = path.join(os.tmpdir(), "pi-workflow-writer-leases"),
): WriterLease {
  const root = repositoryRoot(cwd);
  // ponytail: one global workflow writer lease; scope by disjoint roots only if measured throughput requires it.
  const leaseDir = path.join(leaseBase, "writer");
  const reclaimDir = path.join(leaseBase, "reclaim");
  const token = randomUUID();
  fs.mkdirSync(leaseBase, { recursive: true, mode: 0o700 });
  const claim = () => {
    fs.mkdirSync(leaseDir, { mode: 0o700 });
    fs.writeFileSync(
      path.join(leaseDir, "owner.json"),
      JSON.stringify({
        token,
        pid: process.pid,
        host: os.hostname(),
        start: processStart(process.pid),
        root,
      }),
      { mode: 0o600 },
    );
  };
  const readOwner = () => {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(leaseDir, "owner.json"), "utf8"),
      ) as {
        token?: string;
        pid?: unknown;
        host?: unknown;
        start?: unknown;
        root?: unknown;
      };
    } catch {
      throw new Error("Workflow writer lease has unverifiable ownership");
    }
  };
  try {
    claim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (ownerIsLive(readOwner()))
      throw new Error("Another workflow writer already owns the global lease");
    try {
      fs.mkdirSync(reclaimDir, { mode: 0o700 });
    } catch (reclaimError) {
      if ((reclaimError as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error("Workflow writer lease is already being reclaimed");
      throw reclaimError;
    }
    try {
      if (ownerIsLive(readOwner()))
        throw new Error(
          "Another workflow writer already owns the global lease",
        );
      fs.rmSync(leaseDir, { recursive: true, force: true });
      claim();
    } finally {
      fs.rmSync(reclaimDir, { recursive: true, force: true });
    }
  }
  return {
    root,
    release() {
      try {
        const owner = readOwner();
        if (owner.token === token)
          fs.rmSync(leaseDir, { recursive: true, force: true });
      } catch {
        // Never remove a lease whose ownership can no longer be proven.
      }
    },
  };
}
