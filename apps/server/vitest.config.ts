import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/**/*.test.ts",
      "../desktop/src/connection.test.ts",
      "../desktop/src/invoiceDraft.test.ts",
      "../desktop/src/invoicePrint.test.tsx",
      "../desktop/src/productRefresh.test.ts",
    ],
    exclude: ["test/integration/**"],
    setupFiles: ["./test/setup.ts"],
  },
});
