import { afterEach, describe, expect, it } from "vitest";
import { GitRepoHarness } from "./git-repo-harness.mjs";

const ID = "2026-09-29-topic";
const ID_A = "2026-09-29-article-a";
const ID_B = "2026-09-29-article-b";
const ZERO_SHA = "0000000000000000000000000000000000000000";

describe("detect-ready-transitions (Human authorization detection)", () => {
  let harness;
  afterEach(() => {
    harness?.cleanup();
  });

  it("A. draft -> ready(B): publishes B", () => {
    harness = new GitRepoHarness();
    const base = harness.addArticleCommit({ id: ID, status: "draft" }, "base draft");
    const b = harness.addArticleCommit({ id: ID, status: "ready_to_upload", withCover: true }, "ready B");

    const result = harness.detect(base, harness.sha());
    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0]?.article_id).toBe(ID);
    expect(result.transitions[0]?.source_commit).toBe(b);
  });

  it("B. draft -> ready(B) -> ready(C content edit): publishes B only", () => {
    harness = new GitRepoHarness();
    const base = harness.addArticleCommit({ id: ID, status: "draft" }, "base draft");
    const b = harness.addArticleCommit({ id: ID, status: "ready_to_upload", withCover: true }, "ready B");
    harness.addArticleCommit(
      { id: ID, status: "ready_to_upload", withCover: true, content: "<p>edited body</p>\n" },
      "ready C content edit"
    );

    const result = harness.detect(base, harness.sha());
    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0]?.source_commit).toBe(b);
  });

  it("C. ready(A) -> draft(B) -> ready(C) with identical endpoint content: still detects C", () => {
    harness = new GitRepoHarness();
    const a = harness.addArticleCommit({ id: ID, status: "ready_to_upload", withCover: true }, "ready A");
    harness.addArticleCommit({ id: ID, status: "draft", withCover: true }, "draft B");
    const c = harness.addArticleCommit({ id: ID, status: "ready_to_upload", withCover: true }, "ready C");

    // The endpoint (final) diff A..C is empty: the old logic saw no candidate and
    // missed the reauthorization. Guard that precondition explicitly.
    expect(harness.endpointDiffEmpty(a, c)).toBe(true);

    const result = harness.detect(a, c);
    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0]?.source_commit).toBe(c);
  });

  it("D. draft -> ready(B) -> draft(C) -> ready(D): publishes D", () => {
    harness = new GitRepoHarness();
    const base = harness.addArticleCommit({ id: ID, status: "draft" }, "base draft");
    const b = harness.addArticleCommit({ id: ID, status: "ready_to_upload", withCover: true }, "ready B");
    harness.addArticleCommit({ id: ID, status: "draft", withCover: true }, "draft C");
    const d = harness.addArticleCommit({ id: ID, status: "ready_to_upload", withCover: true }, "ready D");

    const result = harness.detect(base, harness.sha());
    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0]?.source_commit).toBe(d);
    expect(result.transitions[0]?.source_commit).not.toBe(b);
  });

  it("E. ready -> ready content-only edit: no new authorization", () => {
    harness = new GitRepoHarness();
    const base = harness.addArticleCommit({ id: ID, status: "ready_to_upload", withCover: true }, "ready base");
    harness.addArticleCommit(
      { id: ID, status: "ready_to_upload", withCover: true, content: "<p>edited body</p>\n" },
      "ready content edit"
    );

    const result = harness.detect(base, harness.sha());
    expect(result.transitions).toHaveLength(0);
  });

  it("F. ready -> draft: no publish", () => {
    harness = new GitRepoHarness();
    const base = harness.addArticleCommit({ id: ID, status: "ready_to_upload", withCover: true }, "ready base");
    harness.addArticleCommit({ id: ID, status: "draft", withCover: true }, "draft");

    const result = harness.detect(base, harness.sha());
    expect(result.transitions).toHaveLength(0);
  });

  it("G. final HEAD is not ready_to_upload: no publish", () => {
    harness = new GitRepoHarness();
    const base = harness.addArticleCommit({ id: ID, status: "draft" }, "base draft");
    harness.addArticleCommit({ id: ID, status: "ready_to_upload", withCover: true }, "ready B");
    harness.addArticleCommit({ id: ID, status: "draft", withCover: true }, "final draft C");

    const result = harness.detect(base, harness.sha());
    expect(result.transitions).toHaveLength(0);
  });

  it("H. multi-article push binds each article to its own authorized SHA", () => {
    harness = new GitRepoHarness();
    harness.writeArticle({ id: ID_A, status: "draft" });
    harness.writeArticle({ id: ID_B, status: "draft" });
    const base = harness.commit("base: both draft");

    const x = harness.addArticleCommit({ id: ID_A, status: "ready_to_upload", withCover: true }, "A ready");
    const y = harness.addArticleCommit({ id: ID_B, status: "ready_to_upload", withCover: true }, "B ready");

    const result = harness.detect(base, harness.sha());
    expect(result.transitions).toHaveLength(2);
    const byId = Object.fromEntries(result.transitions.map((t) => [t.article_id, t.source_commit]));
    expect(byId[ID_A]).toBe(x);
    expect(byId[ID_B]).toBe(y);
  });

  it("I. new article <none> -> ready(B) -> ready(C): publishes B (zero base)", () => {
    harness = new GitRepoHarness();
    const b = harness.addArticleCommit({ id: ID, status: "ready_to_upload", withCover: true }, "ready B");
    harness.addArticleCommit(
      { id: ID, status: "ready_to_upload", withCover: true, content: "<p>edited body</p>\n" },
      "ready C"
    );

    const result = harness.detect(ZERO_SHA, harness.sha());
    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0]?.source_commit).toBe(b);
  });

  it("J. article becomes ready only inside a conflict-resolution merge commit", () => {
    harness = new GitRepoHarness();
    // base：文章为 draft
    harness.writeArticle({ id: ID, status: "draft" });
    harness.writeFile("README.md", "base\n");
    const base = harness.commit("base: draft + readme");

    // feature 分支：只改 README，不碰文章
    harness.createBranch("feature");
    harness.writeFile("README.md", "feature-side\n");
    harness.commit("feature: touch readme");

    // 回到 main：只改 README（制造 README 冲突）
    harness.checkout("main");
    harness.writeFile("README.md", "main-side\n");
    harness.commit("main: touch readme");

    // merge 产生冲突；在解决冲突时把文章改为 ready
    // —— 这次状态变化只存在于 merge commit 的结果中
    harness.mergeNoFf("feature", "merge feature");
    expect(harness.mergeConflicted).toBe(true);

    harness.writeArticle({ id: ID, status: "ready_to_upload", withCover: true });
    harness.writeFile("README.md", "resolved\n");
    const mergeSha = harness.commitMerge("merge feature (resolved; article made ready)");

    // 前置条件：该 merge commit 相对每个 parent 的普通 diff-tree 不带 --name-only？
    // 关键断言：旧实现（无 -m）对 merge commit 不输出路径，因此完全漏掉该目录。
    const withoutM = harness.git([
      "diff-tree", "--no-commit-id", "--name-only", "-r", "--root", mergeSha
    ]).trim();
    expect(withoutM).toBe(""); // 复现旧 bug 的前提

    const result = harness.detect(base, mergeSha);
    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0]?.article_id).toBe(ID);
    expect(result.transitions[0]?.source_commit).toBe(mergeSha);
  });

  it("K. directory / meta.article_id mismatch must not redirect authorization", () => {
    harness = new GitRepoHarness();
    // 目录名是 ID，但 meta.article_id 写成了另一篇文章的 ID
    harness.writeArticleWithMetaId({ id: ID_A, status: "draft", metaArticleId: ID_B });
    harness.writeArticle({ id: ID_B, status: "draft" });
    const base = harness.commit("base: mismatched meta + article-b draft");

    harness.writeArticleWithMetaId({ id: ID_A, status: "ready_to_upload", withCover: true, metaArticleId: ID_B });
    const head = harness.commit("ready A (meta claims B)");

    const result = harness.detect(base, head);
    // authorization target identity 只能来自目录名，绝不 redirect 到 meta 声明的 ID_B
    const ids = result.transitions.map((t) => t.article_id);
    expect(ids).not.toContain(ID_B);
    expect(ids).toEqual([ID_A]);

    // 且 exact-ref Validator 必须 FAIL CLOSED（目录名与 meta 不一致）
    const validation = harness.validateRef(head, ID_A);
    expect(validation.ok).toBe(false);
    expect(validation.errors.some((e) => e.includes("目录名"))).toBe(true);
  });
});
