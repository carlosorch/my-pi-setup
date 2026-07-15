import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

const expected = {
  extensions: [
    "./extensions/subagents/src/extension/index.ts",
    "./extensions/workflows/index.ts",
  ],
  skills: ["./extensions/subagents/skills"],
  prompts: ["./extensions/subagents/prompts"],
};

test("root manifest exposes only the integrated Pi resources", () => {
  assert.equal(pkg.name, "my-pi-setup");
  assert.equal(pkg.version, "0.1.3");
  assert.equal(pkg.private, true);
  assert.deepEqual(pkg.keywords, ["pi-package"]);
  assert.deepEqual(pkg.pi, expected);
  assert.equal(pkg.pi.themes, undefined);

  for (const paths of Object.values(expected)) {
    for (const relative of paths) {
      assert.equal(
        existsSync(join(rootPath, relative)),
        true,
        `${relative} must exist`,
      );
    }
  }
});

test("git-package install includes the nested subagents workspace without duplicate package dependencies", () => {
  assert.deepEqual(pkg.workspaces, ["extensions/subagents"]);
  assert.equal(pkg.dependencies?.["pi-subagents"], undefined);
  assert.equal(pkg.devDependencies?.["pi-subagents"], undefined);
  assert.equal(pkg.peerDependencies?.["pi-subagents"], undefined);
  assert.equal(pkg.peerDependencies?.typebox, "*");
  assert.equal(typeof pkg.devDependencies?.typebox, "string");

  const nested = JSON.parse(
    readFileSync(new URL("extensions/subagents/package.json", root), "utf8"),
  );
  for (const dependency of ["jiti", "yaml"]) {
    assert.equal(
      typeof nested.dependencies?.[dependency],
      "string",
      `${dependency} must be installed by the workspace`,
    );
  }
  for (const dependency of ["@earendil-works/pi-tui", "typebox"]) {
    assert.equal(nested.peerDependencies?.[dependency], "*");
    assert.equal(nested.peerDependenciesMeta?.[dependency]?.optional, true);
    assert.equal(nested.dependencies?.[dependency], undefined);
    assert.equal(
      nested.devDependencies?.[dependency],
      dependency === "typebox" ? "1.3.6" : "0.80.6",
    );
  }
});
