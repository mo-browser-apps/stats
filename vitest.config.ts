import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = resolve(fileURLToPath(import.meta.url), "..");

/**
 * Vitest config for unit tests.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@/": `${resolve(here, "src/renderer")}/`,
      "@main/": `${resolve(here, "src/main")}/`,
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    reporters: ["default"],
  },
});
