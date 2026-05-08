/* App Insights page analytics for the docs site
 *
 * Sends pageviews + basic session data to the same App Insights resource
 * that captures Copilot chat telemetry, so docs traffic and chat usage
 * can be correlated in a single workbook.
 *
 * Privacy posture:
 *
 * - Honors ``navigator.doNotTrack`` — opts out automatically
 * - Honors the Copilot privacy localStorage decision
 *   (``csa.copilot.privacy.v1`` == "opted_out") — covers users who
 *   already opted out of chat tracking
 * - Disables IP collection at ingest (``disableAjaxTracking`` /
 *   ``isStorageUseDisabled`` configured)
 * - No correlation cookies (``disableCookiesUsage: true``)
 * - Auto-route tracking enabled so mkdocs-material instant nav still
 *   produces sensible per-page metrics
 *
 * The connection string is intentionally hardcoded — App Insights
 * connection strings are designed for client-side use, the ingestion
 * endpoint is rate-limited per resource, and the cost is bounded by
 * the daily cap configured on the resource.
 */
(function () {
  "use strict";

  // ── Privacy gates ────────────────────────────────────────────────
  // Honor browser-level Do Not Track header.
  var dnt = (
    navigator.doNotTrack === "1" ||
    window.doNotTrack === "1" ||
    navigator.msDoNotTrack === "1"
  );

  // Honor the Copilot opt-out decision (set by the chat widget).
  var copilotOptedOut = false;
  try {
    copilotOptedOut = localStorage.getItem("csa.copilot.privacy.v1") === "opted_out";
  } catch (_) { /* localStorage blocked — treat as not-opted-out */ }

  if (dnt || copilotOptedOut) {
    // Quiet exit — no SDK load, no telemetry.
    return;
  }

  // ── Connection string ─────────────────────────────────────────────
  // Public-safe (designed for client-side ingestion). If the resource
  // is replaced, update both this constant and the Function App's
  // ``APPLICATIONINSIGHTS_CONNECTION_STRING`` setting.
  var CONNECTION_STRING =
    "InstrumentationKey=dff52c9c-b5da-4756-8a4b-aa4026c6838f;" +
    "IngestionEndpoint=https://eastus2-1.in.applicationinsights.azure.com/;" +
    "LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com/;" +
    "ApplicationId=ae42232b-107f-4fbb-9bce-ee68fe7ff110";

  // ── Standard Application Insights JS snippet (v3) ─────────────────
  // Adapted from https://learn.microsoft.com/azure/azure-monitor/app/javascript-sdk
  // with privacy-conservative defaults.
  !function (cfg) {
    function e() { i.initialize !== !1 && i.initialize !== "false" && (cfg.initialized = !0, h.SeverityLevel = { Verbose: 0, Information: 1, Warning: 2, Error: 3, Critical: 4 }, k && setTimeout(function () { k.loadFinal && k.loadFinal() }, 0), l = !1) }
    var t, n, i, a, d, s, c, u, l, p = (cfg.name || "appInsights") + (cfg.namePrefix || ""), h = window[p] || function (cfg) {
      var n = !1, i = !1, a = { initialize: !0, queue: [], sv: "8", version: 2, config: cfg };
      function s(e, t) { var n = {}, i = "Browser"; function a(e) { e = "" + e; return 1 === e.length ? "0" + e : e } return n[i + "Id"] = "x", n[i + "Ver"] = "0.0.0", { time: function () { var e = new Date; return e.getUTCFullYear() + "-" + a(1 + e.getUTCMonth()) + "-" + a(e.getUTCDate()) + "T" + a(e.getUTCHours()) + ":" + a(e.getUTCMinutes()) + ":" + a(e.getUTCSeconds()) + "." + ((e.getUTCMilliseconds() / 1e3).toFixed(3) + "").slice(2, 5) + "Z" }(), iKey: e, name: "Microsoft.ApplicationInsights." + e.replace(/-/g, "") + "." + t, sampleRate: 100, tags: n, data: { baseData: { ver: 2 } }, ver: 4, seq: "1", aiDataContract: void 0 } }
      a.SeverityLevel = h.SeverityLevel || {};
      var c = (cfg.cfg || {}).connectionString || cfg.connectionString;
      function u(e, t) { if (a[e]) return; var n = "https://js.monitor.azure.com/scripts/b/" + e; t && -1 !== ("" + t).indexOf("ScriptDom") < 0 && (n = t); function r() { var t, r = document, o = r.createElement("script"); o.src = n, c && o.setAttribute("ai-cs", c); var s = "integrity"; cfg[s] && o.setAttribute(s, cfg[s]), o.setAttribute("crossOrigin", "anonymous"), (t = cfg.onInit || null) && o.addEventListener && o.addEventListener("load", function () { try { t(d) } catch (e) {} }, !1), o.onload = function () { i = !0, e() }; var l = r.getElementsByTagName("script")[0]; l.parentNode.insertBefore(o, l) } cfg.ld < 0 ? (r.readyState !== "loading" ? r() : window.addEventListener("DOMContentLoaded", r)) : setTimeout(r, cfg.ld || 0) }
      try { a.cookie = document.cookie } catch (e) {} a.trackEvent = a.trackPageView = function () {};
      var l = cfg.url || "https://js.monitor.azure.com/scripts/b/ai.3.gbl.min.js";
      try {
        var p = function (e) { return function (t) { var r = "Microsoft_ApplicationInsights_BypassAjaxInstrumentation", o = window[e]; o && o[r] || (window[e] = function () { var n = arguments, r = !1; try { r = !!(o && o.apply && o.apply(window[e], n)) } catch (e) {} return r })(t) } }; "fetch" in window && p("fetch")(l)
      } catch (e) {}
      u("ai.3", l);
      var d = function (e, t, n) { i ? e.diagnosticLog && e.diagnosticLog(t, n) : a.queue.push(function () { d(e, t, n) }) };
      function f(e) { return function () { var t = arguments, n = a; if (!i) return a.queue.push(function () { n[e].apply(n, t) }); var r = n[e]; "function" == typeof r && r.apply(n, t) } }
      ["Event", "PageView", "Exception", "Trace", "DependencyData", "Metric", "PageViewPerformance"].forEach(function (e) { a["track" + e] = f("track" + e) });
      ["startTrackEvent", "stopTrackEvent", "startTrackPage", "stopTrackPage", "addTelemetryInitializer", "setAuthenticatedUserContext", "clearAuthenticatedUserContext", "trackPageViewPerformance", "addPlugin", "evtNamespace", "addUnloadCb", "onCfgChange", "trackPageViewExtension"].forEach(function (e) { a[e] = f(e) });
      return a
    }({ src: cfg.src, crossOrigin: "anonymous", cfg: { connectionString: cfg.connectionString } });
    window[p] = h, h.queue && 0 === h.queue.length && (h.trackPageView({}), e())
  }({
    src: "https://js.monitor.azure.com/scripts/b/ai.3.gbl.min.js",
    crossOrigin: "anonymous",
    connectionString: CONNECTION_STRING,
    cfg: {
      // Disable cookies so we don't need a cookie banner
      disableCookiesUsage: true,
      // SPA-friendly: mkdocs-material uses instant loading (XHR-based
      // navigation), so we need explicit route tracking.
      enableAutoRouteTracking: true,
      // Don't capture full URLs / query strings — we only want the path.
      enableRequestHeaderTracking: false,
      enableResponseHeaderTracking: false,
      // Don't auto-correlate AJAX calls (keeps the chat widget's
      // requests off the docs analytics)
      disableFetchTracking: true,
      disableAjaxTracking: true,
      // Drop user agent; reduce fingerprintable surface
      disableExceptionTracking: false,
      // Keep telemetry sampling at 100% — bounded by App Insights cap
      samplingPercentage: 100
    }
  });

  // ── Tag every event with a "site=docs" property so chat events
  //    and docs events are easy to separate in queries ──────────────
  if (window.appInsights && window.appInsights.addTelemetryInitializer) {
    window.appInsights.addTelemetryInitializer(function (envelope) {
      try {
        var data = envelope.data || (envelope.baseData ? envelope.baseData : {});
        data.properties = data.properties || {};
        data.properties.site = "docs";
        // Strip any query strings from the page URL — paths only
        if (data.uri && typeof data.uri === "string") {
          data.uri = data.uri.split("?")[0];
        }
      } catch (_) { /* never break telemetry */ }
    });
  }
})();
