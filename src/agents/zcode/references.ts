import fs from "node:fs";
import path from "node:path";

export interface ValidatedReference {
  source: string;
  absolutePath: string;
  directory: boolean;
}

/**
 * 引用校验模式：
 * - `strict`（缺省）：引用缺失 / 越出项目范围即抛错，保持既有 fail-closed 契约；
 * - `soft`：不因此阻断派发，未通过校验的引用进 `unverified` 清单（随提示词以
 *   「提及但未验证」附给 agent 自行判断）——适合自然语言任务书里的叙述性提及、
 *   待创建文件、粘贴的构建报错路径等。
 */
export type ReferenceValidationMode = "strict" | "soft";

/** {@link validateTaskReferences} 的结果；`unverified` 仅在 soft 模式下非空。 */
export interface TaskReferenceCheck {
  verified: ValidatedReference[];
  /** 未通过校验的候选（缺失 / 越界 / 无项目模式无法解析），以剥离 query 后的基路径记录 */
  unverified: string[];
}

function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 从任务书/上下文中抽取「像本地路径」的候选值（URL、模型名、命令文本等已被排除）。 */
export function collectLocalReferences(task: string, context?: string): string[] {
  const text = `${task}\n${context ?? ""}`;
  const values = new Set<string>();
  for (const m of text.matchAll(/`([^`]+)`/g)) values.add(m[1]!.trim());
  for (const m of text.matchAll(/(?:^|\s)((?:[A-Za-z]:[\\/]|\/|\.\.?[\\/])[^\s，。；;]+)/gm))
    values.add(m[1]!.trim());
  return [...values].filter(
    (source) => path.isAbsolute(source) || /^\.\.?[\\/]/.test(source) || /[\\/]/.test(source),
  );
}

/**
 * 校验任务书里的本地引用。
 *
 * `projectRoot` 缺失（无项目模式，issue #12）时**不得**退回 cwd / 主目录 / 日志目录去解析：
 * strict 下识别到明确引用就直接说明需要 projectPath，没有引用则返回空表
 * （soft 下识别到的引用只进 `unverified`，不阻断）。
 *
 * 校验前先剥离 `?query` 后缀：Vite/Vue 等构建工具的虚拟模块引用
 * （`App.uvue?vue&type=style&…`）常被整段粘贴进需求描述，`?` 在 Windows 文件名中
 * 非法、整串必不存在，不剥离就会把合法的基路径误判成缺失。只剥 `?` 不剥 `#`
 * （`#` 是 Windows 合法文件名字符，误剥会改变语义）；整串以 `?` 开头时剥离结果
 * 为空，回退原串保持 fail-closed。
 */
export function validateTaskReferences(
  task: string,
  context: string | undefined,
  projectRoot: string | undefined,
  mode: ReferenceValidationMode = "strict",
): TaskReferenceCheck {
  const candidates = collectLocalReferences(task, context);
  if (!projectRoot) {
    if (mode === "soft") return { verified: [], unverified: [...candidates] };
    if (candidates.length)
      throw new Error(
        `任务书包含本地文件引用（${candidates.slice(0, 5).join("、")}${candidates.length > 5 ? ` 等 ${candidates.length} 项` : ""}）；无项目模式无法解析路径，请提供 projectPath`,
      );
    return { verified: [], unverified: [] };
  }
  const root = path.resolve(projectRoot);
  const verified: ValidatedReference[] = [];
  const unverified: string[] = [];
  const seenVerified = new Set<string>();
  const seenUnverified = new Set<string>();
  const fail = (strictMessage: string, basePath: string): void => {
    if (mode === "strict") throw new Error(strictMessage);
    if (seenUnverified.has(basePath)) return;
    seenUnverified.add(basePath);
    unverified.push(basePath);
  };
  for (const source of candidates) {
    const basePath = source.replace(/\?.*$/, "") || source;
    const absolutePath = path.resolve(root, basePath);
    if (!inside(root, absolutePath)) {
      fail(`引用路径越出项目范围：${basePath}`, basePath);
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolutePath);
    } catch {
      fail(`引用路径不存在：${basePath}`, basePath);
      continue;
    }
    // 不同写法（带/不带 query、正反斜杠）可能归一到同一路径，去重保持提示词清单干净
    if (seenVerified.has(absolutePath)) continue;
    seenVerified.add(absolutePath);
    verified.push({ source: basePath, absolutePath, directory: stat.isDirectory() });
  }
  return { verified, unverified };
}
