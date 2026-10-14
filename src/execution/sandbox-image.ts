// 日常沙箱的镜像（决策 247）：缺省用 Pigeon 自带的通用镜像（仓库里 docker/sandbox/Dockerfile，Ubuntu 24.04），
// 首次使用时构建，标签带 Dockerfile 内容与底镜像名的哈希，之后直接用缓存；项目可在设置的 sandbox 一节里改用任一镜像名，
// 或指向项目自己的 Dockerfile。国内网络经构建参数替换底镜像、apt 软件源、Node 二进制包下载地址与 pip / npm 的软件源（环境变量或配置的 build 段）。
// 镜像里须有 git：开工时由沙箱检查（sandbox.ts），这里只负责给出可用的镜像名。
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageFileUrl } from "../state/package-paths.ts";
import type { SandboxConfig } from "../state/sandbox-config.ts";
import { dockerOnce } from "./container-host.ts";

// 通用镜像的 Dockerfile（随包，源码与打包产物运行时都在包根下）
export const GENERIC_DOCKERFILE = fileURLToPath(packageFileUrl("docker/sandbox/Dockerfile"));
export const GENERIC_IMAGE_REPO = "pigeon-sandbox";
export const PROJECT_IMAGE_REPO = "pigeon-sandbox-project";
export const DEFAULT_BASE_IMAGE = "ubuntu:24.04";

// 通用镜像的构建参数：配置字段、环境变量与 Dockerfile 里的 ARG 名一一对应
const BUILD_PARAMS = [
  {
    key: "baseImage",
    env: "PIGEON_SANDBOX_BASE_IMAGE",
    arg: "BASE_IMAGE",
    what: "base image (default ubuntu:24.04)",
  },
  {
    key: "aptMirror",
    env: "PIGEON_SANDBOX_APT_MIRROR",
    arg: "APT_MIRROR",
    what: "apt mirror URL",
  },
  {
    key: "nodeMirror",
    env: "PIGEON_SANDBOX_NODE_MIRROR",
    arg: "NODE_MIRROR",
    what: "Node binary download URL (default https://nodejs.org/dist)",
  },
  { key: "pipIndex", env: "PIGEON_SANDBOX_PIP_INDEX", arg: "PIP_INDEX_URL", what: "pip index URL" },
  {
    key: "npmRegistry",
    env: "PIGEON_SANDBOX_NPM_REGISTRY",
    arg: "NPM_REGISTRY",
    what: "npm registry",
  },
] as const;

// 解析出的镜像来源：现成的镜像名，或要按 Dockerfile 构建（带缓存标签）
export type SandboxImageSpec =
  | { kind: "image"; image: string }
  | {
      kind: "build";
      image: string;
      dockerfile: string;
      context: string;
      buildArgs: Record<string, string>;
      // 是否 Pigeon 自带的通用镜像（构建失败时才提示通用镜像的构建参数）
      generic: boolean;
    };

const digest = (...parts: string[]): string =>
  createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 12);

// 由配置与环境变量得出镜像来源
export function resolveSandboxImage(
  governanceRoot: string,
  config: SandboxConfig,
  env: Record<string, string | undefined> = process.env
): SandboxImageSpec {
  if (config.image !== undefined) {
    return { kind: "image", image: config.image };
  }
  if (config.dockerfile !== undefined) {
    const dockerfile = path.resolve(governanceRoot, config.dockerfile);
    if (!existsSync(dockerfile)) {
      throw new Error(`sandbox Dockerfile not found: ${config.dockerfile}`);
    }
    const context =
      config.context !== undefined
        ? path.resolve(governanceRoot, config.context)
        : path.dirname(dockerfile);
    return {
      kind: "build",
      image: `${PROJECT_IMAGE_REPO}:${digest(readFileSync(dockerfile, "utf8"))}`,
      dockerfile,
      context,
      buildArgs: {},
      generic: false,
    };
  }
  const buildArgs: Record<string, string> = {};
  for (const param of BUILD_PARAMS) {
    const value = config.build?.[param.key] ?? env[param.env];
    if (value !== undefined && value !== "") buildArgs[param.arg] = value;
  }
  const content = readFileSync(GENERIC_DOCKERFILE, "utf8");
  // 换了底镜像即是另一份镜像；软件源只影响下载来源，不进标签
  const base = buildArgs.BASE_IMAGE ?? DEFAULT_BASE_IMAGE;
  return {
    kind: "build",
    image: `${GENERIC_IMAGE_REPO}:${digest(content, base)}`,
    dockerfile: GENERIC_DOCKERFILE,
    context: path.dirname(GENERIC_DOCKERFILE),
    buildArgs,
    generic: true,
  };
}

// 构建失败时说明可设的参数
export function buildParamsHelp(): string {
  return `build parameters: ${BUILD_PARAMS.map((p) => `${p.env} / sandbox.build.${p.key} (${p.what})`).join("; ")}`;
}

// 给出可用的镜像名：要构建的先看本地有没有同标签的缓存，没有才构建
export async function ensureSandboxImage(
  spec: SandboxImageSpec,
  options: {
    docker?: readonly string[];
    log?: (line: string, progress?: boolean) => void;
    timeoutMs?: number;
  } = {}
): Promise<string> {
  if (spec.kind === "image") {
    return spec.image;
  }
  const docker = options.docker ?? ["docker"];
  const cached = await dockerOnce(docker, ["image", "inspect", spec.image], 60_000);
  if (cached.exitCode === 0) {
    return spec.image;
  }
  options.log?.(`building sandbox image ${spec.image} (first use, may take a few minutes)`, true);
  const built = await dockerOnce(
    docker,
    [
      "build",
      "-t",
      spec.image,
      "-f",
      spec.dockerfile,
      ...Object.entries(spec.buildArgs).flatMap(([key, value]) => [
        "--build-arg",
        `${key}=${value}`,
      ]),
      spec.context,
    ],
    options.timeoutMs ?? 60 * 60_000
  );
  if (built.exitCode !== 0) {
    const tail = `${built.stdout.toString("utf8")}\n${built.stderr}`
      .trim()
      .split("\n")
      .slice(-15)
      .join("\n");
    throw new Error(
      `building sandbox image ${spec.image} failed (exit code ${built.exitCode}):\n${tail}\n` +
        (spec.generic ? buildParamsHelp() : `Dockerfile: ${spec.dockerfile}`)
    );
  }
  return spec.image;
}
