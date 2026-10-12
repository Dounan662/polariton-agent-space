import { defineConfig } from 'vite';
import {cp} from 'node:fs/promises';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  plugins: [react(),{name:'pdf-resources',async closeBundle(){for(const directory of ['wasm','cmaps','standard_fonts'])await cp(fileURLToPath(new URL(`./node_modules/pdfjs-dist/${directory}`,import.meta.url)),fileURLToPath(new URL(`./dist/web/pdf/${directory}`,import.meta.url)),{recursive:true});}}],
  // Fonts must remain same-origin files to satisfy Main's font-src policy.
  build: { outDir: '../dist/web', emptyOutDir: true, assetsInlineLimit: (path) => /\.(?:woff2?|ttf|otf)$/i.test(path) ? false : undefined },
});
