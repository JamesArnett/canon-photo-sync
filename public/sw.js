const cacheName = 'canon-shell-v6';
const shell = ['/', '/styles.css', '/app.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];
self.addEventListener('install', event => event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(shell)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('canon-shell-') && key !== cacheName).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.search || !shell.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).catch(async () => (await caches.match(url.pathname)) || Response.error()));
});
self.addEventListener('push', event => {
  let data;
  try { data = event.data?.json(); } catch {}
  event.waitUntil(self.registration.showNotification(data?.title || 'Canon Photo Sync', {
    body: data?.body || 'Open Canon Photo Sync for details.', tag: data?.tag, icon: '/icon-192.png'
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(clients => clients.find(client => client.url.startsWith(self.location.origin+'/'))?.focus() || self.clients.openWindow('/')));
});
