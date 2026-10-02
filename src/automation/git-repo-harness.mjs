/**
 * git-repo-harness.mjs — 自动化回归测试的一次性 Git 仓库夹具（plain ESM）。
 *
 * 检测 / 校验逻辑直接 import 唯一生产实现（scripts/lib/*.mjs），在进程内调用，
 * 不为每个测试反复 spawn Node CLI；CLI 表面由独立的 smoke test 覆盖。
 * 这样既满足「测试调用同一实现、不复制算法」，又保持测试轻量、确定。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createGitRefReader, createWorkspaceReader } from "../../scripts/lib/reader.mjs";
import { validateArticleAtRef, validateWorkspace } from "../../scripts/lib/content-validator.mjs";
import { detectTransitions } from "../../scripts/lib/detect-transitions.mjs";

const FILE_DIR = path.dirname(fileURLToPath(import.meta.url));
// src/automation -> repository root is two levels up.
export const REPO_ROOT = path.resolve(FILE_DIR, "..", "..");
export const DETECT_SCRIPT = path.join(REPO_ROOT, "scripts", "detect-ready-transitions.mjs");
export const VALIDATE_SCRIPT = path.join(REPO_ROOT, "scripts", "validate-content.mjs");

export class GitRepoHarness {
  constructor() {
    this.dir = mkdtempSync(path.join(os.tmpdir(), "safety-gate-"));
    this.git(["-c", "init.defaultBranch=main", "init", "-q"]);
    this.git(["config", "user.email", "harness@example.com"]);
    this.git(["config", "user.name", "Safety Gate Harness"]);
  }

  git(args) {
    return execFileSync("git", args, { cwd: this.dir, encoding: "utf8" });
  }

  sha(ref = "HEAD") {
    return this.git(["rev-parse", ref]).trim();
  }

  articleDir(id) {
    return path.join(this.dir, "content", "articles", id.slice(0, 4), id);
  }

  /** article directory 的仓库相对路径（POSIX）。 */
  articleRelDir(id) {
    return `content/articles/${id.slice(0, 4)}/${id}`;
  }

  writeArticle(input) {
    const dir = this.articleDir(input.id);
    mkdirSync(path.join(dir, "assets"), { recursive: true });

    const meta = {
      schema_version: 1,
      article_id: input.id,
      title: input.title ?? "测试文章标题",
      author: "Lyra Wang",
      created_at: "2026-09-29",
      updated_at: input.updated_at ?? "2026-09-29",
      status: input.status
    };
    writeFileSync(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    writeFileSync(path.join(dir, "source.md"), "# 源稿\n\n正文\n", "utf8");
    writeFileSync(path.join(dir, "content.html"), input.content ?? "<p>正文内容</p>\n", "utf8");

    const assets = {
      schema_version: 1,
      cover: { path: "assets/cover.jpg", required: true },
      body_images: []
    };
    writeFileSync(path.join(dir, "assets.json"), `${JSON.stringify(assets, null, 2)}\n`, "utf8");

    if (input.withCover) {
      writeFileSync(path.join(dir, "assets", "cover.jpg"), "fake-jpeg-cover-bytes", "utf8");
    }
  }

  /**
   * 写出一个 article package，但把 meta.article_id 覆写成另一个 ID。
   * 用于回归 K：目录名与 meta.article_id 不一致时必须 FAIL CLOSED。
   */
  writeArticleWithMetaId(input) {
    this.writeArticle(input);
    const metaPath = path.join(this.articleDir(input.id), "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    meta.article_id = input.metaArticleId;
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  }

  /**
   * 在指定年份目录下写出一个同名 article_id 的目录。
   * 用于回归 L：重复 article_id 目录必须被检出，不能被静默折叠。
   */
  writeArticleAtYear(input) {
    const dir = path.join(this.dir, "content", "articles", input.year, input.id);
    mkdirSync(path.join(dir, "assets"), { recursive: true });
    const meta = {
      schema_version: 1,
      article_id: input.metaArticleId ?? input.id,
      title: input.title ?? "测试文章标题",
      author: "Lyra Wang",
      created_at: "2026-09-29",
      updated_at: "2026-09-29",
      status: input.status ?? "draft"
    };
    writeFileSync(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    writeFileSync(path.join(dir, "source.md"), "# 源稿\n\n正文\n", "utf8");
    writeFileSync(path.join(dir, "content.html"), "<p>正文内容</p>\n", "utf8");
    writeFileSync(
      path.join(dir, "assets.json"),
      `${JSON.stringify({ schema_version: 1, cover: { path: "assets/cover.jpg", required: true }, body_images: [] }, null, 2)}\n`,
      "utf8"
    );
    if (input.withCover) {
      writeFileSync(path.join(dir, "assets", "cover.jpg"), "fake-jpeg-cover-bytes", "utf8");
    }
  }

  /** 创建分支并提交（用于构造 merge commit）。 */
  createBranch(name) {
    this.git(["checkout", "-q", "-b", name]);
  }

  checkout(ref) {
    this.git(["checkout", "-q", ref]);
  }

  currentBranch() {
    return this.git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  }

  /**
   * 构造一个真正的 merge commit（--no-ff）。
   * 若产生冲突，则写入 README.md 解决冲突后提交，形成「conflict-resolution merge」。
   */
  mergeNoFf(branch, message) {
    try {
      this.git(["merge", "--no-ff", "--no-edit", "-q", branch]);
    } catch {
      // 冲突：交由调用方先写好解决结果，再由 commitMerge 完成提交。
      this.mergeConflicted = true;
      return null;
    }
    return this.sha();
  }

  /** 冲突 merge 解决后提交。 */
  commitMerge(message) {
    this.git(["add", "-A"]);
    this.git(["commit", "-q", "--no-edit", "-m", message]);
    return this.sha();
  }

  /** 通过 git update-index 把一个路径登记为 symlink（mode 120000）。 */
  addSymlink(relPath, target) {
    const abs = path.join(this.dir, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, target, "utf8");
    this.git(["add", "-A"]);
    this.git(["update-index", "--cacheinfo", "120000", this.hashBlob(target), relPath]);
  }

  hashBlob(content) {
    return execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: this.dir,
      encoding: "utf8",
      input: content
    }).trim();
  }

  /** Overwrite a single file inside the repo (repo-relative POSIX path). */
  writeFile(relPath, content) {
    const target = path.join(this.dir, relPath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }

  /** Remove a repo-relative file/dir. */
  removeFile(relPath) {
    rmSync(path.join(this.dir, relPath), { force: true });
  }

  /** Read a repo-relative file as UTF-8. */
  readFile(relPath) {
    return readFileSync(path.join(this.dir, relPath), "utf8");
  }

  commit(message) {
    this.syncIndex();
    this.git(["add", "-A"]);
    this.git(["commit", "-q", "-m", message]);
    return this.sha();
  }

  addArticleCommit(input, message) {
    this.writeArticle(input);
    return this.commit(message);
  }

  /**
   * Regenerate content/index.json from the current on-disk article metas so
   * every commit snapshots a consistent index (including multi-article pushes).
   */
  syncIndex() {
    const articlesRoot = path.join(this.dir, "content", "articles");
    const records = [];

    let years = [];
    try {
      years = readdirSync(articlesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      years = [];
    }

    for (const year of years) {
      const yearDir = path.join(articlesRoot, year);
      const ids = readdirSync(yearDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      for (const id of ids) {
        try {
          const meta = JSON.parse(readFileSync(path.join(yearDir, id, "meta.json"), "utf8"));
          records.push({
            article_id: meta.article_id,
            title: meta.title,
            status: meta.status,
            path: `content/articles/${year}/${id}/`,
            updated_at: meta.updated_at
          });
        } catch {
          // Malformed meta: let the Content Validator report it; skip in index.
        }
      }
    }

    records.sort((a, b) => a.article_id.localeCompare(b.article_id));
    mkdirSync(path.join(this.dir, "content"), { recursive: true });
    writeFileSync(
      path.join(this.dir, "content", "index.json"),
      `${JSON.stringify({ schema_version: 1, articles: records }, null, 2)}\n`,
      "utf8"
    );
  }

  /** True when the endpoint (final) diff between two refs is empty. */
  endpointDiffEmpty(a, b) {
    return this.git(["diff", "--name-only", a, b]).trim() === "";
  }

  /* ---- In-process calls to the single production implementation ---- */

  /** Authorization detection (same logic the workflow invokes). */
  detect(base, head) {
    return detectTransitions({ cwd: this.dir, base, head });
  }

  /** Validate one Article Package at an immutable commit. */
  validateRef(ref, articleId) {
    const reader = createGitRefReader(ref, { cwd: this.dir });
    return validateArticleAtRef(reader, articleId);
  }

  /** Validate the whole content workspace at its current on-disk state. */
  validateWorkspace() {
    return validateWorkspace(createWorkspaceReader(this.dir));
  }

  cleanup() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
