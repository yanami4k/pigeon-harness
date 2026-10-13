// 命令行输出的终端边界净化写（决策 036）：cli 唯一 stdout 出口组合子——帮助、trace / replay / session list 只读视图与
// 各子命令的结果全部经它写出。半信任内容（模型文本、参数、错误消息）携带的终端控制序列在边界统一替换为可见标记
// ␛/控制图形（M2 审计 P2-1），不做逐调用点修补
import { sanitizeTerminalText } from "../application/format.ts";

export type WriteFn = (text: string) => void;

export function sanitizedWriter(write: WriteFn): WriteFn {
  return (text) => write(sanitizeTerminalText(text));
}
