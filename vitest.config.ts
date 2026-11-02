import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import manifest from './manifest.json' with { type: 'json' };

const srcDir = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': srcDir } },
  define: { __APP_VERSION__: JSON.stringify(manifest.version) },
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/devtools/panel/main.tsx', 'src/devtools/devtools.ts'],
      reporter: ['text', 'html'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'component',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx', 'test/component/**/*.test.tsx'],
          setupFiles: ['./test/setup/component-setup.ts'],
        },
      },
    ],
  },
});
