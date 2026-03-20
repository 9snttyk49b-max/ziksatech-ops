import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  define: {
    'window.__ANTHROPIC_KEY__': JSON.stringify(process.env.ANTHROPIC_API_KEY || ''),
    'import.meta.env.VITE_ANTHROPIC_API_KEY': JSON.stringify(process.env.ANTHROPIC_API_KEY || process.env.VITE_ANTHROPIC_API_KEY || ''),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // Only cache static assets — NOT the JS bundle (causes the stale version problem)
        globPatterns: ['**/*.{css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          {
            // JS chunks: network-first so new deploys load immediately
            urlPattern: /\/assets\/index-.*\.js$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'js-bundle',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 2, maxAgeSeconds: 3600 },
            },
          },
          {
            urlPattern: /^https:\/\/yucvxkugtwlsvhqzpoqe\.supabase\.co\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-cache',
              expiration: { maxEntries: 50, maxAgeSeconds: 300 },
              networkTimeoutSeconds: 5,
            },
          },
          {
            urlPattern: /^https:\/\/api\.anthropic\.com\/.*/i,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/i,
            handler: 'CacheFirst',
            options: { cacheName: 'google-fonts', expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 } },
          },
        ],
      },
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      manifest: {
        name: 'Ziksatech Ops Center',
        short_name: 'Ziksatech',
        description: 'Internal operations platform for Ziksatech — finance, HR, compliance, CRM',
        theme_color: '#0D1B2A',
        background_color: '#0D1B2A',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/#ops',
        icons: [
          { src: 'icons/icon-72x72.png',   sizes: '72x72',   type: 'image/png' },
          { src: 'icons/icon-96x96.png',   sizes: '96x96',   type: 'image/png' },
          { src: 'icons/icon-128x128.png', sizes: '128x128', type: 'image/png' },
          { src: 'icons/icon-144x144.png', sizes: '144x144', type: 'image/png' },
          { src: 'icons/icon-152x152.png', sizes: '152x152', type: 'image/png' },
          { src: 'icons/icon-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: 'icons/icon-384x384.png', sizes: '384x384', type: 'image/png' },
          { src: 'icons/icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
        categories: ['business', 'productivity'],
        shortcuts: [
          { name: 'Dashboard',   short_name: 'Dashboard', url: '/#ops?tab=dashboard', icons: [{ src: 'icons/icon-96x96.png', sizes: '96x96' }] },
          { name: 'Timesheets',  short_name: 'Timesheets',url: '/#ops?tab=timesheet', icons: [{ src: 'icons/icon-96x96.png', sizes: '96x96' }] },
          { name: 'Invoices',    short_name: 'Invoices',  url: '/#ops?tab=arinvoices',icons: [{ src: 'icons/icon-96x96.png', sizes: '96x96' }] },
          { name: 'Team Roster', short_name: 'Roster',    url: '/#ops?tab=roster',    icons: [{ src: 'icons/icon-96x96.png', sizes: '96x96' }] },
        ],
      },
    }),
  ],
  build: {
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
        },
      },
    },
  },
})
