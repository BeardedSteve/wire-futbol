// Progressive enhancement only. Pages are complete server-rendered HTML and htmx does the navigation and filtering.
// This file keeps clocks and relative times current and remembers what you have already seen. About 60 lines, no dependencies.
(function () {
  var TZ = "Europe/London", root = document.documentElement;
  // The server stamps its own clock on <html data-now>. Using it as the reference keeps times right on a phone with a wrong clock.
  var skew = root.dataset.now ? new Date(root.dataset.now).getTime() - Date.now() : 0;
  var now = function () { return Date.now() + skew; };
  var LS = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };
  var hm = function (d) { return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ }); };
  var day = function (d) { return d.toLocaleDateString("en-GB", { timeZone: TZ }); };
  function rel(iso) {
    var d = new Date(iso), s = (now() - d.getTime()) / 1000, t = new Date(now());
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 21600) return Math.floor(s / 3600) + "h ago";
    if (day(d) === day(t)) return hm(d);
    if (day(d) === day(new Date(now() - 864e5))) return "Yesterday " + hm(d);
    return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: TZ }) + " " + hm(d);
  }
  function setTile(c, u, v) {
    var b = c.querySelector('[data-u="' + u + '"] b'); if (!b) return;
    var t = String(v).padStart(2, "0");
    if (b.textContent !== t) { b.textContent = t; var tile = b.parentNode; tile.classList.remove("flip"); void tile.offsetWidth; tile.classList.add("flip"); }
  }
  function tick() {
    document.querySelectorAll("time[data-rel]").forEach(function (t) { t.textContent = rel(t.getAttribute("datetime")); });
    document.querySelectorAll(".clock[data-kickoff]").forEach(function (c) {
      var s = Math.max(0, Math.floor((new Date(c.dataset.kickoff).getTime() - now()) / 1000));
      setTile(c, "d", Math.floor(s / 86400)); setTile(c, "h", Math.floor((s % 86400) / 3600)); setTile(c, "m", Math.floor((s % 3600) / 60)); setTile(c, "s", s % 60);
    });
    document.querySelectorAll(".ko-big[data-kickoff] [data-elapsed]").forEach(function (e) {
      var m = Math.floor((now() - new Date(e.parentNode.dataset.kickoff).getTime()) / 60000);
      e.textContent = (m > 45 && m < 62 ? "HT" : Math.min(m, 90)) + (m > 45 && m < 62 ? "" : "'");
    });
  }
  // "N new since 09:14": compares each story's fetch time with the last time this browser had the wire open.
  function markNew() {
    var line = document.getElementById("since"), seen = LS.get("wire:seen"); if (!line) return;
    var fresh = seen ? [].filter.call(document.querySelectorAll(".story[data-fetched]"), function (s) { return s.dataset.fetched > seen; }) : [];
    fresh.forEach(function (s) { s.classList.add("is-new"); });
    if (fresh.length) {
      document.getElementById("since-t").textContent = fresh.length + " new since " + hm(new Date(seen));
      line.hidden = false;
    } else line.hidden = true;
  }
  function boot() { tick(); markNew(); }
  document.addEventListener("DOMContentLoaded", boot);
  document.addEventListener("htmx:afterSettle", boot);
  setInterval(tick, 1000);
  var mark = function () { if (document.visibilityState === "visible") LS.set("wire:seen", new Date(now()).toISOString()); };
  setTimeout(mark, 5000);
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") mark(); });
})();
