import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { DETECT_SCRIPT, GitRepoHarness, VALIDATE_SCRIPT } from "./git-repo-harness.mjs";

const ID = "2026-09-29-topic";
// Hard cap so a misbehaving CLI fails the test instead of hanging the suite.
const CLI_TIMEOUT_MS = 20_000;

// The thin CLIs are what the GitHub workflow actually invokes; verify their
// command surface end-to-end. All logic lives in the shared libs, so one happy
// path per CLI is sufficient (logic branches are covered by the in-process tests).
describe("automation thin CLIs (workflow entry points)", () => {
  let harness;
  afterEach(() => {
    harness?.cleanup();
  });

  it("detect-ready-transitions.mjs emits JSON bound to the authorized commit", () => {
    harness = new GitRepoHarness();
    const base = harness.addArticleCommit({ id: ID, status: "draft" }, "base draft");
    const head = harness.addArticleCommit({ id: ID, status: "ready_to_upload", withCover: true }, "ready B");

    const stdout = execFileSync(
      process.execPath,
      [DETECT_SCRIPT, "--base", base, "--head", head],
      { cwd: harness.dir, encoding: "utf8", timeout: CLI_TIMEOUT_MS }
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.transitions).toHaveLength(1);
    expect(parsed.transitions[0]?.source_commit).toBe(head);
  });

  it("validate-content.mjs --ref validates the exact commit and exits 0", () => {
    harness = new GitRepoHarness();
    harness.addArticleCommit({ id: ID, status: "draft" }, "base draft");
    const head = harness.addArticleCommit({ id: ID, status: "ready_to_upload", withCover: true }, "ready B");

    // execFileSync throws on non-zero exit; reaching here means exit code 0.
    const stdout = execFileSync(
      process.execPath,
      [VALIDATE_SCRIPT, "--ref", head, "--article-id", ID],
      { cwd: harness.dir, encoding: "utf8", timeout: CLI_TIMEOUT_MS }
    );
    expect(stdout).toContain("PASS");
  });

  it("validate-content.mjs --ref exits non-zero for an invalid authorized commit", () => {
    harness = new GitRepoHarness();
    harness.addArticleCommit({ id: ID, status: "draft" }, "base draft");
    const head = harness.addArticleCommit({ id: ID, status: "ready_to_upload" }, "ready B no cover");

    expect(() =>
      execFileSync(
        process.execPath,
        [VALIDATE_SCRIPT, "--ref", head, "--article-id", ID],
        { cwd: harness.dir, encoding: "utf8", timeout: CLI_TIMEOUT_MS }
      )
    ).toThrow();
  });
});
