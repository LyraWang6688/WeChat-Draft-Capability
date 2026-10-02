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
});
