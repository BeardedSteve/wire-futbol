// Progressive enhancement. Pages are complete server-rendered HTML and htmx does navigation and filtering. This keeps
// clocks and relative times current, remembers what this browser has seen, takes typed page numbers and shows the
// squad page's dot-plot labels. No dependencies; every handler is bound once at the document.
(function () {
  var TZ = "Europe/London", root = document.documentElement;
  // The server stamps its clock on <html data-now>. Times are worked out against it, so a phone with a wrong clock
  // still says "5 min ago" correctly.
  var skew = root.dataset.now ? new Date(root.dataset.now).getTime() - Date.now() : 0;
  if (!isFinite(skew) || Math.abs(skew) < 2000) skew = 0;
  var now = function () { return Date.now() + skew; };
  var LS = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };
  var fmt = function (d, o) { o.timeZone = TZ; return d.toLocaleString("en-GB", o); };
  var hm = function (d) { return fmt(d, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); };
  var day = function (d) { return fmt(d, { year: "numeric", month: "2-digit", day: "2-digit" }); };
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };

  // Mirrors rel() in format.go.
  function rel(iso) {
    var d = new Date(iso), s = (now() - d.getTime()) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 21600) return Math.floor(s / 3600) + "h ago";
    if (day(d) === day(new Date(now()))) return hm(d);
    if (day(d) === day(new Date(now() - 864e5))) return "Yesterday " + hm(d);
    return fmt(d, { weekday: "short", day: "numeric", month: "short" }).replace(",", "") + " " + hm(d);
  }

  var lastMinute = -1;
  function tick() {
    var t = new Date(now()), c = document.querySelector("[data-clock]");
    if (c) c.textContent = hm(t) + "/" + pad(t.getSeconds());
    document.querySelectorAll(".clock[data-kickoff]").forEach(function (el) {
      var s = Math.max(0, Math.floor((new Date(el.dataset.kickoff).getTime() - now()) / 1000));
      var v = { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
      el.querySelectorAll(".tile").forEach(function (tile) {
        var b = tile.firstChild, x = pad(v[tile.dataset.u]);
        if (b.textContent !== x) b.textContent = x;
      });
    });
    if (t.getMinutes() === lastMinute) return;
    lastMinute = t.getMinutes();
    document.querySelectorAll("time.rel").forEach(function (el) { el.textContent = rel(el.getAttribute("datetime")); });
    document.querySelectorAll(".ko[data-kickoff] [data-elapsed]").forEach(function (el) {
      el.textContent = Math.max(1, Math.floor((now() - new Date(el.closest(".ko").dataset.kickoff).getTime()) / 60000));
    });
  }

  // "3 new since 09:14": stories this browser hasn't seen, by the time each was fetched.
  var seenAtLoad = LS.get("wire:seen");
  function markNew() {
    var line = document.getElementById("since");
    if (!line || !seenAtLoad) return;
    var n = 0;
    document.querySelectorAll(".story[data-fetched], .splash[data-fetched]").forEach(function (s) {
      if (s.dataset.fetched > seenAtLoad) { s.classList.add("is-new"); n++; }
    });
    line.textContent = n + " new since " + hm(new Date(seenAtLoad));
    line.hidden = !n;
  }
  function markSeen() { if (document.getElementById("feed")) LS.set("wire:seen", new Date(now()).toISOString()); }
  setTimeout(markSeen, 5000);
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") markSeen(); });

  // Typed page numbers, like a teletext remote: three digits anywhere go to that page.
  var typed = "", typedTimer = 0;
  function pg(text, typing) {
    var p = document.getElementById("pgnum");
    if (!p) return;
    p.textContent = text || "P" + p.dataset.no;
    p.classList.toggle("typing", !!typing);
  }
  document.addEventListener("keydown", function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    var tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target && e.target.isContentEditable)) return;
    if (e.key === "Escape" && typed) { typed = ""; pg(); return; }
    if (!/^[0-9]$/.test(e.key)) return;
    typed += e.key;
    clearTimeout(typedTimer);
    pg("P" + (typed + "--").slice(0, 3), true);
    if (typed.length < 3) { typedTimer = setTimeout(function () { typed = ""; pg(); }, 4000); return; }
    var pages = {};
    try { pages = JSON.parse(document.body.dataset.pages || "{}"); } catch (x) {}
    var url = pages[typed];
    typed = "";
    if (url) { pg(); location.assign(url); }
    else { pg("P---", true); typedTimer = setTimeout(pg, 1200); }
  });

  // Shorts not yet watched, once this browser has watched some.
  function shortsBadge() {
    var seen = {}, any = false;
    try { JSON.parse(LS.get("wire.shorts.seen") || "[]").forEach(function (id) { seen[id] = 1; any = true; }); } catch (e) {}
    var els = document.querySelectorAll("[data-shorts-n]");
    if (!any || !els.length) return;
    fetch("/api/shorts").then(function (r) { return r.ok ? r.json() : []; }).then(function (list) {
      var n = list.filter(function (v) { return !seen[v.id]; }).length;
      els.forEach(function (el) {
        el.textContent = n > 99 ? "99+" : String(n);
        el.hidden = !n;
        el.closest("a").setAttribute("aria-label", "Shorts" + (n ? ", " + n + " unseen" : ""));
      });
    }).catch(function () {});
  }

  // Dot-plot labels on the squad page: the nearest dot to the pointer, within reach of a thumb.
  var tip = null;
  function hideTip() { if (tip) tip.hidden = true; var h = document.querySelector(".strip circle.hot"); if (h) h.classList.remove("hot"); }
  function showTip(e) {
    var svg = e.target.closest && e.target.closest(".strip svg");
    if (!svg) return hideTip();
    var best = null, bd = 22 * 22;
    svg.querySelectorAll("circle[data-t]").forEach(function (c) {
      var r = c.getBoundingClientRect(), dx = r.left + r.width / 2 - e.clientX, dy = r.top + r.height / 2 - e.clientY, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = c; }
    });
    hideTip();
    if (!best) return;
    if (!tip) { tip = document.createElement("div"); tip.className = "tip"; tip.setAttribute("role", "status"); document.body.appendChild(tip); }
    best.classList.add("hot");
    tip.textContent = best.dataset.t;
    tip.hidden = false;
    var r = best.getBoundingClientRect();
    tip.style.left = Math.min(innerWidth - tip.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2)) + "px";
    tip.style.top = Math.max(8, r.top - tip.offsetHeight - 10) + "px";
  }
  document.addEventListener("pointermove", function (e) { if (e.pointerType === "mouse") showTip(e); }, { passive: true });
  document.addEventListener("pointerdown", showTip, { passive: true });
  addEventListener("scroll", hideTip, { passive: true });

  // A link to /squad#p-123 opens that player's row, so the board and treatment room land on the injury.
  function openHash() {
    var id = location.hash.slice(1), el = /^p-\d+$/.test(id) && document.getElementById(id);
    if (!el || el.tagName !== "DETAILS") return;
    el.open = true;
    el.scrollIntoView({ block: "start" });
  }
  addEventListener("hashchange", openHash);

  function boot() { lastMinute = -1; tick(); markNew(); shortsBadge(); openHash(); }
  document.addEventListener("DOMContentLoaded", boot);
  setInterval(tick, 1000);
  document.addEventListener("htmx:afterSettle", function (e) {
    var d = e.detail || {}, to = (d.requestConfig && d.requestConfig.headers && d.requestConfig.headers["HX-Target"]) || "";
    if (d.boosted || to === "") {
      boot();
      // A page change: start the reader at the content, as a full load would.
      var m = document.getElementById("main");
      if (m && d.boosted) m.focus({ preventScroll: true });
    } else if (to === "feedzone") {
      lastMinute = -1; tick(); markNew();
      var fz = document.getElementById("feedzone"), cur = fz && fz.querySelector(".menu [aria-current]");
      if (cur) cur.focus({ preventScroll: true });
      if (fz && fz.getBoundingClientRect().top < 0) fz.scrollIntoView({ block: "start" });
    } else { lastMinute = -1; tick(); }
  });
})();
