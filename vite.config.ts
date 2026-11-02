import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { crx } from '@crxjs/vite-plugin';
import { fileURLToPath } from 'node:url';
import manifest from './manifest.json' with { type: 'json' };

const srcDir = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss(), crx({ manifest })],
  define: { __APP_VERSION__: JSON.stringify(manifest.version) },
  resolve: {
    alias: { '@': srcDir },
  },
  build: {
    target: 'chrome116',
    sourcemap: false,
    rollupOptions: {
      input: {
        panel: fileURLToPath(new URL('./src/devtools/panel/panel.html', import.meta.url)),
      },
    },
  },
});
