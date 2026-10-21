// scripts/spec-refs.mjs 的测试：规格规则号与测试引用的对齐检查（工具本身不验证某条产品规则）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { checkSpecRefs, collectSpecRules, collectTestRefs } from "../scripts/spec-refs.mjs";

function fixture(files: Record<string, string>, run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pigeon-spec-refs-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      const file = join(root, path);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, text);
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const SPEC_VIEWS = [
  "- **VIEWS-001** first",
  "- **VIEWS-002** second",
  "- **VIEWS-003** third",
  "",
].join("\n");

const SPEC_CLI = "- **CLI-001** first\n";

test("规格规则号按区收集；同一规则号写两次报重复", () => {
  fixture(
    {
      "spec/views.md": `${SPEC_VIEWS}- **VIEWS-002** again\n`,
      "spec/cli.md": SPEC_CLI,
      "src/unused.ts": "export {};\n",
    },
    (root) => {
      const spec = collectSpecRules(join(root, "spec"));
      assert.deepEqual([...spec.rules.keys()].sort(), [
        "CLI-001",
        "VIEWS-001",
        "VIEWS-002",
        "VIEWS-003",
      ]);
      assert.equal(spec.duplicates.length, 1);
      assert.equal(spec.duplicates[0]?.rule, "VIEWS-002");
      const checked = checkSpecRefs({ specDir: join(root, "spec"), srcDir: join(root, "src") });
      assert.ok(checked.problems.some((problem) => problem.includes("VIEWS-002")));
    }
  );
});

test("测试标题与上一行的 spec 注释都算引用；标题里的非规则名（如 SHA-256）不算", () => {
  fixture(
    {
      "spec/views.md": SPEC_VIEWS,
      "spec/cli.md": SPEC_CLI,
      "src/example.test.ts": [
        "// spec: CLI-001, VIEWS-999",
        'test("VIEWS-001 works", () => {});',
        'test.skipIf(false)("VIEWS-002 works", () => {});',
        'test("SHA-256 repo", () => {});',
        "",
      ].join("\n"),
    },
    (root) => {
      const refs = collectTestRefs(join(root, "src"), new Set(["VIEWS", "CLI"]));
      assert.deepEqual(refs.map((ref) => `${ref.rule}:${ref.source}`).sort(), [
        "CLI-001:spec comment",
        "VIEWS-001:title",
        "VIEWS-002:title",
        "VIEWS-999:spec comment",
      ]);
      const checked = checkSpecRefs({ specDir: join(root, "spec"), srcDir: join(root, "src") });
      assert.ok(
        checked.problems.some(
          (problem) => problem.includes("VIEWS-999") && problem.includes("not defined")
        )
      );
      assert.deepEqual(checked.report, [
        { area: "CLI", covered: 1, total: 1 },
        { area: "VIEWS", covered: 2, total: 3 },
      ]);
    }
  );
});

test("覆盖低只报告不失败；没有引用的区照样列出 0/总数", () => {
  fixture(
    {
      "spec/views.md": SPEC_VIEWS,
      "spec/cli.md": SPEC_CLI,
      "src/example.test.ts": 'test("VIEWS-003 works", () => {});\n',
    },
    (root) => {
      const checked = checkSpecRefs({ specDir: join(root, "spec"), srcDir: join(root, "src") });
      assert.deepEqual(checked.problems, []);
      assert.deepEqual(checked.report, [
        { area: "CLI", covered: 0, total: 1 },
        { area: "VIEWS", covered: 1, total: 3 },
      ]);
    }
  );
});
