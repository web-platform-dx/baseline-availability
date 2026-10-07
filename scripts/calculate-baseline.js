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
 * Resolves a daily aggregate row to a `baseline-browser-mapping` browser ID and version.
 *
 * Rules:
 * 1. WebKit browsers: Use the browser version (`USERAGENTVERSION`) or OS version (`OSVERSION`)
 *    when it matches a valid Safari / iOS major version in `baseline-browser-mapping`.
 * 2. Blink browsers: If `USERAGENTENGINEVERSION` is absent and `USERAGENTVERSION` matches a known
 *    downstream browser version in `baseline-browser-mapping`, use that downstream browser.
 *    Otherwise, use the Blink engine version (`USERAGENTENGINEVERSION` or `USERAGENTVERSION`)
 *    and map it to Chrome (`chrome`, `chrome_android`, `edge`, or `webview_android`).
 * 3. Gecko browsers: Use the Gecko engine version (`USERAGENTENGINEVERSION` or `USERAGENTVERSION`)
 *    and map it to Firefox (`firefox` or `firefox_android`).
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

  const isBlink = eng === "Blink";
  const isGecko = eng === "Gecko";
  const isWebKit = eng === "WebKit" || eng === "Web Kit";

  // 1. WebKit / iOS / Safari rows
  if (isWebKit || ua === "s" || ua === "si" || ua === "siw" || os === "iOS") {
    const targetBrowser = os === "Mac OS X" || ua === "s" ? "safari" : "safari_ios";

    if (isValidVersion(uav) && lookups.safariMajorVersions.has(getMajorVersion(uav))) {
      return { browser: targetBrowser, version: String(uav) };
    }

    if (isValidVersion(osv) && lookups.safariMajorVersions.has(getMajorVersion(osv))) {
      // On iOS, OS version maps directly to Safari iOS version; on macOS, unified 26+ maps to Safari 26+
      if (os === "iOS" || Number(getMajorVersion(osv)) >= 26) {
        return { browser: targetBrowser, version: String(osv) };
      }
    }

    return null;
  }

  // 2. Blink rows
  if (isBlink || BLINK_BROWSER_SHORTS.has(ua)) {
    if (!isValidVersion(engv) && Object.hasOwn(DOWNSTREAM_SHORT_TO_BBM, ua) && isValidVersion(uav)) {
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

    const blinkVersion = isValidVersion(engv)
      ? String(engv)
      : isValidVersion(uav)
        ? String(uav)
        : null;

    if (blinkVersion) {
      if (ua === "e") return { browser: "edge", version: blinkVersion };
      if (ua === "wva") return { browser: "webview_android", version: blinkVersion };
      if (os === "Android OS" || ua === "ca") return { browser: "chrome_android", version: blinkVersion };
      return { browser: "chrome", version: blinkVersion };
    }

    return null;
  }

  // 3. Gecko rows
  if (isGecko || ua === "f" || ua === "fa") {
    const geckoVersion = isValidVersion(engv)
      ? String(engv)
      : isValidVersion(uav)
        ? String(uav)
        : null;

    if (geckoVersion) {
      return {
        browser: os === "Android OS" ? "firefox_android" : "firefox",
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
 * Formats compatibility metrics for a single Baseline target.
 * @param {number} compatiblePageLoads
 * @param {number} mappedPageLoads
 * @param {number} totalPageLoads
 */
function formatTargetMetrics(compatiblePageLoads, mappedPageLoads, totalPageLoads) {
  return {
    compatiblePageLoads,
    percentage: mappedPageLoads > 0 ? round2((compatiblePageLoads / mappedPageLoads) * 100) : 0,
    percentageOfTotal: totalPageLoads > 0 ? round2((compatiblePageLoads / totalPageLoads) * 100) : 0,
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
    let widelyCompatibleLoads = 0;
    let newlyCompatibleLoads = 0;
    /** @type {Record<string, number>} */
    const annualCompatibleLoads = Object.fromEntries(
      Object.keys(annualMinMaps).map((year) => [year, 0])
    );

    const countCol = colIdx.TOTAL ?? colIdx.count;
    for (const row of rows) {
      const count = Number(row[countCol] || 0);
      totalPageLoads += count;

      const resolved = resolveRowToBaselineBrowser(row, colIdx, lookups);
      if (!resolved) {
        continue;
      }

      mappedPageLoads += count;

      const widelyMin = widelyMinMap[resolved.browser];
      if (widelyMin !== undefined && compareVersions(resolved.version, widelyMin) >= 0) {
        widelyCompatibleLoads += count;
      }

      const newlyMin = newlyMinMap[resolved.browser];
      if (newlyMin !== undefined && compareVersions(resolved.version, newlyMin) >= 0) {
        newlyCompatibleLoads += count;
      }

      for (const [year, minMap] of Object.entries(annualMinMaps)) {
        const minVer = minMap[resolved.browser];
        if (minVer !== undefined && compareVersions(resolved.version, minVer) >= 0) {
          annualCompatibleLoads[year] += count;
        }
      }
    }

    /** @type {Record<string, ReturnType<typeof formatTargetMetrics>>} */
    const annualTargets = {};
    for (const [year, loads] of Object.entries(annualCompatibleLoads)) {
      annualTargets[year] = formatTargetMetrics(loads, mappedPageLoads, totalPageLoads);
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      date: dateStr,
      totalPageLoads,
      mappedPageLoads,
      unmappedPageLoads: totalPageLoads - mappedPageLoads,
      mappedPercentage: totalPageLoads > 0 ? round2((mappedPageLoads / totalPageLoads) * 100) : 0,
      widelyAvailable: formatTargetMetrics(widelyCompatibleLoads, mappedPageLoads, totalPageLoads),
      newlyAvailable: formatTargetMetrics(newlyCompatibleLoads, mappedPageLoads, totalPageLoads),
      annualTargets,
    };

    await fs.writeFile(outputPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    console.log(
      `Wrote Baseline compatibility for ${dateStr} -> ${path.relative(PROJECT_ROOT, outputPath)} ` +
        `(Widely: ${payload.widelyAvailable.percentage}%, Newly: ${payload.newlyAvailable.percentage}%)`
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const force = process.argv.includes("--force");
  calculateAllDailyBaseline({ force }).catch((error) => {
    console.error("Error calculating daily Baseline compatibility:", error.message || error);
    process.exitCode = 1;
  });
}
