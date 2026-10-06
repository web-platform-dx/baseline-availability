import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BigQuery } from "@google-cloud/bigquery";

// Automatically load .env file if present in working directory (Node.js 20.6+)
try {
  process.loadEnvFile();
} catch (error) {
  if (error.code !== "ENOENT") {
    console.warn("Warning: Could not load .env file:", error.message);
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, "..");
const QUERIES_DIR = path.resolve(PROJECT_ROOT, "queries");
const OUTPUT_DIR = path.resolve(PROJECT_ROOT, "src", "_data", "bigquery");
const BROWSERS_DEFINITIONS_PATH = path.resolve(PROJECT_ROOT, "src", "_data", "browsers.json");

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
 * Loads a SQL file from the local queries/ directory and interpolates template variables.
 * @param {string} sqlFileName
 * @param {Record<string, string>} [templateVars={}]
 * @returns {Promise<string>}
 */
async function loadSqlFile(sqlFileName, templateVars = {}) {
  const sqlPath = resolveSafeFilePath(QUERIES_DIR, sqlFileName);
  let sql = await fs.readFile(sqlPath, "utf8");
  for (const [key, value] of Object.entries(templateVars)) {
    sql = sql.replaceAll(`{{${key}}}`, value);
  }
  return sql;
}

/**
 * Loads browser family-to-shortname mappings from `src/_data/browsers.json`.
 * @returns {Promise<Record<string, string>>}
 */
async function loadBrowserShortNames() {
  try {
    const content = await fs.readFile(BROWSERS_DEFINITIONS_PATH, "utf8");
    const parsed = JSON.parse(content);
    return parsed.familyToShort || {};
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Returns a sorted array of YYYY-MM-DD dates that already have a local JSON file
 * inside `src/_data/bigquery/<outputSubDir>/`.
 * @param {string} outputSubDir
 * @returns {Promise<string[]>}
 */
async function getExistingDailyDates(outputSubDir) {
  const targetDir = resolveSafeFilePath(OUTPUT_DIR, outputSubDir);
  try {
    const entries = await fs.readdir(targetDir);
    const dates = [];
    for (const entry of entries) {
      if (entry.endsWith(".json")) {
        const datePart = entry.slice(0, -5);
        if (DATE_PATTERN.test(datePart)) {
          dates.push(datePart);
        }
      }
    }
    return dates.sort();
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * Advances `minStartDate` past any contiguous prefix of dates already present in `existingDates`.
 * @param {string} minStartDate
 * @param {string[]} existingDates
 * @returns {string}
 */
function computeNextStartDate(minStartDate, existingDates) {
  const existingSet = new Set(existingDates);
  const current = new Date(`${minStartDate}T00:00:00Z`);
  while (true) {
    const dateStr = current.toISOString().slice(0, 10);
    if (!existingSet.has(dateStr)) {
      return dateStr;
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }
}

/**
 * Serializes a daily aggregate payload with pretty-printed metadata/schema
 * and one compact JSON array per row.
 * @param {{ generatedAt: string, date: string, schema: string[], rows: unknown[][] }} payload
 * @returns {string}
 */
function serializeDailyPayload(payload) {
  const header = JSON.stringify(
    {
      generatedAt: payload.generatedAt,
      date: payload.date,
      schema: payload.schema,
    },
    null,
    2
  );
  const rowsFormatted = payload.rows.map((row) => JSON.stringify(row)).join(",\n");
  const prefix = header.slice(0, -2);
  return rowsFormatted.length > 0
    ? `${prefix},\n  "rows": [\n${rowsFormatted}\n  ]\n}\n`
    : `${prefix},\n  "rows": []\n}\n`;
}

/**
 * Groups BigQuery rows by DATE and writes each day's rows as an array of value arrays
 * alongside a `schema` array into `src/_data/bigquery/<outputSubDir>/<YYYY-MM-DD>.json`.
 * @param {string} outputSubDir
 * @param {string[]} schema
 * @param {Array<Record<string, unknown>>} rows
 * @param {Set<string>} existingDatesSet
 */
async function writeDailyPartitions(outputSubDir, schema, rows, existingDatesSet) {
  const targetDir = resolveSafeFilePath(OUTPUT_DIR, outputSubDir);
  await fs.mkdir(targetDir, { recursive: true });
  const familyToShort = await loadBrowserShortNames();
  const unmappedBrowsers = new Set();

  /** @type {Map<string, unknown[][]>} */
  const byDate = new Map();
  for (const row of rows) {
    const rawDate =
      typeof row.DATE === "object" && row.DATE !== null && "value" in row.DATE ? row.DATE.value : row.DATE;
    const dateStr = String(rawDate || "");
    if (!DATE_PATTERN.test(dateStr) || existingDatesSet.has(dateStr)) {
      continue;
    }
    if (!byDate.has(dateStr)) {
      byDate.set(dateStr, []);
    }
    byDate.get(dateStr).push(
      schema.map((col) => {
        const val = row[col] !== undefined ? row[col] : null;
        if (col === "USERAGENTFAMILY" && typeof val === "string" && val !== "") {
          if (Object.hasOwn(familyToShort, val)) {
            return familyToShort[val];
          }
          unmappedBrowsers.add(val);
        }
        return val;
      })
    );
  }

  if (unmappedBrowsers.size > 0) {
    console.warn(
      `Warning: Passed through ${unmappedBrowsers.size} unmapped USERAGENTFAMILY value(s) raw (add shortnames in src/_data/browsers.json): ${[...unmappedBrowsers].join(", ")}`
    );
  }

  if (byDate.size === 0) {
    console.log(`No new daily files to write for "${outputSubDir}" (all available dates are already stored locally).`);
    return;
  }

  const generatedAt = new Date().toISOString();
  for (const [dateStr, dateRows] of byDate.entries()) {
    const outputPath = resolveSafeFilePath(targetDir, `${dateStr}.json`);
    const payload = {
      generatedAt,
      date: dateStr,
      schema,
      rows: dateRows,
    };
    await fs.writeFile(outputPath, serializeDailyPayload(payload), "utf8");
    console.log(`Wrote ${dateRows.length} row(s) -> ${path.relative(PROJECT_ROOT, outputPath)}`);
  }
}

/**
 * Writes processed data as formatted JSON to the local 11ty data directory.
 * @param {string} outputFileName
 * @param {unknown} data
 */
async function writeLocalData(outputFileName, data) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const outputPath = resolveSafeFilePath(OUTPUT_DIR, outputFileName);
  const payload = {
    generatedAt: new Date().toISOString(),
    rows: data,
  };
  const isLarge = Array.isArray(data) && data.length > 5000;
  await fs.writeFile(outputPath, JSON.stringify(payload, null, isLarge ? 0 : 2) + "\n", "utf8");
  console.log(`Wrote ${Array.isArray(data) ? data.length : 0} row(s) -> ${path.relative(PROJECT_ROOT, outputPath)}`);
}

const RUMARCHIVE_TABLE =
  process.env.RUMARCHIVE_TABLE || "cf-open-web-performance.rumarchive.rumarchive_page_loads";

/**
 * Define the BigQuery queries to execute, optional parameters, and post-processing.
 * Each entry reads a SQL query from `queries/`, runs it against BigQuery,
 * processes the rows, and writes the result to `src/_data/bigquery/`.
 */
const QUERY_JOBS = [
  {
    name: "global_daily_aggregates",
    sqlFile: "global_daily_aggregates.sql",
    outputSubDir: "global_daily_aggregates",
    minStartDate: "2026-09-21",
    schema: [
      "USERAGENTFAMILY",
      "USERAGENTVERSION",
      "USERAGENTENGINE",
      "USERAGENTENGINEVERSION",
      "OS",
      "OSVERSION",
      "row_count",
      "count",
    ],
    params: {},
    templateVars: {
      RUMARCHIVE_TABLE,
    },
  },
];

async function main() {
  const isDryRun = process.argv.includes("--dry-run");
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID;
  const location = process.env.BIGQUERY_LOCATION || "US";

  let credentials;
  const rawKeyJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || process.env.GCP_SA_KEY;
  if (rawKeyJson) {
    try {
      credentials = JSON.parse(rawKeyJson);
    } catch (parseErr) {
      throw new Error(`Failed to parse GCP service account key JSON from environment: ${parseErr.message}`);
    }
  }

  const effectiveProjectId = projectId || credentials?.project_id;
  if (!effectiveProjectId) {
    throw new Error(
      "Missing GCP Project ID. Set GOOGLE_CLOUD_PROJECT in your .env file or environment, " +
      "or authenticate locally using 'gcloud auth application-default login' and set your active project."
    );
  }

  // Ensure google-auth-library uses the configured project ID for the
  // x-goog-user-project quota header instead of a stale quota_project_id in local ADC.
  if (!process.env.GOOGLE_CLOUD_QUOTA_PROJECT) {
    process.env.GOOGLE_CLOUD_QUOTA_PROJECT = effectiveProjectId;
  }

  // Initialize BigQuery client.
  // Supports:
  // 1. Explicit credentials JSON from GCP_SA_KEY / GOOGLE_APPLICATION_CREDENTIALS_JSON
  // 2. File path from GOOGLE_APPLICATION_CREDENTIALS (handled natively by @google-cloud/bigquery)
  // 3. Application Default Credentials (ADC) from `gcloud auth application-default login`
  const bigquery = new BigQuery({
    projectId: effectiveProjectId,
    ...(credentials ? { credentials } : {}),
  });

  console.log(
    `Starting BigQuery data fetch (${isDryRun ? "DRY RUN" : "LIVE"}) using project "${effectiveProjectId}"...`
  );

  for (const jobDef of QUERY_JOBS) {
    console.log(`Running query "${jobDef.name}" from queries/${jobDef.sqlFile}...`);
    const query = await loadSqlFile(jobDef.sqlFile, jobDef.templateVars);

    let existingDates = [];
    let params = { ...jobDef.params };
    let types;

    if (jobDef.outputSubDir && jobDef.minStartDate) {
      existingDates = await getExistingDailyDates(jobDef.outputSubDir);
      const startDate = computeNextStartDate(jobDef.minStartDate, existingDates);
      params = {
        ...params,
        startDate,
        existingDates,
      };
      types = {
        startDate: "DATE",
        existingDates: ["DATE"],
      };
      console.log(
        `Found ${existingDates.length} existing daily file(s) in src/_data/bigquery/${jobDef.outputSubDir}/; querying from ${startDate}...`
      );
    }

    const options = {
      query,
      location,
      params,
      ...(types ? { types } : {}),
      useLegacySql: false,
      dryRun: isDryRun,
    };

    const [job] = await bigquery.createQueryJob(options);

    if (isDryRun) {
      const totalBytes = Number(job.metadata?.statistics?.totalBytesProcessed || 0);
      const megabytes = (totalBytes / (1024 * 1024)).toFixed(2);
      console.log(`[DRY RUN] "${jobDef.name}" validated successfully. Estimated bytes processed: ${megabytes} MB`);
      continue;
    }

    const [rows] = await job.getQueryResults();
    if (jobDef.outputSubDir && jobDef.schema) {
      await writeDailyPartitions(jobDef.outputSubDir, jobDef.schema, rows, new Set(existingDates));
    } else {
      const processed = typeof jobDef.process === "function" ? await jobDef.process(rows) : rows;
      await writeLocalData(jobDef.outputFile, processed);
    }
  }

  console.log("BigQuery data pipeline completed.");
}

main().catch((error) => {
  console.error("Error running BigQuery data pipeline:", error.message || error);
  process.exitCode = 1;
});
