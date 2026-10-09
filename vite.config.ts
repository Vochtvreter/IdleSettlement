/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// Relative base so the build works from any static host path (e.g. GitHub Pages).
export default defineConfig({
  base: './',
  build: { target: 'es2022', assetsInlineLimit: 0 },
  // The world is large: generating it takes a moment, so tests get more time than the default.
  test: { testTimeout: 60_000 },
});
