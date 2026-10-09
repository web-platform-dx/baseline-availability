import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCompatibleVersions, getTimeline } from "baseline-browser-mapping";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, "..");
const AGGREGATES_DIR = path.resolve(PROJECT_ROOT, "src", "_data", "bigquery", "global_daily_aggregates");
const COUNTRY_AGGREGATES_DIR = path.resolve(PROJECT_ROOT, "src", "_data", "bigquery", "country_daily_aggregates");
const OUTPUT_DIR = path.resolve(PROJECT_ROOT, "src", "_data", "baseline_daily");
const COUNTRY_DAILY_OUTPUT_DIR = path.resolve(PROJECT_ROOT, "src", "_data", "baseline_country_daily");

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const VERSION_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Safely resolves a filename inside a target directory, preventing path traversal.
 * @param {string} baseDir
 * @param {string} fileName
 * @returns {string}
 */
function resolveSafeFilePath(baseDir, fileName) {
  const safeName = path.basename(fileName);
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, safeName);
  if (!resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Invalid file path outside target directory: ${fileName}`);
  }
  return resolvedTarget;
}

/**
 * Compares two version strings (e.g. "15.6" vs "16" or "153" vs "121").
 * Returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal.
 * @param {string} v1
 * @param {string} v2
 * @returns {number}
 */
function compareVersions(v1, v2) {
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
 * Checks whether a value is a numeric major or major.minor version string.
 * @param {unknown} value
 * @returns {value is string | number}
 */
function isValidVersion(value) {
  if (value === null || value === undefined || value === "") return false;
  return VERSION_PATTERN.test(String(value));
}

/**
 * Extracts the major version component as a string.
 * @param {string | number} version
 * @returns {string}
 */
function getMajorVersion(version) {
  return String(version).split(".")[0];
}

/**
 * Builds lookup tables from `baseline-browser-mapping` for fast version resolution.
 */
function buildBbmLookups() {
  const allKnownVersions = getCompatibleVersions({
    targetYear: 2002,
    listAllCompatibleVersions: true,
    includeDownstreamBrowsers: true,
    suppressWarnings: true,
  });

  /** @type {Record<string, Set<string>>} */
  const knownVersionsByBrowser = {};
  /** @type {Record<string, Record<string, { releaseDate: string | null, engine: string | null, engineVersion: string | null }>>} */
  const versionMetaByBrowser = {};
  for (const entry of allKnownVersions) {
    if (!knownVersionsByBrowser[entry.browser]) {
      knownVersionsByBrowser[entry.browser] = new Set();
    }
    knownVersionsByBrowser[entry.browser].add(entry.version);

    if (!versionMetaByBrowser[entry.browser]) {
      versionMetaByBrowser[entry.browser] = {};
    }
    const relDate =
      typeof entry.release_date === "string" && DATE_PATTERN.test(entry.release_date)
        ? entry.release_date
        : null;
    versionMetaByBrowser[entry.browser][entry.version] = {
      releaseDate: relDate,
      engine: entry.engine || null,
      engineVersion: entry.engine_version || null,
    };
  }

  const safariMajorVersions = new Set();
  for (const b of ["safari", "safari_ios"]) {
    for (const ver of knownVersionsByBrowser[b] || []) {
      safariMajorVersions.add(getMajorVersion(ver));
    }
  }

  const timelineEvents = getTimeline({
    includeDownstreamBrowsers: true,
    listAllBrowsers: true,
  });

  return {
    knownVersionsByBrowser,
    versionMetaByBrowser,
    safariMajorVersions,
    timelineEvents,
  };
}

const DOWNSTREAM_SHORT_TO_BBM = {
  sa: "samsunginternet_android",
  oa: "opera_android",
  o: "opera",
  u: "uc_android",
  y: "ya_android",
  ysa: "ya_android",
  fb: "facebook_android",
  ia: "instagram_android",
};

const ANDROID_WEBVIEW_FAMILIES = new Set([
  "wva",
  "Chrome Mobile Webview",
]);

const IOS_WEBVIEW_FAMILIES = new Set([
  "siw",
  "Mobile Safari Webview",
]);

const BLINK_BROWSER_SHORTS = new Set([
  "c",
  "ca",
  "e",
  "wva",
  "sa",
  "oa",
  "o",
  "u",
  "y",
  "ysa",
  "fb",
  "ia",
  "cd",
  "cr",
  "stv",
  "slk",
  "yd",
  "uc",
  "puf",
  "brv",
  "cc",
]);

/**
 * Identifies whether a row represents an Android WebView (`wva`) or iOS WebView (`siw`).
 * @param {unknown[]} row
 * @param {Record<string, number>} colIdx
 * @returns {"android" | "ios" | null}
 */
function getWebviewType(row, colIdx) {
  const ua = String(row[colIdx.USERAGENTFAMILY] ?? "");
  if (ANDROID_WEBVIEW_FAMILIES.has(ua)) return "android";
  if (IOS_WEBVIEW_FAMILIES.has(ua)) return "ios";
  return null;
}

/**
 * Resolves a daily aggregate row to a `baseline-browser-mapping` browser ID and version.
 *
 * Rules:
 * 1. iOS (`OS === "iOS"`):
 *    - If `USERAGENTFAMILY` is Mobile Safari (`"si"`), map to `safari_ios` using `USERAGENTVERSION`.
 *    - If `USERAGENTFAMILY` is not Mobile Safari, map to `safari_ios` using `OSVERSION`.
 *    - If the required version is unavailable or invalid, return `null` (recorded as unmapped).
 * 2. Android (`OS === "Android OS"`):
 *    - Chrome Mobile Webview (`"wva"`) maps to `webview_android` and all other Blink browsers map to
 *      `chrome_android` using their engine version (`USERAGENTENGINEVERSION`, or `USERAGENTVERSION`
 *      for Chromium-versioned families).
 *    - Gecko browsers map to `firefox_android` using their engine version (`USERAGENTENGINEVERSION`
 *      or `USERAGENTVERSION`).
 * 3. Other OSes (Desktop / etc.):
 *    - WebKit / Safari rows map to `safari` using `USERAGENTVERSION` (or `OSVERSION` >= 26 on macOS).
 *    - Blink rows map to `edge` (`"e"`), `chrome_android` (`"ca"`), `webview_android` (`"wva"`), or `chrome`.
 *    - Gecko rows map to `firefox` (or `firefox_android` for `"fa"`).
 *
 * @param {unknown[]} row
 * @param {Record<string, number>} colIdx
 * @param {ReturnType<typeof buildBbmLookups>} lookups
 * @returns {{ browser: string, version: string } | null}
 */
function resolveRowToBaselineBrowser(row, colIdx, lookups) {
  const ua = String(row[colIdx.USERAGENTFAMILY] ?? "");
  const uav = row[colIdx.USERAGENTVERSION];
  const eng = String(row[colIdx.USERAGENTENGINE] ?? "");
  const engv = row[colIdx.USERAGENTENGINEVERSION];
  const os = String(row[colIdx.OS] ?? "");
  const osv = row[colIdx.OSVERSION];

  // 1. All iOS rows map to safari_ios: Mobile Safari via UAVERSION, all others via OSVERSION
  if (os === "iOS") {
    const isMobileSafari = ua === "si" || ua === "Mobile Safari";
    const candidateVersion = isMobileSafari ? uav : osv;
    if (
      isValidVersion(candidateVersion) &&
      lookups.safariMajorVersions.has(getMajorVersion(candidateVersion))
    ) {
      return { browser: "safari_ios", version: String(candidateVersion) };
    }
    return null;
  }

  const isBlink = eng === "Blink";
  const isGecko = eng === "Gecko";
  const isWebKit = eng === "WebKit" || eng === "Web Kit";

  // 2. Android OS rows: map Blink to chrome_android (or webview_android for wva) and Gecko to firefox_android
  if (os === "Android OS") {
    if (isBlink || BLINK_BROWSER_SHORTS.has(ua)) {
      const targetBrowser = ANDROID_WEBVIEW_FAMILIES.has(ua) ? "webview_android" : "chrome_android";
      if (isValidVersion(engv)) {
        return { browser: targetBrowser, version: String(engv) };
      }

      if (!Object.hasOwn(DOWNSTREAM_SHORT_TO_BBM, ua) && isValidVersion(uav)) {
        return { browser: targetBrowser, version: String(uav) };
      }

      return null;
    }

    if (isGecko || ua === "f" || ua === "fa") {
      const geckoVersion = isValidVersion(engv)
        ? String(engv)
        : isValidVersion(uav)
          ? String(uav)
          : null;

      if (geckoVersion) {
        return { browser: "firefox_android", version: geckoVersion };
      }
    }

    return null;
  }

  // 3. Non-iOS WebKit / Safari rows (e.g. macOS Safari)
  if (isWebKit || ua === "s" || ua === "si" || ua === "siw") {
    const targetBrowser = os === "Mac OS X" || ua === "s" ? "safari" : "safari_ios";

    if (isValidVersion(uav) && lookups.safariMajorVersions.has(getMajorVersion(uav))) {
      return { browser: targetBrowser, version: String(uav) };
    }

    if (isValidVersion(osv) && lookups.safariMajorVersions.has(getMajorVersion(osv))) {
      if (Number(getMajorVersion(osv)) >= 26) {
        return { browser: targetBrowser, version: String(osv) };
      }
    }

    return null;
  }

  // 4. Non-Android Blink rows
  if (isBlink || BLINK_BROWSER_SHORTS.has(ua)) {
    if (!isValidVersion(engv) && Object.hasOwn(DOWNSTREAM_SHORT_TO_BBM, ua)) {
      if (isValidVersion(uav)) {
        const bbmBrowser = DOWNSTREAM_SHORT_TO_BBM[ua];
        const knownSet = lookups.knownVersionsByBrowser[bbmBrowser];
        const uavStr = String(uav);
        if (knownSet?.has(uavStr)) {
          return { browser: bbmBrowser, version: uavStr };
        }
        if (knownSet?.has(`${uavStr}.0`)) {
          return { browser: bbmBrowser, version: `${uavStr}.0` };
        }
      }
      return null;
    }

    const blinkVersion = isValidVersion(engv)
      ? String(engv)
      : isValidVersion(uav)
        ? String(uav)
        : null;

    if (blinkVersion) {
      if (ua === "e") return { browser: "edge", version: blinkVersion };
      if (ua === "wva") return { browser: "webview_android", version: blinkVersion };
      if (ua === "ca") return { browser: "chrome_android", version: blinkVersion };
      return { browser: "chrome", version: blinkVersion };
    }

    return null;
  }

  // 5. Non-Android Gecko rows
  if (isGecko || ua === "f" || ua === "fa") {
    const geckoVersion = isValidVersion(engv)
      ? String(engv)
      : isValidVersion(uav)
        ? String(uav)
        : null;

    if (geckoVersion) {
      return {
        browser: ua === "fa" ? "firefox_android" : "firefox",
        version: geckoVersion,
      };
    }

    return null;
  }

  return null;
}

/**
 * Converts an array of BrowserVersion objects into a `{ [browser]: minVersion }` map.
 * @param {Array<{ browser: string, version: string }>} versions
 * @returns {Record<string, string>}
 */
function toMinVersionMap(versions) {
  /** @type {Record<string, string>} */
  const map = {};
  for (const item of versions) {
    map[item.browser] = item.version;
  }
  return map;
}

/**
 * Returns the minimum browser versions required for Newly available features on `cutoffDate`
 * using the `baseline-browser-mapping` timeline.
 * @param {string} cutoffDate
 * @param {Array<{ date: string, browsers: Array<{ browser: string, version: string }> }>} timelineEvents
 * @returns {Record<string, string>}
 */
function getNewlyAvailableMinVersionsOnDate(cutoffDate, timelineEvents) {
  let latestBrowsers = [];
  for (const event of timelineEvents) {
    if (event.date <= cutoffDate) {
      latestBrowsers = event.browsers;
    } else {
      break;
    }
  }
  return toMinVersionMap(latestBrowsers);
}

/**
 * Rounds a number to 2 decimal places.
 * @param {number} value
 * @returns {number}
 */
function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Formats compatibility metrics for a single Baseline target, including separated
 * Android WebView (`wva`) and iOS WebView (`siw`) proportions.
 * @param {number} compatiblePageLoads
 * @param {number} androidWebviewCompatiblePageLoads
 * @param {number} iosWebviewCompatiblePageLoads
 * @param {number} mappedPageLoads
 * @param {number} totalPageLoads
 */
function formatTargetMetrics(
  compatiblePageLoads,
  androidWebviewCompatiblePageLoads,
  iosWebviewCompatiblePageLoads,
  mappedPageLoads,
  totalPageLoads
) {
  return {
    compatiblePageLoads,
    percentage: mappedPageLoads > 0 ? round2((compatiblePageLoads / mappedPageLoads) * 100) : 0,
    percentageOfTotal: totalPageLoads > 0 ? round2((compatiblePageLoads / totalPageLoads) * 100) : 0,
    androidWebviewCompatiblePageLoads,
    androidWebviewPercentageOfCompatible:
      compatiblePageLoads > 0
        ? round2((androidWebviewCompatiblePageLoads / compatiblePageLoads) * 100)
        : 0,
    androidWebviewPercentageOfMapped:
      mappedPageLoads > 0 ? round2((androidWebviewCompatiblePageLoads / mappedPageLoads) * 100) : 0,
    androidWebviewPercentageOfTotal:
      totalPageLoads > 0 ? round2((androidWebviewCompatiblePageLoads / totalPageLoads) * 100) : 0,
    iosWebviewCompatiblePageLoads,
    iosWebviewPercentageOfCompatible:
      compatiblePageLoads > 0
        ? round2((iosWebviewCompatiblePageLoads / compatiblePageLoads) * 100)
        : 0,
    iosWebviewPercentageOfMapped:
      mappedPageLoads > 0 ? round2((iosWebviewCompatiblePageLoads / mappedPageLoads) * 100) : 0,
    iosWebviewPercentageOfTotal:
      totalPageLoads > 0 ? round2((iosWebviewCompatiblePageLoads / totalPageLoads) * 100) : 0,
  };
}

/**
 * Processes all daily aggregate files in `src/_data/bigquery/global_daily_aggregates/`
 * and writes corresponding daily Baseline compatibility files to `src/_data/baseline_daily/`.
 * @param {{ force?: boolean }} [options]
 */
export async function calculateAllDailyBaseline({ force = false } = {}) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  let entries = [];
  try {
    entries = await fs.readdir(AGGREGATES_DIR);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("No daily aggregate directory found yet; skipping Baseline calculation.");
      return;
    }
    throw error;
  }

  const dailyFiles = entries
    .filter((f) => f.endsWith(".json") && DATE_PATTERN.test(f.slice(0, -5)))
    .sort();

  if (dailyFiles.length === 0) {
    console.log("No daily aggregate files found; skipping Baseline calculation.");
    return;
  }

  const lookups = buildBbmLookups();

  for (const fileName of dailyFiles) {
    const dateStr = fileName.slice(0, -5);
    const outputPath = resolveSafeFilePath(OUTPUT_DIR, `${dateStr}.json`);

    if (!force) {
      try {
        await fs.access(outputPath);
        continue;
      } catch {
        // Output file does not exist yet; proceed to calculate
      }
    }

    const inputPath = resolveSafeFilePath(AGGREGATES_DIR, fileName);
    const raw = JSON.parse(await fs.readFile(inputPath, "utf8"));
    const schema = Array.isArray(raw.schema) ? raw.schema : [];
    const rows = Array.isArray(raw.rows) ? raw.rows : [];

    /** @type {Record<string, number>} */
    const colIdx = {};
    schema.forEach((col, idx) => {
      colIdx[col] = idx;
    });

    const dataYear = Number(dateStr.slice(0, 4));

    // Build minimum browser version maps for each target on `dateStr`
    const widelyMinMap = toMinVersionMap(
      getCompatibleVersions({
        widelyAvailableOnDate: dateStr,
        includeDownstreamBrowsers: true,
        suppressWarnings: true,
      })
    );

    const newlyMinMap = getNewlyAvailableMinVersionsOnDate(dateStr, lookups.timelineEvents);

    /** @type {Record<string, Record<string, string>>} */
    const annualMinMaps = {};
    for (let year = 2015; year <= dataYear; year++) {
      const yearEndCutoff = `${year}-12-31` <= dateStr ? `${year}-12-31` : dateStr;
      annualMinMaps[String(year)] = getNewlyAvailableMinVersionsOnDate(
        yearEndCutoff,
        lookups.timelineEvents
      );
    }

    let totalPageLoads = 0;
    let mappedPageLoads = 0;
    let androidWebviewPageLoads = 0;
    let mappedAndroidWebviewPageLoads = 0;
    let iosWebviewPageLoads = 0;
    let mappedIosWebviewPageLoads = 0;
    let widelyCompatibleLoads = 0;
    let widelyAndroidWebviewCompatibleLoads = 0;
    let widelyIosWebviewCompatibleLoads = 0;
    let newlyCompatibleLoads = 0;
    let newlyAndroidWebviewCompatibleLoads = 0;
    let newlyIosWebviewCompatibleLoads = 0;
    /** @type {Record<string, number>} */
    const annualCompatibleLoads = Object.fromEntries(
      Object.keys(annualMinMaps).map((year) => [year, 0])
    );
    /** @type {Record<string, number>} */
    const annualAndroidWebviewCompatibleLoads = Object.fromEntries(
      Object.keys(annualMinMaps).map((year) => [year, 0])
    );
    /** @type {Record<string, number>} */
    const annualIosWebviewCompatibleLoads = Object.fromEntries(
      Object.keys(annualMinMaps).map((year) => [year, 0])
    );

    const countCol = colIdx.TOTAL ?? colIdx.count;
    for (const row of rows) {
      const count = Number(row[countCol] || 0);
      totalPageLoads += count;

      const webviewType = getWebviewType(row, colIdx);
      if (webviewType === "android") {
        androidWebviewPageLoads += count;
      } else if (webviewType === "ios") {
        iosWebviewPageLoads += count;
      }

      const resolved = resolveRowToBaselineBrowser(row, colIdx, lookups);
      if (!resolved) {
        continue;
      }

      mappedPageLoads += count;
      if (webviewType === "android") {
        mappedAndroidWebviewPageLoads += count;
      } else if (webviewType === "ios") {
        mappedIosWebviewPageLoads += count;
      }

      const widelyMin = widelyMinMap[resolved.browser];
      if (widelyMin !== undefined && compareVersions(resolved.version, widelyMin) >= 0) {
        widelyCompatibleLoads += count;
        if (webviewType === "android") {
          widelyAndroidWebviewCompatibleLoads += count;
        } else if (webviewType === "ios") {
          widelyIosWebviewCompatibleLoads += count;
        }
      }

      const newlyMin = newlyMinMap[resolved.browser];
      if (newlyMin !== undefined && compareVersions(resolved.version, newlyMin) >= 0) {
        newlyCompatibleLoads += count;
        if (webviewType === "android") {
          newlyAndroidWebviewCompatibleLoads += count;
        } else if (webviewType === "ios") {
          newlyIosWebviewCompatibleLoads += count;
        }
      }

      for (const [year, minMap] of Object.entries(annualMinMaps)) {
        const minVer = minMap[resolved.browser];
        if (minVer !== undefined && compareVersions(resolved.version, minVer) >= 0) {
          annualCompatibleLoads[year] += count;
          if (webviewType === "android") {
            annualAndroidWebviewCompatibleLoads[year] += count;
          } else if (webviewType === "ios") {
            annualIosWebviewCompatibleLoads[year] += count;
          }
        }
      }
    }

    /** @type {Record<string, ReturnType<typeof formatTargetMetrics>>} */
    const annualTargets = {};
    for (const [year, loads] of Object.entries(annualCompatibleLoads)) {
      annualTargets[year] = formatTargetMetrics(
        loads,
        annualAndroidWebviewCompatibleLoads[year],
        annualIosWebviewCompatibleLoads[year],
        mappedPageLoads,
        totalPageLoads
      );
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      date: dateStr,
      totalPageLoads,
      mappedPageLoads,
      unmappedPageLoads: totalPageLoads - mappedPageLoads,
      mappedPercentage: totalPageLoads > 0 ? round2((mappedPageLoads / totalPageLoads) * 100) : 0,
      androidWebviewPageLoads,
      mappedAndroidWebviewPageLoads,
      unmappedAndroidWebviewPageLoads: androidWebviewPageLoads - mappedAndroidWebviewPageLoads,
      androidWebviewPercentageOfTotal:
        totalPageLoads > 0 ? round2((androidWebviewPageLoads / totalPageLoads) * 100) : 0,
      androidWebviewPercentageOfMapped:
        mappedPageLoads > 0 ? round2((mappedAndroidWebviewPageLoads / mappedPageLoads) * 100) : 0,
      iosWebviewPageLoads,
      mappedIosWebviewPageLoads,
      unmappedIosWebviewPageLoads: iosWebviewPageLoads - mappedIosWebviewPageLoads,
      iosWebviewPercentageOfTotal:
        totalPageLoads > 0 ? round2((iosWebviewPageLoads / totalPageLoads) * 100) : 0,
      iosWebviewPercentageOfMapped:
        mappedPageLoads > 0 ? round2((mappedIosWebviewPageLoads / mappedPageLoads) * 100) : 0,
      widelyAvailable: formatTargetMetrics(
        widelyCompatibleLoads,
        widelyAndroidWebviewCompatibleLoads,
        widelyIosWebviewCompatibleLoads,
        mappedPageLoads,
        totalPageLoads
      ),
      newlyAvailable: formatTargetMetrics(
        newlyCompatibleLoads,
        newlyAndroidWebviewCompatibleLoads,
        newlyIosWebviewCompatibleLoads,
        mappedPageLoads,
        totalPageLoads
      ),
      annualTargets,
    };

    await fs.writeFile(outputPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    console.log(
      `Wrote Baseline compatibility for ${dateStr} -> ${path.relative(PROJECT_ROOT, outputPath)} ` +
        `(Widely: ${payload.widelyAvailable.percentage}%, Newly: ${payload.newlyAvailable.percentage}%)`
    );
  }

  await writeInitialViewBundle();
  await calculateAllCountryDailyBaseline({ force, lookups });
}

const SUMMARY_DATA_PATH = path.resolve(PROJECT_ROOT, "src", "_data", "baseline_summary.json");
const BREAKDOWN_DATA_PATH = path.resolve(
  PROJECT_ROOT,
  "src",
  "_data",
  "baseline_browser_breakdown.json"
);
const INITIAL_JS_BUNDLE_PATH = path.resolve(PROJECT_ROOT, "src", "assets", "js", "baseline-initial-data.js");
const BREAKDOWN_JS_BUNDLE_PATH = path.resolve(
  PROJECT_ROOT,
  "src",
  "assets",
  "js",
  "baseline-browser-breakdown.js"
);
const COUNTRY_SUMMARY_DATA_PATH = path.resolve(
  PROJECT_ROOT,
  "src",
  "_data",
  "baseline_country_summary.json"
);
const COUNTRY_BREAKDOWN_DATA_PATH = path.resolve(
  PROJECT_ROOT,
  "src",
  "_data",
  "baseline_country_browser_breakdown.json"
);
const COUNTRY_INITIAL_JS_BUNDLE_PATH = path.resolve(
  PROJECT_ROOT,
  "src",
  "assets",
  "js",
  "baseline-country-data.js"
);
const COUNTRY_BREAKDOWN_JS_BUNDLE_PATH = path.resolve(
  PROJECT_ROOT,
  "src",
  "assets",
  "js",
  "baseline-country-breakdown.js"
);
const MAX_CHART_DAYS = 90;
const AVG_WINDOW_DAYS = 7;

const BBM_BROWSER_NAMES = {
  chrome: "Chrome",
  chrome_android: "Chrome for Android",
  edge: "Edge",
  firefox: "Firefox",
  firefox_android: "Firefox for Android",
  safari: "Safari",
  safari_ios: "Safari on iOS",
  webview_android: "WebView Android",
  samsunginternet_android: "Samsung Internet",
  opera: "Opera",
  opera_android: "Opera Android",
  uc_android: "UC Browser Mobile",
  ya_android: "Yandex Browser Mobile",
  qq_android: "QQ Browser Mobile",
  facebook_android: "Facebook for Android",
  instagram_android: "Instagram for Android",
  kai_os: "KaiOS",
};

const DOWNSTREAM_BBM_BROWSERS = new Set([
  "webview_android",
  "samsunginternet_android",
  "opera",
  "opera_android",
  "uc_android",
  "ya_android",
  "qq_android",
  "facebook_android",
  "instagram_android",
  "kai_os",
]);

/**
 * Rounds a number to 4 decimal places for fine-grained browser share precision.
 * @param {number} value
 * @returns {number}
 */
function round4(value) {
  return Math.round(value * 10000) / 10000;
}

/**
 * Delta-encodes an array of percentage values in basis points (0..10000).
 * Collapses constant series (e.g. all zeros) to a single integer.
 * @param {number[]} values
 * @returns {number | number[]}
 */
function encodeBasisPointsSeries(values) {
  const bp = values.map((v) => Math.round(Number(v || 0) * 100));
  if (bp.length === 0) return 0;
  const first = bp[0];
  if (bp.every((v) => v === first)) {
    return first;
  }
  const out = [first];
  for (let i = 1; i < bp.length; i++) {
    out.push(bp[i] - bp[i - 1]);
  }
  return out;
}

/**
 * Computes the arithmetic mean rounded to 2 decimal places.
 * @param {number[]} values
 * @returns {number}
 */
function meanRound2(values) {
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, v) => acc + Number(v || 0), 0);
  return round2(sum / values.length);
}

/**
 * Aggregates browser versions over the last 7 days of raw daily aggregate files and writes:
 * 1. `src/_data/baseline_browser_breakdown.json` for build-time template metadata
 * 2. `src/assets/js/baseline-browser-breakdown.js` for the interactive horizontal breakdown bar chart and sortable tables
 */
export async function writeBrowserBreakdownBundle() {
  let aggEntries = [];
  try {
    aggEntries = await fs.readdir(AGGREGATES_DIR);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  const dailyFiles = aggEntries
    .filter((f) => f.endsWith(".json") && DATE_PATTERN.test(f.slice(0, -5)))
    .sort();

  if (dailyFiles.length === 0) return;

  const recentFiles = dailyFiles.slice(-AVG_WINDOW_DAYS);
  const recentDates = recentFiles.map((f) => f.slice(0, -5));
  const startDate = recentDates[0];
  const endDate = recentDates[recentDates.length - 1];
  const dataYear = Number(endDate.slice(0, 4));

  const lookups = buildBbmLookups();

  let totalPageLoads = 0;
  let mappedPageLoads = 0;
  /** @type {Map<string, { browser: string, version: string, pageLoads: number }>} */
  const countsByBrowserVer = new Map();

  for (const fileName of recentFiles) {
    const inputPath = resolveSafeFilePath(AGGREGATES_DIR, fileName);
    const raw = JSON.parse(await fs.readFile(inputPath, "utf8"));
    const schema = Array.isArray(raw.schema) ? raw.schema : [];
    const rows = Array.isArray(raw.rows) ? raw.rows : [];

    /** @type {Record<string, number>} */
    const colIdx = {};
    schema.forEach((col, idx) => {
      colIdx[col] = idx;
    });

    const countCol = colIdx.TOTAL ?? colIdx.count;
    for (const row of rows) {
      const count = Number(row[countCol] || 0);
      if (count <= 0) continue;
      totalPageLoads += count;

      const resolved = resolveRowToBaselineBrowser(row, colIdx, lookups);
      if (!resolved) continue;

      mappedPageLoads += count;
      const key = `${resolved.browser}|${resolved.version}`;
      const existing = countsByBrowserVer.get(key);
      if (existing) {
        existing.pageLoads += count;
      } else {
        countsByBrowserVer.set(key, {
          browser: resolved.browser,
          version: resolved.version,
          pageLoads: count,
        });
      }
    }
  }

  // Build minimum compatible version maps for each target as of `endDate`
  const widelyMinMap = toMinVersionMap(
    getCompatibleVersions({
      widelyAvailableOnDate: endDate,
      includeDownstreamBrowsers: true,
      suppressWarnings: true,
    })
  );
  const newlyMinMap = getNewlyAvailableMinVersionsOnDate(endDate, lookups.timelineEvents);

  /** @type {Record<string, Record<string, string>>} */
  const targetMinMaps = {
    widely: widelyMinMap,
    newly: newlyMinMap,
  };
  const targetsList = [
    { id: "newly", label: "Baseline Newly available", shortLabel: "Newly available", kind: "newly" },
    { id: "widely", label: "Baseline Widely available", shortLabel: "Widely available", kind: "widely" },
  ];

  for (let year = 2015; year <= dataYear; year++) {
    const yearStr = String(year);
    const yearEndCutoff = `${yearStr}-12-31` <= endDate ? `${yearStr}-12-31` : endDate;
    targetMinMaps[yearStr] = getNewlyAvailableMinVersionsOnDate(
      yearEndCutoff,
      lookups.timelineEvents
    );
    targetsList.push({
      id: yearStr,
      label: `Baseline ${yearStr}`,
      shortLabel: yearStr,
      kind: "year",
      year,
    });
  }

  // Enrich each browser+version entry with releaseDate, engine, engineVersion, engineReleaseDate
  const browsers = [...countsByBrowserVer.values()]
    .sort((a, b) => b.pageLoads - a.pageLoads)
    .map((item) => {
      const { browser, version, pageLoads } = item;
      const meta = lookups.versionMetaByBrowser[browser]?.[version] || null;
      const isDownstream = DOWNSTREAM_BBM_BROWSERS.has(browser);

      const releaseDate = meta?.releaseDate || null;
      let engine = null;
      let engineVersion = null;
      let engineReleaseDate = null;

      if (isDownstream) {
        engine = meta?.engine || (browser === "kai_os" ? "Gecko" : "Blink");
        engineVersion =
          meta?.engineVersion || (browser === "webview_android" ? version : null);
        if (engine && engineVersion) {
          if (engine === "Gecko") {
            engineReleaseDate =
              lookups.versionMetaByBrowser.firefox?.[engineVersion]?.releaseDate ||
              lookups.versionMetaByBrowser.firefox_android?.[engineVersion]?.releaseDate ||
              null;
          } else {
            engineReleaseDate =
              lookups.versionMetaByBrowser.chrome?.[engineVersion]?.releaseDate ||
              lookups.versionMetaByBrowser.chrome_android?.[engineVersion]?.releaseDate ||
              null;
          }
        }
      }

      return {
        browser,
        name: BBM_BROWSER_NAMES[browser] || browser,
        version,
        isDownstream,
        releaseDate,
        engine,
        engineVersion,
        engineReleaseDate,
        pageLoads,
        pct: mappedPageLoads > 0 ? round4((pageLoads / mappedPageLoads) * 100) : 0,
        pctTotal: totalPageLoads > 0 ? round4((pageLoads / totalPageLoads) * 100) : 0,
      };
    });

  const breakdownPayload = {
    generatedAt: new Date().toISOString(),
    windowDays: recentFiles.length,
    startDate,
    endDate,
    totalPageLoads,
    mappedPageLoads,
    unmappedPageLoads: totalPageLoads - mappedPageLoads,
    mappedPercentage: totalPageLoads > 0 ? round2((mappedPageLoads / totalPageLoads) * 100) : 0,
    browserVersionCount: browsers.length,
    targets: targetsList,
    targetMinMaps,
    browsers,
  };

  await fs.mkdir(path.dirname(BREAKDOWN_DATA_PATH), { recursive: true });
  await fs.writeFile(BREAKDOWN_DATA_PATH, JSON.stringify(breakdownPayload, null, 2) + "\n", "utf8");

  // Compact client-side bundle for the browser breakdown chart and sortable tables
  const compactClientData = {
    w: recentFiles.length,
    s: startDate,
    e: endDate,
    m: breakdownPayload.mappedPercentage,
    names: BBM_BROWSER_NAMES,
    targets: targetsList,
    minMaps: targetMinMaps,
    // Each row: [browser, version, pctOfMapped, pctOfTotal, releaseDate, engine, engineVersion, engineReleaseDate]
    rows: browsers.map((b) => [
      b.browser,
      b.version,
      b.pct,
      b.pctTotal,
      b.releaseDate,
      b.engine,
      b.engineVersion,
      b.engineReleaseDate,
    ]),
  };

  const breakdownJs =
    `(()=>{const D=${JSON.stringify(compactClientData)};` +
    `const browsers=D.rows.map(r=>({browser:r[0],name:D.names[r[0]]||r[0],version:r[1],pct:r[2],pctTotal:r[3],releaseDate:r[4],engine:r[5],engineVersion:r[6],engineReleaseDate:r[7],isDownstream:Boolean(r[5])}));` +
    `window.BASELINE_BROWSER_BREAKDOWN={windowDays:D.w,startDate:D.s,endDate:D.e,mappedPercentage:D.m,targets:D.targets,targetMinMaps:D.minMaps,browsers};` +
    `window.dispatchEvent(new CustomEvent("baseline-breakdown-ready",{detail:window.BASELINE_BROWSER_BREAKDOWN}))})();\n`;

  await fs.mkdir(path.dirname(BREAKDOWN_JS_BUNDLE_PATH), { recursive: true });
  await fs.writeFile(BREAKDOWN_JS_BUNDLE_PATH, breakdownJs, "utf8");
  console.log(
    `Wrote 7-day browser breakdown (${browsers.length} browser versions, ${Buffer.byteLength(breakdownJs, "utf8")} bytes) -> ${path.relative(PROJECT_ROOT, BREAKDOWN_JS_BUNDLE_PATH)}`
  );
}

/**
 * Builds both:
 * 1. `src/assets/js/baseline-initial-data.js`: an ultra-minimal delta-encoded, self-unpacking JS file
 *    for the initial 7-day table and 3-month (up to 90-day) time series chart.
 * 2. `src/_data/baseline_summary.json`: build-time 11ty data for server-rendering the 7-day summary table.
 */
export async function writeInitialViewBundle() {
  let entries = [];
  try {
    entries = await fs.readdir(OUTPUT_DIR);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  const allFiles = entries
    .filter((f) => f.endsWith(".json") && DATE_PATTERN.test(f.slice(0, -5)))
    .sort();

  if (allFiles.length === 0) return;

  const selectedFiles = allFiles.slice(-MAX_CHART_DAYS);
  const dailyPayloads = [];
  for (const fileName of selectedFiles) {
    const filePath = resolveSafeFilePath(OUTPUT_DIR, fileName);
    dailyPayloads.push(JSON.parse(await fs.readFile(filePath, "utf8")));
  }

  const dates = dailyPayloads.map((d) => d.date);
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];

  // Check if dates are strictly contiguous (+1 day each)
  let isContiguous = true;
  const dayGaps = [];
  for (let i = 1; i < dates.length; i++) {
    const prevMs = Date.parse(`${dates[i - 1]}T00:00:00Z`);
    const currMs = Date.parse(`${dates[i]}T00:00:00Z`);
    const diffDays = Math.round((currMs - prevMs) / 86400000);
    dayGaps.push(diffDays);
    if (diffDays !== 1) {
      isContiguous = false;
    }
  }

  // Collect all annual target years in descending order (e.g. 2026 down to 2015)
  const latestDay = dailyPayloads[dailyPayloads.length - 1];
  const yearsDesc = Object.keys(latestDay.annualTargets || {})
    .map(Number)
    .filter((y) => !Number.isNaN(y))
    .sort((a, b) => b - a);
  const minYear = yearsDesc.length > 0 ? yearsDesc[yearsDesc.length - 1] : 2015;
  const maxYear = yearsDesc.length > 0 ? yearsDesc[0] : Number(endDate.slice(0, 4));

  const targetDefs = [
    {
      key: "w",
      id: "widely",
      label: "Widely available",
      kind: "widely",
      extract: (d) => d.widelyAvailable,
    },
    {
      key: "n",
      id: "newly",
      label: "Newly available",
      kind: "newly",
      extract: (d) => d.newlyAvailable,
    },
    ...yearsDesc.map((yr) => ({
      key: String(yr),
      id: String(yr),
      label: `Baseline ${yr}`,
      kind: "year",
      year: yr,
      extract: (d) => d.annualTargets?.[String(yr)],
    })),
  ];

  /** @type {Record<string, Array<number | number[]>>} */
  const packedTargets = {};
  const summaryRows = [];
  const recentSliceCount = Math.min(AVG_WINDOW_DAYS, dailyPayloads.length);

  for (const def of targetDefs) {
    const pctSeries = dailyPayloads.map((d) => def.extract(d)?.percentage ?? 0);
    const pctTotalSeries = dailyPayloads.map((d) => def.extract(d)?.percentageOfTotal ?? 0);
    const androidWvSeries = dailyPayloads.map(
      (d) => def.extract(d)?.androidWebviewPercentageOfCompatible ?? 0
    );
    const iosWvSeries = dailyPayloads.map(
      (d) => def.extract(d)?.iosWebviewPercentageOfCompatible ?? 0
    );

    packedTargets[def.key] = [
      encodeBasisPointsSeries(pctSeries),
      encodeBasisPointsSeries(pctTotalSeries),
      encodeBasisPointsSeries(androidWvSeries),
      encodeBasisPointsSeries(iosWvSeries),
    ];

    const recentPct = pctSeries.slice(-recentSliceCount);
    const recentPctTotal = pctTotalSeries.slice(-recentSliceCount);
    const recentAndroidWv = androidWvSeries.slice(-recentSliceCount);
    const recentIosWv = iosWvSeries.slice(-recentSliceCount);
    const delta7 =
      recentPct.length > 1 ? round2(recentPct[recentPct.length - 1] - recentPct[0]) : 0;

    summaryRows.push({
      id: def.id,
      key: def.key,
      label: def.label,
      kind: def.kind,
      year: def.year ?? null,
      avgPercentage: meanRound2(recentPct),
      avgPercentageOfTotal: meanRound2(recentPctTotal),
      avgAndroidWebviewPercentage: meanRound2(recentAndroidWv),
      avgIosWebviewPercentage: meanRound2(recentIosWv),
      latestPercentage: recentPct[recentPct.length - 1] ?? 0,
      delta7,
    });
  }

  const packedData = {
    s: startDate,
    n: dates.length,
    ...(isContiguous ? {} : { g: dayGaps }),
    y: [minYear, maxYear],
    m: encodeBasisPointsSeries(dailyPayloads.map((d) => d.mappedPercentage ?? 0)),
    t: packedTargets,
  };

  // Self-unpacking minified JS bundle
  const jsBundle =
    `(()=>{const P=${JSON.stringify(packedData)},` +
    `D=(s,n)=>{if(typeof s==="number")return Array(n).fill(s/100);const o=[s[0]/100];let v=s[0];for(let i=1;i<s.length;i++){v+=s[i];o.push(v/100)}return o},` +
    `M=a=>a.length?Math.round(a.reduce((x,y)=>x+y,0)/a.length*100)/100:0,` +
    `n=P.n,dates=[P.s];let ms=Date.parse(P.s+"T00:00:00Z");` +
    `for(let i=1;i<n;i++){ms+=(P.g?P.g[i-1]:1)*864e5;dates.push(new Date(ms).toISOString().slice(0,10))}` +
    `const keys=["w","n"];for(let y=P.y[1];y>=P.y[0];y--)keys.push(""+y);` +
    `const w=Math.min(7,n),targets=keys.map(k=>{const raw=P.t[k]||[0,0,0,0],` +
    `pct=D(raw[0],n),pctTotal=D(raw[1],n),androidWv=D(raw[2],n),iosWv=D(raw[3],n),` +
    `rp=pct.slice(-w),rt=pctTotal.slice(-w),ra=androidWv.slice(-w),ri=iosWv.slice(-w);` +
    `return{id:k==="w"?"widely":k==="n"?"newly":k,key:k,` +
    `label:k==="w"?"Widely available":k==="n"?"Newly available":"Baseline "+k,` +
    `kind:k==="w"?"widely":k==="n"?"newly":"year",year:k==="w"||k==="n"?null:+k,` +
    `avg7:{pct:M(rp),pctTotal:M(rt),androidWv:M(ra),iosWv:M(ri),` +
    `delta:rp.length>1?Math.round((rp[rp.length-1]-rp[0])*100)/100:0},` +
    `series:{pct,pctTotal,androidWv,iosWv}}});` +
    `window.BASELINE_INITIAL_DATA={dates,startDate:dates[0],endDate:dates[n-1],dayCount:n,recentWindowDays:w,mappedPct:D(P.m,n),targets};` +
    `window.dispatchEvent(new CustomEvent("baseline-data-ready",{detail:window.BASELINE_INITIAL_DATA}))})();\n`;

  await fs.mkdir(path.dirname(INITIAL_JS_BUNDLE_PATH), { recursive: true });
  await fs.writeFile(INITIAL_JS_BUNDLE_PATH, jsBundle, "utf8");

  const recentMappedPct = dailyPayloads
    .slice(-recentSliceCount)
    .map((d) => d.mappedPercentage ?? 0);
  const recentStartDate = dates[Math.max(0, dates.length - recentSliceCount)];

  const summaryPayload = {
    generatedAt: latestDay.generatedAt || new Date().toISOString(),
    dayCount: dates.length,
    startDate,
    endDate,
    recentWindowDays: recentSliceCount,
    recentStartDate,
    recentEndDate: endDate,
    avgMappedPercentage: meanRound2(recentMappedPct),
    bundleSizeBytes: Buffer.byteLength(jsBundle, "utf8"),
    rows: summaryRows,
  };

  await fs.writeFile(SUMMARY_DATA_PATH, JSON.stringify(summaryPayload, null, 2) + "\n", "utf8");
  console.log(
    `Wrote initial view JS bundle (${summaryPayload.bundleSizeBytes} bytes) -> ${path.relative(PROJECT_ROOT, INITIAL_JS_BUNDLE_PATH)}`
  );

  await writeBrowserBreakdownBundle();
}

const regionDisplayNames = new Intl.DisplayNames(["en"], { type: "region" });

const SPECIAL_COUNTRY_NAMES = {
  XX: "Unknown / Unspecified",
  T1: "Tor Network",
  XK: "Kosovo",
};

/**
 * Normalizes a raw country code from BigQuery (`COUNTRY`), mapping empty/null values to `"XX"`.
 * @param {unknown} rawCountry
 * @returns {string}
 */
export function normalizeCountryCode(rawCountry) {
  const code = String(rawCountry ?? "").trim().toUpperCase();
  return code || "XX";
}

/**
 * Resolves an ISO 3166-1 alpha-2 country code (or special code) to a human-readable English name.
 * @param {string} countryCode
 * @returns {string}
 */
export function getCountryName(countryCode) {
  if (Object.hasOwn(SPECIAL_COUNTRY_NAMES, countryCode)) {
    return SPECIAL_COUNTRY_NAMES[countryCode];
  }
  try {
    return regionDisplayNames.of(countryCode) || countryCode;
  } catch {
    return countryCode;
  }
}

/**
 * Creates a fresh daily page-load accumulator for a country or region.
 * @param {string[]} annualYears
 */
function createDailyAccumulator(annualYears) {
  return {
    totalPageLoads: 0,
    mappedPageLoads: 0,
    androidWebviewPageLoads: 0,
    mappedAndroidWebviewPageLoads: 0,
    iosWebviewPageLoads: 0,
    mappedIosWebviewPageLoads: 0,
    widelyCompatibleLoads: 0,
    widelyAndroidWebviewCompatibleLoads: 0,
    widelyIosWebviewCompatibleLoads: 0,
    newlyCompatibleLoads: 0,
    newlyAndroidWebviewCompatibleLoads: 0,
    newlyIosWebviewCompatibleLoads: 0,
    /** @type {Record<string, number>} */
    annualCompatibleLoads: Object.fromEntries(annualYears.map((y) => [y, 0])),
    /** @type {Record<string, number>} */
    annualAndroidWebviewCompatibleLoads: Object.fromEntries(annualYears.map((y) => [y, 0])),
    /** @type {Record<string, number>} */
    annualIosWebviewCompatibleLoads: Object.fromEntries(annualYears.map((y) => [y, 0])),
  };
}

/**
 * Finalizes a daily accumulator into the standard Baseline daily compatibility metric structure.
 * @param {ReturnType<typeof createDailyAccumulator>} acc
 */
function finalizeDailyAccumulator(acc) {
  const {
    totalPageLoads,
    mappedPageLoads,
    androidWebviewPageLoads,
    mappedAndroidWebviewPageLoads,
    iosWebviewPageLoads,
    mappedIosWebviewPageLoads,
    widelyCompatibleLoads,
    widelyAndroidWebviewCompatibleLoads,
    widelyIosWebviewCompatibleLoads,
    newlyCompatibleLoads,
    newlyAndroidWebviewCompatibleLoads,
    newlyIosWebviewCompatibleLoads,
    annualCompatibleLoads,
    annualAndroidWebviewCompatibleLoads,
    annualIosWebviewCompatibleLoads,
  } = acc;

  /** @type {Record<string, ReturnType<typeof formatTargetMetrics>>} */
  const annualTargets = {};
  for (const [year, loads] of Object.entries(annualCompatibleLoads)) {
    annualTargets[year] = formatTargetMetrics(
      loads,
      annualAndroidWebviewCompatibleLoads[year],
      annualIosWebviewCompatibleLoads[year],
      mappedPageLoads,
      totalPageLoads
    );
  }

  return {
    totalPageLoads,
    mappedPageLoads,
    unmappedPageLoads: totalPageLoads - mappedPageLoads,
    mappedPercentage: totalPageLoads > 0 ? round2((mappedPageLoads / totalPageLoads) * 100) : 0,
    androidWebviewPageLoads,
    mappedAndroidWebviewPageLoads,
    unmappedAndroidWebviewPageLoads: androidWebviewPageLoads - mappedAndroidWebviewPageLoads,
    androidWebviewPercentageOfTotal:
      totalPageLoads > 0 ? round2((androidWebviewPageLoads / totalPageLoads) * 100) : 0,
    androidWebviewPercentageOfMapped:
      mappedPageLoads > 0 ? round2((mappedAndroidWebviewPageLoads / mappedPageLoads) * 100) : 0,
    iosWebviewPageLoads,
    mappedIosWebviewPageLoads,
    unmappedIosWebviewPageLoads: iosWebviewPageLoads - mappedIosWebviewPageLoads,
    iosWebviewPercentageOfTotal:
      totalPageLoads > 0 ? round2((iosWebviewPageLoads / totalPageLoads) * 100) : 0,
    iosWebviewPercentageOfMapped:
      mappedPageLoads > 0 ? round2((mappedIosWebviewPageLoads / mappedPageLoads) * 100) : 0,
    widelyAvailable: formatTargetMetrics(
      widelyCompatibleLoads,
      widelyAndroidWebviewCompatibleLoads,
      widelyIosWebviewCompatibleLoads,
      mappedPageLoads,
      totalPageLoads
    ),
    newlyAvailable: formatTargetMetrics(
      newlyCompatibleLoads,
      newlyAndroidWebviewCompatibleLoads,
      newlyIosWebviewCompatibleLoads,
      mappedPageLoads,
      totalPageLoads
    ),
    annualTargets,
  };
}

/**
 * Serializes a country-daily payload with pretty-printed header metadata and one compact line per country.
 * @param {{ generatedAt: string, date: string, countryCount: number, countries: Record<string, unknown> }} payload
 * @returns {string}
 */
function serializeCountryDailyPayload(payload) {
  const entries = Object.entries(payload.countries).map(
    ([code, data]) => `    ${JSON.stringify(code)}: ${JSON.stringify(data)}`
  );
  return (
    `{\n` +
    `  "generatedAt": ${JSON.stringify(payload.generatedAt)},\n` +
    `  "date": ${JSON.stringify(payload.date)},\n` +
    `  "countryCount": ${payload.countryCount},\n` +
    `  "countries": {\n` +
    `${entries.join(",\n")}\n` +
    `  }\n` +
    `}\n`
  );
}

/**
 * Processes all daily aggregate files in `src/_data/bigquery/country_daily_aggregates/`
 * and writes:
 * 1. `src/_data/baseline_country_daily/<YYYY-MM-DD>.json`
 * 2. `src/_data/baseline_country_summary.json` and `src/assets/js/baseline-country-data.js`
 * 3. `src/_data/baseline_country_browser_breakdown.json` and `src/assets/js/baseline-country-breakdown.js`
 * @param {{ force?: boolean, lookups?: ReturnType<typeof buildBbmLookups> }} [options]
 */
export async function calculateAllCountryDailyBaseline({ force = false, lookups } = {}) {
  let entries = [];
  try {
    entries = await fs.readdir(COUNTRY_AGGREGATES_DIR);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("No country daily aggregate directory found yet; skipping country Baseline calculation.");
      return;
    }
    throw error;
  }

  const dailyFiles = entries
    .filter((f) => f.endsWith(".json") && DATE_PATTERN.test(f.slice(0, -5)))
    .sort();

  if (dailyFiles.length === 0) {
    console.log("No country daily aggregate files found; skipping country Baseline calculation.");
    return;
  }

  await fs.mkdir(COUNTRY_DAILY_OUTPUT_DIR, { recursive: true });
  const effectiveLookups = lookups || buildBbmLookups();

  for (const fileName of dailyFiles) {
    const dateStr = fileName.slice(0, -5);
    const outputPath = resolveSafeFilePath(COUNTRY_DAILY_OUTPUT_DIR, `${dateStr}.json`);

    if (!force) {
      try {
        await fs.access(outputPath);
        continue;
      } catch {
        // Output file does not exist yet; proceed to calculate
      }
    }

    const inputPath = resolveSafeFilePath(COUNTRY_AGGREGATES_DIR, fileName);
    const raw = JSON.parse(await fs.readFile(inputPath, "utf8"));
    const schema = Array.isArray(raw.schema) ? raw.schema : [];
    const rows = Array.isArray(raw.rows) ? raw.rows : [];

    /** @type {Record<string, number>} */
    const colIdx = {};
    schema.forEach((col, idx) => {
      colIdx[col] = idx;
    });

    const dataYear = Number(dateStr.slice(0, 4));
    const widelyMinMap = toMinVersionMap(
      getCompatibleVersions({
        widelyAvailableOnDate: dateStr,
        includeDownstreamBrowsers: true,
        suppressWarnings: true,
      })
    );
    const newlyMinMap = getNewlyAvailableMinVersionsOnDate(dateStr, effectiveLookups.timelineEvents);

    /** @type {Record<string, Record<string, string>>} */
    const annualMinMaps = {};
    for (let year = 2015; year <= dataYear; year++) {
      const yearEndCutoff = `${year}-12-31` <= dateStr ? `${year}-12-31` : dateStr;
      annualMinMaps[String(year)] = getNewlyAvailableMinVersionsOnDate(
        yearEndCutoff,
        effectiveLookups.timelineEvents
      );
    }
    const annualYears = Object.keys(annualMinMaps);

    /** @type {Map<string, ReturnType<typeof createDailyAccumulator>>} */
    const byCountry = new Map();

    // Cache row classification by UA+OS tuple to avoid repeating version comparisons across ~245 countries
    /** @type {Map<string, { webviewType: "android" | "ios" | null, resolved: { browser: string, version: string } | null, isWidely: boolean, isNewly: boolean, compatibleYears: string[] }>} */
    const rowCache = new Map();

    const countryCol = colIdx.COUNTRY;
    const countCol = colIdx.TOTAL ?? colIdx.count;
    const uaCol = colIdx.USERAGENTFAMILY;
    const uavCol = colIdx.USERAGENTVERSION;
    const engCol = colIdx.USERAGENTENGINE;
    const engvCol = colIdx.USERAGENTENGINEVERSION;
    const osCol = colIdx.OS;
    const osvCol = colIdx.OSVERSION;

    for (const row of rows) {
      const count = Number(row[countCol] || 0);
      if (count <= 0) continue;

      const countryCode = normalizeCountryCode(row[countryCol]);
      let acc = byCountry.get(countryCode);
      if (!acc) {
        acc = createDailyAccumulator(annualYears);
        byCountry.set(countryCode, acc);
      }

      const uaKey = `${row[uaCol] ?? ""}|${row[uavCol] ?? ""}|${row[engCol] ?? ""}|${row[engvCol] ?? ""}|${row[osCol] ?? ""}|${row[osvCol] ?? ""}`;
      let cached = rowCache.get(uaKey);
      if (!cached) {
        const webviewType = getWebviewType(row, colIdx);
        const resolved = resolveRowToBaselineBrowser(row, colIdx, effectiveLookups);
        let isWidely = false;
        let isNewly = false;
        const compatibleYears = [];

        if (resolved) {
          const widelyMin = widelyMinMap[resolved.browser];
          if (widelyMin !== undefined && compareVersions(resolved.version, widelyMin) >= 0) {
            isWidely = true;
          }
          const newlyMin = newlyMinMap[resolved.browser];
          if (newlyMin !== undefined && compareVersions(resolved.version, newlyMin) >= 0) {
            isNewly = true;
          }
          for (const [year, minMap] of Object.entries(annualMinMaps)) {
            const minVer = minMap[resolved.browser];
            if (minVer !== undefined && compareVersions(resolved.version, minVer) >= 0) {
              compatibleYears.push(year);
            }
          }
        }

        cached = { webviewType, resolved, isWidely, isNewly, compatibleYears };
        rowCache.set(uaKey, cached);
      }

      acc.totalPageLoads += count;
      const { webviewType, resolved, isWidely, isNewly, compatibleYears } = cached;

      if (webviewType === "android") {
        acc.androidWebviewPageLoads += count;
      } else if (webviewType === "ios") {
        acc.iosWebviewPageLoads += count;
      }

      if (!resolved) {
        continue;
      }

      acc.mappedPageLoads += count;
      if (webviewType === "android") {
        acc.mappedAndroidWebviewPageLoads += count;
      } else if (webviewType === "ios") {
        acc.mappedIosWebviewPageLoads += count;
      }

      if (isWidely) {
        acc.widelyCompatibleLoads += count;
        if (webviewType === "android") {
          acc.widelyAndroidWebviewCompatibleLoads += count;
        } else if (webviewType === "ios") {
          acc.widelyIosWebviewCompatibleLoads += count;
        }
      }

      if (isNewly) {
        acc.newlyCompatibleLoads += count;
        if (webviewType === "android") {
          acc.newlyAndroidWebviewCompatibleLoads += count;
        } else if (webviewType === "ios") {
          acc.newlyIosWebviewCompatibleLoads += count;
        }
      }

      for (const year of compatibleYears) {
        acc.annualCompatibleLoads[year] += count;
        if (webviewType === "android") {
          acc.annualAndroidWebviewCompatibleLoads[year] += count;
        } else if (webviewType === "ios") {
          acc.annualIosWebviewCompatibleLoads[year] += count;
        }
      }
    }

    const sortedCountryEntries = [...byCountry.entries()].sort(
      (a, b) => b[1].totalPageLoads - a[1].totalPageLoads
    );

    /** @type {Record<string, ReturnType<typeof finalizeDailyAccumulator>>} */
    const countries = {};
    for (const [code, acc] of sortedCountryEntries) {
      countries[code] = finalizeDailyAccumulator(acc);
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      date: dateStr,
      countryCount: sortedCountryEntries.length,
      countries,
    };

    await fs.writeFile(outputPath, serializeCountryDailyPayload(payload), "utf8");
    console.log(
      `Wrote country Baseline compatibility for ${dateStr} (${sortedCountryEntries.length} countries) -> ${path.relative(PROJECT_ROOT, outputPath)}`
    );
  }

  await writeCountrySummaryAndBundle();
  await writeCountryBrowserBreakdownBundle(effectiveLookups);
}

const REGIONS_DEFINITIONS_PATH = path.resolve(PROJECT_ROOT, "src", "_data", "regions.json");
const REGION_SUMMARY_DATA_PATH = path.resolve(
  PROJECT_ROOT,
  "src",
  "_data",
  "baseline_region_summary.json"
);

/**
 * Loads regional taxonomy definitions from `src/_data/regions.json` and builds a fast
 * `countryCode -> { macroRegion, subregion, leafRegion }` UN M49 lookup map.
 */
async function loadRegionLookups() {
  const raw = JSON.parse(await fs.readFile(REGIONS_DEFINITIONS_PATH, "utf8"));
  /** @type {Record<string, { macroRegion: string, subregion: string, leafRegion: string }>} */
  const countryToRegions = {};
  for (const [leafCode, leafDef] of Object.entries(raw.unM49LeafRegions || {})) {
    for (const cc of leafDef.countries || []) {
      countryToRegions[cc] = {
        macroRegion: leafDef.macroRegion,
        subregion: leafDef.subregion,
        leafRegion: leafCode,
      };
    }
  }
  return {
    taxonomy: raw,
    countryToRegions,
  };
}

/**
 * Merges a country's finalized daily metric object into a regional daily accumulator.
 * @param {ReturnType<typeof createDailyAccumulator>} acc
 * @param {any} cDay
 */
function addCountryDayToAccumulator(acc, cDay) {
  if (!cDay) return;
  acc.totalPageLoads += Number(cDay.totalPageLoads || 0);
  acc.mappedPageLoads += Number(cDay.mappedPageLoads || 0);
  acc.androidWebviewPageLoads += Number(cDay.androidWebviewPageLoads || 0);
  acc.mappedAndroidWebviewPageLoads += Number(cDay.mappedAndroidWebviewPageLoads || 0);
  acc.iosWebviewPageLoads += Number(cDay.iosWebviewPageLoads || 0);
  acc.mappedIosWebviewPageLoads += Number(cDay.mappedIosWebviewPageLoads || 0);

  if (cDay.widelyAvailable) {
    acc.widelyCompatibleLoads += Number(cDay.widelyAvailable.compatiblePageLoads || 0);
    acc.widelyAndroidWebviewCompatibleLoads += Number(
      cDay.widelyAvailable.androidWebviewCompatiblePageLoads || 0
    );
    acc.widelyIosWebviewCompatibleLoads += Number(
      cDay.widelyAvailable.iosWebviewCompatiblePageLoads || 0
    );
  }

  if (cDay.newlyAvailable) {
    acc.newlyCompatibleLoads += Number(cDay.newlyAvailable.compatiblePageLoads || 0);
    acc.newlyAndroidWebviewCompatibleLoads += Number(
      cDay.newlyAvailable.androidWebviewCompatiblePageLoads || 0
    );
    acc.newlyIosWebviewCompatibleLoads += Number(
      cDay.newlyAvailable.iosWebviewCompatiblePageLoads || 0
    );
  }

  for (const [yr, yrData] of Object.entries(cDay.annualTargets || {})) {
    if (yr in acc.annualCompatibleLoads && yrData) {
      acc.annualCompatibleLoads[yr] += Number(yrData.compatiblePageLoads || 0);
      acc.annualAndroidWebviewCompatibleLoads[yr] += Number(
        yrData.androidWebviewCompatiblePageLoads || 0
      );
      acc.annualIosWebviewCompatibleLoads[yr] += Number(
        yrData.iosWebviewCompatiblePageLoads || 0
      );
    }
  }
}

/**
 * Builds:
 * 1. `src/_data/baseline_country_summary.json`: 7-day average Baseline availability & traffic share for every country
 * 2. `src/assets/js/baseline-country-data.js`: delta-encoded basis-point time series & 7-day summaries for every country
 * 3. `src/_data/baseline_region_summary.json`: Regional rollups across the UN M49 hierarchy
 */
export async function writeCountrySummaryAndBundle() {
  let entries = [];
  try {
    entries = await fs.readdir(COUNTRY_DAILY_OUTPUT_DIR);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  const allFiles = entries
    .filter((f) => f.endsWith(".json") && DATE_PATTERN.test(f.slice(0, -5)))
    .sort();

  if (allFiles.length === 0) return;

  const selectedFiles = allFiles.slice(-MAX_CHART_DAYS);
  const dailyPayloads = [];
  for (const fileName of selectedFiles) {
    const filePath = resolveSafeFilePath(COUNTRY_DAILY_OUTPUT_DIR, fileName);
    dailyPayloads.push(JSON.parse(await fs.readFile(filePath, "utf8")));
  }

  const { taxonomy, countryToRegions } = await loadRegionLookups();

  const dates = dailyPayloads.map((d) => d.date);
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];
  const recentSliceCount = Math.min(AVG_WINDOW_DAYS, dailyPayloads.length);
  const recentDailyPayloads = dailyPayloads.slice(-recentSliceCount);
  const recentStartDate = dates[Math.max(0, dates.length - recentSliceCount)];

  let isContiguous = true;
  const dayGaps = [];
  for (let i = 1; i < dates.length; i++) {
    const prevMs = Date.parse(`${dates[i - 1]}T00:00:00Z`);
    const currMs = Date.parse(`${dates[i]}T00:00:00Z`);
    const diffDays = Math.round((currMs - prevMs) / 86400000);
    dayGaps.push(diffDays);
    if (diffDays !== 1) {
      isContiguous = false;
    }
  }

  // Collect all distinct country codes across the window and find sample annualTargets keys
  const allCountryCodes = new Set();
  let sampleCountryDay = null;
  for (const day of dailyPayloads) {
    for (const [code, cData] of Object.entries(day.countries || {})) {
      allCountryCodes.add(code);
      if (!sampleCountryDay && cData?.annualTargets) {
        sampleCountryDay = cData;
      }
    }
  }

  const yearsDesc = Object.keys(sampleCountryDay?.annualTargets || {})
    .map(Number)
    .filter((y) => !Number.isNaN(y))
    .sort((a, b) => b - a);
  const annualYears = yearsDesc.map(String);
  const minYear = yearsDesc.length > 0 ? yearsDesc[yearsDesc.length - 1] : 2015;
  const maxYear = yearsDesc.length > 0 ? yearsDesc[0] : Number(endDate.slice(0, 4));

  const targetDefs = [
    {
      key: "w",
      id: "widely",
      label: "Widely available",
      kind: "widely",
      extract: (c) => c?.widelyAvailable,
    },
    {
      key: "n",
      id: "newly",
      label: "Newly available",
      kind: "newly",
      extract: (c) => c?.newlyAvailable,
    },
    ...yearsDesc.map((yr) => ({
      key: String(yr),
      id: String(yr),
      label: `Baseline ${yr}`,
      kind: "year",
      year: yr,
      extract: (c) => c?.annualTargets?.[String(yr)],
    })),
  ];

  // Calculate global 7-day totals across all countries for traffic share computation
  let globalRecentTotalLoads = 0;
  let globalRecentMappedLoads = 0;
  for (const day of recentDailyPayloads) {
    for (const cData of Object.values(day.countries || {})) {
      globalRecentTotalLoads += Number(cData.totalPageLoads || 0);
      globalRecentMappedLoads += Number(cData.mappedPageLoads || 0);
    }
  }

  const countrySummaries = [];
  /** @type {Record<string, { name: string, share: number, regions: any, m: number | number[], t: Record<string, Array<number | number[]>> }>} */
  const packedCountries = {};

  for (const code of allCountryCodes) {
    const name = getCountryName(code);
    const regionMeta = countryToRegions[code] || {
      macroRegion: null,
      subregion: null,
      leafRegion: null,
    };
    const countryDays = dailyPayloads.map((d) => d.countries?.[code] || null);
    const recentCountryDays = countryDays.slice(-recentSliceCount);
    const activeRecentDays = recentCountryDays.filter((c) => c && Number(c.totalPageLoads || 0) > 0);
    const activeRecentMappedDays = recentCountryDays.filter(
      (c) => c && Number(c.mappedPageLoads || 0) > 0
    );

    let recentTotalPageLoads = 0;
    let recentMappedPageLoads = 0;
    for (const cDay of recentCountryDays) {
      if (cDay) {
        recentTotalPageLoads += Number(cDay.totalPageLoads || 0);
        recentMappedPageLoads += Number(cDay.mappedPageLoads || 0);
      }
    }
    const recentUnmappedPageLoads = recentTotalPageLoads - recentMappedPageLoads;
    const shareOfGlobalTraffic =
      globalRecentTotalLoads > 0 ? round4((recentTotalPageLoads / globalRecentTotalLoads) * 100) : 0;
    const shareOfGlobalMappedTraffic =
      globalRecentMappedLoads > 0
        ? round4((recentMappedPageLoads / globalRecentMappedLoads) * 100)
        : 0;

    const mappedPctSeries = countryDays.map((c) => c?.mappedPercentage ?? 0);
    const avgMappedPercentage = meanRound2(activeRecentDays.map((c) => c.mappedPercentage ?? 0));

    /** @type {Record<string, Array<number | number[]>>} */
    const packedTargets = {};
    const rows = [];

    for (const def of targetDefs) {
      const pctSeries = countryDays.map((c) => def.extract(c)?.percentage ?? 0);
      const pctTotalSeries = countryDays.map((c) => def.extract(c)?.percentageOfTotal ?? 0);
      const androidWvSeries = countryDays.map(
        (c) => def.extract(c)?.androidWebviewPercentageOfCompatible ?? 0
      );
      const iosWvSeries = countryDays.map(
        (c) => def.extract(c)?.iosWebviewPercentageOfCompatible ?? 0
      );

      packedTargets[def.key] = [
        encodeBasisPointsSeries(pctSeries),
        encodeBasisPointsSeries(pctTotalSeries),
        encodeBasisPointsSeries(androidWvSeries),
        encodeBasisPointsSeries(iosWvSeries),
      ];

      const activePct = activeRecentMappedDays.map((c) => def.extract(c)?.percentage ?? 0);
      const activePctTotal = activeRecentDays.map((c) => def.extract(c)?.percentageOfTotal ?? 0);
      const activeAndroidWv = activeRecentMappedDays.map(
        (c) => def.extract(c)?.androidWebviewPercentageOfCompatible ?? 0
      );
      const activeIosWv = activeRecentMappedDays.map(
        (c) => def.extract(c)?.iosWebviewPercentageOfCompatible ?? 0
      );
      const delta7 =
        activePct.length > 1 ? round2(activePct[activePct.length - 1] - activePct[0]) : 0;

      rows.push({
        id: def.id,
        key: def.key,
        label: def.label,
        kind: def.kind,
        year: def.year ?? null,
        avgPercentage: meanRound2(activePct),
        avgPercentageOfTotal: meanRound2(activePctTotal),
        avgAndroidWebviewPercentage: meanRound2(activeAndroidWv),
        avgIosWebviewPercentage: meanRound2(activeIosWv),
        latestPercentage: activePct[activePct.length - 1] ?? 0,
        delta7,
      });
    }

    countrySummaries.push({
      code,
      name,
      regions: regionMeta,
      activeDaysInWindow: activeRecentDays.length,
      totalPageLoads: recentTotalPageLoads,
      mappedPageLoads: recentMappedPageLoads,
      unmappedPageLoads: recentUnmappedPageLoads,
      shareOfGlobalTraffic,
      shareOfGlobalMappedTraffic,
      avgMappedPercentage,
      widelyAvailablePct: rows[0]?.avgPercentage ?? 0,
      newlyAvailablePct: rows[1]?.avgPercentage ?? 0,
      rows,
    });

    packedCountries[code] = {
      name,
      share: shareOfGlobalTraffic,
      regions: regionMeta,
      m: encodeBasisPointsSeries(mappedPctSeries),
      t: packedTargets,
    };
  }

  countrySummaries.sort((a, b) => b.totalPageLoads - a.totalPageLoads);

  // Order packedCountries in the same descending traffic order
  /** @type {Record<string, { name: string, share: number, regions: any, m: number | number[], t: Record<string, Array<number | number[]>> }>} */
  const orderedPackedCountries = {};
  for (const c of countrySummaries) {
    orderedPackedCountries[c.code] = packedCountries[c.code];
  }

  const packedCountryBundleData = {
    s: startDate,
    n: dates.length,
    ...(isContiguous ? {} : { g: dayGaps }),
    y: [minYear, maxYear],
    c: orderedPackedCountries,
  };

  const countryJsBundle =
    `(()=>{const P=${JSON.stringify(packedCountryBundleData)},` +
    `D=(s,n)=>{if(typeof s==="number")return Array(n).fill(s/100);const o=[s[0]/100];let v=s[0];for(let i=1;i<s.length;i++){v+=s[i];o.push(v/100)}return o},` +
    `M=a=>a.length?Math.round(a.reduce((x,y)=>x+y,0)/a.length*100)/100:0,` +
    `n=P.n,dates=[P.s];let ms=Date.parse(P.s+"T00:00:00Z");` +
    `for(let i=1;i<n;i++){ms+=(P.g?P.g[i-1]:1)*864e5;dates.push(new Date(ms).toISOString().slice(0,10))}` +
    `const keys=["w","n"];for(let y=P.y[1];y>=P.y[0];y--)keys.push(""+y);` +
    `const w=Math.min(7,n),cache={};` +
    `function unpackCountry(code){if(cache[code])return cache[code];const C=P.c[code];if(!C)return null;` +
    `const mappedPct=D(C.m,n),recentMapped=mappedPct.slice(-w),activeIdx=[];` +
    `for(let i=0;i<recentMapped.length;i++){if(recentMapped[i]>0)activeIdx.push(i)}` +
    `const pick=arr=>activeIdx.length?activeIdx.map(i=>arr[i]):arr;` +
    `const targets=keys.map(k=>{const raw=C.t[k]||[0,0,0,0],` +
    `pct=D(raw[0],n),pctTotal=D(raw[1],n),androidWv=D(raw[2],n),iosWv=D(raw[3],n),` +
    `rp=pick(pct.slice(-w)),rt=pick(pctTotal.slice(-w)),ra=pick(androidWv.slice(-w)),ri=pick(iosWv.slice(-w));` +
    `return{id:k==="w"?"widely":k==="n"?"newly":k,key:k,` +
    `label:k==="w"?"Widely available":k==="n"?"Newly available":"Baseline "+k,` +
    `kind:k==="w"?"widely":k==="n"?"newly":"year",year:k==="w"||k==="n"?null:+k,` +
    `avg7:{pct:M(rp),pctTotal:M(rt),androidWv:M(ra),iosWv:M(ri),` +
    `delta:rp.length>1?Math.round((rp[rp.length-1]-rp[0])*100)/100:0},` +
    `series:{pct,pctTotal,androidWv,iosWv}}});` +
    `return(cache[code]={code,name:C.name,share:C.share,regions:C.regions,dates,startDate:dates[0],endDate:dates[n-1],dayCount:n,recentWindowDays:w,mappedPct,targets})}` +
    `window.BASELINE_COUNTRY_DATA={dates,startDate:dates[0],endDate:dates[n-1],dayCount:n,recentWindowDays:w,countries:Object.keys(P.c).map(code=>({code,name:P.c[code].name,share:P.c[code].share,regions:P.c[code].regions})),getCountry:unpackCountry};` +
    `window.dispatchEvent(new CustomEvent("baseline-country-data-ready",{detail:window.BASELINE_COUNTRY_DATA}))})();\n`;

  await fs.mkdir(path.dirname(COUNTRY_INITIAL_JS_BUNDLE_PATH), { recursive: true });
  await fs.writeFile(COUNTRY_INITIAL_JS_BUNDLE_PATH, countryJsBundle, "utf8");

  const summaryPayload = {
    generatedAt: new Date().toISOString(),
    dayCount: dates.length,
    startDate,
    endDate,
    recentWindowDays: recentSliceCount,
    recentStartDate,
    recentEndDate: endDate,
    countryCount: countrySummaries.length,
    globalRecentTotalPageLoads: globalRecentTotalLoads,
    globalRecentMappedPageLoads: globalRecentMappedLoads,
    bundleSizeBytes: Buffer.byteLength(countryJsBundle, "utf8"),
    countries: countrySummaries,
  };

  const countriesFormatted = summaryPayload.countries
    .map((c) => `    ${JSON.stringify(c)}`)
    .join(",\n");
  const summaryJson =
    `{\n` +
    `  "generatedAt": ${JSON.stringify(summaryPayload.generatedAt)},\n` +
    `  "dayCount": ${summaryPayload.dayCount},\n` +
    `  "startDate": ${JSON.stringify(summaryPayload.startDate)},\n` +
    `  "endDate": ${JSON.stringify(summaryPayload.endDate)},\n` +
    `  "recentWindowDays": ${summaryPayload.recentWindowDays},\n` +
    `  "recentStartDate": ${JSON.stringify(summaryPayload.recentStartDate)},\n` +
    `  "recentEndDate": ${JSON.stringify(summaryPayload.recentEndDate)},\n` +
    `  "countryCount": ${summaryPayload.countryCount},\n` +
    `  "globalRecentTotalPageLoads": ${summaryPayload.globalRecentTotalPageLoads},\n` +
    `  "globalRecentMappedPageLoads": ${summaryPayload.globalRecentMappedPageLoads},\n` +
    `  "bundleSizeBytes": ${summaryPayload.bundleSizeBytes},\n` +
    `  "countries": [\n` +
    `${countriesFormatted}\n` +
    `  ]\n` +
    `}\n`;

  await fs.writeFile(COUNTRY_SUMMARY_DATA_PATH, summaryJson, "utf8");
  console.log(
    `Wrote country summary (${countrySummaries.length} countries) & JS bundle (${summaryPayload.bundleSizeBytes} bytes) -> ${path.relative(PROJECT_ROOT, COUNTRY_SUMMARY_DATA_PATH)}`
  );

  // Build regional rollups for each UN M49 taxonomy level
  function computeRegionalRollup(regionDefsMap, countryRegionSelector) {
    const results = [];
    for (const [regionId, regionDef] of Object.entries(regionDefsMap)) {
      const memberCountries = [...allCountryCodes].filter(
        (cc) => countryRegionSelector(countryToRegions[cc]) === regionId
      );
      if (memberCountries.length === 0) continue;

      const regionDailyMetrics = dailyPayloads.map((day) => {
        const acc = createDailyAccumulator(annualYears);
        for (const cc of memberCountries) {
          addCountryDayToAccumulator(acc, day.countries?.[cc]);
        }
        return finalizeDailyAccumulator(acc);
      });

      const recentRegionDays = regionDailyMetrics.slice(-recentSliceCount);
      const activeRegionDays = recentRegionDays.filter((r) => r.totalPageLoads > 0);
      const activeRegionMappedDays = recentRegionDays.filter((r) => r.mappedPageLoads > 0);

      let totalPageLoads = 0;
      let mappedPageLoads = 0;
      for (const rDay of recentRegionDays) {
        totalPageLoads += rDay.totalPageLoads;
        mappedPageLoads += rDay.mappedPageLoads;
      }

      const shareOfGlobalTraffic =
        globalRecentTotalLoads > 0 ? round4((totalPageLoads / globalRecentTotalLoads) * 100) : 0;
      const shareOfGlobalMappedTraffic =
        globalRecentMappedLoads > 0
          ? round4((mappedPageLoads / globalRecentMappedLoads) * 100)
          : 0;
      const avgMappedPercentage = meanRound2(activeRegionDays.map((r) => r.mappedPercentage));

      const rows = [];
      for (const def of targetDefs) {
        const activePct = activeRegionMappedDays.map((r) => def.extract(r)?.percentage ?? 0);
        const activePctTotal = activeRegionDays.map((r) => def.extract(r)?.percentageOfTotal ?? 0);
        const activeAndroidWv = activeRegionMappedDays.map(
          (r) => def.extract(r)?.androidWebviewPercentageOfCompatible ?? 0
        );
        const activeIosWv = activeRegionMappedDays.map(
          (r) => def.extract(r)?.iosWebviewPercentageOfCompatible ?? 0
        );
        const delta7 =
          activePct.length > 1 ? round2(activePct[activePct.length - 1] - activePct[0]) : 0;

        rows.push({
          id: def.id,
          key: def.key,
          label: def.label,
          kind: def.kind,
          year: def.year ?? null,
          avgPercentage: meanRound2(activePct),
          avgPercentageOfTotal: meanRound2(activePctTotal),
          avgAndroidWebviewPercentage: meanRound2(activeAndroidWv),
          avgIosWebviewPercentage: meanRound2(activeIosWv),
          latestPercentage: activePct[activePct.length - 1] ?? 0,
          delta7,
        });
      }

      const { caniuse: _caniuse, countries: _countries, ...unM49Fields } = regionDef;

      results.push({
        id: regionId,
        ...unM49Fields,
        activeCountryCount: memberCountries.length,
        memberCountries: memberCountries.sort(),
        totalPageLoads,
        mappedPageLoads,
        unmappedPageLoads: totalPageLoads - mappedPageLoads,
        shareOfGlobalTraffic,
        shareOfGlobalMappedTraffic,
        avgMappedPercentage,
        widelyAvailablePct: rows[0]?.avgPercentage ?? 0,
        newlyAvailablePct: rows[1]?.avgPercentage ?? 0,
        rows,
      });
    }
    return results.sort((a, b) => b.totalPageLoads - a.totalPageLoads);
  }

  const regionSummaryPayload = {
    generatedAt: new Date().toISOString(),
    dayCount: dates.length,
    startDate,
    endDate,
    recentWindowDays: recentSliceCount,
    recentStartDate,
    recentEndDate: endDate,
    unM49MacroRegions: computeRegionalRollup(taxonomy.unM49MacroRegions, (r) => r?.macroRegion),
    unM49Subregions: computeRegionalRollup(taxonomy.unM49Subregions, (r) => r?.subregion),
    unM49LeafRegions: computeRegionalRollup(taxonomy.unM49LeafRegions, (r) => r?.leafRegion),
  };

  await fs.writeFile(
    REGION_SUMMARY_DATA_PATH,
    JSON.stringify(regionSummaryPayload, null, 2) + "\n",
    "utf8"
  );
  console.log(
    `Wrote UN M49 regional summary rollups (macro: ${regionSummaryPayload.unM49MacroRegions.length}, sub-regions: ${regionSummaryPayload.unM49Subregions.length}, leaf: ${regionSummaryPayload.unM49LeafRegions.length}) -> ${path.relative(PROJECT_ROOT, REGION_SUMMARY_DATA_PATH)}`
  );
}

/**
 * Aggregates browser versions by country over the last 7 days of `country_daily_aggregates` files and writes:
 * 1. `src/_data/baseline_country_browser_breakdown.json`
 * 2. `src/assets/js/baseline-country-breakdown.js`
 * @param {ReturnType<typeof buildBbmLookups>} [lookups]
 */
export async function writeCountryBrowserBreakdownBundle(lookups) {
  let aggEntries = [];
  try {
    aggEntries = await fs.readdir(COUNTRY_AGGREGATES_DIR);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  const dailyFiles = aggEntries
    .filter((f) => f.endsWith(".json") && DATE_PATTERN.test(f.slice(0, -5)))
    .sort();

  if (dailyFiles.length === 0) return;

  const recentFiles = dailyFiles.slice(-AVG_WINDOW_DAYS);
  const recentDates = recentFiles.map((f) => f.slice(0, -5));
  const startDate = recentDates[0];
  const endDate = recentDates[recentDates.length - 1];
  const dataYear = Number(endDate.slice(0, 4));

  const effectiveLookups = lookups || buildBbmLookups();

  /** @type {Map<string, { totalPageLoads: number, mappedPageLoads: number, byBrowserVer: Map<string, { browser: string, version: string, pageLoads: number }> }>} */
  const byCountry = new Map();
  /** @type {Map<string, { browser: string, version: string }>} */
  const allBrowserVers = new Map();
  /** @type {Map<string, { browser: string, version: string } | null>} */
  const uaResolveCache = new Map();

  for (const fileName of recentFiles) {
    const inputPath = resolveSafeFilePath(COUNTRY_AGGREGATES_DIR, fileName);
    const raw = JSON.parse(await fs.readFile(inputPath, "utf8"));
    const schema = Array.isArray(raw.schema) ? raw.schema : [];
    const rows = Array.isArray(raw.rows) ? raw.rows : [];

    /** @type {Record<string, number>} */
    const colIdx = {};
    schema.forEach((col, idx) => {
      colIdx[col] = idx;
    });

    const countryCol = colIdx.COUNTRY;
    const countCol = colIdx.TOTAL ?? colIdx.count;
    const uaCol = colIdx.USERAGENTFAMILY;
    const uavCol = colIdx.USERAGENTVERSION;
    const engCol = colIdx.USERAGENTENGINE;
    const engvCol = colIdx.USERAGENTENGINEVERSION;
    const osCol = colIdx.OS;
    const osvCol = colIdx.OSVERSION;

    for (const row of rows) {
      const count = Number(row[countCol] || 0);
      if (count <= 0) continue;

      const countryCode = normalizeCountryCode(row[countryCol]);
      let cBucket = byCountry.get(countryCode);
      if (!cBucket) {
        cBucket = {
          totalPageLoads: 0,
          mappedPageLoads: 0,
          byBrowserVer: new Map(),
        };
        byCountry.set(countryCode, cBucket);
      }

      cBucket.totalPageLoads += count;

      const uaKey = `${row[uaCol] ?? ""}|${row[uavCol] ?? ""}|${row[engCol] ?? ""}|${row[engvCol] ?? ""}|${row[osCol] ?? ""}|${row[osvCol] ?? ""}`;
      let resolved = uaResolveCache.get(uaKey);
      if (resolved === undefined) {
        resolved = resolveRowToBaselineBrowser(row, colIdx, effectiveLookups);
        uaResolveCache.set(uaKey, resolved);
      }
      if (!resolved) continue;

      cBucket.mappedPageLoads += count;
      const bvKey = `${resolved.browser}|${resolved.version}`;
      if (!allBrowserVers.has(bvKey)) {
        allBrowserVers.set(bvKey, resolved);
      }

      const existing = cBucket.byBrowserVer.get(bvKey);
      if (existing) {
        existing.pageLoads += count;
      } else {
        cBucket.byBrowserVer.set(bvKey, {
          browser: resolved.browser,
          version: resolved.version,
          pageLoads: count,
        });
      }
    }
  }

  // Build minimum compatible version maps for each target as of `endDate`
  const widelyMinMap = toMinVersionMap(
    getCompatibleVersions({
      widelyAvailableOnDate: endDate,
      includeDownstreamBrowsers: true,
      suppressWarnings: true,
    })
  );
  const newlyMinMap = getNewlyAvailableMinVersionsOnDate(endDate, effectiveLookups.timelineEvents);

  /** @type {Record<string, Record<string, string>>} */
  const targetMinMaps = {
    widely: widelyMinMap,
    newly: newlyMinMap,
  };
  const targetsList = [
    { id: "newly", label: "Baseline Newly available", shortLabel: "Newly available", kind: "newly" },
    { id: "widely", label: "Baseline Widely available", shortLabel: "Widely available", kind: "widely" },
  ];

  for (let year = 2015; year <= dataYear; year++) {
    const yearStr = String(year);
    const yearEndCutoff = `${yearStr}-12-31` <= endDate ? `${yearStr}-12-31` : endDate;
    targetMinMaps[yearStr] = getNewlyAvailableMinVersionsOnDate(
      yearEndCutoff,
      effectiveLookups.timelineEvents
    );
    targetsList.push({
      id: yearStr,
      label: `Baseline ${yearStr}`,
      shortLabel: yearStr,
      kind: "year",
      year,
    });
  }

  // Enrich all distinct browser|version entries once in a shared catalog
  /** @type {Record<string, { browser: string, name: string, version: string, isDownstream: boolean, releaseDate: string | null, engine: string | null, engineVersion: string | null, engineReleaseDate: string | null }>} */
  const browserMeta = {};
  for (const [bvKey, { browser, version }] of allBrowserVers.entries()) {
    const meta = effectiveLookups.versionMetaByBrowser[browser]?.[version] || null;
    const isDownstream = DOWNSTREAM_BBM_BROWSERS.has(browser);
    const releaseDate = meta?.releaseDate || null;
    let engine = null;
    let engineVersion = null;
    let engineReleaseDate = null;

    if (isDownstream) {
      engine = meta?.engine || (browser === "kai_os" ? "Gecko" : "Blink");
      engineVersion =
        meta?.engineVersion || (browser === "webview_android" ? version : null);
      if (engine && engineVersion) {
        if (engine === "Gecko") {
          engineReleaseDate =
            effectiveLookups.versionMetaByBrowser.firefox?.[engineVersion]?.releaseDate ||
            effectiveLookups.versionMetaByBrowser.firefox_android?.[engineVersion]?.releaseDate ||
            null;
        } else {
          engineReleaseDate =
            effectiveLookups.versionMetaByBrowser.chrome?.[engineVersion]?.releaseDate ||
            effectiveLookups.versionMetaByBrowser.chrome_android?.[engineVersion]?.releaseDate ||
            null;
        }
      }
    }

    browserMeta[bvKey] = {
      browser,
      name: BBM_BROWSER_NAMES[browser] || browser,
      version,
      isDownstream,
      releaseDate,
      engine,
      engineVersion,
      engineReleaseDate,
    };
  }

  const sortedCountries = [...byCountry.entries()].sort(
    (a, b) => b[1].totalPageLoads - a[1].totalPageLoads
  );

  /** @type {Record<string, unknown>} */
  const countries = {};
  /** @type {Record<string, { m: number, rows: Array<[string, string, number, number]> }>} */
  const compactCountries = {};

  for (const [code, bucket] of sortedCountries) {
    const { totalPageLoads, mappedPageLoads, byBrowserVer } = bucket;
    const mappedPercentage =
      totalPageLoads > 0 ? round2((mappedPageLoads / totalPageLoads) * 100) : 0;

    const browsers = [...byBrowserVer.values()]
      .sort((a, b) => b.pageLoads - a.pageLoads)
      .map((item) => ({
        browser: item.browser,
        version: item.version,
        pageLoads: item.pageLoads,
        pct: mappedPageLoads > 0 ? round4((item.pageLoads / mappedPageLoads) * 100) : 0,
        pctTotal: totalPageLoads > 0 ? round4((item.pageLoads / totalPageLoads) * 100) : 0,
      }));

    countries[code] = {
      code,
      name: getCountryName(code),
      totalPageLoads,
      mappedPageLoads,
      unmappedPageLoads: totalPageLoads - mappedPageLoads,
      mappedPercentage,
      browserVersionCount: browsers.length,
      browsers,
    };

    compactCountries[code] = {
      m: mappedPercentage,
      rows: browsers.map((b) => [b.browser, b.version, b.pct, b.pctTotal]),
    };
  }

  const generatedAt = new Date().toISOString();
  const countryEntriesFormatted = Object.entries(countries)
    .map(([code, data]) => `    ${JSON.stringify(code)}: ${JSON.stringify(data)}`)
    .join(",\n");

  const breakdownJson =
    `{\n` +
    `  "generatedAt": ${JSON.stringify(generatedAt)},\n` +
    `  "windowDays": ${recentFiles.length},\n` +
    `  "startDate": ${JSON.stringify(startDate)},\n` +
    `  "endDate": ${JSON.stringify(endDate)},\n` +
    `  "countryCount": ${sortedCountries.length},\n` +
    `  "targets": ${JSON.stringify(targetsList)},\n` +
    `  "targetMinMaps": ${JSON.stringify(targetMinMaps)},\n` +
    `  "browserMeta": ${JSON.stringify(browserMeta)},\n` +
    `  "countries": {\n` +
    `${countryEntriesFormatted}\n` +
    `  }\n` +
    `}\n`;

  await fs.mkdir(path.dirname(COUNTRY_BREAKDOWN_DATA_PATH), { recursive: true });
  await fs.writeFile(COUNTRY_BREAKDOWN_DATA_PATH, breakdownJson, "utf8");

  // Compact client-side bundle for country browser breakdowns
  /** @type {Record<string, [string | null, string | null, string | null, string | null]>} */
  const compactMeta = {};
  for (const [bvKey, m] of Object.entries(browserMeta)) {
    compactMeta[bvKey] = [m.releaseDate, m.engine, m.engineVersion, m.engineReleaseDate];
  }

  const compactClientPayload = {
    w: recentFiles.length,
    s: startDate,
    e: endDate,
    names: BBM_BROWSER_NAMES,
    targets: targetsList,
    minMaps: targetMinMaps,
    meta: compactMeta,
    c: compactCountries,
  };

  const countryBreakdownJs =
    `(()=>{const D=${JSON.stringify(compactClientPayload)},cache={};` +
    `function getCountryBreakdown(code){if(cache[code])return cache[code];const C=D.c[code];if(!C)return null;` +
    `const browsers=C.rows.map(r=>{const k=r[0]+"|"+r[1],m=D.meta[k]||[null,null,null,null];` +
    `return{browser:r[0],name:D.names[r[0]]||r[0],version:r[1],pct:r[2],pctTotal:r[3],releaseDate:m[0],engine:m[1],engineVersion:m[2],engineReleaseDate:m[3],isDownstream:Boolean(m[1])}});` +
    `return(cache[code]={code,windowDays:D.w,startDate:D.s,endDate:D.e,mappedPercentage:C.m,targets:D.targets,targetMinMaps:D.minMaps,browsers})}` +
    `window.BASELINE_COUNTRY_BREAKDOWN={windowDays:D.w,startDate:D.s,endDate:D.e,targets:D.targets,targetMinMaps:D.minMaps,getCountry:getCountryBreakdown};` +
    `window.dispatchEvent(new CustomEvent("baseline-country-breakdown-ready",{detail:window.BASELINE_COUNTRY_BREAKDOWN}))})();\n`;

  await fs.mkdir(path.dirname(COUNTRY_BREAKDOWN_JS_BUNDLE_PATH), { recursive: true });
  await fs.writeFile(COUNTRY_BREAKDOWN_JS_BUNDLE_PATH, countryBreakdownJs, "utf8");
  console.log(
    `Wrote 7-day country browser breakdown (${sortedCountries.length} countries, ${Buffer.byteLength(countryBreakdownJs, "utf8")} bytes) -> ${path.relative(PROJECT_ROOT, COUNTRY_BREAKDOWN_JS_BUNDLE_PATH)}`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const force = process.argv.includes("--force");
  calculateAllDailyBaseline({ force }).catch((error) => {
    console.error("Error calculating daily Baseline compatibility:", error.message || error);
    process.exitCode = 1;
  });
}
