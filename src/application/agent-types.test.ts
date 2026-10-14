// 子 agent 类型（决策 457、480）：内置两种、自定义类型文件的解析、项目级压过用户级、读不成的列出原因
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { agentTypeOf, loadAgentTypes, parseAgentTypeText } from "./agent-types.ts";

test("文件头：必填 name 与 description；tools 认逗号、方括号与逐行列表；model 写 inherit 即不另指定；正文附加到系统提示", () => {
  const parsed = parseAgentTypeText(
    "---\nname: reviewer\ndescription: Reviews diffs\ntools: read_file, grep\nmodel: m-small\n---\nYou review code.\n",
    "project",
    ".pigeon/agents/reviewer.md"
  );
  assert.deepEqual(parsed, {
    name: "reviewer",
    description: "Reviews diffs",
    tools: ["read_file", "grep"],
    model: "m-small",
    prompt: "You review code.",
    source: "project",
    displayPath: ".pigeon/agents/reviewer.md",
  });
  const listed = parseAgentTypeText(
    "---\nname: a\ndescription: 'd'\ntools:\n  - read_file\n  - \"glob\"\nmodel: inherit\n---\n",
    "user",
    "x"
  );
  assert.ok(!("problem" in listed));
  assert.deepEqual(listed.tools, ["read_file", "glob"]);
  assert.equal(listed.model, undefined);
  assert.equal(listed.prompt, undefined);
  const bracket = parseAgentTypeText(
    "---\nname: b\ndescription: d\ntools: [read_file, grep]\n---\n",
    "user",
    "x"
  );
  assert.ok(!("problem" in bracket));
  assert.deepEqual(bracket.tools, ["read_file", "grep"]);
  assert.match(
    (parseAgentTypeText("---\nname: a\n---\n", "user", "f.md") as { problem: string }).problem,
    /f\.md: missing description/
  );
  assert.match(
    (parseAgentTypeText("no header", "user", "f.md") as { problem: string }).problem,
    /no front matter/
  );
  assert.match(
    (
      parseAgentTypeText("---\nname: Bad Name\ndescription: d\n---\n", "user", "f.md") as {
        problem: string;
      }
    ).problem,
    /must be lowercase/
  );
});

test("登记：内置 explore 与 general 在前；项目级压过用户级、自定义压过同名内置；读不成的列出原因", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-agent-types-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-agent-types-home-"));
  try {
    assert.deepEqual(
      loadAgentTypes({ governanceRoot: root, homeDir: home }).types.map((type) => type.name),
      ["general", "explore"]
    );
    mkdirSync(join(root, ".pigeon", "agents"), { recursive: true });
    mkdirSync(join(home, ".pigeon", "agents"), { recursive: true });
    writeFileSync(
      join(home, ".pigeon", "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: user version\n---\n"
    );
    writeFileSync(
      join(root, ".pigeon", "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: project version\n---\n"
    );
    writeFileSync(
      join(root, ".pigeon", "agents", "explore.md"),
      "---\nname: explore\ndescription: my explore\n---\n"
    );
    writeFileSync(join(root, ".pigeon", "agents", "broken.md"), "---\nname: broken\n---\n");
    const catalog = loadAgentTypes({ governanceRoot: root, homeDir: home });
    assert.deepEqual(
      catalog.types.map((type) => type.name),
      ["general", "explore", "reviewer"]
    );
    assert.equal(agentTypeOf(catalog, "reviewer")?.description, "project version");
    assert.equal(agentTypeOf(catalog, "explore")?.description, "my explore");
    assert.equal(agentTypeOf(catalog, "explore")?.source, "project");
    assert.deepEqual(catalog.problems, [".pigeon/agents/broken.md: missing description"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
