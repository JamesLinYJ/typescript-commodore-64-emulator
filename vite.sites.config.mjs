import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { sites } from './build/sites-vite-plugin';

export default defineConfig({
  base: '/',
  plugins: [
    react(),
    sites(),
    cloudflare({
      viteEnvironment: { name: 'server' },
      config: {
        main: './worker/index.ts',
        compatibility_flags: ['nodejs_compat'],
        assets: {
          binding: 'ASSETS',
          run_worker_first: true,
        },
      },
    }),
  ],
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
