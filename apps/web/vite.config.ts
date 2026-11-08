import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon.svg'],
      manifest: {
        name: 'Reader',
        short_name: 'Reader',
        description: 'Your newsletters, feeds and websites in one calm inbox.',
        theme_color: '#0B6B66',
        background_color: '#F6F7F5',
        display: 'standalone',
        start_url: '/',
        // The app shows up in the phone's share sheet (installed app on Chrome or Samsung Internet):
        // a shared link opens Add with "Just one page" filled in; a shared PDF (or picture) is kept
        // and opened in the reader while the PC reads it. The Worker answers /api/share (POST).
        share_target: {
          action: '/api/share',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'shared_title',
            text: 'shared_text',
            url: 'shared_url',
            files: [{ name: 'file', accept: ['application/pdf', '.pdf', 'image/*', 'text/plain'] }],
          },
        },
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Keep the last few days readable offline: lists and bodies fall back to cache.
        navigateFallback: '/index.html',
        // /helper/ holds the PC helper downloads: real files, never the app shell.
        navigateFallbackDenylist: [/^\/api\//, /^\/helper\//],
        runtimeCaching: [
          {
            urlPattern: ({ url, request }) => request.method === 'GET' && url.pathname.startsWith('/api/items') && url.pathname.endsWith('/body'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'item-bodies',
              expiration: { maxEntries: 300, maxAgeSeconds: 7 * 24 * 3600 },
            },
          },
          {
            urlPattern: ({ url, request }) => request.method === 'GET' && url.pathname.startsWith('/api/'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 100, maxAgeSeconds: 24 * 3600 },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
  build: {
    sourcemap: false,
  },
});
