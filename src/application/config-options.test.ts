// 决策 442：/config 的选项。生效值取会话快照（没写为缺省），用户级的值与"被项目设置覆盖"读三层文件；改动只写用户级、保留文件
// 里的其余内容、default 即删键（节空了一并删）、值不合法或文件坏了不写。
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
  CONFIG_OPTIONS,
  ConfigError,
  configView,
  parseConfigAssignment,
  setUserConfig,
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

test("清单是六项常用个人选项；没写即缺省，用户级的值与生效值；项目层覆盖时标明是哪一层", () => {
  assert.deepEqual(
    CONFIG_OPTIONS.map((option) => option.id),
    [
      "thinking.level",
      "web.enabled",
      "loopGuard.enabled",
      "modelRequest.maxRetries",
      "contextPrune.enabled",
      "truncationContinuation.enabled",
    ]
  );
  const { home, root } = setup();
  assert.deepEqual(
    (({ effective, user, overriddenBy }) => ({ effective, user, overriddenBy }))(
      viewOf(root, home, "web.enabled")
    ),
    { effective: "true（缺省）", user: "default", overriddenBy: undefined }
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
  assert.throws(() => setUserConfig(root, "nope.key", "1", home), /没有这个选项/);
  writeFileSync(file, "{ not json");
  assert.throws(() => setUserConfig(root, "web.enabled", "false", home), /不是合法 JSON/);
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
    assert.throws(() => setUserConfig(root, "web.enabled", "true", home), /只读/);
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
    assert.throws(() => setUserConfig(root, "web.enabled", "false", home), /符号链接/);
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

test("带 BOM 的用户级设置照常读改；1000 与 True 这类值拒绝", () => {
  const { home, root } = setup();
  const file = join(home, ".pigeon", "settings.json");
  writeFileSync(file, `${String.fromCharCode(0xfeff)}{ "loopGuard": { "enabled": true } }`);
  setUserConfig(root, "web.enabled", "false", home);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    loopGuard: { enabled: true },
    web: { enabled: false },
  });
  assert.throws(() => setUserConfig(root, "modelRequest.maxRetries", "1000", home), ConfigError);
  assert.throws(() => setUserConfig(root, "web.enabled", "True", home), ConfigError);
  assert.deepEqual(parseConfigAssignment("a=b"), { id: "a", value: "b" });
  assert.throws(() => setUserConfig(root, "a", "b", home), /没有这个选项/);
});
