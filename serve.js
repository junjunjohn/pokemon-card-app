// Plain static file server — for local testing only. GitHub Pages will
// actually serve these same files in production; this just mimics that
// environment locally (fetch() to Supabase/the Pokémon TCG API works the
// same way here as it will once deployed).

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8123;
const ROOT = __dirname;

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

http.createServer((req, res) => {
  let staticPath = decodeURIComponent(req.url.split("?")[0]);
  if (staticPath === "/" || staticPath === "") staticPath = "/index.html";
  const filePath = path.resolve(path.join(ROOT, staticPath));

  // Block path traversal (e.g. "/../some-other-file").
  if (!(filePath === ROOT || filePath.startsWith(ROOT + path.sep))) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Serving on http://localhost:${PORT}`));
