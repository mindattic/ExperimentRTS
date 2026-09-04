import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Vite already busts cache on JS modules it transforms, but static assets served straight out
    // of public/ are still cacheable by the browser with no header at all — a plain reload can
    // then serve a stale copy. no-cache forces revalidation on every request instead (a cheap 304
    // when nothing changed).
    headers: { 'Cache-Control': 'no-cache' },
  },
});
