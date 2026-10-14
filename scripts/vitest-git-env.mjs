// 测试进程的 git 全局配置隔离（决策 444）：第一次在 git 仓库里写程序状态时，Pigeon 会把忽略规则写进使用者的全局 git
// 排除文件。测试里绝不能写到真实用户目录，所以每个测试文件开跑前：
// - GIT_CONFIG_GLOBAL 指向一份只有提交身份（user.name、user.email）的临时配置——不照抄真实的全局配置，免得带进 include、
//   core.excludesFile、hooksPath 等指向真实用户目录的设置；
// - XDG_CONFIG_HOME 指向临时目录（没设 core.excludesFile 时全局排除文件落在这里）；
// - HOME 与 USERPROFILE 指向临时目录（在用锁等用户级程序状态不落进真实用户目录）。
// 测试里起的子进程继承这些变量。要验证具体路径的用例自己再指到各自的临时目录。测试文件跑完删掉这份临时目录。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const base = mkdtempSync(join(tmpdir(), "pigeon-test-gitenv-"));
const globalConfig = join(base, "gitconfig");
writeFileSync(
  globalConfig,
  "[user]\n\tname = pigeon-test\n\temail = pigeon-test@example.invalid\n"
);
const xdg = join(base, "xdg");
mkdirSync(xdg, { recursive: true });
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.XDG_CONFIG_HOME = xdg;
const home = join(base, "home");
mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});
