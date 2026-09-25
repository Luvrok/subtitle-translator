import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// PUBLIC_URL is the sub-path the page is served under, e.g. /subtitle-translator
const base = `${(process.env.PUBLIC_URL ?? '').replace(/\/+$/, '')}/`;

export default defineConfig({
  base,
  plugins: [react()],
  build: { outDir: 'build' },
  // `npm run dev` next to `npm run serve`: the page from Vite, the API from server/server.mjs
  server: { proxy: { [`${base}api`]: 'http://localhost:5390' } },
});
