// Spec reference check (release gate): line the rule ids in docs/spec up with the tests that cite them.
// - A rule is defined by a `**PANEL-011**` fragment in docs/spec/*.md;
// - A reference is a rule id in a test title under src/**/*.test.ts, or in a `// spec: PANEL-011` comment on
//   the line directly above a test;
// - A test citing an id the spec does not define, or the spec defining one id twice, is an error (exit 1);
// - Coverage is per area: `covered/total`, plus how many rules the area leaves unreferenced against the
//   baseline in scripts/spec-coverage-baseline.json. With `--require`, leaving more unreferenced than the
//   baseline fails, so a new rule has to bring a reference; `--update-baseline` records the current numbers;
// - Rules in scripts/spec-coverage-exempt.json are taken out of the unreferenced count, and every exempt id
//   has to exist in the spec (so the list cannot drift).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const RULE_DEFINITION = /\*\*([A-Z]+-\d{3})\*\*/g;
const RULE_REFERENCE = /\b([A-Z]+-\d{3})\b/g;

const prefixOf = (rule) => rule.slice(0, rule.indexOf("-"));

// 规格里定义的规则号；同一规则号出现两次记为 duplicate
export function collectSpecRules(specDir) {
  const rules = new Map();
  const duplicates = [];
  const areas = new Map();
  for (const file of readdirSync(specDir)
    .filter((name) => name.endsWith(".md"))
    .sort()) {
    const text = readFileSync(join(specDir, file), "utf8");
    for (const match of text.matchAll(RULE_DEFINITION)) {
      const rule = match[1];
      const prefix = prefixOf(rule);
      if (rules.has(rule)) {
        duplicates.push({ rule, first: rules.get(rule), second: file });
      } else {
        rules.set(rule, file);
      }
      if (!areas.has(prefix)) areas.set(prefix, new Set());
      areas.get(prefix).add(rule);
    }
  }
  return { rules, duplicates, areas };
}

function testTitleOf(node) {
  let expression = node.expression;
  while (ts.isCallExpression(expression) || ts.isPropertyAccessExpression(expression)) {
    expression = expression.expression;
  }
  if (!ts.isIdentifier(expression) || (expression.text !== "test" && expression.text !== "it")) {
    return undefined;
  }
  const first = node.arguments[0];
  if (first === undefined) return undefined;
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text;
  if (ts.isTemplateExpression(first)) {
    return [first.head.text, ...first.templateSpans.map((span) => span.literal.text)].join("\n");
  }
  return undefined;
}

function walkFiles(dir, suffix) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(path, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) out.push(path);
  }
  return out.sort();
}

// 测试标题里的规则号（只认规格里出现过的区名，避免把 SHA-256 这类名称当成规则）
// 与测试上一行 // spec: 注释里的规则号（注释是明确的引用，不按区名过滤）
export function collectTestRefs(srcDir, knownPrefixes) {
  const refs = [];
  for (const file of walkFiles(srcDir, ".test.ts")) {
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const title = testTitleOf(node);
        if (title !== undefined) {
          for (const match of title.matchAll(RULE_REFERENCE)) {
            if (knownPrefixes.has(prefixOf(match[1]))) {
              refs.push({ file, rule: match[1], source: "title" });
            }
          }
        }
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
        const comment = /^\s*\/\/\s*spec:\s*(.*)$/.exec(lines[line - 1] ?? "");
        if (comment !== null) {
          for (const match of comment[1].matchAll(RULE_REFERENCE)) {
            refs.push({ file, rule: match[1], source: "spec comment" });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return refs;
}

export function checkSpecRefs({ specDir, srcDir }) {
  const spec = collectSpecRules(specDir);
  const problems = spec.duplicates.map(
    (duplicate) =>
      `rule ${duplicate.rule} is defined twice: ${duplicate.first} and ${duplicate.second}`
  );
  const refs = collectTestRefs(srcDir, new Set(spec.areas.keys()));
  const referenced = new Set();
  for (const ref of refs) {
    referenced.add(ref.rule);
    if (!spec.rules.has(ref.rule)) {
      problems.push(
        `${relative(process.cwd(), ref.file)}: ${ref.rule} (${ref.source}) is not defined in docs/spec`
      );
    }
  }
  const report = [...spec.areas.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([area, rules]) => ({
      area,
      covered: [...rules].filter((rule) => referenced.has(rule)).length,
      total: rules.size,
    }));
  return { problems: problems.sort(), report, rules: spec.rules, referenced, refs };
}

// Unreferenced count per area: the rules no test cites, minus the exempt ones (an exemption only counts when
// the rule really is unreferenced, so exempting a cited rule changes nothing)
export function unreferencedByArea({ report, referenced, rules, exemptRules }) {
  const problems = [];
  const exempt = new Map();
  for (const entry of exemptRules) {
    if (
      typeof entry?.rule !== "string" ||
      typeof entry?.why !== "string" ||
      entry.why.trim() === ""
    ) {
      problems.push(`exempt entry needs a rule and a why: ${JSON.stringify(entry)}`);
      continue;
    }
    if (!rules.has(entry.rule)) {
      problems.push(`exempt rule ${entry.rule} is not defined in docs/spec`);
      continue;
    }
    if (referenced.has(entry.rule)) continue;
    const area = prefixOf(entry.rule);
    exempt.set(area, (exempt.get(area) ?? 0) + 1);
  }
  const areas = new Map();
  for (const { area, covered, total } of report) {
    areas.set(area, Math.max(0, total - covered - (exempt.get(area) ?? 0)));
  }
  return { areas, problems };
}

// Compare the current numbers with the baseline: an area may not leave more rules unreferenced than recorded.
// An area the baseline does not know about is held to 0, so a brand-new area starts covered.
export function compareWithBaseline({ areas, baseline }) {
  const rows = [];
  for (const [area, unreferenced] of [...areas.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const allowed = baseline[area] ?? 0;
    rows.push({ area, unreferenced, allowed, surplus: unreferenced - allowed });
  }
  return rows;
}

export function formatCoverageLine(row, covered, total) {
  return `${row.area}: ${covered}/${total} (baseline unreferenced ${row.allowed})`;
}

export function formatSurplus(row) {
  return (
    `${row.area}: ${row.surplus} more rule(s) unreferenced than the baseline ` +
    `(${row.unreferenced} now, ${row.allowed} allowed)`
  );
}

export const REFERENCE_HINT =
  "To cover a rule, put its id in a test title, or write `// spec: AREA-NNN` on the line above the test; " +
  "if the rule cannot be covered by a test, list it in scripts/spec-coverage-exempt.json with a why.";

export function readJsonFile(path) {
  if (!existsSync(path)) return undefined;
  // a byte-order mark from an editor would make JSON.parse fail for no good reason
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

// [{"rule": "VIEWS-010", "why": "visual only"}]
export function readExemptRules(path) {
  const value = readJsonFile(path);
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${path}: expected an array of {rule, why}`);
  return value;
}

// {"areas": {"VIEWS": 58}} — the last accepted unreferenced count per area
export function readBaseline(path) {
  const value = readJsonFile(path);
  if (value === undefined) return undefined;
  const areas = value?.areas;
  if (typeof areas !== "object" || areas === null || Array.isArray(areas)) {
    throw new Error(`${path}: expected {"areas": {"AREA": number}}`);
  }
  return areas;
}

export function writeBaseline(path, areas) {
  const sorted = Object.fromEntries([...areas.entries()].sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path, `${JSON.stringify({ areas: sorted }, null, 2)}\n`);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const requireCoverage = argv.includes("--require");
  const updateBaseline = argv.includes("--update-baseline");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const baselinePath = join(root, "scripts", "spec-coverage-baseline.json");
  const exemptPath = join(root, "scripts", "spec-coverage-exempt.json");
  const { problems, report, rules, referenced } = checkSpecRefs({
    specDir: join(root, "docs", "spec"),
    srcDir: join(root, "src"),
  });
  const { areas, problems: exemptProblems } = unreferencedByArea({
    report,
    referenced,
    rules,
    exemptRules: readExemptRules(exemptPath),
  });
  problems.push(...exemptProblems);
  if (updateBaseline) {
    writeBaseline(baselinePath, areas);
    console.log(`baseline updated: ${relative(root, baselinePath)}`);
  }
  const baseline = readBaseline(baselinePath);
  const rows = compareWithBaseline({ areas, baseline: baseline ?? {} });
  const totalOf = new Map(report.map(({ area, total }) => [area, total]));
  const coveredOf = new Map(report.map(({ area, covered }) => [area, covered]));
  for (const row of rows) {
    console.log(formatCoverageLine(row, coveredOf.get(row.area) ?? 0, totalOf.get(row.area) ?? 0));
  }
  const over = rows.filter((row) => row.surplus > 0);
  for (const problem of [...problems, ...over.map(formatSurplus)]) console.error(problem);
  if (over.length > 0) console.error(REFERENCE_HINT);
  const missingBaseline = requireCoverage && baseline === undefined;
  if (missingBaseline) {
    console.error(
      `no baseline: run \`node scripts/spec-refs.mjs --update-baseline\` and commit ${relative(root, baselinePath)}`
    );
  }
  if (problems.length > 0 || missingBaseline || (requireCoverage && over.length > 0)) {
    process.exit(1);
  }
}
