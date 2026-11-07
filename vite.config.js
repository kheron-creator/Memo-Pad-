import { defineConfig } from 'vite';
export default defineConfig({ build: { rollupOptions: { input: { main: 'index.html', listen: 'listen.html', create: 'create.html', mix: 'mix.html' } } } });
