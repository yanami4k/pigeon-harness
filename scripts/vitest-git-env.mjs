// 测试进程的 git 全局配置隔离（决策 444）：第一次在 git 仓库里写程序状态时，Pigeon 会把忽略规则写进使用者的全局 git
// 排除文件。测试里绝不能写到真实用户目录，所以每个测试进程开跑前：
// - GIT_CONFIG_GLOBAL 指向一份临时副本（照抄真实的全局配置，保住提交身份、换行等既有行为，只去掉 core.excludesFile）；
// - XDG_CONFIG_HOME 指向临时目录（没设 core.excludesFile 时全局排除文件落在这里）。
// 测试里起的子进程继承这两个变量。要验证具体路径的用例自己再指到各自的临时目录。
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "pigeon-test-gitenv-"));
const globalConfig = join(base, "gitconfig");
const source = process.env.GIT_CONFIG_GLOBAL ?? join(homedir(), ".gitconfig");
if (existsSync(source)) {
  copyFileSync(source, globalConfig);
  try {
    execFileSync("git", ["config", "--file", globalConfig, "--unset-all", "core.excludesFile"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    // 本就没有这一项（git 以 5 退出）
  }
} else {
  writeFileSync(globalConfig, "");
}
const xdg = join(base, "xdg");
mkdirSync(xdg, { recursive: true });
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.XDG_CONFIG_HOME = xdg;
