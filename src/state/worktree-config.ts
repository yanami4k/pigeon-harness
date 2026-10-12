// 独立工作树的设置（决策 445；settings.json 的 worktree 一节）：baseRef 为新建工作树的起点——"fresh"（缺省）取远端默认分支的
// 最新版（远端引用超过 24 小时没取过先取一次，取不到用当前 HEAD），"head" 直接用当前 HEAD。纯 schema 与取值，无 IO。
import { type Static, Type } from "typebox";

export const WorktreeSectionSchema = Type.Object(
  {
    baseRef: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("head")])),
  },
  { additionalProperties: false }
);
export type WorktreeSection = Static<typeof WorktreeSectionSchema>;

export function worktreeBaseModeOf(section: WorktreeSection | undefined): "fresh" | "head" {
  return section?.baseRef ?? "fresh";
}
