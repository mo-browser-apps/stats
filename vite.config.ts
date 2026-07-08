import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig, type UserConfig } from "vite";

export default defineConfig(({ command, mode }) => {
  const buildTimeDefines = createBuildTimeDefines(command === "build");

  if (mode === "main") {
    return defineMainConfig(buildTimeDefines);
  }
  if (mode === "renderer") {
    return defineRendererConfig(buildTimeDefines);
  }
  throw new Error(`Unsupported Vite config mode: ${mode}`);
});

function createBuildTimeDefines(sentryEnabled: boolean): Record<string, string> {
  return {
    SENTRY_DSN: JSON.stringify(process.env.SENTRY_DSN ?? ""),
    SENTRY_ENABLED: JSON.stringify(sentryEnabled),
  };
}

// No build sourcemaps: `mobrowser build` output is the distributed app, and
// shipping .map files would hand the original TypeScript to anyone who opens
// the bundle - defeating the framework's source protection. Dev debugging
// goes through the dev server, which has its own transient maps.

function defineMainConfig(buildTimeDefines: Record<string, string>): UserConfig {
  return {
    root: path.resolve(__dirname, "./src/main"),
    define: buildTimeDefines,
    build: {
      target: "esnext",
      outDir: path.resolve(__dirname, "./out/main"),
      emptyOutDir: true,
      lib: {
        entry: path.resolve(__dirname, "./src/main/index.ts"),
        formats: ["es"],
        fileName: () => "index.js",
      },
      rollupOptions: {
        external: [
          "mobrowser",
          "import-in-the-middle",
          "module-details-from-path",
          "require-in-the-middle",
          /^node:.*/,
        ],
      },
    },
    resolve: {
      conditions: ["node"],
      alias: {
        "@": path.resolve(__dirname, "./src/main"),
      },
    },
  };
}


function defineRendererConfig(buildTimeDefines: Record<string, string>): UserConfig {
  return {
    root: path.resolve(__dirname, "./src/renderer"),
    define: buildTimeDefines,
    plugins: [react()],
    build: {
      outDir: path.resolve(__dirname, "./out/renderer"),
      emptyOutDir: true,
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src/renderer"),
      },
    },
  };
}
