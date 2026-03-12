const CACHE_NAME = 'dailynote-panel-static-v7';
const STATIC_ASSETS = [
  '/AdminPanel/DailyNotePanel/',
  '/AdminPanel/DailyNotePanel/index.html',
  '/AdminPanel/DailyNotePanel/style.css',
  '/AdminPanel/DailyNotePanel/script.js',
  '/AdminPanel/DailyNotePanel/manifest.json',
  '/AdminPanel/DailyNotePanel/VCPNoteBook500.ico',
  '/AdminPanel/marked.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)).then(() => {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // 仅对 DailyNotePanel 自己的静态资源与本地 marked 解析器做 cache-first
  const isStatic =
    url.pathname.startsWith('/AdminPanel/DailyNotePanel/') ||
    url.pathname === '/AdminPanel/marked.min.js';

  if (!isStatic) {
    return; // 交给浏览器默认处理（包括 /dailynote_api/*）
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(resp => {
        const respClone = resp.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, respClone));
        return resp;
      });
    })
  );
});
  