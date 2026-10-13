# Changelog

All notable changes to the **Baseline Availability** dashboard and data pipeline are documented in this file.
Update this changelog whenever a user-facing feature, data calculation change, or site improvement is made.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2026-10-13]

### Added
- **Include WebViews / Exclude WebViews toggle**: Added a synchronized toggle in the 7-day average summary table and the 7-day browser compatibility breakdown to switch between including and excluding Android (`Chrome Mobile WebView`) and iOS (`Mobile Safari WebView`) traffic across the summary table, 90-day time-series chart, and browser version breakdown (and hiding the WebView share columns when WebViews are excluded), derived at runtime from existing WebView share data.
- **Project changelog**: Added `CHANGELOG.md` to track ongoing site and data pipeline changes.

### Changed
- Updated `README.md` to reference the Cloudflare BEACON RUM dataset and project structure.
- Updated the unmapped traffic explanatory footnote to remove the reference to the `% of Total` toggle.

### Removed
- Removed the `% of Mapped / % of Total` denominator toggle from the summary table and browser breakdown cards, as unmapped traffic is already explained in the page footnote.

## [2026-10-12]

### Added
- **Interactive Location Filter (Worldwide, UN M49 Regions, and Countries)**: Added `<baseline-location-filter>` at the top of the dashboard to filter the 7-day summary table, time-series chart, and browser compatibility breakdown by Worldwide, UN M49 macro-region/sub-region/intermediate region, or individual ISO 3166-1 alpha-2 country.
- **Searchable WAI-ARIA 1.2 Combobox**: Converted the location selector into a keyboard-accessible searchable combobox with instant filtering by region name, country name, ISO code, or common aliases (e.g., `UK`, `USA`, `UAE`).
- **Unmapped traffic footnote**: Added an explanatory footnote linked from the **Mapped traffic** summary pill detailing why ~9–11% of global RUM Archive beacons cannot be deterministically mapped to a Baseline browser release.

### Fixed
- **Browser mapping coverage**: Mapped additional real-world RUM Archive user agents (`Waterfox`, `Pale Moon`, `Facebook` on Android with Chromium engine versions, `DuckDuckGo` on macOS/Windows, and `Chrome Mobile` on iOS) to their corresponding `baseline-browser-mapping` browser or upstream engine releases.

## [2026-10-09]

### Added
- **7-Day Browser Compatibility Breakdown (`<baseline-browser-breakdown>`)**: Added a horizontal stacked compatibility bar chart and dual sortable tables (*Compatible Browsers* and *Incompatible Browsers*) with traffic share, browser release date, and downstream engine release date columns.
- **Country & UN M49 Regional Aggregation Pipeline**: Added `queries/country_daily_aggregates.sql`, `src/_data/regions.json`, and country/regional rollup generation in `scripts/calculate-baseline.js`.
- **License**: Added the Apache 2.0 `LICENSE` file.

## [2026-10-08]

### Added
- **7-Day Summary Table & 90-Day Time-Series Chart**: Built `<baseline-summary-table>` and `<baseline-timeseries-chart>` for inspecting Baseline Widely available, Baseline Newly available, and yearly Baseline target (2016–2026) compatibility over time.
- **Android & iOS WebView Share Columns**: Split WebView share reporting into dedicated **Android WebView Share** and **iOS WebView Share** columns.
- **Dark Mode Theme Toggle**: Added light/dark theme switching in the site header with `localStorage` persistence and `prefers-color-scheme` support.
- **Work-in-Progress Banner**: Added a top banner noting that the site is under active development.

## [2026-10-06]

### Added
- **Initial Eleventy Site & BigQuery Pipeline**: Scaffolded the Eleventy (11ty) static site, GitHub Pages deployment workflow (`.github/workflows/deploy.yml`), BigQuery daily aggregation script (`scripts/fetch-data.js`), and `baseline-browser-mapping` calculation script (`scripts/calculate-baseline.js`).
