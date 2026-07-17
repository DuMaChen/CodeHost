import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@platform/contracts": resolve(
        fileURLToPath(new URL("../contracts/src/index.ts", import.meta.url)),
      ),
    },
  },
});
