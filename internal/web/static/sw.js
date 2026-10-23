self.addEventListener('install',function(){self.skipWaiting()});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim())});
self.addEventListener('push',function(e){var d={};try{d=e.data.json()}catch(_){d={body:e.data?e.data.text():''}}
 e.waitUntil(self.registration.showNotification(d.title||'Wire',{body:d.body||'',tag:d.tag||undefined,renotify:!!d.tag,icon:'/icon-192.png',data:{url:d.url||'/'}}))});
self.addEventListener('notificationclick',function(e){e.notification.close();var url=(e.notification.data&&e.notification.data.url)||'/';
 e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(ws){for(var i=0;i<ws.length;i++){var w=ws[i];if('focus' in w){if(w.navigate)w.navigate(url);return w.focus()}}return self.clients.openWindow(url)}))});
