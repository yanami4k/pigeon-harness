// 在主目录下启动（项目根就是主目录，或项目的 .pigeon 链到用户级的 ~/.pigeon）时，项目级的 .pigeon 与用户级的 ~/.pigeon 是同一个
// 目录、同一批文件。按"用户级加项目级"两层读取的东西（设置等）此时按一层（用户级）处理：不重复读、不报"被项目设置覆盖"、
// 不把只许写在用户级的项当成写在项目里。按真实路径比较（Windows 上不分大小写）
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { PIGEON_DIR, userPigeonDir } from "../state/paths.ts";

function real(target: string): string | undefined {
  try {
    return realpathSync.native(target);
  } catch {
    return undefined;
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (value: string): string =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return norm(a) === norm(b);
}

export function projectSharesUserPigeonDir(root: string, homeDir: string = homedir()): boolean {
  // 两个 .pigeon 都在：直接比真实路径（含 .pigeon 本身是链接的情况）
  const projectDir = real(path.join(root, PIGEON_DIR));
  const userDir = real(userPigeonDir(homeDir));
  if (projectDir !== undefined && userDir !== undefined) return samePath(projectDir, userDir);
  // 还没建：比项目根与主目录的真实路径
  const realRoot = real(root) ?? root;
  const realHome = real(homeDir) ?? homeDir;
  return samePath(realRoot, realHome);
}
