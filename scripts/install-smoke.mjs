// 安装冒烟（发版与 CI）：npm pack → 装进临时前缀 → pigeon --version → 用仓库的假模型
// （scripts/smoke-stream-fn.ts）跑一次 pigeon run → 核对安装包里的文件清单。
// 全程在临时目录里进行，不读写使用者的全局安装与家目录。
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packageName = packageJson.name;
const version = packageJson.version;
// 经系统 shell 跑 npm：Windows 上 npm 是 .cmd，Node 24 起不能直接 spawn
const quoteArg =
  process.platform === "win32"
    ? (arg) => `"${arg.replaceAll('"', '""')}"`
    : (arg) => `'${arg.replaceAll("'", "'\\''")}'`;
const npmCommand = (args) => ["npm", ...args.map(quoteArg)].join(" ");

const REQUIRED = [
  "LICENSE",
  "README.md",
  "THIRD_PARTY_LICENSES.md",
  "package.json",
  "dist/pigeon.mjs",
  "dist/pigeon-cli.mjs",
  "dist/pigeon-cli.mjs.map",
  "dist/deepseek-stream-fn.mjs",
  "dist/photon_rs_bg.wasm",
  "docker/sandbox/Dockerfile",
  "third_party/pi-web-access/LICENSE",
  "third_party/pi-web-access/NOTICE.md",
];
const FORBIDDEN_PATHS = ["docs/notes", ".pigeon/state"];
const SECRET_FILE =
  /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|secrets\.json|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa.*|id_ed25519(?:\..*)?|id_e.*)$/i;

function fail(message) {
  throw new Error(message);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(path).map((child) => join(entry.name, child).replaceAll("\\", "/")));
    } else if (entry.isFile()) {
      out.push(entry.name);
    }
  }
  return out.sort();
}

// Windows 上经 cmd.exe 跑全局安装的 .cmd 包装（路径可能带空格）
function runPigeon(bin, args, env) {
  if (process.platform !== "win32") {
    return spawnSync(bin, args, { encoding: "utf8", env, timeout: 180_000 });
  }
  const quote = (arg) => `"${arg.replaceAll('"', '\\"')}"`;
  const command = `"${bin}" ${args.map(quote).join(" ")}`;
  return spawnSync(command, {
    encoding: "utf8",
    env,
    timeout: 180_000,
    shell: true,
  });
}

const temp = mkdtempSync(join(tmpdir(), "pigeon-install-smoke-"));
try {
  const packDir = join(temp, "pack");
  mkdirSync(packDir);
  const packed = execSync(npmCommand(["pack", "--json", "--pack-destination", packDir]), {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const jsonStart = packed.indexOf("[");
  if (jsonStart < 0) fail(`npm pack 没有给出 JSON：\n${packed}`);
  const archive = JSON.parse(packed.slice(jsonStart))[0];
  const tarball = join(packDir, archive.filename);
  if (!existsSync(tarball)) fail(`安装包不存在：${tarball}`);

  const files = archive.files.map((file) => file.path.replaceAll("\\", "/"));
  for (const path of REQUIRED) {
    if (!files.includes(path)) fail(`安装包缺少 ${path}`);
  }
  for (const path of files) {
    for (const forbidden of FORBIDDEN_PATHS) {
      if (path.includes(forbidden)) fail(`安装包不应包含 ${path}`);
    }
    if (SECRET_FILE.test(path)) fail(`安装包不应包含密钥文件 ${path}`);
  }

  const prefix = join(temp, "prefix");
  execSync(
    npmCommand([
      "install",
      "-g",
      "--prefix",
      prefix,
      "--no-audit",
      "--no-fund",
      // 依赖树里的版本范围以官方源为准（镜像可能还没同步最新版本）
      "--registry=https://registry.npmjs.org/",
      tarball,
    ]),
    { cwd: temp, stdio: "inherit" }
  );
  const installedRoot = join(
    prefix,
    ...(process.platform === "win32" ? [] : ["lib"]),
    "node_modules",
    packageName
  );
  const installedFiles = walk(installedRoot).filter((path) => !path.startsWith("node_modules/"));
  const packedFiles = [...files].sort();
  const missing = packedFiles.filter((path) => !installedFiles.includes(path));
  const extra = installedFiles.filter((path) => !packedFiles.includes(path));
  if (missing.length > 0 || extra.length > 0) {
    fail(`安装后的文件与安装包不一致：缺 ${missing.join(", ")}；多 ${extra.join(", ")}`);
  }

  const bin =
    process.platform === "win32" ? join(prefix, "pigeon.cmd") : join(prefix, "bin", "pigeon");
  if (!existsSync(bin)) fail(`没有找到安装后的 pigeon：${bin}`);
  const env = { ...process.env };
  delete env.PIGEON_STREAM_FN;
  const versioned = runPigeon(bin, ["--version"], env);
  const expected = new RegExp(
    `^pigeon ${version.replaceAll(".", "\\.")} \\(commit [0-9a-f]+(, uncommitted changes)?\\)`
  );
  if (versioned.status !== 0 || !expected.test(versioned.stdout)) {
    fail(
      `pigeon --version 不符合预期：${versioned.status}\n${versioned.stdout}\n${versioned.stderr}`
    );
  }
  if (versioned.stderr.trim() !== "")
    fail(`pigeon --version 有输出到 stderr：\n${versioned.stderr}`);

  const work = join(temp, "work");
  const home = join(temp, "home");
  const log = join(temp, "requests.log");
  mkdirSync(work);
  mkdirSync(home);
  const run = runPigeon(
    bin,
    [
      "run",
      "说一句话",
      "--root",
      work,
      "--stream-fn",
      join(root, "scripts", "smoke-stream-fn.ts"),
      "--yolo",
      "--no-subagents",
    ],
    { ...env, SMOKE_LOG: log, HOME: home, USERPROFILE: home }
  );
  if (run.status !== 0) {
    fail(`pigeon run 退出码 ${run.status}\n${run.stdout}\n${run.stderr}`);
  }
  const requests = existsSync(log)
    ? readFileSync(log, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
    : [];
  if (requests.length === 0) fail(`pigeon run 没有发出模型请求\n${run.stdout}\n${run.stderr}`);

  console.log(
    `安装冒烟通过：pigeon ${version}；${archive.entryCount} 个文件；pigeon run 发出 ${requests.length} 次请求`
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
