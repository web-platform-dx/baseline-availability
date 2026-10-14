# Changelog

All notable changes to the **Baseline Availability** dashboard and data pipeline are documented in this file.
Update this changelog whenever a user-facing feature, data calculation change, or site improvement is made.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2026-10-14]

### Added
- **Multi-location combination & exclusion in `<baseline-location-filter>`**: Upgraded the Region / Country picker to support combining multiple regions and/or countries (`Include`) and excluding specific regions and/or countries (`Exclude`, either from **Worldwide** or from selected regions) using theme-adaptive vector SVG checkmark and cross action buttons, keyboard shortcuts (`Enter` to include, `Shift+Enter` to exclude), removable active filter chips, and shareable comma-separated URL query parameters (`?country=US,GB`, `?region=europe`, `?exclude=CN,SG`).

### Changed
- **iOS browser breakdown aggregation & display**: For iOS traffic where `USERAGENTFAMILY` is not `Mobile Safari`, the 7-day browser compatibility breakdown now aggregates rows by `(USERAGENTFAMILY, OSVERSION)` and displays them as `"App name (on iOS VERSION)"` (e.g., `Chrome Mobile (on iOS 26.6)`, `Firefox Mobile (on iOS 18.7)`) rather than merging them into `Safari on iOS` or splitting by app version.

## [2026-10-13]

### Added
- **Location and target filter URL parameters (`?country=`, `?region=`, and `?target=`)**: Added deep-linking and browser history navigation (`history.pushState` and `popstate` support) for `<baseline-location-filter>`, `<baseline-summary-table>`, `<baseline-timeseries-chart>`, and `<baseline-browser-breakdown>`, supporting ISO 3166-1 alpha-2 country codes or country slugs (`?country=US`, `?country=united-states`), UN M49 region slugs or numeric codes (`?region=europe`, `?region=northern-europe`, `?region=150`), and Baseline target filters (`?target=widely`, `?target=newly`, `?target=2025`), while clearing parameters when **Worldwide** is selected or a target is unpinned.
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
