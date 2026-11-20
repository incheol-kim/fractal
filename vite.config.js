import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Folders that are not part of the page: Python's environment, the source material, documents and
// reviews, the running plan's workspace, and everything that is not on GitHub (local-only/: scratch,
// videos, models, notes). The dev server's file watcher crawled all of them on start; .venv alone
// (35,000 files) held up the first page load after every server start by 20 s and more.
const NOT_PAGE = ['.venv', 'resources', 'docs', '.superpowers', 'local-only'];
const norm = (p) => (process.platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p);
const notPageDirs = NOT_PAGE.map((d) => norm(path.join(ROOT, d)));
const isNotPage = (p) => {
  const n = norm(p);
  return notPageDirs.some((d) => n === d || n.startsWith(d + '/'));
};

export default defineConfig({
  root: '.',
  publicDir: 'assets', // served under the base path (the root on the dev server, /fractal/ on GitHub Pages); the build copies it there
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: [isNotPage] },
  },
  build: { outDir: 'local-only/temp/dist', emptyOutDir: true },
});
