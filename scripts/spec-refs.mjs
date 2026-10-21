// 规格引用检查（发版）：docs/spec 里的规则号与测试引用对齐。
// - 规则定义取自 docs/spec/*.md 里形如 **PANEL-011** 的片段；
// - 测试引用取自 src/**/*.test.ts 的测试标题，以及测试上一行的 // spec: PANEL-011, PANEL-012；
// - 测试引用了不存在的规则号、或规格里同一规则号定义了两次，报错并退出 1；
// - 每区“被至少一个测试引用的规则数 / 总数”只报告，不因覆盖低而失败。
import { readdirSync, readFileSync } from "node:fs";
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
  return { problems: problems.sort(), report, rules: spec.rules, refs };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const { problems, report } = checkSpecRefs({
    specDir: join(root, "docs", "spec"),
    srcDir: join(root, "src"),
  });
  for (const { area, covered, total } of report) {
    console.log(`${area}: ${covered}/${total} rules referenced by tests`);
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
}
