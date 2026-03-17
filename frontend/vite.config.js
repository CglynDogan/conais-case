import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Allows both sides to import from shared/ using '@shared/events'
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  server: {
    port: 5173,
  },
});
