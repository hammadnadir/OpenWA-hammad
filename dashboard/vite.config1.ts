import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Single source of truth for the version shown in the dashboard: read it from
// package.json at build time so the Login screen always reflects the actual
// release (bumped via `npm version`), instead of a hard-coded literal that
// silently drifts. APP_VERSION env still overrides if explicitly provided.
const { version: pkgVersion } = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')) as {
  version: string;
};

// https://vite.dev/config/
const rootDir = existsSync(resolve(process.cwd(), 'key.pem')) ? process.cwd() : resolve(process.cwd(), '..');
const hasCerts = existsSync(resolve(rootDir, 'key.pem')) && existsSync(resolve(rootDir, 'cert.pem'));
// Default NestJS API port is 2785 unless PORT is explicitly specified in the root .env
const getApiPort = () => {
  try {
    const envContent = readFileSync(resolve(rootDir, '.env'), 'utf-8');
    const portMatch = envContent.match(/^PORT\s*=\s*(\d+)/m);
    if (portMatch) return portMatch[1];
  } catch {}
  return '2785';
};
const apiPort = getApiPort();
const apiTarget = `${hasCerts ? 'https' : 'http'}://localhost:${apiPort}`;

export default defineConfig({
  plugins: [react()],
  appType: 'spa', // Enable SPA fallback for client-side routing
  define: {
    __APP_VERSION__: JSON.stringify(process.env.APP_VERSION || pkgVersion),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    port: 80,
    host: true,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        secure: false,
      },
      // Proxy the WebSocket (socket.io) transport so the dashboard's real-time
      // chats/sessions streams work against the dev backend.
      '/socket.io': {
        target: apiTarget,
        ws: true,
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
