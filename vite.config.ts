import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig, type UserConfig } from "vite";

export default defineConfig(({ mode }) => {
  if (mode === "main") {
    return defineMainConfig();
  }
  if (mode === "renderer") {
    return defineRendererConfig();
  }
  throw new Error(`Unsupported Vite config mode: ${mode}`);
});

// No build sourcemaps: `mobrowser build` output is the distributed app, and
// shipping .map files would hand the original TypeScript to anyone who opens
// the bundle - defeating the framework's source protection. Dev debugging
// goes through the dev server, which has its own transient maps.

function defineMainConfig(): UserConfig {
  return {
    root: path.resolve(__dirname, "./src/main"),
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
          // Externalize all Node.js built-in modules
          /^node:.*/,
        ],
      },
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src/main"),
      },
    },
  };
}


function defineRendererConfig(): UserConfig {
  return {
    root: path.resolve(__dirname, "./src/renderer"),
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
