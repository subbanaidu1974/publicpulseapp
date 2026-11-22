import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // S-70: `npm run test:coverage`. Thresholds sit just below the actuals measured when they were set
    // (server/civic: lines 96.98, statements 91.54, functions 97.46, branches 83.37; src/lib: 100 / 97.79 / 97.37 / 84.36).
    // Ratchet them up when coverage improves; never lower them to make a change pass.
    coverage: {
      provider: "v8",
      include: ["server/civic/**/*.ts", "src/lib/**/*.ts"],
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      thresholds: {
        "server/civic/**": { lines: 95, statements: 90, functions: 95, branches: 80 },
        "src/lib/**": { lines: 98, statements: 95, functions: 95, branches: 80 },
      },
    },
  },
});
