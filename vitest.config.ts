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
  },
});
