import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HtmlBasePlugin } from "@11ty/eleventy";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const browsersDefinitions = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "src", "_data", "browsers.json"), "utf8")
);
const shortToFamily = browsersDefinitions.shortToFamily || {};

/** @param {import("@11ty/eleventy").UserConfig} eleventyConfig */
export default function (eleventyConfig) {
  // Automatically prefix internal URLs when deployed to a GitHub Pages project site
  // (e.g. https://web-platform-dx.github.io/baseline-availability/)
  eleventyConfig.addPlugin(HtmlBasePlugin);

  // Copy static assets directly to the output directory
  eleventyConfig.addPassthroughCopy("src/css");
  eleventyConfig.addPassthroughCopy("src/assets");

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
    templateFormats: ["njk", "md", "html"],
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk",
  };
}
