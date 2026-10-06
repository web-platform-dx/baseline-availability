import { HtmlBasePlugin } from "@11ty/eleventy";

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
