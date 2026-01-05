import { defineConfig } from 'astro/config';
import netlify from '@astrojs/netlify';

import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // This tells Astro to run code on the server for every request
  output: 'server',

  adapter: netlify(),

  vite: {
    plugins: [tailwindcss()],
  },
});