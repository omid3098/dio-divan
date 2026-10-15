import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { thirdPartyNotices } from '../scripts/third-party-notices.mjs';

// The web editor. It is built into dist/web, which the local server serves; nothing is fetched from a CDN.
export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [react(), thirdPartyNotices(tailwindcss())],
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  clearScreen: false,
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    sourcemap: false,
    // No data: URLs for fonts: the server's CSP allows font-src 'self' only.
    assetsInlineLimit: 0,
    target: 'chrome140',
  },
});
