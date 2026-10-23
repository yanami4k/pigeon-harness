// scripts/spec-refs.mjs 的测试：规格规则号与测试引用的对齐检查（工具本身不验证某条产品规则）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  checkSpecRefs,
  collectSpecRules,
  collectTestRefs,
  compareWithBaseline,
  type ExemptRule,
  formatSurplus,
  readBaseline,
  readExemptRules,
  unreferencedByArea,
  writeBaseline,
} from "../scripts/spec-refs.mjs";

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

// The gate compares each area's unreferenced count with the recorded baseline: one new uncovered rule fails.
test("baseline: an area may not leave more rules unreferenced than recorded", () => {
  const report = [
    { area: "CLI", covered: 0, total: 2 },
    { area: "VIEWS", covered: 3, total: 5 },
  ];
  const referenced = new Set(["VIEWS-001", "VIEWS-002", "VIEWS-003"]);
  const rules = new Map([
    ["CLI-001", "cli.md"],
    ["CLI-002", "cli.md"],
    ["VIEWS-001", "views.md"],
    ["VIEWS-002", "views.md"],
    ["VIEWS-003", "views.md"],
    ["VIEWS-004", "views.md"],
    ["VIEWS-005", "views.md"],
  ]);
  const { areas, problems } = unreferencedByArea({ report, referenced, rules, exemptRules: [] });
  assert.deepEqual(
    [...areas.entries()],
    [
      ["CLI", 2],
      ["VIEWS", 2],
    ]
  );
  assert.deepEqual(problems, []);
  // equal to the baseline passes; one more than the baseline fails on that area only
  const equal = compareWithBaseline({ areas, baseline: { CLI: 2, VIEWS: 2 } });
  assert.deepEqual(
    equal.map((row: { area: string; surplus: number }) => [row.area, row.surplus]),
    [
      ["CLI", 0],
      ["VIEWS", 0],
    ]
  );
  const tighter = compareWithBaseline({ areas, baseline: { CLI: 2, VIEWS: 1 } });
  assert.deepEqual(
    tighter.map((row: { area: string; surplus: number }) => [row.area, row.surplus]),
    [
      ["CLI", 0],
      ["VIEWS", 1],
    ]
  );
  const viewRow = tighter[1];
  assert.ok(viewRow !== undefined);
  assert.match(
    formatSurplus(viewRow),
    /VIEWS: 1 more rule\(s\) unreferenced than the baseline \(2 now, 1 allowed\)/
  );
  // an area the baseline does not know is held to zero, so a new area starts covered
  const fresh = compareWithBaseline({ areas: new Map([["NEW", 1]]), baseline: {} });
  assert.deepEqual(
    fresh.map((row: { area: string; allowed: number; surplus: number }) => [
      row.area,
      row.allowed,
      row.surplus,
    ]),
    [["NEW", 0, 1]]
  );
});

// Exemptions are subtracted, but only when the rule is really unreferenced, and a stale id is an error.
test("exempt rules leave the count and have to exist in the spec", () => {
  const report = [{ area: "VIEWS", covered: 1, total: 3 }];
  const referenced = new Set(["VIEWS-001"]);
  const rules = new Map([
    ["VIEWS-001", "views.md"],
    ["VIEWS-002", "views.md"],
    ["VIEWS-003", "views.md"],
  ]);
  const none = unreferencedByArea({ report, referenced, rules, exemptRules: [] });
  assert.deepEqual([...none.areas.entries()], [["VIEWS", 2]]);
  // an unreferenced rule can be exempted
  const exemptOne = unreferencedByArea({
    report,
    referenced,
    rules,
    exemptRules: [{ rule: "VIEWS-002", why: "visual only" }],
  });
  assert.deepEqual([...exemptOne.areas.entries()], [["VIEWS", 1]]);
  // exempting a rule a test already cites changes nothing
  const exemptCited = unreferencedByArea({
    report,
    referenced,
    rules,
    exemptRules: [{ rule: "VIEWS-001", why: "already covered" }],
  });
  assert.deepEqual([...exemptCited.areas.entries()], [["VIEWS", 2]]);
  // a stale id, and an entry with no why, are reported
  const broken = unreferencedByArea({
    report,
    referenced,
    rules,
    exemptRules: [{ rule: "VIEWS-999", why: "gone" }, { rule: "VIEWS-003" } as ExemptRule],
  });
  assert.deepEqual(broken.problems, [
    "exempt rule VIEWS-999 is not defined in docs/spec",
    'exempt entry needs a rule and a why: {"rule":"VIEWS-003"}',
  ]);
});

// Rewriting the baseline twice has to give the same bytes, or every run would show a diff
test("the baseline writer is sorted and idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-spec-baseline-"));
  try {
    const path = join(dir, "baseline.json");
    const areas = new Map([
      ["VIEWS", 2],
      ["CLI", 5],
    ]);
    writeBaseline(path, areas);
    const first = readFileSync(path, "utf8");
    assert.equal(first, '{\n  "areas": {\n    "CLI": 5,\n    "VIEWS": 2\n  }\n}\n');
    writeBaseline(path, new Map([...areas.entries()].reverse()));
    assert.equal(readFileSync(path, "utf8"), first);
    assert.deepEqual(readBaseline(path), { CLI: 5, VIEWS: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing baseline and exempt files read as empty, malformed ones throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-spec-files-"));
  try {
    const baseline = join(dir, "baseline.json");
    const exempt = join(dir, "exempt.json");
    assert.equal(readBaseline(baseline), undefined);
    assert.deepEqual(readExemptRules(exempt), []);
    writeFileSync(baseline, '{"areas": []}');
    assert.throws(() => readBaseline(baseline), /expected \{"areas"/);
    writeFileSync(exempt, '{"rule": "VIEWS-001"}');
    assert.throws(() => readExemptRules(exempt), /expected an array/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
