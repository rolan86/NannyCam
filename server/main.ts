import { join } from "node:path";

const DIST_DIR = join(import.meta.dir, "..", "dist");
const PORT = 8080;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") {
      return new Response("ok");
    }

    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    let file = Bun.file(join(DIST_DIR, pathname));

    if (!(await file.exists())) {
      file = Bun.file(join(DIST_DIR, "index.html"));
    }

    return new Response(file);
  },
});

console.log(`Listening on http://localhost:${PORT}`);
