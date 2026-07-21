import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Read version from package.json
const { version: pkgVersion } = JSON.parse(
  readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')
) as {
  version: string;
};

// Detect project root
const rootDir = existsSync(resolve(process.cwd(), 'key.pem'))
  ? process.cwd()
  : resolve(process.cwd(), '..');

const hasCerts =
  existsSync(resolve(rootDir, 'key.pem')) &&
  existsSync(resolve(rootDir, 'cert.pem'));

// Load SSL certificates
const ssl = hasCerts
  ? {
      key: readFileSync(resolve(rootDir, 'key.pem')),
      cert: readFileSync(resolve(rootDir, 'cert.pem')),
    }
  : undefined;


// Get backend API port from .env
const getApiPort = () => {
  try {
    const envContent = readFileSync(resolve(rootDir, '.env'), 'utf-8');

    const portMatch = envContent.match(/^PORT\s*=\s*(\d+)/m);

    if (portMatch) {
      return portMatch[1];
    }
  } catch {}

  return '2785';
};

const apiPort = getApiPort();

const apiTarget = `${hasCerts ? 'https' : 'http'}://localhost:${apiPort}`;


// Vite Config
export default defineConfig({

  plugins: [
    react()
  ],

  appType: 'spa',

  define: {
    __APP_VERSION__: JSON.stringify(
      process.env.APP_VERSION || pkgVersion
    ),

    __BUILD_TIME__: JSON.stringify(
      new Date().toISOString()
    ),
  },


  server: {

    // Domain
    host: '0.0.0.0',

    // HTTPS port
    port: 80,

    // SSL
    https: ssl,

    // Allow domain
    allowedHosts: [
      'whatsapp1.biztekapps.us',
      'localhost',
      '127.0.0.1',
      '192.168.61.190'
    ],


    proxy: {

      // Backend API
      '/api': {

        target: apiTarget,

        changeOrigin: true,

        secure: false,

      },


      // Socket.io
      '/socket.io': {

        target: apiTarget,

        ws: true,

        changeOrigin: true,

        secure: false,

      },

    },

  },

});