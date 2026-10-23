// Phone alerts. The sheet is a native <dialog>. The button and the sheet are replaced by every boosted page change,
// so they are looked up when used; the document-level listeners are added once.
(function () {
  var ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  var supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  var reg = null, sub = null;
  var $ = function (id) { return document.getElementById(id); };
  var app = function () { return (document.querySelector("meta[name=apple-mobile-web-app-title]") || {}).content || "the wire"; };

  function b64(k) {
    var s = (k + "=".repeat((4 - (k.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"), r = atob(s), a = new Uint8Array(r.length);
    for (var i = 0; i < r.length; i++) a[i] = r.charCodeAt(i);
    return a;
  }
  function post(u, d) {
    return fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(d) })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
  }
  function setBtn() {
    var btn = $("alerts-btn");
    if (!btn) return;
    if (supported || (ios && !standalone)) btn.hidden = false;
    btn.classList.toggle("on", !!sub);
    btn.querySelector(".alerts-l").textContent = sub ? "Alerts on" : "Alerts";
    btn.setAttribute("aria-label", sub ? "Phone alerts are on" : "Turn on phone alerts");
  }
  function open(html) {
    var sheet = $("alerts-sheet");
    $("sheet-body").innerHTML = html;
    if (!sheet.open) sheet.show();
    $("alerts-btn").setAttribute("aria-expanded", "true");
    var f = sheet.querySelector("button");
    if (f) f.focus();
  }
  function close() {
    var sheet = $("alerts-sheet"), btn = $("alerts-btn");
    if (sheet && sheet.open) sheet.close();
    if (btn) btn.setAttribute("aria-expanded", "false");
  }
  function msg(t) { var b = $("sheet-body"), p = document.createElement("p"); p.textContent = t; b.insertBefore(p, b.querySelector(".sheet-actions")); }
  var LIMITS = " At most six a day, none between 22:00 and 07:00.";
  var WHAT = "material news breaks: a key player ruled out, a signing, a contract, a manager change.";
  function render() {
    if (!supported && ios && !standalone) return open("<p>On iPhone, alerts only work once the wire is on your Home Screen.</p><ol><li>Tap the Share button in Safari</li><li>Choose Add to Home Screen</li><li>Open " + app() + ' from your Home Screen and tap Alerts</li></ol><div class="sheet-actions"><button class="btn" data-a="close">Got it</button></div>');
    if (!supported) return open('<p>This browser does not support push notifications.</p><div class="sheet-actions"><button class="btn" data-a="close">Close</button></div>');
    if (Notification.permission === "denied") return open('<p>Notifications are blocked for this site. Allow them in your phone or browser settings, then come back here.</p><div class="sheet-actions"><button class="btn" data-a="close">Close</button></div>');
    if (sub) return open("<p>You get an alert when " + WHAT + LIMITS + '</p><div class="sheet-actions"><button class="btn primary" data-a="test">Send a test</button><button class="btn" data-a="off">Turn off</button></div>');
    open("<p>Get a notification on this device when " + WHAT + LIMITS + '</p><div class="sheet-actions"><button class="btn primary" data-a="on">Turn on alerts</button><button class="btn" data-a="close">Not now</button></div>');
  }
  function enable(b) {
    b.disabled = true;
    Notification.requestPermission().then(function (p) {
      if (p !== "granted") { render(); return; }
      return fetch("/api/push/key").then(function (r) { return r.json(); })
        .then(function (k) { return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(k.key) }); })
        .then(function (s) { sub = s; return post("/api/push/subscribe", s.toJSON()); })
        .then(function () { setBtn(); render(); msg("Alerts are on. A confirmation should arrive in a few seconds."); });
    }).catch(function (e) { b.disabled = false; msg("Could not turn on alerts: " + e.message); });
  }
  document.addEventListener("click", function (e) {
    var sheet = $("alerts-sheet"), btn = $("alerts-btn");
    if (!sheet || !btn) return;
    if (btn.contains(e.target)) { sheet.open ? close() : render(); return; }
    if (!sheet.contains(e.target)) { if (sheet.open) close(); return; }
    var a = e.target.closest("button");
    if (!a) return;
    var act = a.dataset.a;
    if (act === "close") close();
    else if (act === "on") enable(a);
    else if (act === "test") {
      a.disabled = true;
      post("/api/push/test", { endpoint: sub.endpoint }).then(function () { msg("Test sent."); a.disabled = false; }).catch(function (x) { msg("Test failed: " + x.message); a.disabled = false; });
    } else if (act === "off") {
      a.disabled = true;
      var ep = sub.endpoint;
      sub.unsubscribe().catch(function () {}).then(function () { return post("/api/push/unsubscribe", { endpoint: ep }); }).catch(function () {}).then(function () { sub = null; setBtn(); close(); });
    }
  });
  document.addEventListener("keydown", function (e) { var s = $("alerts-sheet"); if (e.key === "Escape" && s && s.open) { close(); $("alerts-btn").focus(); } });
  document.addEventListener("DOMContentLoaded", setBtn);
  document.addEventListener("htmx:afterSettle", setBtn);
  if (supported) {
    navigator.serviceWorker.register("/sw.js").then(function (r) { reg = r; return r.pushManager.getSubscription(); })
      .then(function (s) { sub = s; if (s) post("/api/push/subscribe", s.toJSON()).catch(function () {}); setBtn(); }).catch(function () {});
  }
})();
