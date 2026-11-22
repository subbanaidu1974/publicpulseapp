import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      // The polyfill is a separate request shared by both pages; on 2G that is a wasted 300 ms round trip for /lite. Every browser that runs type=module has native modulepreload or ignores the hint.
      modulePreload: { polyfill: false },
      // Two pages: the full app and the separately built, framework-free /lite entry (S-75). No shared chunks beyond what Rollup finds.
      rollupOptions: { input: { main: path.resolve(__dirname, "index.html"), lite: path.resolve(__dirname, "lite.html") } },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
