# Baseline Availability

Public HTML dashboard for [web-platform-dx](https://github.com/web-platform-dx), powered by **Google Cloud BigQuery** and built into static HTML with **Eleventy (11ty)** for hosting on GitHub Pages (`https://web-platform-dx.github.io/baseline-availability/`).

## Project Structure

```text
├── .github/workflows/
│   └── deploy.yml                # GitHub Actions pipeline to build 11ty & publish to GitHub Pages
├── queries/
│   └── example.sql               # BigQuery SQL queries
├── scripts/
│   └── fetch-data.js             # Queries BigQuery, processes results, and writes JSON to src/_data/bigquery/
├── src/
│   ├── _data/
│   │   ├── bigquery/             # Local JSON files generated from BigQuery
│   │   └── site.json             # Global site metadata
│   ├── _includes/layouts/
│   │   └── base.njk              # Base HTML5 layout
│   ├── css/
│   │   └── styles.css            # Dashboard styles
│   └── index.njk                 # Dashboard entry template
├── eleventy.config.js            # 11ty configuration (includes HtmlBasePlugin for GitHub Pages path prefixes)
├── .env.example                  # Template for local environment variables & GCP credentials
└── package.json
```

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
