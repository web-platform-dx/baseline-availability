import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCompatibleVersions, getTimeline } from "baseline-browser-mapping";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, "..");
const AGGREGATES_DIR = path.resolve(PROJECT_ROOT, "src", "_data", "bigquery", "global_daily_aggregates");
const OUTPUT_DIR = path.resolve(PROJECT_ROOT, "src", "_data", "baseline_daily");

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
  for (const entry of allKnownVersions) {
    if (!knownVersionsByBrowser[entry.browser]) {
      knownVersionsByBrowser[entry.browser] = new Set();
    }
    knownVersionsByBrowser[entry.browser].add(entry.version);
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
}

const SUMMARY_DATA_PATH = path.resolve(PROJECT_ROOT, "src", "_data", "baseline_summary.json");
const INITIAL_JS_BUNDLE_PATH = path.resolve(PROJECT_ROOT, "src", "assets", "js", "baseline-initial-data.js");
const MAX_CHART_DAYS = 90;
const AVG_WINDOW_DAYS = 7;

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
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const force = process.argv.includes("--force");
  calculateAllDailyBaseline({ force }).catch((error) => {
    console.error("Error calculating daily Baseline compatibility:", error.message || error);
    process.exitCode = 1;
  });
}
