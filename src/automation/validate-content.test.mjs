import { afterEach, describe, expect, it } from "vitest";
import { GitRepoHarness } from "./git-repo-harness.mjs";

const ID = "2026-09-29-topic";

describe("validate-content workspace mode (current on-disk snapshot)", () => {
  let harness;
  afterEach(() => {
    harness?.cleanup();
  });

  it("passes a draft package and warns about the missing required cover", () => {
    harness = new GitRepoHarness();
    harness.writeArticle({ id: ID, status: "draft" });
    harness.syncIndex();
    const result = harness.validateWorkspace();
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("cover.jpg"))).toBe(true);
  });

  it("passes a ready_to_upload package whose required cover exists", () => {
    harness = new GitRepoHarness();
    harness.writeArticle({ id: ID, status: "ready_to_upload", withCover: true });
    harness.syncIndex();
    const result = harness.validateWorkspace();
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("fails a ready_to_upload package whose required cover is missing", () => {
    harness = new GitRepoHarness();
    harness.writeArticle({ id: ID, status: "ready_to_upload" });
    harness.syncIndex();
    const result = harness.validateWorkspace();
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("cover.jpg"))).toBe(true);
  });

  it("rejects the retired dynamic filename field (content_file) in meta.json", () => {
    harness = new GitRepoHarness();
    harness.writeArticle({ id: ID, status: "draft" });
    const meta = JSON.parse(harness.readFile(`content/articles/2026/${ID}/meta.json`));
    meta.content_file = "custom.html";
    harness.writeFile(`content/articles/2026/${ID}/meta.json`, `${JSON.stringify(meta, null, 2)}\n`);

    harness.syncIndex();
    const result = harness.validateWorkspace();
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("content_file"))).toBe(true);
  });

  it("fails when the frozen content.html file is missing", () => {
    harness = new GitRepoHarness();
    harness.writeArticle({ id: ID, status: "draft" });
    harness.removeFile(`content/articles/2026/${ID}/content.html`);

    harness.syncIndex();
    const result = harness.validateWorkspace();
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("content.html"))).toBe(true);
  });
});

describe("validate-content ref mode (exact authorized commit)", () => {
  let harness;
  afterEach(() => {
    harness?.cleanup();
  });

  it("passes validation of the exact authorized commit with cover", () => {
    harness = new GitRepoHarness();
    const base = harness.addArticleCommit({ id: ID, status: "draft" }, "base draft");
    const b = harness.addArticleCommit({ id: ID, status: "ready_to_upload", withCover: true }, "ready B");

    const result = harness.validateRef(b, ID);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    // Sanity: the validated commit is exactly the one detection binds to.
    const detected = harness.detect(base, harness.sha());
    expect(detected.transitions[0]?.source_commit).toBe(b);
  });

  it("fails validation of an authorized commit missing its required cover", () => {
    harness = new GitRepoHarness();
    harness.addArticleCommit({ id: ID, status: "draft" }, "base draft");
    const b = harness.addArticleCommit({ id: ID, status: "ready_to_upload" }, "ready B no cover");

    const result = harness.validateRef(b, ID);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("cover.jpg"))).toBe(true);
  });

  it("fails validation of an authorized commit with blank content.html", () => {
    harness = new GitRepoHarness();
    harness.addArticleCommit({ id: ID, status: "draft" }, "base draft");
    const b = harness.addArticleCommit(
      { id: ID, status: "ready_to_upload", withCover: true, content: "   \n  " },
      "ready B blank content"
    );

    const result = harness.validateRef(b, ID);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("content.html"))).toBe(true);
  });

  it("binds validation to the exact reauthorized version (D), not the earlier ready commit (B)", () => {
    harness = new GitRepoHarness();
    const base = harness.addArticleCommit({ id: ID, status: "draft" }, "base draft");
    const b = harness.addArticleCommit({ id: ID, status: "ready_to_upload", withCover: true }, "ready B");
    harness.addArticleCommit({ id: ID, status: "draft", withCover: true }, "draft C");
    const d = harness.addArticleCommit({ id: ID, status: "ready_to_upload", withCover: true }, "ready D");

    const detected = harness.detect(base, harness.sha());
    expect(detected.transitions).toHaveLength(1);
    const publishedSha = detected.transitions[0]?.source_commit;
    expect(publishedSha).toBe(d);
    expect(publishedSha).not.toBe(b);

    // Validated version == published version (D).
    const result = harness.validateRef(d, ID);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("L. duplicate article_id directories are detected, not silently deduped", () => {
    harness = new GitRepoHarness();
    // 同名 article_id 出现在两个年份目录下。旧实现按 article_id 折叠 discovery 结果，
    // 使重复目录在唯一性校验前消失，整个工作区被判为 PASS。
    harness.writeArticleAtYear({ year: "2026", id: ID, status: "draft", withCover: true });
    harness.writeArticleAtYear({ year: "2025", id: ID, status: "draft", withCover: true });
    // index 只登记 canonical 的那条，确保不是靠 index 自身查重而通过。
    harness.writeFile(
      "content/index.json",
      `${JSON.stringify(
        {
          schema_version: 1,
          articles: [
            {
              article_id: ID,
              title: "测试文章标题",
              status: "draft",
              path: `content/articles/2026/${ID}/`,
              updated_at: "2026-09-29"
            }
          ]
        },
        null,
        2
      )}\n`
    );

    const result = harness.validateWorkspace();
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("重复 article_id 目录"))).toBe(true);
  });

  it("M. a required Contract path that is a tree (not a regular file) fails validation", () => {
    harness = new GitRepoHarness();
    harness.addArticleCommit({ id: ID, status: "ready_to_upload", withCover: true }, "ready with tree source.md");

    // 把 source.md 换成目录（git tree）。旧实现用 `cat-file -e` 只验证对象存在，
    // tree 同样返回成功，因此这种 package 会被判为 PASS。
    harness.removeFile(`content/articles/2026/${ID}/source.md`);
    harness.writeFile(`content/articles/2026/${ID}/source.md/nested.txt`, "not a regular file\n");
    const ref = harness.commit("source.md is now a tree");

    const result = harness.validateRef(ref, ID);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("source.md"))).toBe(true);
  });
});
