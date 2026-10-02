import { defineConfig } from "vitest/config";

// The automation/ regression tests spawn real `git` and Node CLI subprocesses.
// Run every test file in a single fork, sequentially: this avoids the
// synchronous-child-process busy loop that worker threads use and removes
// cross-file process contention. Correctness/determinism over wall-clock speed.
export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    fileParallelism: false,
    // 显式排除编译产物：`tsc` 会把 *.test.ts 一并编译到 dist/，
    // 若不排除，`npm test` 会同时跑 src/ 源码测试与 dist/ 编译副本，
    // 用例数凭空翻倍（实测 51 -> 81）。这里让测试只针对源码，计数稳定可解释。
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
    ],
  },
});
