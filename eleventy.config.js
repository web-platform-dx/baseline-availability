import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HtmlBasePlugin } from "@11ty/eleventy";
import { getCompatibleVersions } from "baseline-browser-mapping";
import esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const browsersDefinitions = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "src", "_data", "browsers.json"), "utf8")
);
const shortToFamily = browsersDefinitions.shortToFamily || {};

// Map baseline-browser-mapping browser keys to esbuild target names
const BBM_TO_ESBUILD = {
  chrome: "chrome",
  edge: "edge",
  firefox: "firefox",
  safari: "safari",
  safari_ios: "ios",
};

const esbuildTargets = getCompatibleVersions({ suppressWarnings: true })
  .filter((b) => b.browser in BBM_TO_ESBUILD)
  .map((b) => `${BBM_TO_ESBUILD[b.browser]}${b.version}`);

/** @param {import("@11ty/eleventy").UserConfig} eleventyConfig */
export default function (eleventyConfig) {
  // Automatically prefix internal URLs when deployed to a GitHub Pages project site
  // (e.g. https://web-platform-dx.github.io/baseline-availability/)
  eleventyConfig.addPlugin(HtmlBasePlugin);

  // Copy static SVG/image assets directly to the output directory
  eleventyConfig.addPassthroughCopy("src/assets/img");

  // Compile CSS files targeting Baseline Widely available via esbuild
  eleventyConfig.addTemplateFormats("css");
  eleventyConfig.addExtension("css", {
    outputFileExtension: "css",
    compile: async function (inputContent, inputPath) {
      return async () => {
        const result = await esbuild.transform(inputContent, {
          loader: "css",
          target: esbuildTargets,
          minify: true,
          sourcefile: inputPath,
        });
        return result.code;
      };
    },
  });

  // Compile JS files targeting Baseline Widely available via esbuild
  eleventyConfig.addTemplateFormats("js");
  eleventyConfig.addExtension("js", {
    outputFileExtension: "js",
    compile: async function (inputContent, inputPath) {
      return async () => {
        const result = await esbuild.transform(inputContent, {
          loader: "js",
          target: esbuildTargets,
          minify: true,
          sourcefile: inputPath,
        });
        return result.code;
      };
    },
  });

  // Bind local dev server strictly to localhost
  eleventyConfig.setServerOptions({
    host: "127.0.0.1",
    port: 8080,
  });

  // Formatting filter for numbers in templates
  eleventyConfig.addFilter("formatNumber", (value) => {
    if (typeof value !== "number") return value;
    return new Intl.NumberFormat("en-US").format(value);
  });

  eleventyConfig.addFilter("formatPct", (value) => {
    const num = Number(value);
    if (Number.isNaN(num)) return "0.00%";
    return `${num.toFixed(2)}%`;
  });

  eleventyConfig.addFilter("formatDelta", (value) => {
    const num = Number(value);
    if (Number.isNaN(num) || num === 0) return "0.00%";
    return `${num > 0 ? "+" : ""}${num.toFixed(2)}%`;
  });

  eleventyConfig.addFilter("formatTrafficShare", (value) => {
    const num = Number(value);
    if (Number.isNaN(num) || num <= 0) return "<0.01%";
    if (num < 0.01) return "<0.01%";
    return `${num.toFixed(2)}%`;
  });

  eleventyConfig.addFilter("head", (arr, count = 50) => {
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, count);
  });

  // Builds the structured UN M49 region tree + country groups for the location filter dropdown
  eleventyConfig.addFilter("buildLocationHierarchy", (regionSummary, countrySummary) => {
    if (!regionSummary || !countrySummary) {
      return { regionTree: [], countryGroups: [] };
    }

    const macroList = Array.isArray(regionSummary.unM49MacroRegions)
      ? regionSummary.unM49MacroRegions
      : [];
    const subList = Array.isArray(regionSummary.unM49Subregions)
      ? regionSummary.unM49Subregions
      : [];
    const leafList = Array.isArray(regionSummary.unM49LeafRegions)
      ? regionSummary.unM49LeafRegions
      : [];
    const countries = Array.isArray(countrySummary.countries) ? countrySummary.countries : [];

    const regionTree = [];
    const countryGroups = [];

    for (const macro of macroList) {
      regionTree.push({
        value: `region:${macro.code}`,
        code: macro.code,
        name: macro.name,
        depth: 0,
        kind: "macro",
        parentLabel: "Macro-region",
        breadcrumb: macro.name,
        activeCountryCount: macro.activeCountryCount,
        memberCountries: (macro.memberCountries || []).join(","),
        shareOfGlobalTraffic: macro.shareOfGlobalTraffic,
        avgMappedPercentage: macro.avgMappedPercentage,
      });

      const subs = subList.filter(
        (s) => s.macroRegion === macro.code && s.code !== macro.code
      );

      for (const sub of subs) {
        regionTree.push({
          value: `region:${sub.code}`,
          code: sub.code,
          name: sub.name,
          depth: 1,
          kind: "subregion",
          parentLabel: macro.name,
          breadcrumb: `${macro.name} › ${sub.name}`,
          activeCountryCount: sub.activeCountryCount,
          memberCountries: (sub.memberCountries || []).join(","),
          shareOfGlobalTraffic: sub.shareOfGlobalTraffic,
          avgMappedPercentage: sub.avgMappedPercentage,
        });

        const leaves = leafList.filter(
          (l) => l.subregion === sub.code && l.code !== sub.code
        );

        if (leaves.length > 0) {
          for (const leaf of leaves) {
            const leafBreadcrumb = `${macro.name} › ${sub.name} › ${leaf.name}`;
            regionTree.push({
              value: `region:${leaf.code}`,
              code: leaf.code,
              name: leaf.name,
              depth: 2,
              kind: "leaf",
              parentLabel: `${sub.name}, ${macro.name}`,
              breadcrumb: leafBreadcrumb,
              activeCountryCount: leaf.activeCountryCount,
              memberCountries: (leaf.memberCountries || []).join(","),
              shareOfGlobalTraffic: leaf.shareOfGlobalTraffic,
              avgMappedPercentage: leaf.avgMappedPercentage,
            });

            const memberCountries = countries.filter(
              (c) => c.regions?.leafRegion === leaf.code
            );
            if (memberCountries.length > 0) {
              countryGroups.push({
                regionCode: leaf.code,
                label: `${leafBreadcrumb} — Countries`,
                breadcrumb: leafBreadcrumb,
                countries: memberCountries,
              });
            }
          }
        } else {
          const subBreadcrumb = `${macro.name} › ${sub.name}`;
          const memberCountries = countries.filter(
            (c) => c.regions?.subregion === sub.code
          );
          if (memberCountries.length > 0) {
            countryGroups.push({
              regionCode: sub.code,
              label: `${subBreadcrumb} — Countries`,
              breadcrumb: subBreadcrumb,
              countries: memberCountries,
            });
          }
        }
      }

      // Handle macro-regions whose subregion code equals macro code (e.g. 010 Antarctica)
      if (subs.length === 0) {
        const memberCountries = countries.filter(
          (c) => c.regions?.macroRegion === macro.code
        );
        if (memberCountries.length > 0) {
          countryGroups.push({
            regionCode: macro.code,
            label: `${macro.name} — Countries & Territories`,
            breadcrumb: macro.name,
            countries: memberCountries,
          });
        }
      }
    }

    // Include any unmapped / unknown country entries (e.g. XX) at the end
    const unmappedCountries = countries.filter((c) => !c.regions?.macroRegion);
    if (unmappedCountries.length > 0) {
      countryGroups.push({
        regionCode: "XX",
        label: "Other / Unspecified GeoIP",
        breadcrumb: "Unspecified GeoIP",
        countries: unmappedCountries,
      });
    }

    return { regionTree, countryGroups };
  });

  // Builds the structured Regions & Countries availability table model for /regions/
  eleventyConfig.addFilter(
    "buildRegionsTableModel",
    (regionSummary, countrySummary, globalSummary) => {
      if (!regionSummary || !countrySummary) {
        return null;
      }

      const collator = new Intl.Collator("en", { sensitivity: "base" });
      const round2 = (val) => Math.round(val * 100) / 100;

      const sampleRows =
        (Array.isArray(globalSummary?.rows) && globalSummary.rows.length > 0
          ? globalSummary.rows
          : regionSummary.unM49MacroRegions?.[0]?.rows) || [];

      const widelyDef = sampleRows.find((r) => r.id === "widely");
      const newlyDef = sampleRows.find((r) => r.id === "newly");
      const yearDefs = sampleRows
        .filter((r) => r.kind === "year" && r.year !== null && r.year !== undefined)
        .slice()
        .sort((a, b) => Number(b.year) - Number(a.year));

      const globalTotalPageLoads = Number(
        countrySummary.globalRecentTotalPageLoads || 0
      );

      const columns = [
        {
          id: "traffic",
          shortLabel: "Global Traffic",
          fullLabel: "Proportion of global traffic",
          kind: "traffic",
          year: null,
        },
      ];
      if (widelyDef) {
        columns.push({
          id: "widely",
          shortLabel: "Widely",
          fullLabel: "Baseline Widely available",
          kind: "widely",
          year: null,
        });
      }
      if (newlyDef) {
        columns.push({
          id: "newly",
          shortLabel: "Newly",
          fullLabel: "Baseline Newly available",
          kind: "newly",
          year: null,
        });
      }
      for (const yRow of yearDefs) {
        columns.push({
          id: String(yRow.id),
          shortLabel: String(yRow.year),
          fullLabel: yRow.label || `Baseline ${yRow.year}`,
          kind: "year",
          year: Number(yRow.year),
        });
      }

      const computeMetrics = (entity, isGlobal = false) => {
        const entityRows = Array.isArray(entity?.rows) ? entity.rows : [];
        const hasData = isGlobal
          ? entityRows.length > 0
          : Number(entity?.mappedPageLoads || 0) > 0 && entityRows.length > 0;

        const rowById = new Map();
        let maxWvPctOfMapped = 0;
        for (const r of entityRows) {
          rowById.set(String(r.id), r);
          const p = Number(r.avgPercentage || 0);
          const wv =
            Number(r.avgAndroidWebviewPercentage || 0) +
            Number(r.avgIosWebviewPercentage || 0);
          const wvPct = (p * wv) / 100;
          if (wvPct > maxWvPctOfMapped) {
            maxWvPctOfMapped = wvPct;
          }
        }

        const denom = Math.max(0, 100 - maxWvPctOfMapped);
        const hasNoWvData = hasData && denom > 0.0001;

        const totalLoads = Number(entity?.totalPageLoads || 0);
        const exactTrafficShare = isGlobal
          ? 100
          : globalTotalPageLoads > 0 && totalLoads > 0
            ? Number(((totalLoads / globalTotalPageLoads) * 100).toPrecision(8))
            : Number(entity?.shareOfGlobalTraffic || 0);
        const trafficDisplay = isGlobal
          ? "100.00%"
          : totalLoads <= 0 && exactTrafficShare <= 0
            ? "0.00%"
            : exactTrafficShare < 0.01
              ? "<0.01%"
              : `${exactTrafficShare.toFixed(2)}%`;

        const cells = columns.map((col) => {
          if (col.id === "traffic") {
            return {
              id: "traffic",
              kind: "traffic",
              pct: exactTrafficShare,
              pctNoWv: exactTrafficShare,
              display: trafficDisplay,
            };
          }
          const r = rowById.get(col.id);
          if (!hasData || !r) {
            return {
              id: col.id,
              kind: col.kind,
              pct: null,
              pctNoWv: null,
              display: null,
            };
          }
          const pct = round2(Number(r.avgPercentage || 0));
          let pctNoWv = null;
          if (hasNoWvData) {
            const wv =
              Number(r.avgAndroidWebviewPercentage || 0) +
              Number(r.avgIosWebviewPercentage || 0);
            const nonWvCompat = Number(r.avgPercentage || 0) * (1 - wv / 100);
            pctNoWv = round2(
              Math.min(100, Math.max(0, (nonWvCompat / denom) * 100))
            );
          }
          return {
            id: col.id,
            kind: col.kind,
            pct,
            pctNoWv,
            display: `${pct.toFixed(2)}%`,
          };
        });

        return { hasData, hasNoWvData, cells };
      };

      const macroList = (
        Array.isArray(regionSummary.unM49MacroRegions)
          ? regionSummary.unM49MacroRegions
          : []
      )
        .slice()
        .sort((a, b) => collator.compare(a.name, b.name));

      const subList = Array.isArray(regionSummary.unM49Subregions)
        ? regionSummary.unM49Subregions
        : [];
      const leafList = Array.isArray(regionSummary.unM49LeafRegions)
        ? regionSummary.unM49LeafRegions
        : [];
      const countries = Array.isArray(countrySummary.countries)
        ? countrySummary.countries
        : [];

      const rows = [];
      let regionGroupCount = 0;

      for (const macro of macroList) {
        const macroCountries = countries.filter(
          (c) => c.regions?.macroRegion === macro.code
        );
        const subs = subList
          .filter((s) => s.macroRegion === macro.code && s.code !== macro.code)
          .sort((a, b) => collator.compare(a.name, b.name));

        const macroNodeId = `region:${macro.code}`;
        const macroMetrics = computeMetrics(macro, false);
        regionGroupCount += 1;
        rows.push({
          nodeId: macroNodeId,
          parentId: "",
          rowKind: "region",
          regionLevel: "macro",
          treeDepth: 0,
          code: macro.code,
          name: macro.name,
          breadcrumb: macro.name,
          countryCount: macroCountries.length,
          hasChildren: subs.length > 0 || macroCountries.length > 0,
          sortLast: false,
          shareOfGlobalTraffic: Number(macro.shareOfGlobalTraffic || 0),
          drilldownHref: `/?region=${encodeURIComponent(macro.code)}`,
          ...macroMetrics,
        });

        if (subs.length > 0) {
          for (const sub of subs) {
            const subCountries = countries.filter(
              (c) => c.regions?.subregion === sub.code
            );
            const leaves = leafList
              .filter((l) => l.subregion === sub.code && l.code !== sub.code)
              .sort((a, b) => collator.compare(a.name, b.name));

            const subNodeId = `region:${sub.code}`;
            const subBreadcrumb = `${macro.name} › ${sub.name}`;
            const subMetrics = computeMetrics(sub, false);
            regionGroupCount += 1;
            rows.push({
              nodeId: subNodeId,
              parentId: macroNodeId,
              rowKind: "region",
              regionLevel: "subregion",
              treeDepth: 1,
              code: sub.code,
              name: sub.name,
              breadcrumb: subBreadcrumb,
              countryCount: subCountries.length,
              hasChildren: leaves.length > 0 || subCountries.length > 0,
              sortLast: false,
              shareOfGlobalTraffic: Number(sub.shareOfGlobalTraffic || 0),
              drilldownHref: `/?region=${encodeURIComponent(sub.code)}`,
              ...subMetrics,
            });

            if (leaves.length > 0) {
              for (const leaf of leaves) {
                const leafCountries = countries
                  .filter((c) => c.regions?.leafRegion === leaf.code)
                  .sort((a, b) => collator.compare(a.name, b.name));
                const leafNodeId = `region:${leaf.code}`;
                const leafBreadcrumb = `${subBreadcrumb} › ${leaf.name}`;
                const leafMetrics = computeMetrics(leaf, false);
                regionGroupCount += 1;
                rows.push({
                  nodeId: leafNodeId,
                  parentId: subNodeId,
                  rowKind: "region",
                  regionLevel: "leaf",
                  treeDepth: 2,
                  code: leaf.code,
                  name: leaf.name,
                  breadcrumb: leafBreadcrumb,
                  countryCount: leafCountries.length,
                  hasChildren: leafCountries.length > 0,
                  sortLast: false,
                  shareOfGlobalTraffic: Number(leaf.shareOfGlobalTraffic || 0),
                  drilldownHref: `/?region=${encodeURIComponent(leaf.code)}`,
                  ...leafMetrics,
                });

                for (const country of leafCountries) {
                  const cMetrics = computeMetrics(country, false);
                  rows.push({
                    nodeId: `country:${country.code}`,
                    parentId: leafNodeId,
                    rowKind: "country",
                    regionLevel: "",
                    treeDepth: 3,
                    code: country.code,
                    name: country.name,
                    breadcrumb: leafBreadcrumb,
                    countryCount: 0,
                    hasChildren: false,
                    sortLast: false,
                    shareOfGlobalTraffic: Number(
                      country.shareOfGlobalTraffic || 0
                    ),
                    drilldownHref: `/?country=${encodeURIComponent(country.code)}`,
                    ...cMetrics,
                  });
                }
              }
            } else {
              const sortedSubCountries = subCountries
                .slice()
                .sort((a, b) => collator.compare(a.name, b.name));
              for (const country of sortedSubCountries) {
                const cMetrics = computeMetrics(country, false);
                rows.push({
                  nodeId: `country:${country.code}`,
                  parentId: subNodeId,
                  rowKind: "country",
                  regionLevel: "",
                  treeDepth: 2,
                  code: country.code,
                  name: country.name,
                  breadcrumb: subBreadcrumb,
                  countryCount: 0,
                  hasChildren: false,
                  sortLast: false,
                  shareOfGlobalTraffic: Number(
                    country.shareOfGlobalTraffic || 0
                  ),
                  drilldownHref: `/?country=${encodeURIComponent(country.code)}`,
                  ...cMetrics,
                });
              }
            }
          }
        } else {
          const sortedMacroCountries = macroCountries
            .slice()
            .sort((a, b) => collator.compare(a.name, b.name));
          for (const country of sortedMacroCountries) {
            const cMetrics = computeMetrics(country, false);
            rows.push({
              nodeId: `country:${country.code}`,
              parentId: macroNodeId,
              rowKind: "country",
              regionLevel: "",
              treeDepth: 1,
              code: country.code,
              name: country.name,
              breadcrumb: macro.name,
              countryCount: 0,
              hasChildren: false,
              sortLast: false,
              shareOfGlobalTraffic: Number(country.shareOfGlobalTraffic || 0),
              drilldownHref: `/?country=${encodeURIComponent(country.code)}`,
              ...cMetrics,
            });
          }
        }
      }

      const unmappedCountries = countries
        .filter((c) => !c.regions?.macroRegion)
        .sort((a, b) => collator.compare(a.name, b.name));

      if (unmappedCountries.length > 0) {
        const primaryUnmapped = unmappedCountries[0];
        const unmappedGroupMetrics = computeMetrics(primaryUnmapped, false);
        const unmappedNodeId = "region:XX";
        regionGroupCount += 1;
        rows.push({
          nodeId: unmappedNodeId,
          parentId: "",
          rowKind: "region",
          regionLevel: "macro",
          treeDepth: 0,
          code: "XX",
          name: "Other / Unspecified",
          breadcrumb: "Other / Unspecified",
          countryCount: unmappedCountries.length,
          hasChildren: true,
          sortLast: true,
          shareOfGlobalTraffic: Number(
            primaryUnmapped.shareOfGlobalTraffic || 0
          ),
          drilldownHref: "/?country=XX",
          ...unmappedGroupMetrics,
        });

        for (const country of unmappedCountries) {
          const cMetrics = computeMetrics(country, false);
          rows.push({
            nodeId: `country:${country.code}`,
            parentId: unmappedNodeId,
            rowKind: "country",
            regionLevel: "",
            treeDepth: 1,
            code: country.code,
            name: country.name,
            breadcrumb: "Other / Unspecified",
            countryCount: 0,
            hasChildren: false,
            sortLast: true,
            shareOfGlobalTraffic: Number(country.shareOfGlobalTraffic || 0),
            drilldownHref: `/?country=${encodeURIComponent(country.code)}`,
            ...cMetrics,
          });
        }
      }

      const globalRow = globalSummary
        ? {
            nodeId: "global:WW",
            name: "Worldwide",
            code: "WW",
            shareOfGlobalTraffic: 100,
            drilldownHref: "/",
            ...computeMetrics(globalSummary, true),
          }
        : null;

      return {
        columns,
        globalRow,
        rows,
        macroCount: macroList.length,
        regionGroupCount,
        countryCount: countries.length,
        recentWindowDays:
          globalSummary?.recentWindowDays ||
          regionSummary.recentWindowDays ||
          7,
        recentStartDate:
          globalSummary?.recentStartDate || regionSummary.recentStartDate || "",
        recentEndDate:
          globalSummary?.recentEndDate || regionSummary.recentEndDate || "",
      };
    }
  );

  // Unpacks per-day files in src/_data/bigquery/global_daily_aggregates/<YYYY-MM-DD>.json
  // using each file's `schema` array to map compact row arrays into objects for display.
  eleventyConfig.addFilter("summarizeDailyAggregates", (dailyMap, limit = 25) => {
    if (!dailyMap || typeof dailyMap !== "object") {
      return null;
    }
    const dates = Object.keys(dailyMap)
      .filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key) && Array.isArray(dailyMap[key]?.rows))
      .sort();
    if (dates.length === 0) {
      return null;
    }

    let totalRows = 0;
    let latestGeneratedAt = null;
    const sampleRows = [];

    // Use the most recent date first for the preview table
    for (const date of [...dates].reverse()) {
      const dayData = dailyMap[date];
      const rows = dayData.rows || [];
      const schema = dayData.schema || [];
      totalRows += rows.length;
      if (dayData.generatedAt && (!latestGeneratedAt || dayData.generatedAt > latestGeneratedAt)) {
        latestGeneratedAt = dayData.generatedAt;
      }
      if (sampleRows.length < limit) {
        const needed = limit - sampleRows.length;
        for (const rowArr of rows.slice(0, needed)) {
          const rowObj = { DATE: dayData.date || date };
          for (let i = 0; i < schema.length; i++) {
            const col = schema[i];
            const val = rowArr[i];
            if (col === "USERAGENTFAMILY" && typeof val === "string" && val in shortToFamily) {
              rowObj.browserShortName = val;
              rowObj[col] = shortToFamily[val];
            } else {
              rowObj[col] = val;
            }
          }
          if (rowObj.count === undefined && rowObj.TOTAL !== undefined) {
            rowObj.count = rowObj.TOTAL;
          }
          sampleRows.push(rowObj);
        }
      }
    }

    return {
      generatedAt: latestGeneratedAt,
      totalRows,
      dayCount: dates.length,
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      rows: sampleRows,
    };
  });

  return {
    pathPrefix: process.env.ELEVENTY_PATH_PREFIX || "/",
    dir: {
      input: "src",
      includes: "_includes",
      data: "_data",
      output: "_site",
    },
    templateFormats: ["njk", "md", "html", "css", "js"],
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk",
  };
}
