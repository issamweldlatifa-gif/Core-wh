import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // bind to 0.0.0.0 so the live preview works
    port: 5173,
    // Allow the sandbox/live-preview host and local origins in dev only.
    allowedHosts: ['.e2b.app', 'localhost', '127.0.0.1', '0.0.0.0'],
    // Proxy the backend API from the same origin (avoids CORS and the
    // browser calling localhost directly). In dev the frontend calls
    // `/api` and Vite forwards to the NestJS backend.
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
