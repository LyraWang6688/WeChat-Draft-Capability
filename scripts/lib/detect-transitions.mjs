/**
 * detect-transitions — Human Authorization 转换检测的唯一实现（Single Source of Logic）。
 *
 * Workflow 与回归测试都调用本实现，禁止在 YAML 或测试里另写一套算法。
 *
 * 关键语义（修复 reauthorization endpoint-diff 盲区）：
 *   Candidate Article Set 来自「本次 push commit range 中曾被 *任何* commit 触过的
 *   article directories」，而不是 BASE↔HEAD 最终 endpoint diff。
 *   因此 ready(A) → draft(B) → ready(C) 且 HEAD 内容恢复为与 A 相同时，
 *   endpoint diff 为空，C 仍必须被检测为一次新的 authorization。
 *
 * 对每个 candidate：
 *   - 最终 HEAD status 必须为 ready_to_upload，否则跳过；
 *   - 扫描范围内触过该目录的提交（oldest first），保留「最后一次」进入 ready 的提交；
 *   - 该提交即被授权的不可变内容版本（source_commit）。
 */
import { execFileSync } from "node:child_process";

export const ZERO_SHA = "0000000000000000000000000000000000000000";

const DIR_PATTERN = /^content\/articles\/\d{4}\/[^/]+\//;

function git(cwd, args, allowFailure = false) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function splitLines(text) {
  return (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function toArticleDir(filePath) {
  const match = filePath.match(/^(content\/articles\/\d{4}\/[^/]+)\//);
  return match ? match[1] : null;
}

/** 读取某 ref 下某 article 的 meta.status；任何缺失 / 非法都归一为 "<none>"。 */
function readStatus(cwd, ref, dir) {
  const out = git(cwd, ["show", `${ref}:${dir}/meta.json`], true);
  if (out === null) return "<none>";
  try {
    const status = JSON.parse(out).status;
    return typeof status === "string" && status ? status : "<none>";
  } catch {
    return "<none>";
  }
}

/**
 * authorization target identity 只能来自 transitioned directory 本身。
 *
 * 绝不从 meta.json.article_id 推断「发布谁」：若某目录的 meta.json 误写了另一篇文章的
 * article_id，一旦信任 meta，validation 与 Publisher 都会被 redirect 到那篇别的文章，
 * 可能产生错误或重复草稿。目录名才是授权身份。
 */
function articleIdFromDir(dir) {
  const parts = dir.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : dir;
}

/**
 * @param {{cwd?: string, base?: string, head: string}} input
 * @returns {{transitions: Array<{dir: string, article_id: string, source_commit: string}>}}
 */
export function detectTransitions({ cwd = process.cwd(), base, head }) {
  const isZero = !base || base === ZERO_SHA;

  // Push range 内全部提交（oldest first）。
  const revArgs = isZero
    ? ["rev-list", "--reverse", head]
    : ["rev-list", "--reverse", `${base}..${head}`];
  const commits = splitLines(git(cwd, revArgs));

  // Candidate dirs：合并 range 内 *每个* commit 触过的 article 目录。
  const candidateDirs = new Set();
  for (const commit of commits) {
    // --root：range 含 root 提交时也列出其新增文件；对普通提交无副作用。
    // -m：对 merge commit 逐 parent 输出 diff。没有 -m 时 diff-tree 对 merge commit
    //     不输出任何路径（git 默认行为），会漏掉「只在 merge 结果里变成 ready」的目录。
    //     逐 parent 的重复路径由 Set 自然去重。
    const paths = splitLines(
      git(cwd, ["diff-tree", "-m", "--no-commit-id", "--name-only", "-r", "--root", commit], true) ?? ""
    );
    for (const filePath of paths) {
      if (DIR_PATTERN.test(filePath)) {
        const dir = toArticleDir(filePath);
        if (dir) candidateDirs.add(dir);
      }
    }
  }
  // Zero-base 兜底：直接把 HEAD 树中的全部 article 目录纳入候选。
  if (isZero) {
    const headPaths = splitLines(
      git(cwd, ["ls-tree", "-r", "--name-only", head, "--", "content/articles"], true) ?? ""
    );
    for (const filePath of headPaths) {
      const dir = toArticleDir(filePath);
      if (dir) candidateDirs.add(dir);
    }
  }

  const transitions = [];
  for (const dir of [...candidateDirs].sort()) {
    // 最终 HEAD 必须仍为 ready_to_upload。
    if (readStatus(cwd, head, dir) !== "ready_to_upload") continue;

    const dirRevArgs = isZero
      ? ["rev-list", "--reverse", head, "--", dir]
      : ["rev-list", "--reverse", `${base}..${head}`, "--", dir];
    const dirCommits = splitLines(git(cwd, dirRevArgs));

    let authorized = null;
    for (const commit of dirCommits) {
      const prev = readStatus(cwd, `${commit}^`, dir);
      const cur = readStatus(cwd, commit, dir);
      if (cur === "ready_to_upload" && prev !== "ready_to_upload") {
        authorized = commit;
      }
    }
    if (!authorized) continue;

    transitions.push({
      dir,
      // 只信任目录名：meta.json.article_id 不得决定「发布谁」。
      // 与 meta 不一致时由 exact-ref Validator 交叉校验并 FAIL CLOSED。
      article_id: articleIdFromDir(dir),
      source_commit: authorized
    });
  }

  return { transitions };
}
