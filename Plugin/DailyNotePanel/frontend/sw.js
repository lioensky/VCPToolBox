const CACHE_NAME = 'dailynote-panel-static-v9';
const PANEL_STATIC_PREFIX = '/AdminPanel/DailyNotePanel/';
const PROTECTED_API_PREFIXES = [
  '/AdminPanel/dailynote_api',
  '/AdminPanel/DailyNotePanel/api'
];
const STATIC_ASSETS = [
  '/AdminPanel/DailyNotePanel/',
  '/AdminPanel/DailyNotePanel/index.html',
  '/AdminPanel/DailyNotePanel/style.css',
  '/AdminPanel/DailyNotePanel/script.js',
  '/AdminPanel/DailyNotePanel/manifest.json',
  '/AdminPanel/DailyNotePanel/VCPNoteBook500.ico',
  '/AdminPanel/marked.min.js'
];

let fallbackAuthToken = null;

function normalizeStoredBasicToken(rawToken) {
  if (typeof rawToken !== 'string') return '';
  const trimmed = rawToken.trim();
  if (!trimmed) return '';
  return trimmed.replace(/^Basic\s+/i, '').trim();
}

function isProtectedApiPath(pathname) {
  return PROTECTED_API_PREFIXES.some(prefix =>
    pathname === prefix || pathname.startsWith(prefix + '/')
  );
}

function isStaticAssetPath(pathname) {
  if (pathname === '/AdminPanel/marked.min.js') return true;
  if (pathname === PANEL_STATIC_PREFIX + 'sw.js') return false;
  if (!pathname.startsWith(PANEL_STATIC_PREFIX)) return false;
  if (pathname.startsWith(PANEL_STATIC_PREFIX + 'api/')) return false;
  return true;
}

async function handleProtectedApiRequest(request) {
  const hasAuth = request.headers.has('Authorization');

  if (hasAuth) {
    return fetch(request);
  }

  if (!fallbackAuthToken) {
    return new Response(
      JSON.stringify({ error: 'SW Local Kill: Unauthenticated' }),
      {
        status: 401,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      }
    );
  }

  const newHeaders = new Headers(request.headers);
  newHeaders.set('Authorization', `Basic ${fallbackAuthToken}`);
  const secureRequest = new Request(request, { headers: newHeaders });
  return fetch(secureRequest);
}

async function handleStaticRequest(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response && response.ok) {
    const responseClone = response.clone();
    caches.open(CACHE_NAME).then(cache => cache.put(request, responseClone));
  }
  return response;
}

self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'SET_AUTH_TOKEN') {
    fallbackAuthToken = normalizeStoredBasicToken(data.token);
    return;
  }
  if (data.type === 'CLEAR_AUTH_TOKEN') {
    fallbackAuthToken = null;
  }
});

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

  if (isProtectedApiPath(url.pathname)) {
    event.respondWith(handleProtectedApiRequest(event.request));
    return;
  }

  if (!isStaticAssetPath(url.pathname)) {
    return;
  }

  event.respondWith(handleStaticRequest(event.request));
});
  