// 决策 442、465：/config 的选项。按组列出全部简单配置项（结构复杂的、权限类、即将删除的不放）；生效值取会话快照（没写为缺省），
// 用户级的值与"被项目设置覆盖"读三层文件；改动只写用户级、保留文件里的其余内容、default 即删键（路径上空了的一并删）、值不合法
// 或文件坏了不写；跨字段的约束合并三层核对，过不了不写；键位写进用户级 keybindings 一节。
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { loadSettings } from "../persistence/settings.ts";
import {
  CONFIG_GROUPS,
  CONFIG_OPTIONS,
  ConfigError,
  type ConfigOption,
  configView,
  parseConfigAssignment,
  setUserConfig,
  setUserKeybinding,
  userKeybindings,
} from "./config-options.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function setup() {
  const home = temp("pigeon-config-home-");
  const root = temp("pigeon-config-root-");
  mkdirSync(join(home, ".pigeon"), { recursive: true });
  mkdirSync(join(root, ".pigeon"), { recursive: true });
  return { home, root };
}

function viewOf(root: string, home: string, id: string) {
  const view = configView(loadSettings(root, { homeDir: home }), home).find(
    (item) => item.option.id === id
  );
  assert.ok(view !== undefined);
  return view;
}

// 每项一个合法的值：缺省值里的数字（就是合法的），没有就取下限之上
function sampleOf(option: ConfigOption): string {
  if (option.kind === "boolean") return "false";
  if (option.kind === "enum") return option.values[1] ?? "default";
  if (option.kind === "string") return "4g";
  const fromDefault = /(\d+(\.\d+)?)/.exec(option.defaultLabel)?.[1];
  return fromDefault ?? String((option.min ?? 0) + 1);
}

test("清单：按组列出各项；结构复杂的、权限类、即将删除的与自由文本的地址不放；每一项都能写进用户级（路径与范围合 schema）", () => {
  const ids = CONFIG_OPTIONS.map((option) => option.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const expected of [
    "thinking.level",
    "modelRequest.maxRetries",
    "web.search.backend",
    "web.fetch.maxBytes",
    "contextPrune.protectTurns",
    "truncationContinuation.maxPerRun",
    "repetitionGuard.similarity",
    "memory.userLimitChars",
    "tools.grep.maxResults",
    "tools.runCommand.backgroundCloseoutSeconds",
    "loopGuard.stopAt",
    "disableAllHooks",
    "stopHookBlockCap",
    "worktree.baseRef",
    "snapshot.untrackedTotalMaxBytes",
    "sandbox.memory",
    "sandbox.cpus",
    "tui.leftArrowOpensPanel",
  ]) {
    assert.ok(ids.includes(expected), expected);
  }
  assert.ok(
    !ids.some((id) =>
      /^(mcp|hooks|modelInfo|commands|permissions|trustedDirectories|orchestration|keybindings)\b|baseUrl|\.model$|sandbox\.(image|dockerfile|context|build)/.test(
        id
      )
    ),
    ids.join(", ")
  );
  const groups = new Set(CONFIG_GROUPS.map((group) => group.id));
  assert.ok(CONFIG_OPTIONS.every((option) => groups.has(option.group)));
  for (const option of CONFIG_OPTIONS) {
    const { home, root } = setup();
    const file = setUserConfig(root, option.id, sampleOf(option), home);
    assert.ok(file !== undefined, option.id);
    assert.doesNotThrow(() => loadSettings(root, { homeDir: home }), option.id);
  }
});

test("没写即缺省，用户级的值与生效值；项目层覆盖时标明是哪一层", () => {
  const { home, root } = setup();
  assert.deepEqual(
    (({ effective, user, overriddenBy }) => ({ effective, user, overriddenBy }))(
      viewOf(root, home, "web.enabled")
    ),
    { effective: "true (default)", user: "default", overriddenBy: undefined }
  );
  writeFileSync(
    join(home, ".pigeon", "settings.json"),
    JSON.stringify({ web: { enabled: false }, modelRequest: { maxRetries: 2 } })
  );
  assert.equal(viewOf(root, home, "web.enabled").effective, "false");
  assert.equal(viewOf(root, home, "web.enabled").user, "false");
  writeFileSync(join(root, ".pigeon", "settings.json"), JSON.stringify({ web: { enabled: true } }));
  writeFileSync(
    join(root, ".pigeon", "settings.local.json"),
    JSON.stringify({ modelRequest: { maxRetries: 6 } })
  );
  const web = viewOf(root, home, "web.enabled");
  assert.equal(web.effective, "true");
  assert.equal(web.user, "false");
  assert.equal(web.overriddenBy, "project");
  assert.equal(viewOf(root, home, "modelRequest.maxRetries").overriddenBy, "local");
});

test("写用户级：保留其余内容；default 删键、节空了一并删；值不合法、文件坏了不写", () => {
  const { home, root } = setup();
  const file = join(home, ".pigeon", "settings.json");
  writeFileSync(file, JSON.stringify({ trustedDirectories: ["~/work"], web: { enabled: true } }));
  assert.equal(setUserConfig(root, "web.enabled", "false", home), "~/.pigeon/settings.json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    trustedDirectories: ["~/work"],
    web: { enabled: false },
  });
  setUserConfig(root, "thinking.level", "low", home);
  setUserConfig(root, "modelRequest.maxRetries", "3", home);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).modelRequest.maxRetries, 3);
  setUserConfig(root, "web.enabled", "default", home);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).web, undefined);
  assert.throws(() => setUserConfig(root, "web.enabled", "maybe", home), ConfigError);
  assert.throws(() => setUserConfig(root, "thinking.level", "ultra", home), ConfigError);
  assert.throws(() => setUserConfig(root, "nope.key", "1", home), /unknown option/);
  writeFileSync(file, "{ not json");
  assert.throws(() => setUserConfig(root, "web.enabled", "false", home), /is not valid JSON/);
  assert.equal(readFileSync(file, "utf8"), "{ not json", "坏文件原样不动");
});

test("用户级设置文件还没有时新建；/config 选项=值 的解析", () => {
  const home = temp("pigeon-config-fresh-");
  const root = temp("pigeon-config-fresh-root-");
  setUserConfig(root, "loopGuard.enabled", "false", home);
  assert.deepEqual(JSON.parse(readFileSync(join(home, ".pigeon", "settings.json"), "utf8")), {
    loopGuard: { enabled: false },
  });
  assert.deepEqual(parseConfigAssignment(" web.enabled = false "), {
    id: "web.enabled",
    value: "false",
  });
  assert.equal(parseConfigAssignment("web.enabled"), undefined);
});

test("思考档位含 max；值没变不重写、文件不存在又设成 default 不新建；只读文件不改", () => {
  const { home, root } = setup();
  assert.ok(CONFIG_OPTIONS[0]?.values.includes("max"));
  const file = join(home, ".pigeon", "settings.json");
  assert.equal(setUserConfig(root, "web.enabled", "default", home), undefined);
  assert.equal(existsSync(file), false, "不新建 {}");
  setUserConfig(root, "web.enabled", "false", home);
  const before = statSync(file).mtimeMs;
  assert.equal(setUserConfig(root, "web.enabled", "false", home), undefined, "值没变不写");
  assert.equal(statSync(file).mtimeMs, before);
  chmodSync(file, 0o444);
  try {
    assert.throws(() => setUserConfig(root, "web.enabled", "true", home), /read-only/);
  } finally {
    chmodSync(file, 0o644);
  }
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { web: { enabled: false } });
});

test.skipIf(process.platform === "win32")(
  "用户级设置文件是符号链接时不改（不把链接换成普通文件）",
  () => {
    const { home, root } = setup();
    const real = join(home, "real-settings.json");
    writeFileSync(real, "{}\n");
    symlinkSync(real, join(home, ".pigeon", "settings.json"));
    assert.throws(() => setUserConfig(root, "web.enabled", "false", home), /symlink/);
    assert.ok(lstatSync(join(home, ".pigeon", "settings.json")).isSymbolicLink());
  }
);

test("被 git 跟踪的 settings.local.json 覆盖时按项目共享设置标", () => {
  const { home, root } = setup();
  writeFileSync(
    join(root, ".pigeon", "settings.local.json"),
    JSON.stringify({ web: { enabled: true } })
  );
  const snapshot = loadSettings(root, { homeDir: home });
  const untracked = configView(snapshot, home, false).find(
    (item) => item.option.id === "web.enabled"
  );
  assert.equal(untracked?.overriddenBy, "local");
  const tracked = configView(snapshot, home, true).find((item) => item.option.id === "web.enabled");
  assert.equal(tracked?.overriddenBy, "project");
});

test("带 BOM 的用户级设置照常读改；超出范围、不是整数与 True 这类值拒绝", () => {
  const { home, root } = setup();
  const file = join(home, ".pigeon", "settings.json");
  writeFileSync(file, `${String.fromCharCode(0xfeff)}{ "loopGuard": { "enabled": true } }`);
  setUserConfig(root, "web.enabled", "false", home);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    loopGuard: { enabled: true },
    web: { enabled: false },
  });
  assert.throws(() => setUserConfig(root, "modelRequest.maxRetries", "-1", home), ConfigError);
  assert.throws(() => setUserConfig(root, "modelRequest.maxRetries", "1.5", home), ConfigError);
  assert.doesNotThrow(() => setUserConfig(root, "modelRequest.maxRetries", "1000", home));
  assert.throws(() => setUserConfig(root, "web.enabled", "True", home), ConfigError);
  assert.deepEqual(parseConfigAssignment("a=b"), { id: "a", value: "b" });
  assert.throws(() => setUserConfig(root, "a", "b", home), /unknown option/);
});

test("多层路径：写进嵌套的节，default 删键、路径上空了的一并删；数字与小数按范围核对，字符串按格式核对", () => {
  const { home, root } = setup();
  const file = join(home, ".pigeon", "settings.json");
  setUserConfig(root, "tools.grep.maxResults", "50", home);
  setUserConfig(root, "tools.readFile.maxBytes", "8388608", home);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    tools: { grep: { maxResults: 50 }, readFile: { maxBytes: 8388608 } },
  });
  setUserConfig(root, "tools.grep.maxResults", "default", home);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    tools: { readFile: { maxBytes: 8388608 } },
  });
  assert.throws(
    () => setUserConfig(root, "web.search.maxResults", "21", home),
    /web\.search\.maxResults must be an integer >= 1 and <= 20 or default/
  );
  assert.throws(() => setUserConfig(root, "repetitionGuard.similarity", "0", home), /above 0/);
  setUserConfig(root, "repetitionGuard.similarity", "0.5", home);
  setUserConfig(root, "sandbox.cpus", "1.5", home);
  assert.throws(() => setUserConfig(root, "sandbox.memory", "lots", home), ConfigError);
  setUserConfig(root, "sandbox.memory", "8g", home);
  const written = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(written.repetitionGuard.similarity, 0.5);
  assert.deepEqual(written.sandbox, { cpus: 1.5, memory: "8g" });
});

test("跨字段的约束合并三层核对：项目层写了 stopAt 20，用户级 warnAt 写 25 不写文件；合得上的照写", () => {
  const { home, root } = setup();
  writeFileSync(
    join(root, ".pigeon", "settings.json"),
    JSON.stringify({ loopGuard: { stopAt: 20 } })
  );
  const file = join(home, ".pigeon", "settings.json");
  assert.throws(
    () => setUserConfig(root, "loopGuard.warnAt", "25", home),
    /would make the settings invalid; not written: loopGuard: .*warnAt/
  );
  assert.equal(existsSync(file), false);
  setUserConfig(root, "loopGuard.warnAt", "15", home);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { loopGuard: { warnAt: 15 } });
});

test("键位：写进用户级 keybindings（一个键写字符串、清空写空数组、default 删键）；读回用户级写了的", () => {
  const { home, root } = setup();
  const file = join(home, ".pigeon", "settings.json");
  setUserKeybinding(root, "pigeon.tree", ["ctrl+t"], home);
  setUserKeybinding(root, "pigeon.toggleMode", [], home);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    keybindings: { "pigeon.tree": "ctrl+t", "pigeon.toggleMode": [] },
  });
  assert.deepEqual(userKeybindings(root, home), {
    "pigeon.tree": "ctrl+t",
    "pigeon.toggleMode": [],
  });
  setUserKeybinding(root, "pigeon.tree", undefined, home);
  setUserKeybinding(root, "pigeon.toggleMode", undefined, home);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {});
  assert.throws(() => setUserKeybinding(root, "rm -rf", ["x"], home), /unknown action/);
});
