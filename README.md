# Baseline Availability

Public dashboard detailing Web Platform Baseline availability.  Based on the [Cloudflare BEACON RUM dataset](https://blog.cloudflare.com/how-fast-is-the-web/), this dashboard is built with **Eleventy (11ty)** and hosted at the [Baseline Availability](https://github.com/web-platform-dx/baseline-availability) site.

## Project Structure

```text
├── .github/workflows/
│   └── deploy.yml                # GitHub Actions pipeline to build 11ty & publish to GitHub Pages
├── queries/
│   ├── country_daily_aggregates.sql # Daily country-level browser & OS version aggregates
│   └── global_daily_aggregates.sql  # Daily global browser & OS version aggregates
├── scripts/
│   ├── calculate-baseline.js     # Maps RUM user agents to Baseline targets & builds global/regional/country bundles
│   └── fetch-data.js             # Queries BigQuery, writes daily JSON files, and runs Baseline calculations
├── src/
│   ├── _data/
│   │   ├── bigquery/             # Raw per-day JSON files fetched from BigQuery
│   │   ├── browsers.json         # Browser display names and metadata
│   │   ├── regions.json          # UN M49 regional hierarchy & ISO 3166-1 alpha-2 country mappings
│   │   └── site.json             # Global site metadata
│   ├── _includes/layouts/
│   │   └── base.njk              # Base HTML5 layout
│   ├── assets/js/
│   │   └── baseline-components.js # Interactive web components (location filter, summary table, charts)
│   ├── css/
│   │   └── styles.css            # Dashboard styles
│   └── index.njk                 # Dashboard entry template
├── eleventy.config.js            # 11ty configuration & template filters
├── CHANGELOG.md                  # Chronological log of site and data pipeline changes
├── .env.example                  # Template for local environment variables & GCP credentials
└── package.json
```

## Regional & Country Classification (UN M49)

The dashboard supports filtering Baseline availability and browser compatibility breakdowns by **Worldwide**, **Region / Sub-Region**, or **Country**:

- **Countries & Territories**: Keyed by two-letter **ISO 3166-1 alpha-2** country codes (e.g., `US`, `DE`, `JP`) reported in the Cloudflare Beacon RUM Archive `country` field (`src/_data/bigquery/country_daily_aggregates/`). Any traffic without a resolved country is grouped under `XX` (*Unspecified GeoIP*).
- **Regional Hierarchy ([UN M49](https://unstats.un.org/unsd/methodology/m49/))**: Regions and sub-regions in `src/_data/regions.json` follow the United Nations **M49** standard (*Standard Country or Area Codes for Statistical Use*), organized into three nested levels:
  1. **Macro-regions** (6 continental regions, such as *Africa*, *Americas*, *Asia*, *Europe*, *Oceania*, and *Antarctica*)
  2. **Sub-regions** (18 groupings, such as *Sub-Saharan Africa*, *Latin America and the Caribbean*, *Northern Europe*, and *South-eastern Asia*)
  3. **Intermediate / Leaf regions** (23 finest-grained regional subdivisions, such as *Eastern Africa*, *South America*, and *Western Africa*, which directly map to member countries and include cross-references to `caniuse-db` `alt-*` region codes)
- **Traffic-Weighted Rollups**: Regional availability, 7-day deltas, daily time series, and browser version breakdowns are aggregated from member countries weighted by each country's page-load volume (`src/_data/baseline_region_summary.json` and client-side rollups in `src/assets/js/baseline-components.js`).
- **Shareable URL Parameters**: Direct links to specific countries, regions, Baseline targets, and feature searches are supported via `?country=<ISO_CODE>` (e.g., `?country=US`, `?country=JP`, or `?country=united-states`), `?region=<SLUG_OR_M49_CODE>` (e.g., `?region=europe`, `?region=northern-europe`, or `?region=150`), `?target=<TARGET_ID>` (e.g., `?target=widely`, `?target=newly`, or `?target=2025`), and on `/features/` via `?q=<SEARCH_QUERY>` (e.g., `?q=popover`, `?q=:has`, or `?q=subgrid`, also accepting `?search=` or `?feature=`), `?group=<CATEGORY_ID>`, `?avail=<OP:PCT>` / `?min_avail=<PCT>&max_avail=<PCT>`, and `?sort=<ORDER>`. Changing any filter updates the URL and history state so browser Back/Forward buttons step through filter selections, and clearing a filter removes its parameter.

## Prerequisites & Environment Setup

1. **Node.js** (v20.6+ required for native `.env` loading, v22 recommended)
2. **Local Environment File (`.env`)**:
   Copy the template:
   ```bash
   cp .env.example .env
   ```
   Configure your GCP project ID:
   ```env
   GOOGLE_CLOUD_PROJECT=your-gcp-project-id
   ```

3. **Google Cloud Authentication**:
   - **Local Development (`gcloud`)**:
     ```bash
     gcloud auth application-default login
     gcloud config set project your-gcp-project-id
     ```
   - **Service Account Key (Alternative)**:
     If using a service account key file locally, set the path in `.env`:
     ```env
     GOOGLE_APPLICATION_CREDENTIALS=./service-account-key.json
     ```

## Usage

### 1. Install Dependencies

```bash
npm install
```

### 2. Query BigQuery & Write Local Data

Validate queries without executing them (dry run):

```bash
npm run fetch-data:dry-run
```

Execute queries, process results, and write JSON files into `src/_data/bigquery/`:

```bash
npm run fetch-data
```

### 3. Build & Preview with 11ty

Start the local development server at `http://127.0.0.1:8080`:

```bash
npm run serve
```

Build static HTML into `_site/`:

```bash
npm run build
```

## Publishing to GitHub Pages (`web-platform-dx.github.io`)

1. In the GitHub repository settings under **Settings → Pages**, set **Build and deployment > Source** to **GitHub Actions**.
2. Under **Settings → Secrets and variables → Actions**, configure repository secrets for BigQuery automation:
   - **`GCP_PROJECT_ID`**: Your Google Cloud Project ID.
   - **Authentication** (choose one):
     - **Workload Identity Federation (Recommended)**:
       - `GCP_WORKLOAD_IDENTITY_PROVIDER`: Workload Identity Provider resource name.
       - `GCP_SERVICE_ACCOUNT`: Service account email.
     - **Service Account Key**:
       - `GCP_SA_KEY`: Full JSON content of a service account key.
3. Pushing to `main` (or triggering `.github/workflows/deploy.yml` in the Actions tab) authenticates against GCP, fetches updated BigQuery metrics, builds static HTML with 11ty, and publishes to GitHub Pages.
