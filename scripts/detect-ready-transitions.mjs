#!/usr/bin/env node
/**
 * detect-ready-transitions.mjs — 检测本次 push 中进入 ready_to_upload 的文章（thin CLI）。
 *
 * 检测逻辑唯一实现见 scripts/lib/detect-transitions.mjs，本文件只负责参数与输出。
 * Workflow 与回归测试都调用本文件，保证 Single Implementation。
 *
 * 用法：
 *   node scripts/detect-ready-transitions.mjs --base <sha|ZERO> --head <sha> [--out <file>]
 *
 * 在当前工作目录（git 仓库）上执行。stdout 只输出 JSON（便于程序化消费）；
 * 人类可读 / GitHub 注解输出到 stderr。检测本身始终以 0 退出（无转换即空列表），
 * 是否发布由调用方依据 JSON 决定。
 */
import { writeFileSync } from "node:fs";
import { detectTransitions, ZERO_SHA } from "./lib/detect-transitions.mjs";

function parseArgs(argv) {
  const options = { positionals: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      options.positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      options[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      options[body] = next;
      i += 1;
    } else {
      options[body] = true;
    }
  }
  return options;
}

const args = parseArgs(process.argv.slice(2));
const base = args.base ? String(args.base) : ZERO_SHA;
const head = args.head ? String(args.head) : "";

if (!head) {
  console.error("必须提供 --head <sha>");
  process.exit(2);
}

const result = detectTransitions({ cwd: process.cwd(), base, head });
const json = JSON.stringify(result, null, 2);

if (args.out) {
  writeFileSync(String(args.out), `${json}\n`, "utf8");
}

// stdout：纯 JSON。
console.log(json);

// stderr：人类可读摘要（GitHub Actions 同样可识别 ::notice::）。
for (const transition of result.transitions) {
  console.error(`::notice::${transition.dir} (${transition.article_id}) authorized @ ${transition.source_commit}`);
}
if (result.transitions.length === 0) {
  console.error("No article entered ready_to_upload in this commit range.");
}

process.exit(0);
