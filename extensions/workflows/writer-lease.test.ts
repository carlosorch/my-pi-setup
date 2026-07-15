import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { acquireWriterLease } from "./writer-lease.ts";

function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-lease-test-"));
  const repo = path.join(temp, "repo");
  const leases = path.join(temp, "leases");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  return { temp, repo, leases };
}

function writeStaleLease(leases: string) {
  const leaseDir = path.join(leases, "writer");
  fs.mkdirSync(leaseDir, { recursive: true });
  fs.writeFileSync(
    path.join(leaseDir, "owner.json"),
    JSON.stringify({ pid: 999_999_999, host: os.hostname(), start: "dead" }),
  );
}

test("writer lease globally serializes live workflows and releases cleanly", () => {
  const { temp, repo, leases } = fixture();
  const other = path.join(temp, "other");
  fs.mkdirSync(other);
  try {
    const first = acquireWriterLease(repo, leases);
    assert.throws(() => acquireWriterLease(other, leases), /already owns/);
    first.release();
    const second = acquireWriterLease(other, leases);
    second.release();
    assert.deepEqual(fs.readdirSync(leases), []);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("writer lease reclaims a demonstrably stale owner", () => {
  const { temp, repo, leases } = fixture();
  try {
    writeStaleLease(leases);
    const lease = acquireWriterLease(repo, leases);
    assert.equal(lease.root, fs.realpathSync(repo));
    lease.release();
    assert.deepEqual(fs.readdirSync(leases), []);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("concurrent stale contenders elect only one owner", async () => {
  const { temp, repo, leases } = fixture();
  try {
    writeStaleLease(leases);
    const moduleUrl = new URL("./writer-lease.ts", import.meta.url).href;
    const script = `
      const { acquireWriterLease } = await import(${JSON.stringify(moduleUrl)});
      try {
        const lease = acquireWriterLease(${JSON.stringify(repo)}, ${JSON.stringify(leases)});
        console.log("acquired");
        process.stdin.once("data", () => { lease.release(); process.exit(0); });
        process.stdin.resume();
      } catch { console.log("blocked"); }
    `;
    const run = () => {
      const child = spawn(process.execPath, [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        script,
      ]);
      let output = "";
      const firstLine = new Promise<string>((resolve, reject) => {
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (output.includes("\n")) resolve(output.trim());
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (!output.includes("\n"))
            reject(new Error(`child exited ${code} before reporting`));
        });
      });
      const closed = new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`child exited ${code}`)),
        );
      });
      return { child, firstLine, closed };
    };
    const children = [run(), run()];
    const reports = await Promise.all(children.map((child) => child.firstLine));
    assert.deepEqual([...reports].sort(), ["acquired", "blocked"]);
    children[reports.indexOf("acquired")]!.child.stdin.end("release\n");
    await Promise.all(children.map((child) => child.closed));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
