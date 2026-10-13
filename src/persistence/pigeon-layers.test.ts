// 验收修改：在主目录下启动时项目级 .pigeon 与用户级 ~/.pigeon 是同一个目录——设置按一层（用户级）读：不重复读、
// 只许写在用户级的项（trustedDirectories）不当成写在项目里、各节来源记为用户级；别的目录照旧三层。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "vitest";
import { projectSharesUserPigeonDir } from "./pigeon-layers.ts";
import { loadSettings, settingsLocations } from "./settings.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

function write(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

test("项目根就是主目录时判为同一层；别的目录不是；还没建 .pigeon 时按项目根与主目录比", () => {
  const home = temp("pigeon-layers-home-");
  const project = temp("pigeon-layers-project-");
  assert.equal(projectSharesUserPigeonDir(home, home), true);
  assert.equal(projectSharesUserPigeonDir(project, home), false);
  mkdirSync(join(home, ".pigeon"));
  mkdirSync(join(project, ".pigeon"));
  assert.equal(projectSharesUserPigeonDir(home, home), true);
  assert.equal(projectSharesUserPigeonDir(project, home), false);
});

test("主目录下：设置只读用户级与项目个人两层；用户级的 trustedDirectories 不报错；各节来源记为用户级", () => {
  const home = temp("pigeon-layers-home-");
  write(join(home, ".pigeon", "settings.json"), {
    trustedDirectories: [join(home, "work")],
    loopGuard: { stopAt: 30 },
  });
  assert.deepEqual(
    settingsLocations(home, home).map((location) => location.layer),
    ["user", "local"]
  );
  const snapshot = loadSettings(home, { homeDir: home });
  assert.deepEqual(
    snapshot.sources.map((source) => source.layer),
    ["user", "local"]
  );
  assert.deepEqual(snapshot.sectionSources.loopGuard, ["user"], "不再报成两层（被项目设置覆盖）");
});

test("别的目录：照旧三层；写在项目共享设置里的 trustedDirectories 照旧报错", () => {
  const home = temp("pigeon-layers-home-");
  const project = temp("pigeon-layers-project-");
  assert.deepEqual(
    settingsLocations(project, home).map((location) => location.layer),
    ["user", "project", "local"]
  );
  write(join(project, ".pigeon", "settings.json"), { trustedDirectories: [project] });
  assert.throws(() => loadSettings(project, { homeDir: home }), /trustedDirectories/);
});
