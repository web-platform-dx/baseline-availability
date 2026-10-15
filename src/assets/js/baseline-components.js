/**
 * Native Web Components for Baseline Availability:
 * - <baseline-summary-table>: Interactive enhancement for the 7-day average summary table
 * - <baseline-timeseries-chart>: Interactive SVG time-series chart (0-100% Y-axis, up to 90 days X-axis)
 *
 * Uses strict DOM creation APIs (createElement / createElementNS / textContent) without innerHTML
 * and avoids inline style attributes to comply with strict Content-Security-Policy (style-src 'self').
 */

const SVG_NS = "http://www.w3.org/2000/svg";

const COMPONENT_SCRIPT_URL =
  (document.currentScript && document.currentScript.src) ||
  document.querySelector('script[src*="baseline-components.js"]')?.src ||
  new URL("/assets/js/baseline-components.js", window.location.origin).href;

/**
 * Resolves an asset path relative to the `assets/` directory where `baseline-components.js`
 * is served (e.g. `resolveAssetUrl("js/baseline-country-breakdown.js")` ->
 * `https://web-platform-dx.github.io/baseline-availability/assets/js/baseline-country-breakdown.js`),
 * ensuring dynamic scripts and icons work under any Eleventy `pathPrefix` (such as GitHub Pages).
 * @param {string} assetSubpath Path under `assets/`, e.g. `"js/baseline-country-breakdown.js"` or `"img/baseline-widely-icon.svg"`
 * @returns {string}
 */
function resolveAssetUrl(assetSubpath) {
  const cleanSubpath = String(assetSubpath).replace(/^\/+/, "");
  return new URL(`../${cleanSubpath}`, COMPONENT_SCRIPT_URL).href;
}

/**
 * Formats a number to 2 decimal places with a "%" suffix.
 * @param {number} value
 * @returns {string}
 */
function formatPct(value) {
  return `${Number(value || 0).toFixed(2)}%`;
}

/**
 * Formats a signed percentage delta (e.g. "+0.61%" or "-0.46%").
 * @param {number} delta
 * @returns {string}
 */
function formatDelta(delta) {
  const num = Number(delta || 0);
  if (num === 0) return "0.00%";
  return `${num > 0 ? "+" : ""}${num.toFixed(2)}%`;
}

/**
 * Formats an ISO YYYY-MM-DD date string into a short human-readable label (e.g. "Sep 28").
 * @param {string} isoDate
 * @returns {string}
 */
function formatShortDate(isoDate) {
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(ms)) return isoDate;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(ms));
}

/**
 * Creates an SVG element in the SVG namespace with the given attributes.
 * @param {string} tag
 * @param {Record<string, string | number>} [attrs={}]
 * @returns {SVGElement}
 */
function createSvgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  return el;
}

/**
 * Formats a traffic share percentage for display in location pills and selectors.
 * @param {number} value
 * @returns {string}
 */
function formatTrafficShare(value) {
  const num = Number(value || 0);
  if (Number.isNaN(num) || num <= 0 || num < 0.01) return "<0.01%";
  return `${num.toFixed(2)}%`;
}

/**
 * Shared state bus between <baseline-location-filter>, <baseline-summary-table>,
 * <baseline-timeseries-chart>, and <baseline-browser-breakdown>.
 */
const viewState = {
  webviewMode: "include", // "include" (Include WebViews) | "exclude" (Exclude WebViews)
  highlightedTargetId: null,
  pinnedTargetId: null,
  breakdownTargetId: "widely",
  urlTargetId: null,
  selectedDateIndex: null,
  locationValue: "all", // "all" | "region:<M49_CODE>" | "country:<ISO_CODE>" | "custom:<KEY>"
  locationMeta: {
    kind: "global",
    code: "WW",
    name: "Worldwide",
    breadcrumb: "Worldwide",
    share: 100,
    mappedPct: null,
    countryCount: null,
    memberCountries: [],
    includedItems: [],
    excludedItems: [],
  },
};

function notifyStateChange(source) {
  window.dispatchEvent(
    new CustomEvent("baseline-view-state", {
      detail: { ...viewState, source },
    })
  );
}

const regionInitialCache = new Map();
const regionBreakdownCache = new Map();

function round2(val) {
  return Math.round(val * 100) / 100;
}

function round4(val) {
  return Math.round(val * 10000) / 10000;
}

function meanRound2(arr) {
  if (!arr || arr.length === 0) return 0;
  return round2(arr.reduce((a, b) => a + b, 0) / arr.length);
}

/**
 * Derives `series.pctNoWv`, `avg7.pctNoWv`, and `avg7.deltaNoWv` at runtime from
 * each target's existing `pct`, `androidWv`, and `iosWv` series.
 * @param {any} data
 */
function ensureNonWebviewSeries(data) {
  if (!data || !Array.isArray(data.targets) || data._noWvComputed) {
    return data;
  }
  const dayCount = data.dayCount || (Array.isArray(data.dates) ? data.dates.length : 0);
  const recentWindowDays = data.recentWindowDays || Math.min(7, dayCount);

  const nonWvMappedShare = new Array(dayCount).fill(100);
  for (let d = 0; d < dayCount; d++) {
    let maxWvPctOfMapped = 0;
    for (const t of data.targets) {
      const p = Number(t.series?.pct?.[d] || 0);
      const wvShareOfCompat =
        Number(t.series?.androidWv?.[d] || 0) + Number(t.series?.iosWv?.[d] || 0);
      const wvPctOfMapped = (p * wvShareOfCompat) / 100;
      if (wvPctOfMapped > maxWvPctOfMapped) {
        maxWvPctOfMapped = wvPctOfMapped;
      }
    }
    nonWvMappedShare[d] = Math.max(0, 100 - maxWvPctOfMapped);
  }

  const recentMapped = Array.isArray(data.mappedPct)
    ? data.mappedPct.slice(-recentWindowDays)
    : [];
  const activeRecentIdx = [];
  for (let i = 0; i < recentMapped.length; i++) {
    if (recentMapped[i] > 0) activeRecentIdx.push(i);
  }
  const pickActive = (arr) =>
    activeRecentIdx.length > 0 ? activeRecentIdx.map((i) => arr[i]) : arr;

  for (const t of data.targets) {
    const pctNoWv = [];
    for (let d = 0; d < dayCount; d++) {
      const denom = nonWvMappedShare[d];
      if (denom <= 0) {
        pctNoWv.push(0);
        continue;
      }
      const p = Number(t.series?.pct?.[d] || 0);
      const wvShareOfCompat =
        Number(t.series?.androidWv?.[d] || 0) + Number(t.series?.iosWv?.[d] || 0);
      const nonWvCompatPctOfMapped = p * (1 - wvShareOfCompat / 100);
      pctNoWv.push(
        round2(Math.min(100, Math.max(0, (nonWvCompatPctOfMapped / denom) * 100)))
      );
    }
    t.series.pctNoWv = pctNoWv;
    const rnw = pickActive(pctNoWv.slice(-recentWindowDays));
    t.avg7.pctNoWv = meanRound2(rnw);
    t.avg7.deltaNoWv = rnw.length > 1 ? round2(rnw[rnw.length - 1] - rnw[0]) : 0;
  }

  data._noWvComputed = true;
  return data;
}

/**
 * Derives `pctNoWv` at runtime for each browser entry in a breakdown payload by
 * excluding `webview_android` and re-normalizing the remaining mapped traffic shares to 100%.
 * @param {any} breakdownData
 */
function ensureNonWebviewBreakdown(breakdownData) {
  if (
    !breakdownData ||
    !Array.isArray(breakdownData.browsers) ||
    breakdownData._noWvComputed
  ) {
    return breakdownData;
  }

  const isWebviewEntry = (b) =>
    b.browser === "webview_android" || (b.onIos && b.name === "Mobile Safari Webview");

  let nonWvPctSum = 0;
  for (const b of breakdownData.browsers) {
    if (!isWebviewEntry(b)) {
      nonWvPctSum += Number(b.pct || 0);
    }
  }

  for (const b of breakdownData.browsers) {
    if (isWebviewEntry(b)) {
      b.pctNoWv = 0;
    } else {
      b.pctNoWv =
        nonWvPctSum > 0 ? round4((Number(b.pct || 0) / nonWvPctSum) * 100) : 0;
    }
  }

  breakdownData._noWvComputed = true;
  return breakdownData;
}

/**
 * Computes the daily time-series & 7-day summary for a region or custom country set from its member countries.
 * @param {string} cacheKey
 * @param {typeof viewState.locationMeta} meta
 */
function computeRegionInitialData(cacheKey, meta) {
  if (regionInitialCache.has(cacheKey)) {
    return regionInitialCache.get(cacheKey);
  }
  const cData = window.BASELINE_COUNTRY_DATA;
  if (!cData || typeof cData.getCountry !== "function") {
    return ensureNonWebviewSeries(window.BASELINE_INITIAL_DATA || null);
  }

  const memberCodes = Array.isArray(meta.memberCountries) ? meta.memberCountries : [];
  const memberObjs = memberCodes.map((cc) => cData.getCountry(cc)).filter(Boolean);
  if (memberObjs.length === 0) {
    const fallback = window.BASELINE_INITIAL_DATA;
    if (!fallback) return null;
    const emptyDayCount = fallback.dayCount || fallback.dates.length;
    const zeroes = new Array(emptyDayCount).fill(0);
    const emptyResult = ensureNonWebviewSeries({
      code: cacheKey,
      name: meta.name,
      share: 0,
      dates: fallback.dates,
      startDate: fallback.startDate,
      endDate: fallback.endDate,
      dayCount: emptyDayCount,
      recentWindowDays: fallback.recentWindowDays,
      mappedPct: zeroes,
      targets: fallback.targets.map((t) => ({
        id: t.id,
        key: t.key,
        label: t.label,
        kind: t.kind,
        year: t.year,
        avg7: { pct: 0, pctTotal: 0, androidWv: 0, iosWv: 0, delta: 0 },
        series: { pct: [...zeroes], pctTotal: [...zeroes], androidWv: [...zeroes], iosWv: [...zeroes] },
      })),
    });
    regionInitialCache.set(cacheKey, emptyResult);
    return emptyResult;
  }

  const sample = memberObjs[0];
  const { dates, startDate, endDate, dayCount, recentWindowDays } = sample;
  const rawShareSum = memberObjs.reduce((acc, c) => acc + Number(c.share || 0), 0);
  const getWeight = (c) => (rawShareSum > 0 ? Number(c.share || 0) : 1);

  const mappedPct = [];
  const dayTotalWeights = [];
  const dayMappedWeights = [];

  for (let d = 0; d < dayCount; d++) {
    let totalW = 0;
    let mappedW = 0;
    for (const c of memberObjs) {
      const m = Number(c.mappedPct?.[d] || 0);
      if (m > 0) {
        const w = getWeight(c);
        totalW += w;
        mappedW += w * (m / 100);
      }
    }
    dayTotalWeights.push(totalW);
    dayMappedWeights.push(mappedW);
    mappedPct.push(totalW > 0 ? round2((mappedW / totalW) * 100) : 0);
  }

  const recentMapped = mappedPct.slice(-recentWindowDays);
  const activeRecentIdx = [];
  for (let i = 0; i < recentMapped.length; i++) {
    if (recentMapped[i] > 0) activeRecentIdx.push(i);
  }
  const pickActive = (arr) =>
    activeRecentIdx.length > 0 ? activeRecentIdx.map((i) => arr[i]) : arr;

  const targets = sample.targets.map((sampleTarget, tIdx) => {
    const pct = [];
    const pctTotal = [];
    const androidWv = [];
    const iosWv = [];

    for (let d = 0; d < dayCount; d++) {
      const totalW = dayTotalWeights[d];
      const mappedW = dayMappedWeights[d];
      let compatW = 0;
      let compatTotalW = 0;
      let androidWvW = 0;
      let iosWvW = 0;

      for (const c of memberObjs) {
        const m = Number(c.mappedPct?.[d] || 0);
        if (m <= 0) continue;
        const w = getWeight(c);
        const mW = w * (m / 100);
        const t = c.targets?.[tIdx];
        if (!t) continue;
        const p = Number(t.series.pct?.[d] || 0);
        const pt = Number(t.series.pctTotal?.[d] || 0);
        const awv = Number(t.series.androidWv?.[d] || 0);
        const iwv = Number(t.series.iosWv?.[d] || 0);
        const cW = mW * (p / 100);

        compatW += cW;
        compatTotalW += w * (pt / 100);
        androidWvW += cW * (awv / 100);
        iosWvW += cW * (iwv / 100);
      }

      pct.push(mappedW > 0 ? round2((compatW / mappedW) * 100) : 0);
      pctTotal.push(totalW > 0 ? round2((compatTotalW / totalW) * 100) : 0);
      androidWv.push(compatW > 0 ? round2((androidWvW / compatW) * 100) : 0);
      iosWv.push(compatW > 0 ? round2((iosWvW / compatW) * 100) : 0);
    }

    const rp = pickActive(pct.slice(-recentWindowDays));
    const rt = pickActive(pctTotal.slice(-recentWindowDays));
    const ra = pickActive(androidWv.slice(-recentWindowDays));
    const ri = pickActive(iosWv.slice(-recentWindowDays));

    return {
      id: sampleTarget.id,
      key: sampleTarget.key,
      label: sampleTarget.label,
      kind: sampleTarget.kind,
      year: sampleTarget.year,
      avg7: {
        pct: meanRound2(rp),
        pctTotal: meanRound2(rt),
        androidWv: meanRound2(ra),
        iosWv: meanRound2(ri),
        delta: rp.length > 1 ? round2(rp[rp.length - 1] - rp[0]) : 0,
      },
      series: { pct, pctTotal, androidWv, iosWv },
    };
  });

  const result = ensureNonWebviewSeries({
    code: cacheKey,
    name: meta.name,
    share: meta.share,
    dates,
    startDate,
    endDate,
    dayCount,
    recentWindowDays,
    mappedPct,
    targets,
  });
  regionInitialCache.set(cacheKey, result);
  return result;
}

let isCountryDataScriptLoading = false;
let isCountryBreakdownScriptLoading = false;

function pageHasTimeSeriesComponents() {
  return Boolean(
    document.querySelector("baseline-summary-table, baseline-timeseries-chart")
  );
}

/**
 * Lazily loads `assets/js/baseline-country-data.js` (per-country 90-day time-series)
 * only when needed on the Baseline stats page. Never loaded on the Features page.
 */
function ensureCountryDataScriptLoaded() {
  if (!pageHasTimeSeriesComponents()) return;
  if (window.BASELINE_COUNTRY_DATA || isCountryDataScriptLoading) return;
  isCountryDataScriptLoading = true;
  const script = document.createElement("script");
  script.src = resolveAssetUrl("js/baseline-country-data.js");
  script.async = true;
  script.addEventListener("error", () => {
    isCountryDataScriptLoading = false;
  });
  document.head.appendChild(script);
}

/**
 * Lazily loads `assets/js/baseline-country-breakdown.js` (per-country 7-day browser breakdown)
 * only when the user interacts with the location filter or visits a URL with location parameters.
 */
function ensureCountryBreakdownScriptLoaded() {
  if (window.BASELINE_COUNTRY_BREAKDOWN || isCountryBreakdownScriptLoading) return;
  isCountryBreakdownScriptLoading = true;
  const script = document.createElement("script");
  script.src = resolveAssetUrl("js/baseline-country-breakdown.js");
  script.async = true;
  script.addEventListener("error", () => {
    isCountryBreakdownScriptLoading = false;
  });
  document.head.appendChild(script);
}

/**
 * Preloads the country bundle(s) required by the current page view when the user
 * interacts with `<baseline-location-filter>` or loads a non-Worldwide URL.
 * - On `/features/`, only `baseline-country-breakdown.js` is needed (never `baseline-country-data.js`).
 * - On `/`, both `baseline-country-data.js` and `baseline-country-breakdown.js` are loaded on demand.
 */
function preloadCountryBundlesForCurrentPage() {
  if (pageHasTimeSeriesComponents()) {
    ensureCountryDataScriptLoaded();
  }
  ensureCountryBreakdownScriptLoaded();
}

/**
 * Computes the 7-day browser compatibility breakdown for a region or custom country set from its member countries.
 * @param {string} cacheKey
 * @param {typeof viewState.locationMeta} meta
 */
function computeRegionBreakdownData(cacheKey, meta) {
  if (regionBreakdownCache.has(cacheKey)) {
    return regionBreakdownCache.get(cacheKey);
  }
  const bData = window.BASELINE_COUNTRY_BREAKDOWN;
  if (!bData || typeof bData.getCountry !== "function") {
    ensureCountryBreakdownScriptLoaded();
    return ensureNonWebviewBreakdown(window.BASELINE_BROWSER_BREAKDOWN || null);
  }

  const shareByCountry = new Map();
  const cData = window.BASELINE_COUNTRY_DATA;
  if (cData && Array.isArray(cData.countries)) {
    for (const c of cData.countries) {
      shareByCountry.set(c.code, Number(c.share || 0));
    }
  }

  const memberCodes = Array.isArray(meta.memberCountries) ? meta.memberCountries : [];
  const entries = [];
  for (const cc of memberCodes) {
    const breakdown = bData.getCountry(cc);
    if (breakdown) {
      const share =
        breakdown.share !== undefined
          ? Number(breakdown.share)
          : shareByCountry.get(cc) ?? 0;
      entries.push({
        cc,
        breakdown,
        share,
      });
    }
  }

  if (entries.length === 0) {
    const emptyBreakdown = ensureNonWebviewBreakdown({
      code: cacheKey,
      name: meta.name,
      windowDays: bData.windowDays,
      startDate: bData.startDate,
      endDate: bData.endDate,
      mappedPercentage: 0,
      targets: bData.targets,
      targetMinMaps: bData.targetMinMaps,
      browsers: [],
    });
    regionBreakdownCache.set(cacheKey, emptyBreakdown);
    return emptyBreakdown;
  }

  const rawShareSum = entries.reduce((acc, e) => acc + e.share, 0);
  const getWeight = (e) => (rawShareSum > 0 ? e.share : 1);

  let totalWeight = 0;
  let mappedWeight = 0;
  const byBrowserVer = new Map();

  for (const entry of entries) {
    const w = getWeight(entry);
    if (w <= 0) continue;
    totalWeight += w;
    const mW = w * (Number(entry.breakdown.mappedPercentage || 0) / 100);
    mappedWeight += mW;

    for (const b of entry.breakdown.browsers || []) {
      const bvKey = `${b.browser}|${b.onIos ? b.name : ""}|${b.version}`;
      const bWeight = w * (Number(b.pctTotal || 0) / 100);
      const existing = byBrowserVer.get(bvKey);
      if (existing) {
        existing.weight += bWeight;
      } else {
        byBrowserVer.set(bvKey, {
          browser: b.browser,
          name: b.name,
          version: b.version,
          onIos: Boolean(b.onIos),
          releaseDate: b.releaseDate,
          engine: b.engine,
          engineVersion: b.engineVersion,
          engineReleaseDate: b.engineReleaseDate,
          isDownstream: b.isDownstream,
          weight: bWeight,
        });
      }
    }
  }

  const browsers = [...byBrowserVer.values()]
    .sort((a, b) => b.weight - a.weight)
    .map((item) => ({
      browser: item.browser,
      name: item.name,
      version: item.version,
      onIos: item.onIos,
      releaseDate: item.releaseDate,
      engine: item.engine,
      engineVersion: item.engineVersion,
      engineReleaseDate: item.engineReleaseDate,
      isDownstream: item.isDownstream,
      pct: mappedWeight > 0 ? round4((item.weight / mappedWeight) * 100) : 0,
      pctTotal: totalWeight > 0 ? round4((item.weight / totalWeight) * 100) : 0,
    }));

  const result = ensureNonWebviewBreakdown({
    code: cacheKey,
    name: meta.name,
    windowDays: bData.windowDays,
    startDate: bData.startDate,
    endDate: bData.endDate,
    mappedPercentage: totalWeight > 0 ? round2((mappedWeight / totalWeight) * 100) : 0,
    targets: bData.targets,
    targetMinMaps: bData.targetMinMaps,
    browsers,
  });
  regionBreakdownCache.set(cacheKey, result);
  return result;
}

/**
 * Resolves the active 7-day summary & time-series payload for the current location selection.
 */
function getActiveInitialData() {
  const val = viewState.locationValue;
  if (!val || val === "all") {
    return ensureNonWebviewSeries(window.BASELINE_INITIAL_DATA || null);
  }
  if (!window.BASELINE_COUNTRY_DATA) {
    ensureCountryDataScriptLoaded();
  }
  if (val.startsWith("country:")) {
    const code = val.slice(8);
    return ensureNonWebviewSeries(
      window.BASELINE_COUNTRY_DATA?.getCountry(code) || window.BASELINE_INITIAL_DATA || null
    );
  }
  if (val.startsWith("region:")) {
    const code = val.slice(7);
    return computeRegionInitialData(code, viewState.locationMeta);
  }
  if (val.startsWith("custom:")) {
    return computeRegionInitialData(val, viewState.locationMeta);
  }
  return ensureNonWebviewSeries(window.BASELINE_INITIAL_DATA || null);
}

/**
 * Resolves the active 7-day browser compatibility breakdown payload for the current location selection.
 */
function getActiveBreakdownData() {
  const val = viewState.locationValue;
  if (!val || val === "all") {
    return ensureNonWebviewBreakdown(window.BASELINE_BROWSER_BREAKDOWN || null);
  }
  if (!window.BASELINE_COUNTRY_BREAKDOWN) {
    ensureCountryBreakdownScriptLoaded();
  }
  if (val.startsWith("country:")) {
    const code = val.slice(8);
    return ensureNonWebviewBreakdown(
      window.BASELINE_COUNTRY_BREAKDOWN?.getCountry(code) ||
        window.BASELINE_BROWSER_BREAKDOWN ||
        null
    );
  }
  if (val.startsWith("region:")) {
    const code = val.slice(7);
    return computeRegionBreakdownData(code, viewState.locationMeta);
  }
  if (val.startsWith("custom:")) {
    return computeRegionBreakdownData(val, viewState.locationMeta);
  }
  return ensureNonWebviewBreakdown(window.BASELINE_BROWSER_BREAKDOWN || null);
}

const COUNTRY_SEARCH_ALIASES = {
  US: "usa america united states",
  GB: "uk britain great britain england scotland wales northern ireland united kingdom",
  AE: "uae emirates",
  KR: "south korea rok",
  KP: "north korea dprk",
  NL: "holland netherlands",
  CZ: "czechia czech republic",
  TW: "taiwan roc",
  VN: "vietnam",
  RU: "russia",
  IR: "iran",
  SY: "syria",
  BO: "bolivia",
  VE: "venezuela",
  TZ: "tanzania",
  MD: "moldova",
  CD: "drc congo kinshasa",
  CG: "congo brazzaville",
  CI: "ivory coast cote d'ivoire",
  LA: "laos",
  MM: "myanmar burma",
  PS: "palestine",
  VA: "vatican",
  XK: "kosovo",
};

const REGION_URL_ALIASES = {
  "north-america": "021",
  "alt-af": "002",
  "alt-an": "010",
  "alt-as": "142",
  "alt-eu": "150",
  "alt-na": "021",
  "alt-oc": "009",
  "alt-sa": "005",
};

const VALID_TARGET_IDS = new Set([
  "widely",
  "newly",
  "limited",
  "2026",
  "2025",
  "2024",
  "2023",
  "2022",
  "2021",
  "2020",
  "2019",
  "2018",
  "2017",
  "2016",
  "2015",
]);

const TARGET_URL_ALIASES = {
  "widely-available": "widely",
  "baseline-widely": "widely",
  "baseline-widely-available": "widely",
  "newly-available": "newly",
  "baseline-newly": "newly",
  "baseline-newly-available": "newly",
  "limited-availability": "limited",
  "baseline-limited": "limited",
};

/**
 * Converts a location or region display name into a lowercase URL-safe slug (e.g. "Northern Europe" -> "northern-europe").
 * @param {string} name
 * @returns {string}
 */
function slugifyLocationName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Resolves a validated Baseline target ID from the `?target=` URL query parameter, or null if not set.
 * @returns {string | null}
 */
function resolveTargetFromUrl() {
  let params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return null;
  }

  const rawTarget = params.get("target");
  if (rawTarget === null) return null;

  const cleaned = rawTarget.trim().toLowerCase();
  if (!cleaned) return null;

  const normalized =
    TARGET_URL_ALIASES[cleaned] || cleaned.replace(/^baseline[-_\s]+/, "");

  if (VALID_TARGET_IDS.has(normalized)) {
    return normalized;
  }

  const dynamicTargets =
    window.BASELINE_INITIAL_DATA?.targets ||
    window.BASELINE_BROWSER_BREAKDOWN?.targets ||
    [];
  const match = dynamicTargets.find((t) => String(t.id).toLowerCase() === normalized);
  return match ? String(match.id) : null;
}

/**
 * Synchronizes navigation drawer links (`Baseline stats` and `Features`) with the current
 * shared URL query parameters (`country`, `region`, `exclude`, `target`) so switching views
 * preserves the active geographic and Baseline target filter.
 */
function syncDrawerLinksWithUrl() {
  try {
    const currentParams = new URLSearchParams(window.location.search);
    const sharedKeys = ["country", "region", "exclude", "target"];
    const sharedParams = new URLSearchParams();
    for (const key of sharedKeys) {
      const val = currentParams.get(key);
      if (val) {
        sharedParams.set(key, val);
      }
    }
    const queryStr = sharedParams.toString();
    document.querySelectorAll(".Drawer-list a.Drawer-link[href]").forEach((link) => {
      const linkUrl = new URL(link.getAttribute("href"), window.location.origin);
      linkUrl.search = queryStr ? `?${queryStr}` : "";
      link.setAttribute("href", `${linkUrl.pathname}${linkUrl.search}`);
    });
  } catch {
    // Ignore URL update errors
  }
}

/**
 * Pushes a new browser history entry reflecting the current location (`?country=`, `?region=`, `?exclude=`)
 * and selected Baseline target (`?target=`) filters so browser Back/Forward navigates through filter changes.
 */
function pushUrlState() {
  if (!window.history || typeof window.history.pushState !== "function") {
    return;
  }
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("country");
    url.searchParams.delete("region");
    url.searchParams.delete("exclude");
    url.searchParams.delete("target");

    const locVal = viewState.locationValue || "all";
    const locMeta = viewState.locationMeta || {};
    if (locVal !== "all") {
      const incItems = Array.isArray(locMeta.includedItems) ? locMeta.includedItems : [];
      const excItems = Array.isArray(locMeta.excludedItems) ? locMeta.excludedItems : [];

      const incCountries = incItems
        .filter((it) => it.kind === "country" && it.code)
        .map((it) => it.code);
      const incRegions = incItems
        .filter((it) => it.kind === "region")
        .map((it) => slugifyLocationName(it.name) || it.code)
        .filter(Boolean);
      const excTokens = excItems
        .map((it) => (it.kind === "country" ? it.code : slugifyLocationName(it.name) || it.code))
        .filter(Boolean);

      if (incCountries.length > 0) {
        url.searchParams.set("country", incCountries.join(","));
      }
      if (incRegions.length > 0) {
        url.searchParams.set("region", incRegions.join(","));
      }
      if (excTokens.length > 0) {
        url.searchParams.set("exclude", excTokens.join(","));
      }
    }

    if (viewState.urlTargetId) {
      url.searchParams.set("target", viewState.urlTargetId);
    }

    const nextHref = url.toString();
    if (nextHref !== window.location.href) {
      window.history.pushState(
        {
          locationValue: viewState.locationValue,
          targetId: viewState.urlTargetId,
        },
        "",
        nextHref
      );
    }
    syncDrawerLinksWithUrl();
  } catch {
    // Ignore URL update errors in restricted environments
  }
}

const initialUrlTargetId = resolveTargetFromUrl();
if (initialUrlTargetId) {
  viewState.urlTargetId = initialUrlTargetId;
  viewState.pinnedTargetId = initialUrlTargetId;
  viewState.highlightedTargetId = initialUrlTargetId;
  viewState.breakdownTargetId = initialUrlTargetId;
}

/**
 * <baseline-location-filter>:
 * Accessible WAI-ARIA 1.2 searchable combobox and grouped listbox for filtering
 * Baseline availability by Worldwide, Region / Sub-Region, or Country.
 */
class BaselineLocationFilter extends HTMLElement {
  connectedCallback() {
    this.wrapEl = this.querySelector("[data-combobox-wrap]");
    this.inputEl = this.querySelector("#location-combobox-input");
    this.clearSearchBtn = this.querySelector("[data-clear-search-btn]");
    this.toggleBtn = this.querySelector("[data-toggle-listbox-btn]");
    this.listboxEl = this.querySelector("#location-listbox");
    this.emptyStateEl = this.querySelector("[data-location-empty]");
    this.resetBtn = this.querySelector("#location-reset-btn");
    this.breadcrumbEl = this.querySelector("[data-location-breadcrumb]");
    this.chipsEl = this.querySelector("[data-location-chips]");
    this.liveRegion = this.querySelector("[data-location-live-region]");

    if (!this.inputEl || !this.listboxEl) return;

    this.groupEls = Array.from(this.listboxEl.querySelectorAll("[data-location-group]"));
    this.optionEls = Array.from(this.listboxEl.querySelectorAll(".location-option"));

    this.optionByValue = new Map();
    this.countryOptByCode = new Map();
    for (const opt of this.optionEls) {
      if (opt.dataset.value) {
        this.optionByValue.set(opt.dataset.value, opt);
      }
      if (opt.dataset.kind === "country" && opt.dataset.code) {
        this.countryOptByCode.set(opt.dataset.code, opt);
      }
    }
    this.allCountryCodes = Array.from(this.countryOptByCode.keys());
    this.allOpt = this.optionByValue.get("all") || this.optionEls[0] || null;

    this.includedMap = new Map();
    this.excludedMap = new Map();

    this.selectedOption = this.allOpt;
    this.activeOption = this.selectedOption;
    this.isOpen = false;
    this.justFocused = false;

    this.onInputFocus = () => {
      this.justFocused = true;
      this.openListbox(true);
      this.inputEl.select();
    };

    this.onInputMouseUp = (e) => {
      if (this.justFocused) {
        e.preventDefault();
        this.justFocused = false;
      }
    };

    this.onInputClick = () => {
      if (!this.isOpen) {
        this.openListbox(true);
        this.inputEl.select();
      }
    };

    this.onInput = () => {
      const val = this.inputEl.value;
      if (this.clearSearchBtn) {
        this.clearSearchBtn.hidden = val.length === 0;
      }
      if (!this.isOpen) {
        this.openListbox(false);
      }
      this.filterOptions(val);
    };

    this.onInputKeyDown = (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!this.isOpen) {
          this.openListbox(true);
        } else {
          this.moveActive(1);
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (!this.isOpen) {
          this.openListbox(true);
        } else {
          this.moveActive(-1);
        }
      } else if (e.key === "PageDown" && this.isOpen) {
        e.preventDefault();
        this.moveActive(8);
      } else if (e.key === "PageUp" && this.isOpen) {
        e.preventDefault();
        this.moveActive(-8);
      } else if (e.key === "Enter") {
        if (this.isOpen && this.activeOption && !this.activeOption.hidden) {
          e.preventDefault();
          if (e.shiftKey || e.altKey) {
            this.toggleOptionMode(this.activeOption, "exclude", true);
            if (this.isOpen && this.inputEl.value) {
              this.inputEl.select();
            }
          } else {
            this.selectSingleOption(this.activeOption, true);
          }
        }
      } else if (e.key === "Escape") {
        if (this.isOpen) {
          e.preventDefault();
          this.closeListbox(true);
        } else {
          this.syncInputToSelected();
        }
      } else if (e.key === "Tab") {
        if (this.isOpen) {
          this.closeListbox(true);
        }
      }
    };

    this.onClearMouseDown = (e) => {
      e.preventDefault();
      this.inputEl.value = "";
      if (this.clearSearchBtn) {
        this.clearSearchBtn.hidden = true;
      }
      if (!this.isOpen) {
        this.openListbox(false);
      }
      this.filterOptions("");
      this.inputEl.focus();
    };

    this.onToggleMouseDown = (e) => {
      e.preventDefault();
      if (this.isOpen) {
        this.closeListbox(true);
      } else {
        this.inputEl.focus();
        this.openListbox(true);
        this.inputEl.select();
      }
    };

    this.onListboxMouseDown = (e) => {
      // Keep focus on input while interacting with the listbox
      e.preventDefault();
      const actionBtn = e.target.closest("[data-opt-action]");
      const opt = e.target.closest(".location-option");
      if (!opt || opt.hidden) return;

      if (opt.dataset.value === "all" || !actionBtn) {
        this.selectSingleOption(opt, true);
        return;
      }

      const mode =
        actionBtn.dataset.optAction === "exclude" ? "exclude" : "include";
      this.toggleOptionMode(opt, mode, true);
      if (this.isOpen && this.inputEl.value) {
        this.inputEl.select();
      }
    };

    this.onListboxMouseMove = (e) => {
      const opt = e.target.closest(".location-option");
      if (opt && !opt.hidden && opt !== this.activeOption) {
        this.setActiveOption(opt, false);
      }
    };

    this.onDocumentMouseDown = (e) => {
      if (this.isOpen && !this.contains(e.target)) {
        this.closeListbox(true);
      }
    };

    this.onResetClick = () => {
      if (this.allOpt) {
        this.includedMap.clear();
        this.excludedMap.clear();
        this.setActiveOption(this.allOpt, false);
        this.applySelectionState(true, true);
        this.closeListbox(true);
        this.inputEl.focus();
      }
    };

    this.onPopState = () => {
      const urlTarget = resolveTargetFromUrl();
      viewState.urlTargetId = urlTarget;
      viewState.pinnedTargetId = urlTarget;
      viewState.highlightedTargetId = urlTarget;
      viewState.breakdownTargetId = urlTarget || "widely";

      this.applySelectionFromUrl(true, false);

      if (this.isOpen) {
        this.closeListbox(true);
      }
    };

    this.onCountryDataReady = () => {
      if (viewState.locationValue !== "all") {
        regionInitialCache.clear();
        this.applySelectionState(false, false);
      }
    };

    this.onCountryBreakdownReady = () => {
      if (viewState.locationValue !== "all") {
        regionBreakdownCache.clear();
        notifyStateChange("location-filter");
        window.dispatchEvent(
          new CustomEvent("baseline:location-change", {
            detail: {
              value: viewState.locationValue,
              meta: viewState.locationMeta,
            },
          })
        );
      }
    };

    this.webviewBtns = Array.from(this.querySelectorAll("button[data-webview-mode]"));
    this.syncWebviewButtons = () => {
      this.webviewBtns.forEach((btn) => {
        const isSelected = btn.getAttribute("data-webview-mode") === viewState.webviewMode;
        btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
      });
    };

    this.onViewStateChange = () => {
      this.syncWebviewButtons();
    };

    this.onWebviewModeEvent = (e) => {
      const mode = e.detail?.mode;
      if ((mode === "include" || mode === "exclude") && viewState.webviewMode !== mode) {
        viewState.webviewMode = mode;
      }
      this.syncWebviewButtons();
    };

    this.webviewBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-webview-mode");
        if ((mode !== "include" && mode !== "exclude") || mode === viewState.webviewMode) {
          return;
        }
        viewState.webviewMode = mode;
        this.syncWebviewButtons();
        notifyStateChange("webview-mode");
        window.dispatchEvent(
          new CustomEvent("baseline:webview-mode-change", {
            detail: { mode },
          })
        );
      });
    });

    this.inputEl.addEventListener("focus", this.onInputFocus);
    this.inputEl.addEventListener("mouseup", this.onInputMouseUp);
    this.inputEl.addEventListener("click", this.onInputClick);
    this.inputEl.addEventListener("input", this.onInput);
    this.inputEl.addEventListener("keydown", this.onInputKeyDown);
    if (this.clearSearchBtn) {
      this.clearSearchBtn.addEventListener("mousedown", this.onClearMouseDown);
    }
    if (this.toggleBtn) {
      this.toggleBtn.addEventListener("mousedown", this.onToggleMouseDown);
    }
    this.listboxEl.addEventListener("mousedown", this.onListboxMouseDown);
    this.listboxEl.addEventListener("mousemove", this.onListboxMouseMove);
    document.addEventListener("mousedown", this.onDocumentMouseDown);
    if (this.resetBtn) {
      this.resetBtn.addEventListener("mousedown", (e) => e.preventDefault());
      this.resetBtn.addEventListener("click", this.onResetClick);
    }
    window.addEventListener("popstate", this.onPopState);
    window.addEventListener("baseline-country-data-ready", this.onCountryDataReady);
    window.addEventListener("baseline-country-breakdown-ready", this.onCountryBreakdownReady);
    window.addEventListener("baseline-view-state", this.onViewStateChange);
    window.addEventListener("baseline:webview-mode-change", this.onWebviewModeEvent);

    this.syncWebviewButtons();

    if (this.hasLocationParamsInUrl()) {
      preloadCountryBundlesForCurrentPage();
      this.applySelectionFromUrl(false, false);
    }
  }

  disconnectedCallback() {
    if (this.inputEl) {
      this.inputEl.removeEventListener("focus", this.onInputFocus);
      this.inputEl.removeEventListener("mouseup", this.onInputMouseUp);
      this.inputEl.removeEventListener("click", this.onInputClick);
      this.inputEl.removeEventListener("input", this.onInput);
      this.inputEl.removeEventListener("keydown", this.onInputKeyDown);
    }
    if (this.clearSearchBtn && this.onClearMouseDown) {
      this.clearSearchBtn.removeEventListener("mousedown", this.onClearMouseDown);
    }
    if (this.toggleBtn && this.onToggleMouseDown) {
      this.toggleBtn.removeEventListener("mousedown", this.onToggleMouseDown);
    }
    if (this.listboxEl) {
      this.listboxEl.removeEventListener("mousedown", this.onListboxMouseDown);
      this.listboxEl.removeEventListener("mousemove", this.onListboxMouseMove);
    }
    document.removeEventListener("mousedown", this.onDocumentMouseDown);
    if (this.resetBtn && this.onResetClick) {
      this.resetBtn.removeEventListener("click", this.onResetClick);
    }
    window.removeEventListener("popstate", this.onPopState);
    window.removeEventListener("baseline-country-data-ready", this.onCountryDataReady);
    window.removeEventListener("baseline-country-breakdown-ready", this.onCountryBreakdownReady);
    window.removeEventListener("baseline-view-state", this.onViewStateChange);
    window.removeEventListener("baseline:webview-mode-change", this.onWebviewModeEvent);
  }

  getSelectedDisplayLabel() {
    if (this.includedMap.size === 0 && this.excludedMap.size === 0) {
      return "Worldwide (All Regions & Countries)";
    }
    if (this.includedMap.size === 1 && this.excludedMap.size === 0) {
      const onlyOpt = Array.from(this.includedMap.values())[0];
      return (
        onlyOpt.dataset.displayLabel ||
        onlyOpt.dataset.name ||
        "Worldwide"
      );
    }
    const meta = viewState.locationMeta;
    if (meta && meta.name) {
      const shareStr = formatTrafficShare(meta.share || 0);
      return `${meta.name} — ${shareStr}`;
    }
    return "Worldwide (All Regions & Countries)";
  }

  syncInputToSelected() {
    this.inputEl.value = this.getSelectedDisplayLabel();
    if (this.clearSearchBtn) {
      this.clearSearchBtn.hidden = true;
    }
  }

  openListbox(resetFilter = false) {
    preloadCountryBundlesForCurrentPage();
    this.isOpen = true;
    this.listboxEl.hidden = false;
    this.inputEl.setAttribute("aria-expanded", "true");
    if (this.wrapEl) {
      this.wrapEl.classList.add("is-open");
    }
    if (resetFilter) {
      this.filterOptions("");
      if (this.clearSearchBtn) {
        this.clearSearchBtn.hidden = this.inputEl.value.length === 0;
      }
    }
  }

  closeListbox(restoreInput = true) {
    this.isOpen = false;
    this.listboxEl.hidden = true;
    this.inputEl.setAttribute("aria-expanded", "false");
    this.inputEl.setAttribute("aria-activedescendant", "");
    if (this.wrapEl) {
      this.wrapEl.classList.remove("is-open");
    }
    if (restoreInput) {
      this.syncInputToSelected();
    }
  }

  setActiveOption(opt, scrollIntoView = true) {
    if (this.activeOption) {
      this.activeOption.classList.remove("is-active");
    }
    this.activeOption = opt || null;
    if (this.activeOption) {
      this.activeOption.classList.add("is-active");
      this.inputEl.setAttribute("aria-activedescendant", this.activeOption.id || "");
      if (scrollIntoView) {
        this.activeOption.scrollIntoView({ block: "nearest" });
      }
    } else {
      this.inputEl.setAttribute("aria-activedescendant", "");
    }
  }

  getVisibleOptions() {
    return this.optionEls.filter((opt) => !opt.hidden);
  }

  moveActive(delta) {
    const visible = this.getVisibleOptions();
    if (visible.length === 0) return;

    const currentIdx = this.activeOption ? visible.indexOf(this.activeOption) : -1;
    let nextIdx;
    if (currentIdx === -1) {
      nextIdx = delta > 0 ? 0 : visible.length - 1;
    } else {
      nextIdx = Math.max(0, Math.min(visible.length - 1, currentIdx + delta));
    }
    this.setActiveOption(visible[nextIdx], true);
  }

  scoreOptionMatch(opt, q) {
    const kind = opt.dataset.kind || "global";
    const name = (opt.dataset.name || "").toLowerCase();
    const code = (opt.dataset.code || "").toLowerCase();
    const breadcrumb = (opt.dataset.breadcrumb || "").toLowerCase();
    const share = Number(opt.dataset.share || 0);
    const aliases =
      kind === "country"
        ? COUNTRY_SEARCH_ALIASES[opt.dataset.code] || ""
        : kind === "global"
          ? "global world all worldwide"
          : "";

    if (kind === "country" && code === q) return 1000 + share;
    if (name === q) return 950 + share;
    if (aliases && aliases.split(" ").includes(q)) return 900 + share;
    if (name.startsWith(q)) return 800 + share;

    const words = name.split(/[\s,()-]+/);
    if (words.some((w) => w.startsWith(q))) return 700 + share;
    if (aliases && aliases.includes(q)) return 650 + share;
    if (name.includes(q)) return 600 + share;
    if (kind === "country" && code.includes(q)) return 550 + share;
    if (q.length >= 2 && breadcrumb.includes(q)) return 400 + share;

    return -1;
  }

  filterOptions(rawQuery) {
    const q = (rawQuery || "").trim().toLowerCase();

    if (!q) {
      for (const opt of this.optionEls) {
        opt.hidden = false;
      }
      for (const group of this.groupEls) {
        group.hidden = false;
      }
      if (this.emptyStateEl) {
        this.emptyStateEl.hidden = true;
      }
      this.setActiveOption(this.selectedOption || this.optionEls[0], true);
      return;
    }

    let bestOpt = null;
    let bestScore = -1;
    let totalVisible = 0;

    for (const opt of this.optionEls) {
      const score = this.scoreOptionMatch(opt, q);
      if (score >= 0) {
        opt.hidden = false;
        totalVisible += 1;
        if (score > bestScore) {
          bestScore = score;
          bestOpt = opt;
        }
      } else {
        opt.hidden = true;
      }
    }

    for (const group of this.groupEls) {
      const hasVisible = group.querySelector(".location-option:not([hidden])") !== null;
      group.hidden = !hasVisible;
    }

    if (this.emptyStateEl) {
      this.emptyStateEl.hidden = totalVisible > 0;
    }

    this.setActiveOption(bestOpt, true);
  }

  getOptionCountryCodes(opt) {
    if (!opt) return [];
    const kind = opt.dataset.kind;
    if (kind === "country") {
      return opt.dataset.code ? [opt.dataset.code] : [];
    }
    if (kind === "region") {
      return opt.dataset.memberCountries
        ? opt.dataset.memberCountries.split(",").filter(Boolean)
        : [];
    }
    return [];
  }

  resolveCountryToken(token) {
    const cleaned = (token || "").trim();
    if (!cleaned) return null;
    const lower = cleaned.toLowerCase();
    if (lower === "all" || lower === "ww" || lower === "worldwide") {
      return this.allOpt;
    }
    const upperCode = lower === "uk" ? "GB" : cleaned.toUpperCase();
    const byCode = this.countryOptByCode.get(upperCode);
    if (byCode) return byCode;

    const slug = slugifyLocationName(cleaned);
    if (slug) {
      const bySlug = this.optionEls.find(
        (opt) =>
          opt.dataset.kind === "country" &&
          slugifyLocationName(opt.dataset.name) === slug
      );
      if (bySlug) return bySlug;
    }
    return null;
  }

  resolveRegionToken(token) {
    const cleaned = (token || "").trim();
    if (!cleaned) return null;
    const lower = cleaned.toLowerCase();
    if (lower === "all" || lower === "ww" || lower === "worldwide") {
      return this.allOpt;
    }
    const slug = slugifyLocationName(cleaned);
    const aliasCode = REGION_URL_ALIASES[lower] || REGION_URL_ALIASES[slug];
    const paddedM49 = /^\d{1,3}$/.test(cleaned) ? cleaned.padStart(3, "0") : null;
    const targetCode = aliasCode || paddedM49;

    if (targetCode) {
      const byCode = this.optionByValue.get(`region:${targetCode}`);
      if (byCode) return byCode;
    }

    if (slug) {
      const bySlug = this.optionEls.find(
        (opt) =>
          opt.dataset.kind === "region" &&
          slugifyLocationName(opt.dataset.name) === slug
      );
      if (bySlug) return bySlug;
    }
    return null;
  }

  resolveAnyLocationToken(token) {
    const cleaned = (token || "").trim();
    if (!cleaned) return null;
    if (/^[A-Za-z]{2}$/.test(cleaned)) {
      const countryOpt = this.resolveCountryToken(cleaned);
      if (countryOpt) return countryOpt;
    }
    const regionOpt = this.resolveRegionToken(cleaned);
    if (regionOpt) return regionOpt;
    return this.resolveCountryToken(cleaned);
  }

  hasLocationParamsInUrl() {
    try {
      const params = new URLSearchParams(window.location.search);
      return (
        params.has("country") ||
        params.has("region") ||
        params.has("exclude")
      );
    } catch {
      return false;
    }
  }

  applySelectionFromUrl(announce = false, updateUrl = false) {
    this.includedMap.clear();
    this.excludedMap.clear();

    let params;
    try {
      params = new URLSearchParams(window.location.search);
    } catch {
      this.applySelectionState(announce, updateUrl);
      return;
    }

    const rawRegion = params.get("region");
    if (rawRegion) {
      for (const token of rawRegion.split(",")) {
        const opt = this.resolveRegionToken(token);
        if (opt && opt.dataset.value && opt.dataset.value !== "all") {
          this.includedMap.set(opt.dataset.value, opt);
        }
      }
    }

    const rawCountry = params.get("country");
    if (rawCountry) {
      for (const token of rawCountry.split(",")) {
        const opt = this.resolveCountryToken(token);
        if (opt && opt.dataset.value && opt.dataset.value !== "all") {
          this.includedMap.set(opt.dataset.value, opt);
        }
      }
    }

    const rawExclude = params.get("exclude");
    if (rawExclude) {
      for (const token of rawExclude.split(",")) {
        const opt = this.resolveAnyLocationToken(token);
        if (opt && opt.dataset.value && opt.dataset.value !== "all") {
          this.includedMap.delete(opt.dataset.value);
          this.excludedMap.set(opt.dataset.value, opt);
        }
      }
    }

    this.applySelectionState(announce, updateUrl);
  }

  selectSingleOption(opt, announce = true) {
    if (!opt) return;
    const val = opt.dataset.value || "all";

    this.includedMap.clear();
    this.excludedMap.clear();
    if (val !== "all") {
      this.includedMap.set(val, opt);
    }
    this.setActiveOption(val === "all" ? this.allOpt : opt, false);
    this.closeListbox(false);
    this.applySelectionState(announce, true);
  }

  toggleOptionMode(opt, mode = "include", announce = true) {
    if (!opt) return;
    const val = opt.dataset.value || "all";

    if (val === "all") {
      this.selectSingleOption(opt, announce);
      return;
    }

    if (mode === "exclude") {
      if (this.excludedMap.has(val)) {
        this.excludedMap.delete(val);
      } else {
        this.includedMap.delete(val);
        this.excludedMap.set(val, opt);
      }
    } else {
      if (this.includedMap.has(val)) {
        this.includedMap.delete(val);
      } else {
        this.excludedMap.delete(val);
        this.includedMap.set(val, opt);
      }
    }

    this.setActiveOption(opt, false);
    this.applySelectionState(announce, true);
  }

  createStatusIconSvg(mode) {
    const svg = createSvgEl("svg", {
      width: "10",
      height: "10",
      viewBox: "0 0 14 14",
      fill: "none",
      "aria-hidden": "true",
    });
    const path = createSvgEl("path", {
      d: mode === "exclude" ? "M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5" : "M2.5 7.25L5.5 10.25L11.5 3.75",
      stroke: "currentColor",
      "stroke-width": "2.2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    });
    svg.appendChild(path);
    return svg;
  }

  createRemoveIconSvg() {
    const svg = createSvgEl("svg", {
      width: "10",
      height: "10",
      viewBox: "0 0 14 14",
      fill: "none",
      "aria-hidden": "true",
    });
    const path = createSvgEl("path", {
      d: "M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
    });
    svg.appendChild(path);
    return svg;
  }

  renderActiveChips(includedItems, excludedItems) {
    if (!this.chipsEl) return;

    const fragment = document.createDocumentFragment();

    if (includedItems.length === 0 && excludedItems.length === 0) {
      const globalChip = document.createElement("span");
      globalChip.className = "location-chip location-chip-global";

      const iconWrap = document.createElement("span");
      iconWrap.className = "location-chip-status-icon";
      iconWrap.appendChild(this.createStatusIconSvg("include"));
      globalChip.appendChild(iconWrap);

      const labelEl = document.createElement("span");
      labelEl.className = "location-chip-label";
      labelEl.textContent = "Worldwide (All Regions & Countries)";
      globalChip.appendChild(labelEl);

      const shareEl = document.createElement("span");
      shareEl.className = "location-chip-share";
      shareEl.textContent = "100.00%";
      globalChip.appendChild(shareEl);

      fragment.appendChild(globalChip);
      this.chipsEl.replaceChildren(fragment);
      this.chipsEl.hidden = false;
      return;
    }

    const buildChip = (item, mode) => {
      const chip = document.createElement("span");
      chip.className = `location-chip location-chip-${mode}`;

      const iconWrap = document.createElement("span");
      iconWrap.className = "location-chip-status-icon";
      iconWrap.appendChild(this.createStatusIconSvg(mode));
      chip.appendChild(iconWrap);

      const labelEl = document.createElement("span");
      labelEl.className = "location-chip-label";
      const displayCode = item.kind === "country" ? ` (${item.code})` : "";
      labelEl.textContent =
        mode === "exclude"
          ? `Excluded: ${item.name}${displayCode}`
          : `${item.name}${displayCode}`;
      chip.appendChild(labelEl);

      const shareEl = document.createElement("span");
      shareEl.className = "location-chip-share";
      shareEl.textContent = formatTrafficShare(item.share);
      chip.appendChild(shareEl);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "location-chip-remove";
      removeBtn.setAttribute(
        "aria-label",
        mode === "exclude"
          ? `Stop excluding ${item.name}`
          : `Remove ${item.name} from selection`
      );
      removeBtn.title =
        mode === "exclude"
          ? `Stop excluding ${item.name}`
          : `Remove ${item.name}`;
      removeBtn.appendChild(this.createRemoveIconSvg());
      removeBtn.addEventListener("click", () => {
        const opt = this.optionByValue.get(item.value);
        if (opt) {
          this.toggleOptionMode(opt, mode, true);
        }
      });
      chip.appendChild(removeBtn);

      return chip;
    };

    for (const item of includedItems) {
      fragment.appendChild(buildChip(item, "include"));
    }
    for (const item of excludedItems) {
      fragment.appendChild(buildChip(item, "exclude"));
    }

    this.chipsEl.replaceChildren(fragment);
    this.chipsEl.hidden = false;
  }

  applySelectionState(announce = false, updateUrl = true) {
    const includedOpts = Array.from(this.includedMap.values());
    const excludedOpts = Array.from(this.excludedMap.values());

    const toItemMeta = (opt) => ({
      value: opt.dataset.value,
      kind: opt.dataset.kind,
      code: opt.dataset.code,
      name: opt.dataset.name,
      breadcrumb: opt.dataset.breadcrumb || opt.dataset.name,
      share: Number(opt.dataset.share || 0),
    });

    const includedItems = includedOpts.map(toItemMeta);
    const excludedItems = excludedOpts.map(toItemMeta);

    const explicitIncludedCountries = new Set();
    const regionIncludedCountries = new Set();
    for (const opt of includedOpts) {
      const codes = this.getOptionCountryCodes(opt);
      for (const c of codes) {
        explicitIncludedCountries.add(c);
        if (opt.dataset.kind === "region") {
          regionIncludedCountries.add(c);
        }
      }
    }

    const explicitExcludedCountries = new Set();
    const regionExcludedCountries = new Set();
    for (const opt of excludedOpts) {
      const codes = this.getOptionCountryCodes(opt);
      for (const c of codes) {
        explicitExcludedCountries.add(c);
        if (opt.dataset.kind === "region") {
          regionExcludedCountries.add(c);
        }
      }
    }

    const isWorldwide = includedOpts.length === 0 && excludedOpts.length === 0;

    for (const opt of this.optionEls) {
      const val = opt.dataset.value;
      if (val === "all") {
        opt.classList.toggle("is-selected", isWorldwide);
        opt.classList.toggle("is-included", isWorldwide);
        opt.setAttribute("aria-selected", isWorldwide ? "true" : "false");
        continue;
      }

      const isInc = this.includedMap.has(val);
      const isExc = this.excludedMap.has(val);
      const code = opt.dataset.code;
      const isCountry = opt.dataset.kind === "country";
      const isMemberInc =
        !isInc && !isExc && isCountry && regionIncludedCountries.has(code);
      const isMemberExc =
        !isExc && isCountry && regionExcludedCountries.has(code);

      opt.classList.toggle("is-selected", isInc);
      opt.classList.toggle("is-included", isInc);
      opt.classList.toggle("is-excluded", isExc);
      opt.classList.toggle("is-member-included", isMemberInc && !isMemberExc);
      opt.classList.toggle("is-member-excluded", isMemberExc);
      opt.setAttribute("aria-selected", isInc ? "true" : "false");

      const incBtn = opt.querySelector('[data-opt-action="include"]');
      if (incBtn) {
        incBtn.setAttribute("aria-pressed", isInc ? "true" : "false");
      }
      const excBtn = opt.querySelector('[data-opt-action="exclude"]');
      if (excBtn) {
        excBtn.setAttribute("aria-pressed", isExc ? "true" : "false");
      }
    }

    let value = "all";
    let kind = "global";
    let code = "WW";
    let name = "Worldwide";
    let breadcrumb = "Worldwide";
    let share = 100;
    let mappedPct = Number(this.allOpt?.dataset.mappedPct || 89.42);
    let countryCount = null;
    let memberCountries = [];

    if (isWorldwide) {
      this.selectedOption = this.allOpt;
    } else if (includedOpts.length === 1 && excludedOpts.length === 0) {
      const opt = includedOpts[0];
      this.selectedOption = opt;
      value = opt.dataset.value || "all";
      kind = opt.dataset.kind || "global";
      code = opt.dataset.code || "WW";
      name = opt.dataset.name || "Worldwide";
      breadcrumb = opt.dataset.breadcrumb || name;
      share = Number(opt.dataset.share || 0);
      mappedPct = Number(opt.dataset.mappedPct || 0);
      countryCount = opt.dataset.countryCount ? Number(opt.dataset.countryCount) : null;
      memberCountries = this.getOptionCountryCodes(opt);
    } else {
      this.selectedOption = includedOpts[0] || excludedOpts[0] || this.allOpt;
      const baseSet =
        includedOpts.length > 0
          ? new Set(explicitIncludedCountries)
          : new Set(this.allCountryCodes);
      for (const c of explicitExcludedCountries) {
        baseSet.delete(c);
      }
      memberCountries = Array.from(baseSet).sort();
      countryCount = memberCountries.length;

      const incKey = includedItems.map((i) => i.value).join("+") || "all";
      const excKey = excludedItems.map((i) => i.value).join("+");
      value = excKey ? `custom:${incKey}!${excKey}` : `custom:${incKey}`;
      kind = "custom";
      code = "CUSTOM";

      let totalShare = 0;
      let weightedMappedSum = 0;
      for (const cCode of memberCountries) {
        const cOpt = this.countryOptByCode.get(cCode);
        if (!cOpt) continue;
        const cShare = Number(cOpt.dataset.share || 0);
        const cMapped = Number(cOpt.dataset.mappedPct || 0);
        totalShare += cShare;
        weightedMappedSum += cShare * cMapped;
      }
      share = Number(totalShare.toFixed(4));
      mappedPct =
        totalShare > 0 ? Number((weightedMappedSum / totalShare).toFixed(2)) : 0;

      const formatList = (items, maxShown, sep = " + ") => {
        if (items.length <= maxShown) {
          return items.map((i) => i.name).join(sep);
        }
        return `${items
          .slice(0, maxShown - 1)
          .map((i) => i.name)
          .join(", ")} + ${items.length - (maxShown - 1)} more`;
      };

      const incLabel =
        includedItems.length > 0 ? formatList(includedItems, 3, " + ") : "Worldwide";
      const excLabel =
        excludedItems.length > 0
          ? ` (excl. ${formatList(excludedItems, 2, ", ")})`
          : "";
      name = `${incLabel}${excLabel}`;
      breadcrumb = name;
    }

    viewState.locationValue = value;
    viewState.locationMeta = {
      kind,
      code,
      name,
      breadcrumb,
      share,
      mappedPct,
      countryCount,
      memberCountries,
      includedItems,
      excludedItems,
    };

    const computedInitial = pageHasTimeSeriesComponents() ? getActiveInitialData() : null;
    if (computedInitial?.meta && typeof computedInitial.meta.mappedPct === "number") {
      mappedPct = computedInitial.meta.mappedPct;
      viewState.locationMeta.mappedPct = mappedPct;
    }

    if (!this.isOpen) {
      this.syncInputToSelected();
    }

    if (updateUrl) {
      pushUrlState();
    }

    if (this.resetBtn) {
      this.resetBtn.hidden = value === "all";
    }

    this.renderActiveChips(includedItems, excludedItems);

    const shareLabel = value === "all" ? "100.00%" : formatTrafficShare(share);

    // Update top hero meta pills
    const metaLocationText = document.querySelector("[data-meta-location-text]");
    if (metaLocationText) {
      metaLocationText.textContent =
        value === "all"
          ? "Worldwide (100.00% of traffic)"
          : `${name} (${shareLabel} of global traffic)`;
    }

    const metaMappedPct = document.querySelector("[data-meta-mapped-pct]");
    if (metaMappedPct && !Number.isNaN(mappedPct)) {
      metaMappedPct.textContent = formatPct(mappedPct);
    }

    // Update single-line summary pill in the filter bar footer
    if (this.breadcrumbEl) {
      if (value === "all") {
        this.breadcrumbEl.textContent = `100.00% of global traffic • ${formatPct(mappedPct)} mapped`;
      } else if (kind === "region" || kind === "custom") {
        const countWord = countryCount === 1 ? "1 country" : `${countryCount} countries`;
        this.breadcrumbEl.textContent = `${countWord} • ${shareLabel} of global traffic • ${formatPct(mappedPct)} mapped`;
      } else {
        this.breadcrumbEl.textContent = `${code} • ${shareLabel} of global traffic • ${formatPct(mappedPct)} mapped`;
      }
    }

    // Update section heading badges without toggling display:none or rewriting long subtitles
    const scopeBadges = document.querySelectorAll("[data-scope-badge]");
    scopeBadges.forEach((badge) => {
      badge.hidden = false;
      badge.textContent =
        value === "all"
          ? "Worldwide"
          : kind === "country"
          ? `${name} (${code})`
          : name;
    });

    const summaryCaption = document.querySelector("[data-summary-caption]");
    if (summaryCaption) {
      summaryCaption.textContent =
        value === "all"
          ? "Last 7 days average Baseline availability by target (Worldwide)"
          : `Last 7 days average Baseline availability by target for ${name}`;
    }

    notifyStateChange("location-filter");
    window.dispatchEvent(
      new CustomEvent("baseline:location-change", {
        detail: {
          value: viewState.locationValue,
          meta: viewState.locationMeta,
        },
      })
    );

    if (announce && this.liveRegion) {
      const widelyTarget = computedInitial?.targets?.find((t) => t.id === "widely");
      const newlyTarget = computedInitial?.targets?.find((t) => t.id === "newly");
      const getTargetAvg = (t) =>
        viewState.webviewMode === "exclude" ? t.avg7.pctNoWv : t.avg7.pct;
      const widelyStr = widelyTarget
        ? `, Widely available ${formatPct(getTargetAvg(widelyTarget))}`
        : "";
      const newlyStr = newlyTarget
        ? `, Newly available ${formatPct(getTargetAvg(newlyTarget))}`
        : "";
      this.liveRegion.textContent = `Showing Baseline availability for ${name} (${shareLabel} of global traffic${widelyStr}${newlyStr}).`;
    }
  }
}

class BaselineSummaryTable extends HTMLElement {
  connectedCallback() {
    this.data = getActiveInitialData();
    this.onDataReady = () => {
      this.data = getActiveInitialData();
      this.setupInteractivity();
    };
    this.onCountryDataReady = () => {
      if (viewState.locationValue !== "all") {
        this.data = getActiveInitialData();
        this.syncHighlightAndMetric();
      }
    };
    this.onViewState = (e) => {
      if (e.detail?.source === "location-filter") {
        this.data = getActiveInitialData();
      }
      this.syncHighlightAndMetric();
    };

    window.addEventListener("baseline-data-ready", this.onDataReady);
    window.addEventListener("baseline-country-data-ready", this.onCountryDataReady);
    window.addEventListener("baseline-view-state", this.onViewState);

    if (this.data) {
      this.setupInteractivity();
    }
  }

  disconnectedCallback() {
    window.removeEventListener("baseline-data-ready", this.onDataReady);
    window.removeEventListener("baseline-country-data-ready", this.onCountryDataReady);
    window.removeEventListener("baseline-view-state", this.onViewState);
  }

  setupInteractivity() {
    if (this._interactivityBound) {
      this.syncHighlightAndMetric();
      return;
    }
    this._interactivityBound = true;

    const rows = this.querySelectorAll("tbody tr[data-target-id]");
    rows.forEach((row) => {
      const targetId = row.getAttribute("data-target-id");
      if (!targetId) return;

      const togglePin = () => {
        if (viewState.pinnedTargetId === targetId) {
          viewState.pinnedTargetId = null;
          viewState.highlightedTargetId = null;
          viewState.urlTargetId = null;
        } else {
          viewState.pinnedTargetId = targetId;
          viewState.highlightedTargetId = targetId;
          viewState.breakdownTargetId = targetId;
          viewState.urlTargetId = targetId;
        }
        pushUrlState();
        notifyStateChange("table");
      };

      row.addEventListener("mouseenter", () => {
        if (!viewState.pinnedTargetId) {
          viewState.highlightedTargetId = targetId;
          notifyStateChange("table");
        }
      });

      row.addEventListener("mouseleave", () => {
        if (!viewState.pinnedTargetId && viewState.highlightedTargetId === targetId) {
          viewState.highlightedTargetId = null;
          notifyStateChange("table");
        }
      });

      row.addEventListener("click", (e) => {
        if (e.target.closest("button[data-target-btn]")) return;
        togglePin();
      });

      const btn = row.querySelector("button[data-target-btn]");
      if (btn) {
        btn.addEventListener("click", () => {
          togglePin();
        });
      }
    });

    const modeButtons = this.querySelectorAll("button[data-webview-mode]");
    modeButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-webview-mode");
        if (mode === "include" || mode === "exclude") {
          viewState.webviewMode = mode;
          notifyStateChange("table-mode");
        }
      });
    });

    this.syncHighlightAndMetric();
  }

  syncHighlightAndMetric() {
    const activeTargetId = viewState.pinnedTargetId || viewState.highlightedTargetId;
    const rows = this.querySelectorAll("tbody tr[data-target-id]");
    const excludeWv = viewState.webviewMode === "exclude";

    const primaryHeader = this.querySelector("[data-primary-metric-header]");
    if (primaryHeader) {
      primaryHeader.textContent = excludeWv
        ? "7-Day Average (Excl. WebViews)"
        : "7-Day Average (Incl. WebViews)";
    }

    const webviewHeaders = this.querySelectorAll("th[data-webview-col]");
    webviewHeaders.forEach((th) => {
      th.hidden = excludeWv;
    });

    const targetMap = new Map();
    if (this.data && Array.isArray(this.data.targets)) {
      for (const t of this.data.targets) {
        targetMap.set(t.id, t);
      }
    }

    rows.forEach((row) => {
      const id = row.getAttribute("data-target-id");
      const isHighlighted = activeTargetId === id;
      const isPinned = viewState.pinnedTargetId === id;
      row.toggleAttribute("data-highlighted", isHighlighted);
      row.toggleAttribute("data-pinned", isPinned);

      const target = targetMap.get(id);
      const btn = row.querySelector("button[data-target-btn]");
      if (btn) {
        btn.setAttribute("aria-pressed", isPinned ? "true" : "false");
        if (target) {
          btn.setAttribute(
            "aria-label",
            isPinned
              ? `${target.label} (pinned on charts, activate to unpin)`
              : `${target.label} (activate to pin on charts)`
          );
        }
      }

      if (target) {
        const primaryVal = excludeWv ? target.avg7.pctNoWv : target.avg7.pct;
        const primaryText = row.querySelector("[data-cell-primary-value]");
        if (primaryText) {
          primaryText.textContent = formatPct(primaryVal);
        }
        const barFill = row.querySelector("rect.pct-bar-fill");
        if (barFill) {
          barFill.setAttribute("width", String(Math.max(0, Math.min(100, primaryVal))));
        }

        const deltaBadge = row.querySelector("[data-cell-delta]");
        if (deltaBadge) {
          const d = Number((excludeWv ? target.avg7.deltaNoWv : target.avg7.delta) || 0);
          deltaBadge.textContent = formatDelta(d);
          deltaBadge.className = `delta-badge ${d > 0 ? "delta-pos" : d < 0 ? "delta-neg" : "delta-neutral"}`;
        }

        const androidWvCell = row.querySelector("[data-cell-android-wv]");
        if (androidWvCell) {
          androidWvCell.hidden = excludeWv;
          androidWvCell.textContent = formatPct(target.avg7.androidWv);
        }

        const iosWvCell = row.querySelector("[data-cell-ios-wv]");
        if (iosWvCell) {
          iosWvCell.hidden = excludeWv;
          iosWvCell.textContent = formatPct(target.avg7.iosWv);
        }
      }
    });

    const modeButtons = this.querySelectorAll("button[data-webview-mode]");
    modeButtons.forEach((btn) => {
      const isSelected = btn.getAttribute("data-webview-mode") === viewState.webviewMode;
      btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
    });
  }
}

class BaselineTimeseriesChart extends HTMLElement {
  connectedCallback() {
    this.data = getActiveInitialData();
    this.hoveredDateIdx = null;
    this.hoveredTargetId = null;

    this.onDataReady = () => {
      this.data = getActiveInitialData();
      this.render();
    };
    this.onCountryDataReady = () => {
      if (viewState.locationValue !== "all") {
        this.data = getActiveInitialData();
        this.updateActiveStates();
      }
    };
    this.onViewState = (e) => {
      if (e.detail?.source === "location-filter") {
        this.data = getActiveInitialData();
        if (this.svgEl && this.data?.dates?.length) {
          const dates = this.data.dates;
          const locName = viewState.locationMeta?.name || "Worldwide";
          this.svgEl.setAttribute(
            "aria-label",
            `Interactive Baseline availability time series chart for ${locName} from ${dates[0]} to ${dates[dates.length - 1]}. Use Left and Right arrow keys to step through dates.`
          );
        }
      }
      this.updateActiveStates();
    };

    window.addEventListener("baseline-data-ready", this.onDataReady);
    window.addEventListener("baseline-country-data-ready", this.onCountryDataReady);
    window.addEventListener("baseline-view-state", this.onViewState);

    if (this.data) {
      this.render();
    }
  }

  disconnectedCallback() {
    window.removeEventListener("baseline-data-ready", this.onDataReady);
    window.removeEventListener("baseline-country-data-ready", this.onCountryDataReady);
    window.removeEventListener("baseline-view-state", this.onViewState);
  }

  getYearStrokeClass(year, minYear, maxYear) {
    const span = Math.max(1, maxYear - minYear);
    const ratio = (year - minYear) / span;
    if (ratio >= 0.8) return "year-line-recent";
    if (ratio >= 0.45) return "year-line-mid";
    return "year-line-older";
  }

  render() {
    this.replaceChildren();
    if (!this.data || !Array.isArray(this.data.dates) || this.data.dates.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No time-series data available yet.";
      this.appendChild(empty);
      return;
    }

    const { dates, targets } = this.data;
    const dayCount = dates.length;
    this.hoveredDateIdx = dayCount - 1;

    // 1. Top Legend / Target Filter Bar
    const controlsRow = document.createElement("div");
    controlsRow.className = "chart-controls-bar";

    const legendGroup = document.createElement("div");
    legendGroup.className = "chart-legend";
    legendGroup.setAttribute("role", "toolbar");
    legendGroup.setAttribute("aria-label", "Highlight Baseline target line");

    this.legendButtons = new Map();
    for (const t of targets) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `legend-pill legend-pill-${t.kind}`;
      btn.setAttribute("data-target-id", t.id);
      btn.setAttribute("aria-pressed", "false");
      btn.setAttribute("aria-label", `Pin ${t.label} on chart`);

      const swatch = document.createElement("span");
      swatch.className = `legend-swatch swatch-${t.kind}`;
      swatch.setAttribute("aria-hidden", "true");
      btn.appendChild(swatch);

      const labelSpan = document.createElement("span");
      labelSpan.textContent = t.kind === "year" ? String(t.year) : t.label;
      btn.appendChild(labelSpan);

      btn.addEventListener("mouseenter", () => {
        if (!viewState.pinnedTargetId) {
          viewState.highlightedTargetId = t.id;
          notifyStateChange("chart-legend");
        }
      });
      btn.addEventListener("mouseleave", () => {
        if (!viewState.pinnedTargetId && viewState.highlightedTargetId === t.id) {
          viewState.highlightedTargetId = null;
          notifyStateChange("chart-legend");
        }
      });
      btn.addEventListener("click", () => {
        if (viewState.pinnedTargetId === t.id) {
          viewState.pinnedTargetId = null;
          viewState.highlightedTargetId = null;
          viewState.urlTargetId = null;
        } else {
          viewState.pinnedTargetId = t.id;
          viewState.highlightedTargetId = t.id;
          viewState.breakdownTargetId = t.id;
          viewState.urlTargetId = t.id;
        }
        pushUrlState();
        notifyStateChange("chart-legend");
      });

      this.legendButtons.set(t.id, btn);
      legendGroup.appendChild(btn);
    }

    controlsRow.appendChild(legendGroup);
    this.appendChild(controlsRow);

    // Polite screen-reader announcer for keyboard date stepping
    this.liveAnnouncer = document.createElement("div");
    this.liveAnnouncer.className = "sr-only";
    this.liveAnnouncer.setAttribute("aria-live", "polite");
    this.liveAnnouncer.setAttribute("aria-atomic", "true");
    this.appendChild(this.liveAnnouncer);

    // 2. SVG Time-Series Chart Canvas
    const svgWrap = document.createElement("div");
    svgWrap.className = "chart-svg-container";

    const W = 920;
    const H = 400;
    const padL = 56;
    const padR = 28;
    const padT = 24;
    const padB = 44;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    this.chartGeom = { W, H, padL, padR, padT, padB, plotW, plotH };

    const locName = viewState.locationMeta?.name || "Worldwide";
    const svg = createSvgEl("svg", {
      viewBox: `0 0 ${W} ${H}`,
      class: "timeseries-svg",
      role: "group",
      "aria-label": `Interactive Baseline availability time series chart for ${locName} from ${dates[0]} to ${dates[dayCount - 1]}. Use Left and Right arrow keys to step through dates.`,
      tabindex: "0",
    });
    this.svgEl = svg;

    // Horizontal Y-axis gridlines & 0-100% labels
    const gridGroup = createSvgEl("g", { class: "chart-grid", "aria-hidden": "true" });
    for (let pct = 0; pct <= 100; pct += 20) {
      const y = padT + plotH - (pct / 100) * plotH;
      const line = createSvgEl("line", {
        x1: padL,
        y1: y.toFixed(1),
        x2: W - padR,
        y2: y.toFixed(1),
        class: pct === 0 || pct === 100 ? "grid-line grid-line-axis" : "grid-line",
      });
      gridGroup.appendChild(line);

      const label = createSvgEl("text", {
        x: padL - 10,
        y: (y + 4).toFixed(1),
        "text-anchor": "end",
        class: "axis-label axis-label-y",
      });
      label.textContent = `${pct}%`;
      gridGroup.appendChild(label);
    }

    // X-axis date ticks (up to ~8 evenly spaced ticks)
    const maxTicks = Math.min(dayCount, 8);
    const tickIndices = new Set([0, dayCount - 1]);
    if (dayCount > 2) {
      const step = (dayCount - 1) / (maxTicks - 1);
      for (let i = 1; i < maxTicks - 1; i++) {
        tickIndices.add(Math.round(i * step));
      }
    }

    for (const idx of [...tickIndices].sort((a, b) => a - b)) {
      const x = this.getXForIndex(idx, dayCount);
      const tickLine = createSvgEl("line", {
        x1: x.toFixed(1),
        y1: padT + plotH,
        x2: x.toFixed(1),
        y2: padT + plotH + 6,
        class: "axis-tick",
      });
      gridGroup.appendChild(tickLine);

      const dateLabel = createSvgEl("text", {
        x: x.toFixed(1),
        y: padT + plotH + 24,
        "text-anchor": idx === 0 ? "start" : idx === dayCount - 1 ? "end" : "middle",
        class: "axis-label axis-label-x",
      });
      dateLabel.textContent = formatShortDate(dates[idx]);
      gridGroup.appendChild(dateLabel);
    }

    svg.appendChild(gridGroup);

    // Vertical hover crosshair line
    this.crosshairLine = createSvgEl("line", {
      x1: padL,
      y1: padT,
      x2: padL,
      y2: padT + plotH,
      class: "chart-crosshair",
      "aria-hidden": "true",
    });
    svg.appendChild(this.crosshairLine);

    // Target lines group (years rendered first, Widely & Newly rendered on top)
    this.linesGroup = createSvgEl("g", { class: "chart-lines", "aria-hidden": "true" });
    this.dotsGroup = createSvgEl("g", { class: "chart-dots", "aria-hidden": "true" });
    svg.appendChild(this.linesGroup);
    svg.appendChild(this.dotsGroup);

    // Floating SVG Callout Tooltip (inside SVG to avoid inline CSS style attributes)
    this.tooltipGroup = createSvgEl("g", {
      class: "svg-tooltip",
      transform: "translate(70, 32)",
      "aria-hidden": "true",
    });
    this.tooltipBg = createSvgEl("rect", {
      x: 0,
      y: 0,
      width: 224,
      height: 94,
      rx: 8,
      class: "svg-tooltip-bg",
    });
    this.tooltipDateText = createSvgEl("text", {
      x: 12,
      y: 20,
      class: "svg-tooltip-date",
    });
    this.tooltipPrimaryText = createSvgEl("text", {
      x: 12,
      y: 42,
      class: "svg-tooltip-primary",
    });
    this.tooltipWidelyText = createSvgEl("text", {
      x: 12,
      y: 64,
      class: "svg-tooltip-sub svg-tooltip-widely",
    });
    this.tooltipNewlyText = createSvgEl("text", {
      x: 12,
      y: 82,
      class: "svg-tooltip-sub svg-tooltip-newly",
    });
    this.tooltipGroup.appendChild(this.tooltipBg);
    this.tooltipGroup.appendChild(this.tooltipDateText);
    this.tooltipGroup.appendChild(this.tooltipPrimaryText);
    this.tooltipGroup.appendChild(this.tooltipWidelyText);
    this.tooltipGroup.appendChild(this.tooltipNewlyText);
    svg.appendChild(this.tooltipGroup);

    // Interactive pointer overlay
    const overlay = createSvgEl("rect", {
      x: padL,
      y: padT,
      width: plotW,
      height: plotH,
      class: "chart-hit-overlay",
      "aria-hidden": "true",
    });

    const handlePointer = (clientX, clientY) => {
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const svgX = ((clientX - rect.left) / rect.width) * W;
      const svgY = ((clientY - rect.top) / rect.height) * H;

      // Nearest date index
      const clampedX = Math.max(padL, Math.min(padL + plotW, svgX));
      const ratioX = dayCount > 1 ? (clampedX - padL) / plotW : 0;
      const dateIdx = Math.round(ratioX * (dayCount - 1));
      this.hoveredDateIdx = Math.max(0, Math.min(dayCount - 1, dateIdx));

      // Nearest line at that date index (unless a target is pinned)
      if (!viewState.pinnedTargetId) {
        const cursorPct = ((padT + plotH - svgY) / plotH) * 100;
        let closestId = null;
        let minDiff = Infinity;
        for (const t of targets) {
          const val = this.getValueForTarget(t, this.hoveredDateIdx);
          const diff = Math.abs(val - cursorPct);
          // Give primary lines (Widely / Newly) a slight magnetic preference
          const weightedDiff = t.kind === "year" ? diff : diff * 0.75;
          if (weightedDiff < minDiff && diff < 12) {
            minDiff = weightedDiff;
            closestId = t.id;
          }
        }
        if (this.hoveredTargetId !== closestId) {
          this.hoveredTargetId = closestId;
          viewState.highlightedTargetId = closestId;
          notifyStateChange("chart-hover");
        }
      }

      this.updateCrosshairAndInspector(false);
    };

    overlay.addEventListener("pointermove", (e) => {
      handlePointer(e.clientX, e.clientY);
    });

    overlay.addEventListener("pointerleave", () => {
      if (!viewState.pinnedTargetId && this.hoveredTargetId !== null) {
        this.hoveredTargetId = null;
        viewState.highlightedTargetId = null;
        notifyStateChange("chart-hover");
      }
      this.updateCrosshairAndInspector(false);
    });

    overlay.addEventListener("click", () => {
      if (this.hoveredTargetId) {
        if (viewState.pinnedTargetId === this.hoveredTargetId) {
          viewState.pinnedTargetId = null;
          viewState.urlTargetId = null;
        } else {
          viewState.pinnedTargetId = this.hoveredTargetId;
          viewState.highlightedTargetId = this.hoveredTargetId;
          viewState.breakdownTargetId = this.hoveredTargetId;
          viewState.urlTargetId = this.hoveredTargetId;
        }
        pushUrlState();
        notifyStateChange("chart-click");
      }
    });

    svg.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        this.hoveredDateIdx = Math.max(0, (this.hoveredDateIdx ?? dayCount - 1) - 1);
        this.updateCrosshairAndInspector(true);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        this.hoveredDateIdx = Math.min(dayCount - 1, (this.hoveredDateIdx ?? dayCount - 1) + 1);
        this.updateCrosshairAndInspector(true);
      }
    });

    svg.appendChild(overlay);
    svgWrap.appendChild(svg);
    this.appendChild(svgWrap);

    // 3. Date Details Breakdown Panel below the chart
    this.inspectorPanel = document.createElement("div");
    this.inspectorPanel.className = "chart-inspector-panel";
    this.inspectorPanel.setAttribute("role", "region");
    this.inspectorPanel.setAttribute("aria-label", "Daily availability snapshot");
    this.appendChild(this.inspectorPanel);

    this.drawLines();
    this.updateActiveStates();
  }

  getXForIndex(idx, dayCount) {
    const { padL, plotW } = this.chartGeom;
    if (dayCount <= 1) return padL + plotW / 2;
    return padL + (idx / (dayCount - 1)) * plotW;
  }

  getYForPct(pct) {
    const { padT, plotH } = this.chartGeom;
    const clamped = Math.max(0, Math.min(100, Number(pct || 0)));
    return padT + plotH - (clamped / 100) * plotH;
  }

  getValueForTarget(target, dateIdx) {
    const arr =
      viewState.webviewMode === "exclude" ? target.series.pctNoWv : target.series.pct;
    return arr?.[dateIdx] ?? 0;
  }

  drawLines() {
    if (!this.linesGroup || !this.data) return;
    this.linesGroup.replaceChildren();
    this.pathElements = new Map();

    const { dates, targets } = this.data;
    const dayCount = dates.length;
    const years = targets.filter((t) => t.kind === "year").map((t) => t.year);
    const minYear = Math.min(...years);
    const maxYear = Math.max(...years);

    // Render year lines first, then Widely and Newly on top
    const orderedForPaint = [
      ...targets.filter((t) => t.kind === "year"),
      ...targets.filter((t) => t.kind !== "year"),
    ];

    for (const t of orderedForPaint) {
      const points = [];
      for (let i = 0; i < dayCount; i++) {
        const x = this.getXForIndex(i, dayCount);
        const y = this.getYForPct(this.getValueForTarget(t, i));
        points.push(`${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
      }

      const yearClass =
        t.kind === "year" ? this.getYearStrokeClass(t.year, minYear, maxYear) : "";
      const path = createSvgEl("path", {
        d: points.join(" "),
        class: `chart-line chart-line-${t.kind} ${yearClass}`.trim(),
        "data-target-id": t.id,
      });

      this.linesGroup.appendChild(path);
      this.pathElements.set(t.id, path);
    }
  }

  updateActiveStates() {
    if (!this.data || !this.pathElements) return;
    this.drawLines();

    const activeId = viewState.pinnedTargetId || viewState.highlightedTargetId;
    for (const [id, path] of this.pathElements.entries()) {
      path.toggleAttribute("data-active", activeId === id);
      path.toggleAttribute("data-dimmed", Boolean(activeId && activeId !== id));
    }

    if (this.legendButtons) {
      for (const [id, btn] of this.legendButtons.entries()) {
        const isActive = activeId === id;
        const isPinned = viewState.pinnedTargetId === id;
        btn.toggleAttribute("data-active", isActive);
        btn.setAttribute("aria-pressed", isPinned ? "true" : "false");
      }
    }

    this.updateCrosshairAndInspector(false);
  }

  updateCrosshairAndInspector(announceToScreenReader = false) {
    if (!this.data || !this.crosshairLine || !this.dotsGroup) return;
    const { dates, targets } = this.data;
    const dayCount = dates.length;
    const dateIdx = Math.max(0, Math.min(dayCount - 1, this.hoveredDateIdx ?? dayCount - 1));
    const dateStr = dates[dateIdx];
    const x = this.getXForIndex(dateIdx, dayCount);

    this.crosshairLine.setAttribute("x1", x.toFixed(1));
    this.crosshairLine.setAttribute("x2", x.toFixed(1));

    // Render active markers on the crosshair
    this.dotsGroup.replaceChildren();
    const activeId = viewState.pinnedTargetId || viewState.highlightedTargetId;

    const widelyTarget = targets.find((t) => t.id === "widely");
    const newlyTarget = targets.find((t) => t.id === "newly");
    const activeTarget = targets.find((t) => t.id === activeId) || widelyTarget;

    for (const t of targets) {
      const isPrimary = t.kind === "widely" || t.kind === "newly";
      const isFocused = t.id === activeId;
      if (!isPrimary && !isFocused && dayCount > 35) continue;

      const val = this.getValueForTarget(t, dateIdx);
      const y = this.getYForPct(val);
      const dot = createSvgEl("circle", {
        cx: x.toFixed(1),
        cy: y.toFixed(1),
        r: isFocused ? 5.5 : isPrimary ? 4.5 : 2.75,
        class: `chart-dot chart-dot-${t.kind}${isFocused ? " chart-dot-focused" : ""}`,
      });
      this.dotsGroup.appendChild(dot);
    }

    // Update SVG floating callout position and text
    if (this.tooltipGroup && activeTarget) {
      const { W, padL, padR, padT } = this.chartGeom;
      const boxW = 224;
      const tx = x + 16 + boxW > W - padR ? Math.max(padL + 8, x - boxW - 16) : x + 16;
      const ty = padT + 8;
      this.tooltipGroup.setAttribute("transform", `translate(${tx.toFixed(1)}, ${ty.toFixed(1)})`);

      const focusVal = this.getValueForTarget(activeTarget, dateIdx);
      const widelyVal = widelyTarget ? this.getValueForTarget(widelyTarget, dateIdx) : 0;
      const newlyVal = newlyTarget ? this.getValueForTarget(newlyTarget, dateIdx) : 0;

      this.tooltipDateText.textContent = `${dateStr} (${formatShortDate(dateStr)})`;
      this.tooltipPrimaryText.textContent = `${activeTarget.label}: ${formatPct(focusVal)}`;
      this.tooltipWidelyText.textContent = `Widely available: ${formatPct(widelyVal)}`;
      this.tooltipNewlyText.textContent = `Newly available: ${formatPct(newlyVal)}`;

      if (announceToScreenReader && this.liveAnnouncer) {
        this.liveAnnouncer.textContent = `${dateStr}: ${activeTarget.label} ${formatPct(focusVal)}, Widely available ${formatPct(widelyVal)}, Newly available ${formatPct(newlyVal)}.`;
      }
    }

    // Update bottom inspector panel with all target values for the selected date
    if (this.inspectorPanel) {
      this.inspectorPanel.replaceChildren();

      const header = document.createElement("div");
      header.className = "inspector-header";

      const title = document.createElement("strong");
      title.className = "inspector-date-title";
      title.textContent = `Daily Snapshot: ${dateStr}`;
      header.appendChild(title);

      const hint = document.createElement("span");
      hint.className = "inspector-hint";
      hint.textContent =
        viewState.webviewMode === "exclude"
          ? "Showing % of mapped page loads excluding WebViews (hover chart or use ←/→ keys)"
          : "Showing % of mapped page loads including WebViews (hover chart or use ←/→ keys)";
      header.appendChild(hint);

      this.inspectorPanel.appendChild(header);

      const grid = document.createElement("dl");
      grid.className = "inspector-grid";

      for (const t of targets) {
        const item = document.createElement("div");
        item.className = `inspector-chip inspector-chip-${t.kind}`;
        if (activeId === t.id) {
          item.setAttribute("data-active", "");
        }

        const nameDt = document.createElement("dt");
        nameDt.className = "inspector-chip-label";
        if (t.kind === "year") {
          const srPrefix = document.createElement("span");
          srPrefix.className = "sr-only";
          srPrefix.textContent = "Baseline ";
          nameDt.appendChild(srPrefix);
          nameDt.appendChild(document.createTextNode(String(t.year)));
        } else {
          nameDt.textContent = t.label;
        }

        const valDd = document.createElement("dd");
        valDd.className = "inspector-chip-value";
        valDd.textContent = formatPct(this.getValueForTarget(t, dateIdx));

        item.appendChild(nameDt);
        item.appendChild(valDd);
        grid.appendChild(item);
      }

      this.inspectorPanel.appendChild(grid);
    }
  }
}

const THEME_STORAGE_KEY = "baseline-theme";

function getStoredTheme() {
  try {
    const val = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (val === "light" || val === "dark") {
      return val;
    }
  } catch {
    // Storage access unavailable
  }
  return null;
}

function setStoredTheme(theme) {
  try {
    if (theme === "light" || theme === "dark") {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } else {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    }
  } catch {
    // Ignore storage write errors
  }
}

function getSystemTheme() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function getEffectiveTheme() {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") {
    return attr;
  }
  return getSystemTheme();
}

function initThemeToggle() {
  const stored = getStoredTheme();
  if (stored) {
    document.documentElement.setAttribute("data-theme", stored);
  }

  const toggleBtn = document.getElementById("theme-toggle");
  const toggleLabel = document.getElementById("theme-toggle-label");
  if (!toggleBtn) return;

  const syncButtonUi = () => {
    const isDark = getEffectiveTheme() === "dark";
    const actionLabel = isDark ? "Switch to light theme" : "Switch to dark theme";
    toggleBtn.setAttribute("aria-pressed", isDark ? "true" : "false");
    toggleBtn.setAttribute("aria-label", actionLabel);
    toggleBtn.setAttribute("title", actionLabel);
    if (toggleLabel) {
      toggleLabel.textContent = isDark ? "Light" : "Dark";
    }
  };

  toggleBtn.addEventListener("click", () => {
    const nextTheme = getEffectiveTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", nextTheme);
    setStoredTheme(nextTheme);
    syncButtonUi();
  });

  if (window.matchMedia) {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    mql.addEventListener("change", () => {
      syncButtonUi();
    });
  }

  syncButtonUi();
}

/**
 * Compares two numeric major or major.minor browser version strings.
 * @param {string} v1
 * @param {string} v2
 * @returns {number}
 */
function compareBrowserVersions(v1, v2) {
  if (v1 === v2) return 0;
  const [maj1 = 0, min1 = 0] = String(v1).split(".", 2).map(Number);
  const [maj2 = 0, min2 = 0] = String(v2).split(".", 2).map(Number);
  if (Number.isNaN(maj1) || Number.isNaN(min1) || Number.isNaN(maj2) || Number.isNaN(min2)) {
    return NaN;
  }
  if (maj1 !== maj2) return maj1 > maj2 ? 1 : -1;
  if (min1 !== min2) return min1 > min2 ? 1 : -1;
  return 0;
}

/**
 * Formats a traffic share percentage with extra precision for sub-0.01% entries in full tables.
 * @param {number} value
 * @returns {string}
 */
function formatSharePct(value) {
  const num = Number(value || 0);
  if (num === 0) return "0.00%";
  if (num >= 0.01) return `${num.toFixed(2)}%`;
  if (num >= 0.0001) return `${num.toFixed(4)}%`;
  return "<0.0001%";
}

class BaselineBrowserBreakdown extends HTMLElement {
  connectedCallback() {
    this.data = getActiveBreakdownData();
    this.selectedTargetId = viewState.breakdownTargetId || viewState.pinnedTargetId || "widely";
    this.activeMobileTab = "compatible";
    this.hoveredBlock = null;
    this.sortState = {
      compatible: { key: "proportion", dir: "desc" },
      incompatible: { key: "proportion", dir: "desc" },
    };

    this.onBreakdownReady = () => {
      this.data = getActiveBreakdownData();
      this.render();
    };

    this.onCountryBreakdownReady = () => {
      if (viewState.locationValue !== "all") {
        this.data = getActiveBreakdownData();
        this.render();
      }
    };

    this.onViewState = (e) => {
      const detail = e.detail || {};
      if (detail.source === "breakdown-target") {
        return;
      }
      if (detail.source === "location-filter") {
        this.data = getActiveBreakdownData();
        if (!this.barContainer && this.data) {
          this.render();
          return;
        }
      }
      if (detail.source === "popstate" || detail.source === "location-filter") {
        this.selectedTargetId = viewState.breakdownTargetId || "widely";
        this.hoveredBlock = null;
      } else if (
        detail.source !== "breakdown" &&
        detail.pinnedTargetId &&
        detail.pinnedTargetId !== this.selectedTargetId
      ) {
        this.selectedTargetId = detail.pinnedTargetId;
        this.hoveredBlock = null;
      }
      this.updateView();
    };

    window.addEventListener("baseline-breakdown-ready", this.onBreakdownReady);
    window.addEventListener("baseline-country-breakdown-ready", this.onCountryBreakdownReady);
    window.addEventListener("baseline-view-state", this.onViewState);

    if (this.data) {
      this.render();
    }
  }

  disconnectedCallback() {
    window.removeEventListener("baseline-breakdown-ready", this.onBreakdownReady);
    window.removeEventListener("baseline-country-breakdown-ready", this.onCountryBreakdownReady);
    window.removeEventListener("baseline-view-state", this.onViewState);
  }

  getShare(browserEntry) {
    return viewState.webviewMode === "exclude"
      ? Number(browserEntry.pctNoWv || 0)
      : Number(browserEntry.pct || 0);
  }

  partitionBrowsersForTarget(targetId) {
    if (!this.data || !Array.isArray(this.data.browsers)) {
      return { compatible: [], incompatible: [], compatibleSum: 0, incompatibleSum: 0 };
    }

    const minMap = (this.data.targetMinMaps && this.data.targetMinMaps[targetId]) || {};
    const compatible = [];
    const incompatible = [];
    let compatibleSum = 0;
    let incompatibleSum = 0;

    for (const b of this.data.browsers) {
      const share = this.getShare(b);
      if (share <= 0) continue;
      const minVer = minMap[b.browser];
      const isCompat =
        minVer !== undefined && compareBrowserVersions(b.version, minVer) >= 0;
      const item = { ...b, share };
      if (isCompat) {
        compatible.push(item);
        compatibleSum += share;
      } else {
        incompatible.push(item);
        incompatibleSum += share;
      }
    }

    // Sort both lists highest proportion to lowest by default
    compatible.sort((a, b) => b.share - a.share || b.pct - a.pct);
    incompatible.sort((a, b) => b.share - a.share || b.pct - a.pct);

    return {
      compatible,
      incompatible,
      compatibleSum,
      incompatibleSum,
    };
  }

  /**
   * Builds bar segments for one side ("compatible" or "incompatible"),
   * sorted highest proportion to lowest left-to-right, compressing any browsers
   * that individually make up <0.5% of total traffic into a single block.
   */
  buildBarBlocks(items, side) {
    const majorBlocks = [];
    const minorItems = [];
    let minorShareSum = 0;

    for (const item of items) {
      // Compress any browser that makes up <0.5% of traffic into a single block
      if (item.share >= 0.5) {
        majorBlocks.push({
          type: "single",
          side,
          share: item.share,
          browser: item,
        });
      } else if (item.share > 0) {
        minorItems.push(item);
        minorShareSum += item.share;
      }
    }

    majorBlocks.sort((a, b) => b.share - a.share);

    if (minorItems.length > 0 && minorShareSum > 0) {
      majorBlocks.push({
        type: "compressed",
        side,
        share: minorShareSum,
        items: minorItems,
      });
    }

    return majorBlocks;
  }

  announce(message) {
    if (this.liveStatus) {
      this.liveStatus.textContent = message;
    }
  }

  render() {
    this.replaceChildren();
    if (!this.data || !Array.isArray(this.data.browsers) || this.data.browsers.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No 7-day browser breakdown data available yet.";
      this.appendChild(empty);
      return;
    }

    // Polite screen-reader live region for target selection & table sorting announcements
    this.liveStatus = document.createElement("div");
    this.liveStatus.className = "sr-only";
    this.liveStatus.setAttribute("aria-live", "polite");
    this.liveStatus.setAttribute("aria-atomic", "true");
    this.appendChild(this.liveStatus);

    // 1. Target Selector Buttons Row + WebView Mode Toggle
    const controlsWrap = document.createElement("div");
    controlsWrap.className = "breakdown-controls-row";

    const targetBtnGroup = document.createElement("div");
    targetBtnGroup.className = "chart-legend breakdown-target-buttons";
    targetBtnGroup.setAttribute("role", "toolbar");
    targetBtnGroup.setAttribute("aria-label", "Select Baseline target for browser breakdown");

    this.targetButtons = new Map();
    for (const t of this.data.targets || []) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `legend-pill legend-pill-${t.kind}`;
      btn.setAttribute("data-target-id", t.id);
      btn.setAttribute("aria-pressed", t.id === this.selectedTargetId ? "true" : "false");
      btn.setAttribute("aria-label", t.label);

      const swatch = document.createElement("span");
      swatch.className = `legend-swatch swatch-${t.kind}`;
      swatch.setAttribute("aria-hidden", "true");
      btn.appendChild(swatch);

      const labelSpan = document.createElement("span");
      labelSpan.textContent =
        t.kind === "newly"
          ? "Baseline Newly"
          : t.kind === "widely"
            ? "Baseline Widely"
            : String(t.year || t.shortLabel);
      btn.appendChild(labelSpan);

      btn.addEventListener("click", () => {
        this.selectedTargetId = t.id;
        viewState.breakdownTargetId = t.id;
        viewState.pinnedTargetId = t.id;
        viewState.highlightedTargetId = t.id;
        viewState.urlTargetId = t.id;
        this.hoveredBlock = null;
        pushUrlState();
        notifyStateChange("breakdown-target");
        this.updateView(true);
      });

      this.targetButtons.set(t.id, btn);
      targetBtnGroup.appendChild(btn);
    }

    controlsWrap.appendChild(targetBtnGroup);

    const modeGroup = document.createElement("div");
    modeGroup.className = "metric-toggle-group";
    modeGroup.setAttribute("role", "group");
    modeGroup.setAttribute("aria-label", "WebView traffic filter");

    this.modeButtons = [];
    for (const modeDef of [
      { mode: "include", label: "Include WebViews", ariaLabel: "Include Android and iOS WebViews" },
      { mode: "exclude", label: "Exclude WebViews", ariaLabel: "Exclude Android and iOS WebViews" },
    ]) {
      const mBtn = document.createElement("button");
      mBtn.type = "button";
      mBtn.className = "metric-toggle-btn";
      mBtn.setAttribute("data-webview-mode", modeDef.mode);
      mBtn.setAttribute("aria-label", modeDef.ariaLabel);
      mBtn.setAttribute(
        "aria-pressed",
        viewState.webviewMode === modeDef.mode ? "true" : "false"
      );
      mBtn.textContent = modeDef.label;
      mBtn.addEventListener("click", () => {
        viewState.webviewMode = modeDef.mode;
        notifyStateChange("breakdown");
      });
      this.modeButtons.push(mBtn);
      modeGroup.appendChild(mBtn);
    }

    controlsWrap.appendChild(modeGroup);
    this.appendChild(controlsWrap);

    // 2. Bar Summary Banner (Compatible on left, 7-day note in center, Incompatible on right)
    this.barSummaryHeader = document.createElement("div");
    this.barSummaryHeader.className = "breakdown-bar-header";
    this.appendChild(this.barSummaryHeader);

    // 3. Wide Horizontal Stacked Bar Chart Container (SVG + below-bar tooltip)
    this.barContainer = document.createElement("div");
    this.barContainer.className = "breakdown-bar-container";
    this.appendChild(this.barContainer);

    // 4. Narrow Screen Tabs ("Compatible" and "Incompatible")
    const tabsBar = document.createElement("div");
    tabsBar.className = "breakdown-tabs";
    tabsBar.setAttribute("role", "tablist");
    tabsBar.setAttribute("aria-label", "Compatible and Incompatible browser tables");

    this.tabButtons = new Map();
    const tabDefs = [
      { id: "compatible", label: "Compatible" },
      { id: "incompatible", label: "Incompatible" },
    ];
    for (const tabDef of tabDefs) {
      const tabBtn = document.createElement("button");
      tabBtn.type = "button";
      tabBtn.className = `breakdown-tab-btn breakdown-tab-${tabDef.id}`;
      tabBtn.id = `breakdown-tab-${tabDef.id}`;
      tabBtn.setAttribute("role", "tab");
      tabBtn.setAttribute("data-tab-id", tabDef.id);
      tabBtn.setAttribute("aria-controls", `breakdown-panel-${tabDef.id}`);
      tabBtn.setAttribute(
        "aria-selected",
        this.activeMobileTab === tabDef.id ? "true" : "false"
      );
      tabBtn.textContent = tabDef.label;

      tabBtn.addEventListener("click", () => {
        this.activeMobileTab = tabDef.id;
        this.syncMobileTabs();
      });

      tabBtn.addEventListener("keydown", (e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          const nextId = tabDef.id === "compatible" ? "incompatible" : "compatible";
          this.activeMobileTab = nextId;
          this.syncMobileTabs();
          this.tabButtons.get(nextId)?.focus();
        }
      });

      this.tabButtons.set(tabDef.id, tabBtn);
      tabsBar.appendChild(tabBtn);
    }
    this.appendChild(tabsBar);

    // 5. Pair of Sortable Tables (Compatible on left, Incompatible on right)
    this.tablesGrid = document.createElement("div");
    this.tablesGrid.className = "breakdown-tables-grid";
    this.tablesGrid.setAttribute("data-active-tab", this.activeMobileTab);

    this.compatPanel = this.createTablePanel("compatible", "Compatible Browsers");
    this.incompatPanel = this.createTablePanel("incompatible", "Incompatible Browsers");

    this.tablesGrid.appendChild(this.compatPanel.panel);
    this.tablesGrid.appendChild(this.incompatPanel.panel);
    this.appendChild(this.tablesGrid);

    this.updateView(false);
  }

  createTablePanel(side, headingText) {
    const headingId = `breakdown-heading-${side}`;
    const panel = document.createElement("div");
    panel.className = `breakdown-table-panel breakdown-table-panel-${side}`;
    panel.id = `breakdown-panel-${side}`;
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-labelledby", headingId);

    const panelHeader = document.createElement("div");
    panelHeader.className = `breakdown-panel-header breakdown-panel-header-${side}`;

    const titleWrap = document.createElement("div");
    titleWrap.className = "breakdown-panel-title-wrap";

    const dot = document.createElement("span");
    dot.className = `breakdown-status-dot status-dot-${side}`;
    dot.setAttribute("aria-hidden", "true");
    titleWrap.appendChild(dot);

    const h3 = document.createElement("h3");
    h3.className = "breakdown-panel-title";
    h3.id = headingId;
    h3.textContent = headingText;
    titleWrap.appendChild(h3);

    const countBadge = document.createElement("span");
    countBadge.className = "breakdown-count-badge";
    titleWrap.appendChild(countBadge);

    panelHeader.appendChild(titleWrap);

    const totalShareBadge = document.createElement("span");
    totalShareBadge.className = `breakdown-share-badge share-badge-${side}`;
    panelHeader.appendChild(totalShareBadge);

    panel.appendChild(panelHeader);

    const scrollWrap = document.createElement("div");
    scrollWrap.className = "table-wrapper breakdown-table-scroll";

    const table = document.createElement("table");
    table.className = "data-table breakdown-browser-table";

    const caption = document.createElement("caption");
    caption.className = "sr-only";
    caption.textContent = headingText;
    table.appendChild(caption);

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");

    const browserTh = document.createElement("th");
    browserTh.scope = "col";
    browserTh.textContent = "Browser & Version";
    headerRow.appendChild(browserTh);

    const sortHeaders = new Map();
    const columns = [
      { key: "proportion", label: "Traffic Share" },
      { key: "releaseDate", label: "Release Date" },
      { key: "engineReleaseDate", label: "Engine Release" },
    ];

    for (const col of columns) {
      const th = document.createElement("th");
      th.scope = "col";
      th.className = "num-col sortable-th";
      th.setAttribute("aria-sort", "none");

      const sortBtn = document.createElement("button");
      sortBtn.type = "button";
      sortBtn.className = "table-sort-btn";
      sortBtn.setAttribute("data-sort-key", col.key);

      const textSpan = document.createElement("span");
      textSpan.textContent = col.label;
      sortBtn.appendChild(textSpan);

      const iconSpan = document.createElement("span");
      iconSpan.className = "sort-indicator";
      iconSpan.setAttribute("aria-hidden", "true");
      iconSpan.textContent = "↕";
      sortBtn.appendChild(iconSpan);

      sortBtn.addEventListener("click", () => {
        const current = this.sortState[side];
        if (current.key === col.key) {
          current.dir = current.dir === "desc" ? "asc" : "desc";
        } else {
          current.key = col.key;
          current.dir = "desc";
        }
        this.renderTableRows(side);
        const dirWord = current.dir === "asc" ? "ascending" : "descending";
        this.announce(`${headingText} sorted by ${col.label} ${dirWord}.`);
      });

      th.appendChild(sortBtn);
      headerRow.appendChild(th);
      sortHeaders.set(col.key, { th, sortBtn, iconSpan, label: col.label });
    }

    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    table.appendChild(tbody);
    scrollWrap.appendChild(table);
    panel.appendChild(scrollWrap);

    return {
      panel,
      caption,
      countBadge,
      totalShareBadge,
      sortHeaders,
      tbody,
    };
  }

  syncMobileTabs() {
    if (!this.tablesGrid || !this.tabButtons) return;
    this.tablesGrid.setAttribute("data-active-tab", this.activeMobileTab);
    for (const [id, btn] of this.tabButtons.entries()) {
      const isSelected = id === this.activeMobileTab;
      btn.setAttribute("aria-selected", isSelected ? "true" : "false");
    }
  }

  updateView(announceChange = false) {
    if (!this.data) return;

    const subtitleEl = document.querySelector("[data-breakdown-subtitle]");
    if (subtitleEl) {
      const locSuffix =
        viewState.locationValue === "all"
          ? ""
          : ` for ${viewState.locationMeta.name}`;
      subtitleEl.textContent = `Based on the last ${this.data.windowDays} days of available data (${this.data.startDate} to ${this.data.endDate})${locSuffix}. Select a Baseline target below to inspect compatible and incompatible browser versions.`;
    }

    // Update target button states
    if (this.targetButtons) {
      for (const [id, btn] of this.targetButtons.entries()) {
        const isActive = id === this.selectedTargetId;
        btn.toggleAttribute("data-active", isActive);
        btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      }
    }

    // Update WebView toggle buttons
    if (this.modeButtons) {
      for (const btn of this.modeButtons) {
        const isSelected = btn.getAttribute("data-webview-mode") === viewState.webviewMode;
        btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
      }
    }

    const partitioned = this.partitionBrowsersForTarget(this.selectedTargetId);
    this.currentPartition = partitioned;

    // Update mobile tab labels with counts
    const compatTab = this.tabButtons?.get("compatible");
    if (compatTab) {
      compatTab.textContent = `Compatible (${partitioned.compatible.length})`;
    }
    const incompatTab = this.tabButtons?.get("incompatible");
    if (incompatTab) {
      incompatTab.textContent = `Incompatible (${partitioned.incompatible.length})`;
    }

    this.renderHorizontalBar(partitioned);
    this.renderTableRows("compatible");
    this.renderTableRows("incompatible");

    if (announceChange) {
      const targetObj = (this.data.targets || []).find((t) => t.id === this.selectedTargetId);
      const targetLabel = targetObj ? targetObj.label : `Baseline ${this.selectedTargetId}`;
      this.announce(
        `${targetLabel} (${viewState.locationMeta.name}) selected: ${formatPct(partitioned.compatibleSum)} compatible (${partitioned.compatible.length} browser versions), ${formatPct(partitioned.incompatibleSum)} incompatible (${partitioned.incompatible.length} browser versions).`
      );
    }
  }

  formatBrowserLabel(b) {
    if (b.onIos) {
      return `${b.name} (on iOS ${b.version})`;
    }
    return `${b.name} ${b.version}`;
  }

  buildBlockAccessibleDescription(block) {
    const sideLabel = block.side === "compatible" ? "Compatible" : "Incompatible";
    const denomLabel =
      viewState.webviewMode === "exclude"
        ? "of mapped traffic (excluding WebViews)"
        : "of mapped traffic";

    if (block.type === "single") {
      const b = block.browser;
      const parts = [
        `${sideLabel}: ${this.formatBrowserLabel(b)}`,
        `${formatPct(block.share)} ${denomLabel}`,
      ];
      if (b.isDownstream && b.engine) {
        parts.push(`Engine: ${b.engine}${b.engineVersion ? ` ${b.engineVersion}` : ""}`);
      }
      if (b.releaseDate) {
        parts.push(`Released ${b.releaseDate}`);
      }
      if (b.isDownstream && b.engineReleaseDate) {
        parts.push(`Engine released ${b.engineReleaseDate}`);
      }
      return parts.join(", ");
    }

    const topPreview = block.items.slice(0, 3).map((b) => {
      const engInfo =
        b.isDownstream && b.engine
          ? ` (${b.engine}${b.engineVersion ? ` ${b.engineVersion}` : ""})`
          : "";
      return `${this.formatBrowserLabel(b)}${engInfo} ${formatPct(b.share)}`;
    });
    const remaining = block.items.length - topPreview.length;
    const previewSuffix =
      remaining > 0
        ? `Top versions: ${topPreview.join(", ")}, plus ${remaining} more.`
        : `Includes: ${topPreview.join(", ")}.`;
    return `${sideLabel}: ${block.items.length} browser versions each under 0.5% of traffic, combined ${formatPct(block.share)} ${denomLabel}. ${previewSuffix}`;
  }

  renderHorizontalBar(partitioned) {
    if (!this.barContainer || !this.barSummaryHeader) return;
    this.barSummaryHeader.replaceChildren();
    this.barContainer.replaceChildren();

    const targetObj = (this.data.targets || []).find((t) => t.id === this.selectedTargetId);
    const targetLabel = targetObj ? targetObj.label : `Baseline ${this.selectedTargetId}`;
    const locBadge =
      viewState.locationValue === "all" ? "" : ` • ${viewState.locationMeta.name}`;

    // Summary header above the bar
    const leftSummary = document.createElement("div");
    leftSummary.className = "bar-side-summary bar-side-compatible";
    const leftTitle = document.createElement("strong");
    leftTitle.className = "bar-side-pct bar-side-pct-compatible";
    leftTitle.textContent = `${formatPct(partitioned.compatibleSum)} Compatible`;
    const leftMeta = document.createElement("span");
    leftMeta.className = "bar-side-meta";
    leftMeta.textContent = `(fills from 0% left • ${partitioned.compatible.length} versions)`;
    leftSummary.appendChild(leftTitle);
    leftSummary.appendChild(leftMeta);

    const centerNote = document.createElement("div");
    centerNote.className = "bar-center-target-label";
    centerNote.textContent = `${targetLabel}${locBadge} • Last ${this.data.windowDays} days (${this.data.startDate} – ${this.data.endDate})`;

    const rightSummary = document.createElement("div");
    rightSummary.className = "bar-side-summary bar-side-incompatible";
    const rightMeta = document.createElement("span");
    rightMeta.className = "bar-side-meta";
    rightMeta.textContent = `(${partitioned.incompatible.length} versions • fills from 100% right)`;
    const rightTitle = document.createElement("strong");
    rightTitle.className = "bar-side-pct bar-side-pct-incompatible";
    rightTitle.textContent = `${formatPct(partitioned.incompatibleSum)} Incompatible`;
    rightSummary.appendChild(rightMeta);
    rightSummary.appendChild(rightTitle);

    this.barSummaryHeader.appendChild(leftSummary);
    this.barSummaryHeader.appendChild(centerNote);
    this.barSummaryHeader.appendChild(rightSummary);

    // Build blocks for Compatible (starts at 0% on the left) and Incompatible (ends at 100% on the right)
    const compatBlocks = this.buildBarBlocks(partitioned.compatible, "compatible");
    const incompatBlocks = this.buildBarBlocks(partitioned.incompatible, "incompatible");

    const W = 1000;
    const barY = 22;
    const barH = 44;
    const svgH = 148;

    const svg = createSvgEl("svg", {
      viewBox: `0 0 ${W} ${svgH}`,
      class: "breakdown-bar-svg",
      role: "group",
      "aria-label": `Browser compatibility breakdown bar for ${targetLabel} (${viewState.locationMeta.name}) over the last ${this.data.windowDays} days: ${formatPct(partitioned.compatibleSum)} compatible from left, ${formatPct(partitioned.incompatibleSum)} incompatible from right. Use Tab or Left and Right arrow keys to inspect browser segments.`,
    });

    const defs = createSvgEl("defs");
    svg.appendChild(defs);

    // Scale ticks at 0%, 25%, 50%, 75%, 100%
    const scaleGroup = createSvgEl("g", { class: "bar-scale-group", "aria-hidden": "true" });
    for (const pctTick of [0, 25, 50, 75, 100]) {
      const tx = (pctTick / 100) * W;
      const tickLabel = createSvgEl("text", {
        x: tx.toFixed(1),
        y: 14,
        "text-anchor": pctTick === 0 ? "start" : pctTick === 100 ? "end" : "middle",
        class: "axis-label bar-scale-label",
      });
      tickLabel.textContent = `${pctTick}%`;
      scaleGroup.appendChild(tickLabel);
    }
    svg.appendChild(scaleGroup);

    // Full-width background track (0% to 100%)
    const trackRect = createSvgEl("rect", {
      x: 0,
      y: barY,
      width: W,
      height: barH,
      rx: 6,
      class: "breakdown-bar-track",
      "aria-hidden": "true",
    });
    svg.appendChild(trackRect);

    const blocksGroup = createSvgEl("g", { class: "breakdown-bar-segments" });
    svg.appendChild(blocksGroup);

    // Tooltip group rendered below the bar (y = barY + barH + 12)
    const tooltipGroup = createSvgEl("g", {
      class: "breakdown-svg-tooltip",
      "data-visible": "false",
      "aria-hidden": "true",
    });
    const tooltipArrow = createSvgEl("polygon", {
      points: "0,0 -7,8 7,8",
      class: "breakdown-tooltip-arrow",
    });
    const tooltipBox = createSvgEl("g", {
      transform: "translate(0, 8)",
    });
    const tooltipBg = createSvgEl("rect", {
      x: 0,
      y: 0,
      width: 440,
      height: 58,
      rx: 7,
      class: "svg-tooltip-bg breakdown-tooltip-bg",
    });
    const tooltipTitle = createSvgEl("text", {
      x: 14,
      y: 23,
      class: "svg-tooltip-primary breakdown-tooltip-title",
    });
    const tooltipSubtitle = createSvgEl("text", {
      x: 14,
      y: 44,
      class: "svg-tooltip-sub breakdown-tooltip-subtitle",
    });
    tooltipBox.appendChild(tooltipBg);
    tooltipBox.appendChild(tooltipTitle);
    tooltipBox.appendChild(tooltipSubtitle);
    tooltipGroup.appendChild(tooltipArrow);
    tooltipGroup.appendChild(tooltipBox);
    svg.appendChild(tooltipGroup);

    const showBlockTooltip = (block, centerX) => {
      let line1 = "";
      let line2 = "";

      if (block.type === "single") {
        const b = block.browser;
        line1 = `${this.formatBrowserLabel(b)} — ${formatPct(block.share)}`;
        const details = [];
        if (b.isDownstream && b.engine) {
          details.push(`Engine: ${b.engine}${b.engineVersion ? ` ${b.engineVersion}` : ""}`);
        }
        if (b.releaseDate) {
          details.push(`Released: ${b.releaseDate}`);
        }
        if (b.isDownstream && b.engineReleaseDate) {
          details.push(`Engine released: ${b.engineReleaseDate}`);
        }
        details.push(block.side === "compatible" ? "Compatible" : "Incompatible");
        line2 = details.join(" • ");
      } else {
        const sideLabel = block.side === "compatible" ? "Compatible" : "Incompatible";
        line1 = `${sideLabel}: Browsers <0.5% of traffic (${block.items.length} versions) — ${formatPct(block.share)}`;
        const topPreview = block.items.slice(0, 3).map((b) => {
          const engInfo =
            b.isDownstream && b.engine
              ? ` [${b.engine}${b.engineVersion ? ` ${b.engineVersion}` : ""}]`
              : "";
          return `${this.formatBrowserLabel(b)}${engInfo} (${formatPct(b.share)})`;
        });
        const remaining = block.items.length - topPreview.length;
        line2 =
          remaining > 0
            ? `Top: ${topPreview.join(", ")} +${remaining} more`
            : `Includes: ${topPreview.join(", ")}`;
      }

      tooltipTitle.textContent = line1;
      tooltipSubtitle.textContent = line2;
      tooltipSubtitle.setAttribute(
        "class",
        `svg-tooltip-sub breakdown-tooltip-subtitle breakdown-tooltip-sub-${block.side}`
      );

      // Estimate dynamic width from text lengths so long downstream tooltips fit cleanly
      const maxChars = Math.max(line1.length, line2.length);
      const boxW = Math.max(320, Math.min(820, Math.round(maxChars * 7.2) + 32));
      tooltipBg.setAttribute("width", String(boxW));

      const clampedCenterX = Math.max(16, Math.min(W - 16, centerX));
      const boxX = Math.max(4, Math.min(W - boxW - 4, clampedCenterX - boxW / 2));
      const arrowY = barY + barH + 4;

      tooltipArrow.setAttribute("transform", `translate(${clampedCenterX.toFixed(1)}, ${arrowY})`);
      tooltipBox.setAttribute("transform", `translate(${boxX.toFixed(1)}, ${arrowY + 8})`);
      tooltipGroup.setAttribute("data-visible", "true");
    };

    const hideBlockTooltip = () => {
      tooltipGroup.setAttribute("data-visible", "false");
    };

    let clipCounter = 0;
    const segmentGroups = [];
    const renderSegment = (block, xStart, widthPx, idxWithinSide) => {
      if (widthPx <= 0) return;
      const g = createSvgEl("g", {
        class: `bar-segment-group bar-segment-${block.side}`,
        tabindex: "0",
        role: "button",
        "aria-label": this.buildBlockAccessibleDescription(block),
      });

      const shadeIndex = block.type === "compressed" ? "compressed" : String(idxWithinSide % 4);
      const rect = createSvgEl("rect", {
        x: xStart.toFixed(2),
        y: barY,
        width: Math.max(1.5, widthPx).toFixed(2),
        height: barH,
        class: `bar-segment-rect bar-rect-${block.side} bar-rect-shade-${shadeIndex}`,
      });
      g.appendChild(rect);

      // Add clipped inline label if block is wide enough (>= 48px out of 1000px, i.e. >= 4.8%)
      if (widthPx >= 48) {
        clipCounter += 1;
        const clipId = `bar-clip-${this.selectedTargetId}-${clipCounter}`;
        const clipPath = createSvgEl("clipPath", { id: clipId });
        clipPath.appendChild(
          createSvgEl("rect", {
            x: (xStart + 6).toFixed(1),
            y: barY,
            width: Math.max(0, widthPx - 12).toFixed(1),
            height: barH,
          })
        );
        defs.appendChild(clipPath);

        const labelGroup = createSvgEl("g", {
          "clip-path": `url(#${clipId})`,
          class: "bar-segment-label-group",
          "aria-hidden": "true",
        });

        const primaryLabel = createSvgEl("text", {
          x: (xStart + 10).toFixed(1),
          y: barY + 20,
          class: "bar-segment-text-main",
        });
        primaryLabel.textContent =
          block.type === "single"
            ? this.formatBrowserLabel(block.browser)
            : `<0.5% (${block.items.length})`;

        const pctLabel = createSvgEl("text", {
          x: (xStart + 10).toFixed(1),
          y: barY + 35,
          class: "bar-segment-text-pct",
        });
        pctLabel.textContent = formatPct(block.share);

        labelGroup.appendChild(primaryLabel);
        labelGroup.appendChild(pctLabel);
        g.appendChild(labelGroup);
      }

      const centerX = xStart + widthPx / 2;
      const segIndex = segmentGroups.length;
      segmentGroups.push(g);

      g.addEventListener("pointerenter", () => {
        g.setAttribute("data-hovered", "true");
        showBlockTooltip(block, centerX);
      });
      g.addEventListener("pointerleave", () => {
        g.removeAttribute("data-hovered");
        hideBlockTooltip();
      });
      g.addEventListener("focus", () => {
        g.setAttribute("data-hovered", "true");
        showBlockTooltip(block, centerX);
      });
      g.addEventListener("blur", () => {
        g.removeAttribute("data-hovered");
        hideBlockTooltip();
      });
      g.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight") {
          e.preventDefault();
          const next = segmentGroups[Math.min(segmentGroups.length - 1, segIndex + 1)];
          next?.focus();
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          const prev = segmentGroups[Math.max(0, segIndex - 1)];
          prev?.focus();
        } else if (e.key === "Home") {
          e.preventDefault();
          segmentGroups[0]?.focus();
        } else if (e.key === "End") {
          e.preventDefault();
          segmentGroups[segmentGroups.length - 1]?.focus();
        }
      });

      blocksGroup.appendChild(g);
    };

    // 1. Lay out Compatible sections from 0% on the left hand side, highest to lowest left-to-right
    let compatCursorX = 0;
    compatBlocks.forEach((block, idx) => {
      const w = (block.share / 100) * W;
      renderSegment(block, compatCursorX, w, idx);
      compatCursorX += w;
    });

    // 2. Lay out Incompatible sections filling up from the right at 100%,
    // sorted highest proportion to lowest, left to right within the incompatible bar
    const totalIncompatW = incompatBlocks.reduce((acc, b) => acc + (b.share / 100) * W, 0);
    let incompatCursorX = Math.max(compatCursorX, W - totalIncompatW);
    incompatBlocks.forEach((block, idx) => {
      const w = (block.share / 100) * W;
      renderSegment(block, incompatCursorX, w, idx);
      incompatCursorX += w;
    });

    this.barContainer.appendChild(svg);
  }

  sortBrowserItems(items, sortConfig) {
    const { key, dir } = sortConfig;
    const mult = dir === "asc" ? 1 : -1;

    return [...items].sort((a, b) => {
      if (key === "releaseDate" || key === "engineReleaseDate") {
        const dateA = a[key] || null;
        const dateB = b[key] || null;
        // Always place rows without a date after rows with an available date
        if (!dateA && !dateB) return b.share - a.share;
        if (!dateA) return 1;
        if (!dateB) return -1;
        if (dateA !== dateB) {
          return dateA < dateB ? -1 * mult : 1 * mult;
        }
        return b.share - a.share;
      }

      // Default: sort by traffic proportion
      if (a.share !== b.share) {
        return (a.share - b.share) * mult;
      }
      return (a.pct - b.pct) * mult;
    });
  }

  renderTableRows(side) {
    if (!this.currentPartition) return;
    const panelObj = side === "compatible" ? this.compatPanel : this.incompatPanel;
    if (!panelObj) return;

    const rawItems =
      side === "compatible"
        ? this.currentPartition.compatible
        : this.currentPartition.incompatible;
    const totalShare =
      side === "compatible"
        ? this.currentPartition.compatibleSum
        : this.currentPartition.incompatibleSum;

    const targetObj = (this.data?.targets || []).find((t) => t.id === this.selectedTargetId);
    const targetLabel = targetObj ? targetObj.label : `Baseline ${this.selectedTargetId}`;
    const sideTitle = side === "compatible" ? "Compatible browsers" : "Incompatible browsers";

    if (panelObj.caption) {
      panelObj.caption.textContent = `${sideTitle} for ${targetLabel} (${viewState.locationMeta.name}: ${rawItems.length} versions, ${formatPct(totalShare)} total share)`;
    }

    panelObj.countBadge.textContent = `${rawItems.length} version${rawItems.length === 1 ? "" : "s"}`;
    panelObj.totalShareBadge.textContent = formatPct(totalShare);

    const sortCfg = this.sortState[side];
    for (const [colKey, headerObj] of panelObj.sortHeaders.entries()) {
      if (colKey === sortCfg.key) {
        const dirWord = sortCfg.dir === "asc" ? "ascending" : "descending";
        const nextDirWord = sortCfg.dir === "asc" ? "descending" : "ascending";
        headerObj.th.setAttribute("aria-sort", dirWord);
        headerObj.iconSpan.textContent = sortCfg.dir === "asc" ? "↑" : "↓";
        headerObj.sortBtn.setAttribute(
          "aria-label",
          `${headerObj.label}, sorted ${dirWord}. Activate to sort ${nextDirWord}.`
        );
      } else {
        headerObj.th.setAttribute("aria-sort", "none");
        headerObj.iconSpan.textContent = "↕";
        headerObj.sortBtn.setAttribute(
          "aria-label",
          `Sort by ${headerObj.label} descending`
        );
      }
    }

    const sortedItems = this.sortBrowserItems(rawItems, sortCfg);
    panelObj.tbody.replaceChildren();

    if (sortedItems.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 4;
      td.className = "empty-table-cell";
      td.textContent = `No ${side} browsers for this target.`;
      tr.appendChild(td);
      panelObj.tbody.appendChild(tr);
      return;
    }

    const createUnavailableDateContent = () => {
      const wrap = document.createDocumentFragment();
      const dash = document.createElement("span");
      dash.setAttribute("aria-hidden", "true");
      dash.textContent = "—";
      const srText = document.createElement("span");
      srText.className = "sr-only";
      srText.textContent = "Not available";
      wrap.appendChild(dash);
      wrap.appendChild(srText);
      return wrap;
    };

    const fragment = document.createDocumentFragment();
    for (const item of sortedItems) {
      const tr = document.createElement("tr");

      // 1. Browser name + version (+ downstream engine badge if relevant) as row header
      const nameTh = document.createElement("th");
      nameTh.scope = "row";
      nameTh.className = "browser-name-cell";

      const mainName = document.createElement("span");
      mainName.className = "browser-title-text";
      mainName.textContent = this.formatBrowserLabel(item);
      nameTh.appendChild(mainName);

      if (item.isDownstream && item.engine) {
        const engineBadge = document.createElement("span");
        engineBadge.className = "downstream-engine-badge";

        const srOpen = document.createElement("span");
        srOpen.className = "sr-only";
        srOpen.textContent = " (Engine: ";
        engineBadge.appendChild(srOpen);

        engineBadge.appendChild(
          document.createTextNode(`${item.engine}${item.engineVersion ? ` ${item.engineVersion}` : ""}`)
        );

        const srClose = document.createElement("span");
        srClose.className = "sr-only";
        srClose.textContent = ")";
        engineBadge.appendChild(srClose);

        nameTh.appendChild(engineBadge);
      }
      tr.appendChild(nameTh);

      // 2. Proportion in traffic
      const shareTd = document.createElement("td");
      shareTd.className = "num-col share-num-cell";
      shareTd.textContent = formatSharePct(item.share);
      tr.appendChild(shareTd);

      // 3. Release Date (where available)
      const relTd = document.createElement("td");
      relTd.className = "num-col date-cell";
      if (item.releaseDate) {
        relTd.textContent = item.releaseDate;
      } else {
        relTd.classList.add("date-unavailable");
        relTd.appendChild(createUnavailableDateContent());
      }
      tr.appendChild(relTd);

      // 4. Engine Release Date (where available)
      const engRelTd = document.createElement("td");
      engRelTd.className = "num-col date-cell";
      if (item.engineReleaseDate) {
        engRelTd.textContent = item.engineReleaseDate;
      } else {
        engRelTd.classList.add("date-unavailable");
        engRelTd.appendChild(createUnavailableDateContent());
      }
      tr.appendChild(engRelTd);

      fragment.appendChild(tr);
    }

    panelObj.tbody.appendChild(fragment);
  }
}

const CORE_FEATURE_BROWSER_LABELS = [
  { id: "chrome", label: "Chrome", short: "Chrome" },
  { id: "chrome_android", label: "Chrome Android", short: "Chrome And." },
  { id: "edge", label: "Edge", short: "Edge" },
  { id: "firefox", label: "Firefox", short: "Firefox" },
  { id: "firefox_android", label: "Firefox Android", short: "Firefox And." },
  { id: "safari", label: "Safari", short: "Safari" },
  { id: "safari_ios", label: "Safari iOS", short: "Safari iOS" },
];

const CORE_FEATURE_BROWSER_SET = new Set(
  CORE_FEATURE_BROWSER_LABELS.map((b) => b.id)
);

/**
 * Computes per-feature availability metrics for a non-global breakdown payload
 * (region, sub-region, country, or custom combination) and caches them on `breakdownData`.
 * @param {Array<any>} features
 * @param {any} breakdownData
 * @returns {Map<string, { pct: number, pctNoWv: number, androidWv: number, iosWv: number }>}
 */
function getFeatureMetricsMapForBreakdown(features, breakdownData) {
  if (!breakdownData || !Array.isArray(breakdownData.browsers)) {
    return new Map();
  }
  if (breakdownData._featureMetricsById) {
    return breakdownData._featureMetricsById;
  }

  /** @type {Record<string, Array<{ effectiveVer: string | null, pct: number, pctNoWv: number, isAndroidWv: boolean, isIosWv: boolean }>>} */
  const buckets = {
    chrome: [],
    chrome_android: [],
    edge: [],
    firefox: [],
    firefox_android: [],
    safari: [],
    safari_ios: [],
  };

  for (const b of breakdownData.browsers) {
    let coreBrowser;
    if (CORE_FEATURE_BROWSER_SET.has(b.browser)) {
      coreBrowser = b.browser;
    } else if (b.browser === "opera") {
      coreBrowser = "chrome";
    } else if (b.browser === "kai_os") {
      coreBrowser = "firefox_android";
    } else {
      coreBrowser = "chrome_android";
    }

    const effectiveVer = CORE_FEATURE_BROWSER_SET.has(b.browser)
      ? b.version
      : b.engineVersion || (b.browser === "webview_android" ? b.version : null);

    buckets[coreBrowser].push({
      effectiveVer,
      pct: Number(b.pct || 0),
      pctNoWv: Number(b.pctNoWv || 0),
      isAndroidWv: b.browser === "webview_android",
      isIosWv: Boolean(b.onIos && b.name === "Mobile Safari Webview"),
    });
  }

  /** @type {Map<string, { pct: number, pctNoWv: number, androidWv: number, iosWv: number }>} */
  const thresholdCache = new Map();
  const ZERO_SUMS = { pct: 0, pctNoWv: 0, androidWv: 0, iosWv: 0 };

  const getCoreThresholdSums = (coreBrowser, minVer) => {
    if (!minVer) return ZERO_SUMS;
    const key = `${coreBrowser}|${minVer}`;
    const cached = thresholdCache.get(key);
    if (cached) return cached;

    let pct = 0;
    let pctNoWv = 0;
    let androidWv = 0;
    let iosWv = 0;
    const list = buckets[coreBrowser] || [];

    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (
        entry.effectiveVer &&
        compareBrowserVersions(entry.effectiveVer, minVer) >= 0
      ) {
        pct += entry.pct;
        pctNoWv += entry.pctNoWv;
        if (entry.isAndroidWv) androidWv += entry.pct;
        if (entry.isIosWv) iosWv += entry.pct;
      }
    }

    const res = { pct, pctNoWv, androidWv, iosWv };
    thresholdCache.set(key, res);
    return res;
  };

  /** @type {Map<string, { pct: number, pctNoWv: number, androidWv: number, iosWv: number }>} */
  const metricsById = new Map();

  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    const sup = f.support || {};
    let pctSum = 0;
    let pctNoWvSum = 0;
    let androidWvRaw = 0;
    let iosWvRaw = 0;

    for (let bIdx = 0; bIdx < CORE_FEATURE_BROWSER_LABELS.length; bIdx++) {
      const bId = CORE_FEATURE_BROWSER_LABELS[bIdx].id;
      const minVer = sup[bId];
      if (!minVer) continue;
      const sums = getCoreThresholdSums(bId, minVer);
      pctSum += sums.pct;
      pctNoWvSum += sums.pctNoWv;
      androidWvRaw += sums.androidWv;
      iosWvRaw += sums.iosWv;
    }

    metricsById.set(f.id, {
      pct: round2(Math.min(100, Math.max(0, pctSum))),
      pctNoWv: round2(Math.min(100, Math.max(0, pctNoWvSum))),
      androidWv: pctSum > 0 ? round2((androidWvRaw / pctSum) * 100) : 0,
      iosWv: pctSum > 0 ? round2((iosWvRaw / pctSum) * 100) : 0,
    });
  }

  breakdownData._featureMetricsById = metricsById;
  return metricsById;
}

/**
 * <baseline-features-explorer>:
 * Interactive explorer for individual web-features availability percentages,
 * supporting the same location filters (Worldwide, UN M49 Regions, Countries, Custom sets),
 * WebView mode toggle, Baseline status/year filters, category filter, search, and sorting.
 */
class BaselineFeaturesExplorer extends HTMLElement {
  connectedCallback() {
    const bundle = window.BASELINE_FEATURES_DATA;
    if (!bundle || !Array.isArray(bundle.features)) return;

    this.bundle = bundle;
    this.features = bundle.features;
    this.webviewMode = viewState.webviewMode || "include";
    this.locationValue = viewState.locationValue || "all";
    this.locationMeta = viewState.locationMeta;

    // Initialize filters from URL ?target= if present
    this.statusFilter = "all";
    this.yearFilter = "all";
    this.groupFilter = "all";
    this.searchQuery = "";
    this.sortOrder = "pct-desc";
    this.availOp = "all";
    this.availVal = null;
    this.availMax = null;

    if (viewState.urlTargetId) {
      if (
        viewState.urlTargetId === "widely" ||
        viewState.urlTargetId === "newly" ||
        viewState.urlTargetId === "limited"
      ) {
        this.statusFilter = viewState.urlTargetId;
      } else if (/^\d{4}$/.test(viewState.urlTargetId)) {
        this.yearFilter = viewState.urlTargetId;
      }
    }

    this.scopeBadgeEl = this.querySelector("[data-scope-badge]");
    this.subtitleEl = this.querySelector("[data-features-subtitle]");
    this.captionEl = this.querySelector("[data-features-caption]");
    this.pctHeaderEl = this.querySelector("[data-features-pct-header]");
    this.liveRegionEl = this.querySelector("[data-features-live-region]");
    this.tbodyEl = this.querySelector("[data-features-tbody]");
    this.tableWrapEl = this.querySelector(".features-table-wrapper");
    this.emptyStateEl = this.querySelector("[data-features-empty]");
    this.emptyResetBtn = this.querySelector("[data-features-empty-reset]");

    this.kpiMatchingCountEl = this.querySelector("[data-kpi-matching-count]");
    this.kpiMatchingSubEl = this.querySelector("[data-kpi-matching-sub]");
    this.kpiAvgPctEl = this.querySelector("[data-kpi-avg-pct]");
    this.kpiAvgSubEl = this.querySelector("[data-kpi-avg-sub]");
    this.kpi95CountEl = this.querySelector("[data-kpi-95-count]");
    this.kpi95SubEl = this.querySelector("[data-kpi-95-sub]");
    this.kpi99CountEl = this.querySelector("[data-kpi-99-count]");
    this.kpi99SubEl = this.querySelector("[data-kpi-99-sub]");

    this.webviewBtns = Array.from(this.querySelectorAll("[data-webview-mode]"));
    this.statusBtns = Array.from(this.querySelectorAll("[data-status-filter]"));
    this.availPresetBtns = Array.from(this.querySelectorAll("[data-avail-preset]"));
    this.availOpSelect = this.querySelector("[data-features-avail-op]");
    this.availValWrap = this.querySelector("[data-features-avail-val-wrap]");
    this.availValInput = this.querySelector("[data-features-avail-val]");
    this.availSepEl = this.querySelector("[data-features-avail-sep]");
    this.availMaxWrap = this.querySelector("[data-features-avail-max-wrap]");
    this.availMaxInput = this.querySelector("[data-features-avail-max]");
    this.searchInput = this.querySelector("[data-features-search]");
    this.searchClearBtn = this.querySelector("[data-features-search-clear]");
    this.yearSelect = this.querySelector("[data-features-year]");
    this.groupSelect = this.querySelector("[data-features-group]");
    this.sortSelect = this.querySelector("[data-features-sort]");
    this.resetBtn = this.querySelector("[data-features-reset]");
    this.sortHeaderBtns = Array.from(this.querySelectorAll("[data-sort-col]"));

    /** @type {Map<string, { tr: HTMLTableRowElement, pctValueEl: HTMLElement, pctFillRect: SVGRectElement, wvSubEl: HTMLElement, currentPct: number }>} */
    this.rowMap = new Map();
    this.pendingRenderHandle = null;
    this.pendingRenderUsingIdle = false;

    this.bindEvents();
    this.syncFilterControlsUi();
    this.updateView(false);
  }

  cancelPendingRender() {
    if (this.pendingRenderHandle === null) return;
    if (this.pendingRenderUsingIdle && typeof window.cancelIdleCallback === "function") {
      window.cancelIdleCallback(this.pendingRenderHandle);
    } else {
      window.cancelAnimationFrame(this.pendingRenderHandle);
    }
    this.pendingRenderHandle = null;
    this.pendingRenderUsingIdle = false;
  }

  getOrCreateRow(f) {
    const existing = this.rowMap.get(f.id);
    if (existing) return existing;

    const tr = document.createElement("tr");
    tr.className = `feature-row feature-row-${f.statusKind}`;
    tr.dataset.featureId = f.id;

    // 1. Feature Name, ID, Category, Description, and Browser Minimum Versions
    const nameTh = document.createElement("th");
    nameTh.scope = "row";
    nameTh.className = "feature-name-cell";

    const titleRow = document.createElement("div");
    titleRow.className = "feature-title-row";

    const nameSpan = document.createElement("span");
    nameSpan.className = "feature-name-text";
    nameSpan.textContent = f.name;
    titleRow.appendChild(nameSpan);

    const idCode = document.createElement("code");
    idCode.className = "feature-id-badge";
    idCode.textContent = f.id;
    titleRow.appendChild(idCode);

    if (f.groupPath || f.groupName) {
      const groupBadge = document.createElement("span");
      groupBadge.className = "feature-group-badge";
      groupBadge.textContent = f.groupPath || f.groupName;
      titleRow.appendChild(groupBadge);
    }

    if (f.discouraged) {
      const discBadge = document.createElement("span");
      discBadge.className = "feature-discouraged-badge";
      discBadge.textContent = "Discouraged";
      titleRow.appendChild(discBadge);
    }

    nameTh.appendChild(titleRow);

    if (f.description) {
      const descP = document.createElement("p");
      descP.className = "feature-desc-text";
      descP.textContent = f.description;
      nameTh.appendChild(descP);
    }

    const browsersRow = document.createElement("div");
    browsersRow.className = "feature-browsers-row";
    browsersRow.setAttribute("aria-label", "Minimum supported browser versions");

    for (let bIdx = 0; bIdx < CORE_FEATURE_BROWSER_LABELS.length; bIdx++) {
      const bMeta = CORE_FEATURE_BROWSER_LABELS[bIdx];
      const rawVer = f.rawSupport?.[bMeta.id] || f.support?.[bMeta.id] || null;
      const chip = document.createElement("span");
      chip.className = rawVer
        ? "feature-browser-chip is-supported"
        : "feature-browser-chip is-unsupported";

      const bNameSpan = document.createElement("span");
      bNameSpan.className = "feature-browser-chip-name";
      bNameSpan.textContent = `${bMeta.short}: `;
      chip.appendChild(bNameSpan);

      const bVerSpan = document.createElement("span");
      bVerSpan.className = "feature-browser-chip-ver";
      bVerSpan.textContent = rawVer ? `${rawVer}+` : "No";
      chip.appendChild(bVerSpan);

      browsersRow.appendChild(chip);
    }

    nameTh.appendChild(browsersRow);
    tr.appendChild(nameTh);

    // 2. Baseline Status Column
    const statusTd = document.createElement("td");
    statusTd.className = "feature-status-cell";

    const statusBadge = document.createElement("div");
    statusBadge.className = `feature-status-badge feature-status-${f.statusKind}`;

    if (f.statusKind === "widely" || f.statusKind === "newly") {
      const iconImg = document.createElement("img");
      iconImg.src =
        f.statusKind === "widely"
          ? resolveAssetUrl("img/baseline-widely-icon.svg")
          : resolveAssetUrl("img/baseline-newly-icon.svg");
      iconImg.alt = "";
      iconImg.width = 24;
      iconImg.height = 14;
      iconImg.setAttribute("aria-hidden", "true");
      iconImg.className = "feature-status-icon";
      statusBadge.appendChild(iconImg);
    } else {
      const dot = document.createElement("span");
      dot.className = "features-limited-dot";
      dot.setAttribute("aria-hidden", "true");
      statusBadge.appendChild(dot);
    }

    const statusText = document.createElement("span");
    statusText.className = "feature-status-label";
    statusText.textContent = f.statusLabel;
    statusBadge.appendChild(statusText);
    statusTd.appendChild(statusBadge);

    if (f.year || f.lowDate) {
      const metaDiv = document.createElement("div");
      metaDiv.className = "feature-status-meta";
      if (f.year) {
        const yearPill = document.createElement("span");
        yearPill.className = "year-badge feature-year-badge";
        yearPill.textContent = `Baseline ${f.year}`;
        metaDiv.appendChild(yearPill);
      }
      if (f.lowDate) {
        const dateSpan = document.createElement("span");
        dateSpan.className = "feature-date-text";
        dateSpan.textContent = f.lowDate;
        metaDiv.appendChild(dateSpan);
      }
      statusTd.appendChild(metaDiv);
    }

    tr.appendChild(statusTd);

    // 3. User Availability Percentage Column
    const pctTd = document.createElement("td");
    pctTd.className = "primary-metric-cell feature-pct-cell";

    const barCell = document.createElement("div");
    barCell.className = "pct-bar-cell";

    const pctValueEl = document.createElement("span");
    pctValueEl.className = "pct-value-strong";
    pctValueEl.textContent = formatPct(f.pct);
    barCell.appendChild(pctValueEl);

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "pct-bar-svg");
    svg.setAttribute("viewBox", "0 0 100 6");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");

    const trackRect = document.createElementNS(SVG_NS, "rect");
    trackRect.setAttribute("class", "pct-bar-track");
    trackRect.setAttribute("x", "0");
    trackRect.setAttribute("y", "0");
    trackRect.setAttribute("width", "100");
    trackRect.setAttribute("height", "6");
    trackRect.setAttribute("rx", "3");
    svg.appendChild(trackRect);

    const fillRect = document.createElementNS(SVG_NS, "rect");
    const fillKindClass =
      f.statusKind === "widely"
        ? "pct-fill-widely"
        : f.statusKind === "newly"
        ? "pct-fill-newly"
        : "pct-fill-year";
    fillRect.setAttribute("class", `pct-bar-fill ${fillKindClass}`);
    fillRect.setAttribute("x", "0");
    fillRect.setAttribute("y", "0");
    fillRect.setAttribute("width", String(f.pct));
    fillRect.setAttribute("height", "6");
    fillRect.setAttribute("rx", "3");
    svg.appendChild(fillRect);

    barCell.appendChild(svg);
    pctTd.appendChild(barCell);

    const wvSubEl = document.createElement("div");
    wvSubEl.className = "feature-wv-sub";
    wvSubEl.textContent = `Android WV: ${formatPct(f.androidWv)} · iOS WV: ${formatPct(f.iosWv)}`;
    pctTd.appendChild(wvSubEl);

    tr.appendChild(pctTd);

    const rowRef = {
      tr,
      pctValueEl,
      pctFillRect: fillRect,
      wvSubEl,
      currentPct: f.pct,
    };
    this.rowMap.set(f.id, rowRef);
    return rowRef;
  }

  applyItemToRow(item, isExcludeWv) {
    const rowRef = this.getOrCreateRow(item.feature);
    rowRef.currentPct = item.pct;
    rowRef.pctValueEl.textContent = formatPct(item.pct);
    rowRef.pctFillRect.setAttribute("width", String(item.pct));
    if (isExcludeWv) {
      rowRef.wvSubEl.hidden = true;
    } else {
      rowRef.wvSubEl.hidden = false;
      rowRef.wvSubEl.textContent = `Android WV: ${formatPct(item.androidWv)} · iOS WV: ${formatPct(item.iosWv)}`;
    }
    rowRef.tr.hidden = false;
    return rowRef.tr;
  }

  bindEvents() {
    this.webviewBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-webview-mode");
        if (!mode || mode === this.webviewMode) return;
        this.webviewMode = mode;
        viewState.webviewMode = mode;
        this.syncFilterControlsUi();
        this.updateView(true);
        window.dispatchEvent(
          new CustomEvent("baseline:webview-mode-change", {
            detail: { mode },
          })
        );
      });
    });

    window.addEventListener("baseline:webview-mode-change", (e) => {
      const mode = e.detail?.mode || "include";
      if (mode !== this.webviewMode) {
        this.webviewMode = mode;
        this.syncFilterControlsUi();
        this.updateView(false);
      }
    });

    window.addEventListener("baseline:location-change", (e) => {
      this.locationValue = e.detail?.value || "all";
      this.locationMeta = e.detail?.meta || viewState.locationMeta;
      this.updateView(true);
    });

    window.addEventListener("baseline-country-breakdown-ready", () => {
      if (this.locationValue && this.locationValue !== "all") {
        this.updateView(true);
      }
    });

    this.statusBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const status = btn.getAttribute("data-status-filter") || "all";
        if (this.statusFilter === status) return;
        this.statusFilter = status;
        if (status !== "all" && status !== "widely" && status !== "newly") {
          // "limited" features don't have a Baseline year
          this.yearFilter = "all";
        }
        this.syncUrlTarget();
        this.syncFilterControlsUi();
        this.updateView(true);
      });
    });

    this.availPresetBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const preset = btn.getAttribute("data-avail-preset") || "all";
        if (preset === "all") {
          this.availOp = "all";
          this.availVal = null;
          this.availMax = null;
          if (this.availValInput) this.availValInput.value = "";
          if (this.availMaxInput) this.availMaxInput.value = "";
        } else {
          const [op, rawVal] = preset.split(":");
          const numVal = Number(rawVal);
          if (this.availOp === op && this.availVal === numVal && this.availMax === null) {
            // Clicking an active preset chip toggles back to "All"
            this.availOp = "all";
            this.availVal = null;
            this.availMax = null;
            if (this.availValInput) this.availValInput.value = "";
            if (this.availMaxInput) this.availMaxInput.value = "";
          } else {
            this.availOp = op;
            this.availVal = numVal;
            this.availMax = null;
            if (this.availValInput) this.availValInput.value = String(numVal);
            if (this.availMaxInput) this.availMaxInput.value = "";
          }
        }
        this.syncFilterControlsUi();
        this.updateView(true);
      });
    });

    if (this.availOpSelect) {
      this.availOpSelect.addEventListener("change", () => {
        const op = this.availOpSelect.value || "all";
        this.availOp = op;
        if (op === "all") {
          this.availVal = null;
          this.availMax = null;
          if (this.availValInput) this.availValInput.value = "";
          if (this.availMaxInput) this.availMaxInput.value = "";
        } else if (op === "between") {
          if (this.availVal === null) {
            this.availVal = 50;
            if (this.availValInput) this.availValInput.value = "50";
          }
          if (this.availMax === null) {
            this.availMax = 95;
            if (this.availMaxInput) this.availMaxInput.value = "95";
          }
        } else {
          this.availMax = null;
          if (this.availMaxInput) this.availMaxInput.value = "";
          if (this.availVal === null) {
            const defaultVal = op === "lt" || op === "lte" ? 50 : 95;
            this.availVal = defaultVal;
            if (this.availValInput) {
              this.availValInput.value = String(defaultVal);
              this.availValInput.focus();
              this.availValInput.select();
            }
          }
        }
        this.syncFilterControlsUi();
        this.updateView(true);
      });
    }

    if (this.availValInput) {
      this.availValInput.addEventListener("input", () => {
        const raw = this.availValInput.value.trim();
        if (raw === "") {
          this.availVal = null;
          if (this.availOp !== "between") {
            this.availOp = "all";
          }
        } else {
          const parsed = Number(raw);
          if (!Number.isNaN(parsed)) {
            this.availVal = Math.min(100, Math.max(0, parsed));
            if (this.availOp === "all") {
              this.availOp = "gte";
            }
          }
        }
        this.syncFilterControlsUi();
        this.updateView(true);
      });
    }

    if (this.availMaxInput) {
      this.availMaxInput.addEventListener("input", () => {
        const raw = this.availMaxInput.value.trim();
        if (raw === "") {
          this.availMax = null;
        } else {
          const parsed = Number(raw);
          if (!Number.isNaN(parsed)) {
            this.availMax = Math.min(100, Math.max(0, parsed));
          }
        }
        this.syncFilterControlsUi();
        this.updateView(true);
      });
    }

    if (this.yearSelect) {
      this.yearSelect.addEventListener("change", () => {
        this.yearFilter = this.yearSelect.value || "all";
        if (this.yearFilter !== "all" && this.statusFilter === "limited") {
          this.statusFilter = "all";
        }
        this.syncUrlTarget();
        this.syncFilterControlsUi();
        this.updateView(true);
      });
    }

    if (this.groupSelect) {
      this.groupSelect.addEventListener("change", () => {
        this.groupFilter = this.groupSelect.value || "all";
        this.syncFilterControlsUi();
        this.updateView(true);
      });
    }

    if (this.sortSelect) {
      this.sortSelect.addEventListener("change", () => {
        this.sortOrder = this.sortSelect.value || "pct-desc";
        this.syncFilterControlsUi();
        this.updateView(true);
      });
    }

    if (this.searchInput) {
      this.searchInput.addEventListener("input", () => {
        this.searchQuery = (this.searchInput.value || "").trim().toLowerCase();
        this.syncFilterControlsUi();
        this.updateView(true);
      });
    }

    if (this.searchClearBtn && this.searchInput) {
      this.searchClearBtn.addEventListener("click", () => {
        this.searchInput.value = "";
        this.searchQuery = "";
        this.syncFilterControlsUi();
        this.updateView(true);
        this.searchInput.focus();
      });
    }

    const handleResetFilters = () => {
      this.statusFilter = "all";
      this.yearFilter = "all";
      this.groupFilter = "all";
      this.searchQuery = "";
      this.availOp = "all";
      this.availVal = null;
      this.availMax = null;
      if (this.searchInput) this.searchInput.value = "";
      if (this.availValInput) this.availValInput.value = "";
      if (this.availMaxInput) this.availMaxInput.value = "";
      this.syncUrlTarget();
      this.syncFilterControlsUi();
      this.updateView(true);
    };

    if (this.resetBtn) {
      this.resetBtn.addEventListener("click", handleResetFilters);
    }
    if (this.emptyResetBtn) {
      this.emptyResetBtn.addEventListener("click", handleResetFilters);
    }

    this.sortHeaderBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const col = btn.getAttribute("data-sort-col");
        if (col === "pct") {
          this.sortOrder = this.sortOrder === "pct-desc" ? "pct-asc" : "pct-desc";
        } else if (col === "name") {
          this.sortOrder = "name-asc";
        } else if (col === "date") {
          this.sortOrder = this.sortOrder === "date-desc" ? "date-asc" : "date-desc";
        }
        this.syncFilterControlsUi();
        this.updateView(true);
      });
    });

    window.addEventListener("popstate", () => {
      const targetFromUrl = resolveTargetFromUrl();
      viewState.urlTargetId = targetFromUrl;
      if (!targetFromUrl) {
        this.statusFilter = "all";
        this.yearFilter = "all";
      } else if (
        targetFromUrl === "widely" ||
        targetFromUrl === "newly" ||
        targetFromUrl === "limited"
      ) {
        this.statusFilter = targetFromUrl;
        this.yearFilter = "all";
      } else if (/^\d{4}$/.test(targetFromUrl)) {
        this.yearFilter = targetFromUrl;
        if (this.statusFilter === "limited") {
          this.statusFilter = "all";
        }
      }
      this.syncFilterControlsUi();
      this.updateView(false);
    });
  }

  syncUrlTarget() {
    if (this.yearFilter !== "all") {
      viewState.urlTargetId = this.yearFilter;
    } else if (this.statusFilter !== "all") {
      viewState.urlTargetId = this.statusFilter;
    } else {
      viewState.urlTargetId = null;
    }
    pushUrlState();
  }

  hasActiveAvailabilityFilter() {
    if (this.availOp === "all") return false;
    if (this.availOp === "between") {
      return this.availVal !== null || this.availMax !== null;
    }
    return this.availVal !== null;
  }

  matchesAvailabilityFilter(pct) {
    if (!this.hasActiveAvailabilityFilter()) return true;
    if (this.availOp === "gte") return pct >= this.availVal;
    if (this.availOp === "gt") return pct > this.availVal;
    if (this.availOp === "lte") return pct <= this.availVal;
    if (this.availOp === "lt") return pct < this.availVal;
    if (this.availOp === "between") {
      const a = this.availVal !== null ? this.availVal : 0;
      const b = this.availMax !== null ? this.availMax : 100;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      return pct >= lo && pct <= hi;
    }
    return true;
  }

  syncFilterControlsUi() {
    const isExclude = this.webviewMode === "exclude";
    this.webviewBtns.forEach((btn) => {
      const isSelected = btn.getAttribute("data-webview-mode") === this.webviewMode;
      btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
    });

    if (this.pctHeaderEl) {
      this.pctHeaderEl.textContent = isExclude
        ? "User Availability (Excl. WebViews)"
        : "User Availability (Incl. WebViews)";
    }

    this.statusBtns.forEach((btn) => {
      const val = btn.getAttribute("data-status-filter");
      const active = val === this.statusFilter;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });

    const activePresetKey =
      !this.hasActiveAvailabilityFilter()
        ? "all"
        : this.availOp !== "between" && this.availVal !== null
        ? `${this.availOp}:${this.availVal}`
        : "";
    this.availPresetBtns.forEach((btn) => {
      const preset = btn.getAttribute("data-avail-preset");
      const active = preset === activePresetKey;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });

    if (this.availOpSelect && this.availOpSelect.value !== this.availOp) {
      this.availOpSelect.value = this.availOp;
    }

    const isBetween = this.availOp === "between";
    if (this.availSepEl) {
      this.availSepEl.hidden = !isBetween;
    }
    if (this.availMaxWrap) {
      this.availMaxWrap.hidden = !isBetween;
    }

    if (this.yearSelect && this.yearSelect.value !== this.yearFilter) {
      this.yearSelect.value = this.yearFilter;
    }
    if (this.groupSelect && this.groupSelect.value !== this.groupFilter) {
      this.groupSelect.value = this.groupFilter;
    }
    if (this.sortSelect && this.sortSelect.value !== this.sortOrder) {
      this.sortSelect.value = this.sortOrder;
    }
    if (this.searchClearBtn) {
      this.searchClearBtn.hidden = !this.searchQuery;
    }

    const hasActiveFeatureFilter =
      this.statusFilter !== "all" ||
      this.yearFilter !== "all" ||
      this.groupFilter !== "all" ||
      this.hasActiveAvailabilityFilter() ||
      Boolean(this.searchQuery);
    if (this.resetBtn) {
      this.resetBtn.hidden = false;
      this.resetBtn.disabled = !hasActiveFeatureFilter;
    }

    // Update table header sort indicators
    this.sortHeaderBtns.forEach((btn) => {
      const col = btn.getAttribute("data-sort-col");
      const th = btn.closest("th");
      const indicator = btn.querySelector("[data-sort-indicator]");
      let isSorted = false;
      let dir = "descending";
      let arrow = "↕";

      if (col === "pct" && (this.sortOrder === "pct-desc" || this.sortOrder === "pct-asc")) {
        isSorted = true;
        dir = this.sortOrder === "pct-asc" ? "ascending" : "descending";
        arrow = this.sortOrder === "pct-asc" ? "↑" : "↓";
      } else if (col === "name" && this.sortOrder === "name-asc") {
        isSorted = true;
        dir = "ascending";
        arrow = "↑";
      } else if (col === "date" && (this.sortOrder === "date-desc" || this.sortOrder === "date-asc")) {
        isSorted = true;
        dir = this.sortOrder === "date-asc" ? "ascending" : "descending";
        arrow = this.sortOrder === "date-asc" ? "↑" : "↓";
      }

      btn.classList.toggle("is-sorted", isSorted);
      if (th) {
        th.setAttribute("aria-sort", isSorted ? dir : "none");
      }
      if (indicator) {
        indicator.textContent = arrow;
      }
    });
  }

  updateView(announce) {
    this.cancelPendingRender();

    const isGlobal = !this.locationValue || this.locationValue === "all";
    const isExcludeWv = this.webviewMode === "exclude";
    const locMeta = this.locationMeta || viewState.locationMeta;

    // Resolve location-specific feature metrics when a non-Worldwide location is active
    const isLoadingCountryBreakdown = !isGlobal && !window.BASELINE_COUNTRY_BREAKDOWN;
    if (isLoadingCountryBreakdown) {
      ensureCountryBreakdownScriptLoaded();
    }
    const breakdownData = isGlobal ? null : getActiveBreakdownData();
    const customMetricsMap = isGlobal
      ? null
      : getFeatureMetricsMapForBreakdown(this.features, breakdownData);

    if (this.scopeBadgeEl) {
      this.scopeBadgeEl.hidden = false;
      if (isGlobal) {
        this.scopeBadgeEl.textContent = "Worldwide";
      } else if (isLoadingCountryBreakdown) {
        this.scopeBadgeEl.textContent = `${locMeta.name} (loading…)`;
      } else {
        this.scopeBadgeEl.textContent =
          locMeta.kind === "country" && locMeta.code
            ? `${locMeta.name} (${locMeta.code})`
            : locMeta.name;
      }
    }

    if (this.subtitleEl) {
      const wvPhrase = isExcludeWv ? "excluding WebViews" : "including WebViews";
      this.subtitleEl.textContent = `Showing browser compatibility (${wvPhrase}) across ${this.features.length} web platform features over the last ${this.bundle.windowDays} days (${this.bundle.startDate} – ${this.bundle.endDate}).`;
    }

    const matchingItems = [];
    let sumPct = 0;
    let count95 = 0;
    let count99 = 0;

    for (let i = 0; i < this.features.length; i++) {
      const f = this.features[i];

      // Check filters first before computing or creating DOM nodes
      if (this.statusFilter !== "all" && f.statusKind !== this.statusFilter) {
        continue;
      }
      if (this.yearFilter !== "all" && String(f.year) !== this.yearFilter) {
        continue;
      }
      if (this.groupFilter !== "all" && f.group !== this.groupFilter) {
        continue;
      }
      if (this.searchQuery) {
        if (f._searchText === undefined) {
          f._searchText = `${f.name || ""} ${f.id || ""} ${f.description || ""} ${f.groupPath || ""}`.toLowerCase();
        }
        if (!f._searchText.includes(this.searchQuery)) {
          continue;
        }
      }

      let pct;
      let androidWv;
      let iosWv;

      if (isGlobal || !customMetricsMap) {
        pct = isExcludeWv ? Number(f.pctNoWv) : Number(f.pct);
        androidWv = Number(f.androidWv || 0);
        iosWv = Number(f.iosWv || 0);
      } else {
        const m = customMetricsMap.get(f.id);
        pct = m ? (isExcludeWv ? m.pctNoWv : m.pct) : 0;
        androidWv = m ? m.androidWv : 0;
        iosWv = m ? m.iosWv : 0;
      }

      if (!this.matchesAvailabilityFilter(pct)) {
        continue;
      }

      matchingItems.push({ feature: f, pct, androidWv, iosWv });
      sumPct += pct;
      if (pct >= 95) count95++;
      if (pct >= 99) count99++;
    }

    // Sort matching features
    matchingItems.sort((a, b) => {
      if (this.sortOrder === "pct-desc") {
        if (b.pct !== a.pct) {
          return b.pct - a.pct;
        }
        return a.feature.name.localeCompare(b.feature.name);
      }
      if (this.sortOrder === "pct-asc") {
        if (a.pct !== b.pct) {
          return a.pct - b.pct;
        }
        return a.feature.name.localeCompare(b.feature.name);
      }
      if (this.sortOrder === "date-desc") {
        const dA = a.feature.lowDate || "";
        const dB = b.feature.lowDate || "";
        if (dA !== dB) {
          if (!dA) return 1;
          if (!dB) return -1;
          return dB.localeCompare(dA);
        }
        return a.feature.name.localeCompare(b.feature.name);
      }
      if (this.sortOrder === "date-asc") {
        const dA = a.feature.lowDate || "";
        const dB = b.feature.lowDate || "";
        if (dA !== dB) {
          if (!dA) return 1;
          if (!dB) return -1;
          return dA.localeCompare(dB);
        }
        return a.feature.name.localeCompare(b.feature.name);
      }
      return a.feature.name.localeCompare(b.feature.name);
    });

    if (this.tbodyEl) {
      const INITIAL_RENDER_BATCH = 60;
      const CHUNK_RENDER_SIZE = 150;
      const initialCount = Math.min(matchingItems.length, INITIAL_RENDER_BATCH);
      const initialFrag = document.createDocumentFragment();
      for (let i = 0; i < initialCount; i++) {
        initialFrag.appendChild(this.applyItemToRow(matchingItems[i], isExcludeWv));
      }
      this.tbodyEl.replaceChildren(initialFrag);

      if (matchingItems.length > initialCount) {
        let nextIndex = initialCount;
        const appendNextChunk = () => {
          this.pendingRenderHandle = null;
          if (!this.tbodyEl) return;
          const end = Math.min(nextIndex + CHUNK_RENDER_SIZE, matchingItems.length);
          const chunkFrag = document.createDocumentFragment();
          for (let i = nextIndex; i < end; i++) {
            chunkFrag.appendChild(this.applyItemToRow(matchingItems[i], isExcludeWv));
          }
          this.tbodyEl.appendChild(chunkFrag);
          nextIndex = end;
          if (nextIndex < matchingItems.length) {
            scheduleNextChunk();
          }
        };

        const scheduleNextChunk = () => {
          if (typeof window.requestIdleCallback === "function") {
            this.pendingRenderUsingIdle = true;
            this.pendingRenderHandle = window.requestIdleCallback(appendNextChunk, {
              timeout: 120,
            });
          } else {
            this.pendingRenderUsingIdle = false;
            this.pendingRenderHandle = window.requestAnimationFrame(appendNextChunk);
          }
        };

        scheduleNextChunk();
      }
    }

    const matchCount = matchingItems.length;
    const meanPct = matchCount > 0 ? round2(sumPct / matchCount) : 0;

    if (this.kpiMatchingCountEl) {
      this.kpiMatchingCountEl.textContent = String(matchCount);
    }
    if (this.kpiMatchingSubEl) {
      this.kpiMatchingSubEl.textContent = `of ${this.features.length} total features`;
    }
    if (this.kpiAvgPctEl) {
      this.kpiAvgPctEl.textContent = matchCount > 0 ? formatPct(meanPct) : "—";
    }
    if (this.kpiAvgSubEl) {
      this.kpiAvgSubEl.textContent = isExcludeWv
        ? `Across matching features (Excl. WebViews)`
        : `Across matching features (Incl. WebViews)`;
    }
    if (this.kpi95CountEl) {
      this.kpi95CountEl.textContent = String(count95);
    }
    if (this.kpi95SubEl) {
      const share95 = matchCount > 0 ? round2((count95 / matchCount) * 100) : 0;
      this.kpi95SubEl.textContent = `${formatPct(share95)} of matching features`;
    }
    if (this.kpi99CountEl) {
      this.kpi99CountEl.textContent = String(count99);
    }
    if (this.kpi99SubEl) {
      const share99 = matchCount > 0 ? round2((count99 / matchCount) * 100) : 0;
      this.kpi99SubEl.textContent = `${formatPct(share99)} of matching features`;
    }

    if (this.emptyStateEl && this.tableWrapEl) {
      const isEmpty = matchCount === 0;
      this.emptyStateEl.hidden = !isEmpty;
      this.tableWrapEl.hidden = isEmpty;
    }

    if (announce && this.liveRegionEl) {
      this.liveRegionEl.textContent = `Showing ${matchCount} web platform features for ${locMeta.name}. Mean availability: ${formatPct(meanPct)}.`;
    }
  }
}

/**
 * Initializes the top-layer App Drawer (`#drawer`) following the Modern Web Guidance
 * navigation-drawer specification (manual Popover API, CSS scroll-snap, IntersectionObserver
 * lifecycle management, background `inert` state, and Constructable Stylesheet fallback for
 * scroll-driven backdrop opacity under strict CSP).
 */
function initAppDrawer() {
  const drawer = document.querySelector("#drawer");
  if (!drawer) return;

  const scroller = drawer.querySelector(".Drawer-scroller");
  const sheet = drawer.querySelector(".Drawer-sheet");
  const openButton = document.querySelector("#drawer-open");
  const closeButton = document.querySelector("#drawer-close");
  const appShell = document.querySelector("#app-shell");

  if (!scroller || !sheet || !openButton) return;

  syncDrawerLinksWithUrl();
  window.addEventListener("popstate", syncDrawerLinksWithUrl);

  let isDrawerOpen = false;
  let hasEnteredViewport = false;

  const getScrollBehavior = () =>
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "instant"
      : "smooth";

  function onDrawerOpened() {
    isDrawerOpen = true;
    if (appShell) {
      appShell.inert = true;
    }
    openButton.setAttribute("aria-expanded", "true");
    sheet.focus();
  }

  function onDrawerClosed() {
    const wasOpen = isDrawerOpen;
    isDrawerOpen = false;
    hasEnteredViewport = false;
    try {
      drawer.hidePopover();
    } catch {
      // Popover already hidden
    }
    if (appShell) {
      appShell.inert = false;
    }
    openButton.setAttribute("aria-expanded", "false");
    if (wasOpen) {
      openButton.focus();
    }
  }

  function closeDrawer() {
    if (!drawer.matches(":popover-open")) return;
    const behavior = getScrollBehavior();
    if (behavior === "instant" || sheet.offsetWidth === 0) {
      onDrawerClosed();
      return;
    }
    scroller.scrollTo({
      left: sheet.offsetWidth,
      behavior,
    });
  }

  const visibleThreshold = 1 / Math.max(1, window.innerWidth);
  const observer = new IntersectionObserver(
    (entries) => {
      if (!drawer.matches(":popover-open")) return;
      const ratio = entries[0].intersectionRatio;
      if (ratio >= 0.98) {
        hasEnteredViewport = true;
        onDrawerOpened();
      } else if (ratio > visibleThreshold) {
        hasEnteredViewport = true;
      } else if (hasEnteredViewport && ratio <= visibleThreshold) {
        onDrawerClosed();
      }
    },
    {
      root: drawer,
      threshold: [visibleThreshold, 0.98, 1],
    }
  );
  observer.observe(sheet);

  openButton.addEventListener("click", () => {
    hasEnteredViewport = false;
    drawer.showPopover();
    // Ensure scroller starts at the closed snap target on the right before scrolling sheet into view
    if (scroller.scrollLeft === 0 && !isDrawerOpen && sheet.offsetWidth > 0) {
      scroller.scrollLeft = sheet.offsetWidth;
    }
    const behavior = getScrollBehavior();
    sheet.scrollIntoView({ behavior, block: "nearest", inline: "start" });
    if (behavior === "instant") {
      hasEnteredViewport = true;
      onDrawerOpened();
    }
  });

  if (closeButton) {
    closeButton.addEventListener("click", () => {
      closeDrawer();
    });
  }

  // Clicking on the backdrop area outside `.Drawer-sheet` closes the drawer
  scroller.addEventListener("click", (e) => {
    if (e.target === scroller && drawer.matches(":popover-open")) {
      closeDrawer();
    }
  });

  // Escape key closes the manual popover drawer
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drawer.matches(":popover-open")) {
      e.preventDefault();
      closeDrawer();
    }
  });

  // Fallback for browsers without CSS scroll-driven animations, using a Constructable Stylesheet
  // to comply with `style-src 'self'` CSP (no inline style attributes)
  if (
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    !CSS.supports("animation-timeline: scroll()") &&
    typeof CSSStyleSheet !== "undefined" &&
    document.adoptedStyleSheets
  ) {
    const fallbackSheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, fallbackSheet];
    scroller.addEventListener(
      "scroll",
      () => {
        const w = sheet.offsetWidth;
        const progress = w > 0 ? Math.max(0, Math.min(1, 1 - scroller.scrollLeft / w)) : 0;
        fallbackSheet.replaceSync(`#drawer { --drawer-backdrop: ${progress.toFixed(3)}; }`);
      },
      { passive: true }
    );
  }
}

initThemeToggle();
initAppDrawer();

if (!customElements.get("baseline-location-filter")) {
  customElements.define("baseline-location-filter", BaselineLocationFilter);
}

if (!customElements.get("baseline-summary-table")) {
  customElements.define("baseline-summary-table", BaselineSummaryTable);
}

if (!customElements.get("baseline-timeseries-chart")) {
  customElements.define("baseline-timeseries-chart", BaselineTimeseriesChart);
}

if (!customElements.get("baseline-browser-breakdown")) {
  customElements.define("baseline-browser-breakdown", BaselineBrowserBreakdown);
}

if (!customElements.get("baseline-features-explorer")) {
  customElements.define("baseline-features-explorer", BaselineFeaturesExplorer);
}


