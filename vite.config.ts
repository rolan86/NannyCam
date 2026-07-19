import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

const src = (path: string) => fileURLToPath(new URL(`src/${path}`, import.meta.url));

export default defineConfig({
  root: "src",
  plugins: [preact()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: src("index.html"),
        camera: src("camera.html"),
        viewer: src("viewer.html"),
      },
    },
  },
});
