// 给模型看、又被程序认回来的固定文字（决策 428）：英文，写的地方与认的地方共用一处。
// 只放跨层共用的；只在一个模块里写、在同模块或上层认的，就近定义

// run_command 结果正文里文件变化一段的开头（tools/run-command.ts 写，pi-runtime/context-prune.ts 截取）
export const FILE_CHANGES_HEAD = "File changes:";

// 正文里最后一段文件变化的起点（含前面的换行）；没有为 -1
export function lastFileChangesAt(text: string): number {
  return text.lastIndexOf(`\n${FILE_CHANGES_HEAD}`);
}
