/**
 * Reader — 对「某一份仓库快照」的只读访问抽象。
 *
 * 同一份 Content Validator 规则通过 Reader 作用于不同输入版本：
 *   - createWorkspaceReader：当前工作区（node:fs）
 *   - createGitRefReader：某个不可变 Git ref（git show / ls-tree / cat-file），
 *     不 checkout、不留下 dirty / detached 状态。
 *
 * 仅依赖 Node 内置模块与本机 git。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {Object} Reader
 * @property {(relPath: string) => string | null} readText  返回 UTF-8 文本；不存在返回 null
 * @property {(relPath: string) => boolean} isFile
 * @property {(relPrefix: string) => string[]} listFiles  返回 prefix 下全部仓库相对文件路径（POSIX 分隔符）
 */

/** Git tree entry 中被 Article Contract 接受的 regular file mode。 */
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

/**
 * `git ls-tree` 的一行输出形如：
 *   100644 blob <sha>\t<path>
 * 解析出 mode 与 object type；非 regular file 返回 null。
 *
 * 为什么不能只用 `git cat-file -e`：它只能证明对象存在，对 tree / symlink /
 * submodule 同样返回成功。Article Contract v1 要求 meta.json / source.md /
 * content.html / assets.json 必须是普通文件，因此必须检查 mode 与 type。
 */
function parseTreeEntry(line) {
  const match = /^(\d{6})\s+(\S+)\s+([0-9a-f]+)\t([\s\S]+)$/.exec(line);
  if (!match) return null;
  return { mode: match[1], type: match[2], sha: match[3], path: match[4] };
}

/** @returns {Reader} 针对当前工作区 */
export function createWorkspaceReader(root) {
  function abs(rel) {
    return path.join(root, rel);
  }

  return {
    mode: "workspace",
    readText(rel) {
      try {
        return fs.readFileSync(abs(rel), "utf8");
      } catch (error) {
        if (error && error.code === "ENOENT") return null;
        throw error;
      }
    },
    isFile(rel) {
      try {
        return fs.statSync(abs(rel)).isFile();
      } catch {
        return false;
      }
    },
    listFiles(relPrefix) {
      const out = [];
      const baseDir = relPrefix ? abs(relPrefix) : root;
      walk(baseDir);
      function walk(dir) {
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const child = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(child);
          } else if (entry.isFile()) {
            out.push(path.relative(root, child).split(path.sep).join("/"));
          }
        }
      }
      return out;
    }
  };
}

/** @returns {Reader} 针对某个不可变 Git ref（commit SHA） */
export function createGitRefReader(ref, { cwd = process.cwd() } = {}) {
  function git(args, allowFailure = false) {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      if (allowFailure) return null;
      throw error;
    }
  }

  const treeCache = new Map();
  function listTree(relPrefix) {
    const cacheKey = relPrefix || "";
    if (treeCache.has(cacheKey)) return treeCache.get(cacheKey);
    const args = relPrefix
      ? ["ls-tree", "-r", "--name-only", ref, "--", relPrefix]
      : ["ls-tree", "-r", "--name-only", ref];
    const out = splitLines(git(args, true) ?? "");
    treeCache.set(cacheKey, out);
    return out;
  }

  /**
   * 判断 ref 下某路径是否为 **regular file**。
   *
   * 不使用 `cat-file -e`：它只验证对象存在，tree / symlink / submodule 都会通过。
   * 这里直接读 tree entry 的 mode 与 type：
   *   - 只有 mode 100644（普通文件）/ 100755（可执行文件）且 type === "blob" 才算通过；
   *   - 目录（040000 tree）、符号链接（120000 blob）、submodule（160000 commit）一律拒绝。
   */
  function isRegularFile(rel) {
    const out = git(["ls-tree", ref, "--", rel], true);
    if (out === null) return false;
    for (const line of out.split("\n").filter(Boolean)) {
      const entry = parseTreeEntry(line);
      if (!entry) continue;
      if (entry.path !== rel) continue;
      return entry.type === "blob" && REGULAR_FILE_MODES.has(entry.mode);
    }
    return false;
  }

  return {
    mode: "ref",
    ref,
    readText(rel) {
      // 路径不存在时 git show 以非零退出，归一为 null；非法 ref 同样表现为 meta 缺失并由上层报错。
      return git(["show", `${ref}:${rel}`], true);
    },
    isFile: isRegularFile,
    listFiles(relPrefix) {
      return listTree(relPrefix || "");
    }
  };
}

function splitLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
