// 打包选项（决策 351）：build-bundle 与第三方许可汇总共用。无副作用：只返回选项，不写文件。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const at = (relative) => fileURLToPath(new URL(relative, root));

// photon 的入口在加载时按 __dirname 拼 wasm 路径，打成 ESM 单文件后没有 __dirname。
// 只在它这一个模块开头补一个局部 __dirname；state.patched 供构建脚本核对插件确实生效。
export function createPhotonDirnamePlugin() {
  const state = { patched: false };
  const plugin = {
    name: "photon-dirname",
    setup(build) {
      build.onLoad(
        { filter: /[\\/]@silvia-odwyer[\\/]photon-node[\\/]photon_rs\.js$/ },
        async (args) => {
          state.patched = true;
          const source = await readFile(args.path, "utf8");
          return { contents: `var __dirname = __pigeonBundleDir;\n${source}`, loader: "js" };
        }
      );
    },
  };
  return { plugin, state };
}

// 按输出目录返回两组 esbuild 选项：DeepSeek 接入的自包含产物与 Pigeon 主产物。
export function bundleOptions(outDir, { photonDirname, define = {} } = {}) {
  const out = (name) => join(outDir, name);
  return [
    {
      entryPoints: [at("src/pi-runtime/deepseek-stream-fn.ts")],
      outfile: out("deepseek-stream-fn.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      logLevel: "warning",
    },
    {
      entryPoints: [at("src/bundle-entry.ts")],
      outfile: out("pigeon-cli.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      sourcemap: true,
      sourcesContent: false,
      // 打进包的 CommonJS 依赖里的 require 要有出处（ESM 产物里没有 require）；产物所在目录供 photon 找 wasm
      banner: {
        js: [
          'import { createRequire as __pigeonCreateRequire } from "node:module";',
          'import { fileURLToPath as __pigeonFileURLToPath } from "node:url";',
          "const require = __pigeonCreateRequire(import.meta.url);",
          'const __pigeonBundleDir = __pigeonFileURLToPath(new URL(".", import.meta.url));',
        ].join("\n"),
      },
      ...(photonDirname !== undefined ? { plugins: [photonDirname] } : {}),
      define,
      logLevel: "warning",
    },
  ];
}
