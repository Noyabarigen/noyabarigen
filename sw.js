/* Family Tree – service worker v32: অফলাইন শেল + পুশ + ব্যাকগ্রাউন্ডে অটো ডাটা সেভ */
var C = "ft-v40",
  SHELL = ["./", "index.html", "config.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"], // ইনস্টলে শুধু এগুলোই লাগে
  LATER = ["icon-maskable-192.png", "icon-maskable-512.png"]; // ইনস্টলের পরে পেছনে

// ---- ডাটা সিঙ্কের জন্য API ঠিকানা (config.js থেকে) ----
var API = "";
try { self.window = self; importScripts("config.js"); API = (self.FT_CFG && self.FT_CFG.api) || ""; } catch (e) {}
var COLLS = ["members", "settings", "news", "gallery", "memories", "comments", "notices", "events", "polls", "phonebook", "drives", "sorrows", "joys"];

// ---- IndexedDB "ft-snap" (পেজও একই ডাটাবেস পড়ে) ----
function db() {
  return new Promise(function (ok, no) {
    var q = indexedDB.open("ft-snap", 1);
    q.onupgradeneeded = function () { q.result.createObjectStore("kv", { keyPath: "k" }); };
    q.onsuccess = function () { ok(q.result); };
    q.onerror = q.onblocked = function () { no(q.error || new Error("idb")); };
  });
}
function kvGet(k) {
  return db().then(function (d) {
    return new Promise(function (ok) {
      var q = d.transaction("kv").objectStore("kv").get(k);
      q.onsuccess = function () { ok(q.result || null); };
      q.onerror = function () { ok(null); };
    });
  });
}
function kvPut(rec) {
  return db().then(function (d) {
    return new Promise(function (ok, no) {
      var t = d.transaction("kv", "readwrite");
      t.objectStore("kv").put(rec);
      t.oncomplete = function () { ok(); };
      t.onerror = t.onabort = function () { no(t.error); };
    });
  });
}
function gas(body) {
  return fetch(API, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(body) })
    .then(function (r) { return r.json(); })
    .then(function (j) { if (!j || !j.ok) throw new Error((j && j.error) || "gas"); return j; });
}

// সর্বশেষ ভার্সন দেখে শুধু বদলানো তালিকাগুলো নামিয়ে ফোনে সেভ করে। ইন্টারনেট না থাকলে error ছোড়ে (পরে আবার চেষ্টা হবে)।
var running = null;
function syncAll() {
  if (!API || /YOUR/.test(API)) return Promise.resolve();
  if (running) return running;
  running = gas({ action: "ver" }).then(function (ver) {
    var v = ver.v || {};
    return Promise.all(COLLS.map(function (c) { return kvGet("c:" + c).then(function (have) { return have && (!v[c] || v[c] === have.v) ? null : c; }); })).then(function (need) {
      need = need.filter(Boolean);
      var save = function (c, x) {
        var map = {};
        (x.docs || []).forEach(function (d) { var id = d.id; delete d.id; map[id] = d; });
        return kvPut({ k: "c:" + c, d: map, v: x.v, t: Date.now() });
      };
      // অনেকগুলো বাকি থাকলে (প্রথমবার) একটি অনুরোধেই সব; না পারলে একটা একটা করে
      var bulk = need.length > 3 ? gas({ action: "all" }).then(function (j) { return j.all || null; }).catch(function () { return null; }) : Promise.resolve(null);
      return bulk.then(function (all) {
        return Promise.all(need.map(function (c) {
          if (all && all[c]) return save(c, all[c]);
          return gas({ action: "list", coll: c }).then(function (x) { return save(c, x); });
        }));
      });
    }).then(function () { return kvPut({ k: "meta", t: Date.now() }); });
  }).then(function () { running = null; }, function (e) { running = null; throw e; });
  return running;
}
function quiet() { return syncAll().catch(function () {}); }


// ---- intro-music.mp3: একবার নামলে ফোনে থাকে (Range অনুরোধও চলে), প্রতিবার ৪৩২ KB নামে না ----
var audioBusy = false;
function ranged(res, r) {
  var h = r.headers.get("range");
  if (!h) return res;
  return res.blob().then(function (b) {
    var m = /bytes=(\d*)-(\d*)/.exec(h) || [], s = m[1] ? +m[1] : 0, en = m[2] ? +m[2] : b.size - 1;
    if (!m[1] && m[2]) { s = Math.max(0, b.size - +m[2]); en = b.size - 1; }
    en = Math.min(en, b.size - 1);
    if (s > en) return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + b.size } });
    return new Response(b.slice(s, en + 1), { status: 206, headers: {
      "Content-Type": res.headers.get("Content-Type") || "audio/mpeg",
      "Content-Range": "bytes " + s + "-" + en + "/" + b.size, "Content-Length": String(en - s + 1), "Accept-Ranges": "bytes" } });
  });
}
function audio(e, r, u) {
  return caches.open(C).then(function (c) {
    return c.match(u.pathname).then(function (m) {
      if (m) return ranged(m, r);
      if (!audioBusy) {
        audioBusy = true;
        e.waitUntil(fetch(u.pathname).then(function (res) { if (res && res.ok) return c.put(u.pathname, res); })
          .catch(function () {}).then(function () { audioBusy = false; }));
      }
      return fetch(r);
    });
  });
}

// রিডাইরেক্ট-হওয়া রেসপন্স ক্যাশ থেকে নেভিগেশনে দিলে ব্রাউজার ত্রুটি দেয়; তাই সাধারণ কপি রাখি
function clean(res) {
  if (!res.redirected) return Promise.resolve(res);
  return res.blob().then(function (b) {
    return new Response(b, { status: res.status, statusText: res.statusText, headers: res.headers });
  });
}
function store(c, key, res) {
  if (!res || res.status !== 200 || res.type !== "basic") return;
  clean(res.clone()).then(function (r) { return c.put(key, r); }).catch(function () {});
}

self.addEventListener("install", function (e) {
  // একটি ফাইল না নামলেও সার্ভিস ওয়ার্কার ইনস্টল হবে (addAll হলে একটিতে ব্যর্থ হলেই সব বাতিল হতো)
  e.waitUntil(caches.open(C).then(function (c) {
    // ক্যাশ-বাইপাস ছাড়া (ব্রাউজারের HTTP ক্যাশ কাজে লাগে), সব একসাথে; ইনস্টল আটকে থাকে না
    LATER.forEach(function (u) { e.waitUntil(fetch(u).then(function (res) { if (res && res.ok) return c.put(u, res); }).catch(function () {})); });
    return Promise.all(SHELL.map(function (u) {
      return fetch(u).then(function (res) {
        if (res && res.ok) return clean(res).then(function (r) { return c.put(u, r); });
      }).catch(function () {});
    }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (k) {
    return Promise.all(k.filter(function (x) { return x !== C; }).map(function (x) { return caches.delete(x); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  var r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.pathname.indexOf("/api/") === 0) return;
  if (u.origin !== location.origin) return;
  if (/\.mp3$/.test(u.pathname)) { e.respondWith(audio(e, r, u)); return; }
  var key = r.mode === "navigate" ? "index.html" : r;
  e.respondWith(caches.open(C).then(function (c) {
    return c.match(key).then(function (m) {
      var net = fetch(r).then(function (res) {
        store(c, key, res);
        return res;
      }).catch(function () { return null; });
      if (m) { e.waitUntil(net); return m; }
      return net.then(function (res) { return res || c.match("index.html") || Response.error(); });
    });
  }));
});

// ---- অটো ডাটা সেভের ট্রিগার (অ্যাপ বন্ধ থাকলেও) ----
self.addEventListener("periodicsync", function (e) { if (e.tag === "ft-sync") e.waitUntil(quiet()); }); // Android Chrome/Edge: ব্রাউজার নিজে সময় ঠিক করে
self.addEventListener("sync", function (e) { if (e.tag === "ft-sync") e.waitUntil(syncAll()); });       // ইন্টারনেট ফিরলেই; ব্যর্থ হলে ব্রাউজার নিজে আবার চেষ্টা করে
self.addEventListener("message", function (e) { if (e.data && e.data.type === "ft-sync") e.waitUntil(quiet()); });

self.addEventListener("push", function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { try { d = { body: e.data.text() }; } catch (__) {} }
  var n = d.notification || d, dt = d.data || { view: d.view }, t = n.title || "Family Tree";
  e.waitUntil(Promise.all([
    self.registration.showNotification(t, {
      body: n.body || "", icon: n.icon || "icon-192.png", badge: "icon-192.png", vibrate: [180, 80, 180],
      renotify: true, tag: n.tag || "ft" + Date.now(), lang: "bn", timestamp: Date.now(), data: { view: dt.view || "home" }
    }),
    quiet() // নোটিফিকেশন এলেই পেছনে সর্বশেষ ডাটাও নামিয়ে রাখে
  ]));
});
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var view = (e.notification.data && e.notification.data.view) || "home";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (l) {
    for (var i = 0; i < l.length; i++) if ("focus" in l[i]) { l[i].postMessage({ type: "ft-nav", view: view }); return l[i].focus(); }
    return self.clients.openWindow("./");
  }));
});
