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
 * Loads a SQL file from the local queries/ directory.
 * @param {string} sqlFileName
 * @returns {Promise<string>}
 */
async function loadSqlFile(sqlFileName) {
  const sqlPath = resolveSafeFilePath(QUERIES_DIR, sqlFileName);
  return fs.readFile(sqlPath, "utf8");
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
  await fs.writeFile(outputPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`Wrote ${Array.isArray(data) ? data.length : 0} row(s) -> ${path.relative(PROJECT_ROOT, outputPath)}`);
}

/**
 * Define the BigQuery queries to execute, optional parameters, and post-processing.
 * Each entry reads a SQL query from `queries/`, runs it against BigQuery,
 * processes the rows, and writes the result to `src/_data/bigquery/<outputFile>`.
 */
const QUERY_JOBS = [
  {
    name: "example_summary",
    sqlFile: "example.sql",
    outputFile: "example_summary.json",
    params: {},
    /**
     * Optional processor function to transform raw BigQuery rows before saving locally.
     * @param {Array<Record<string, unknown>>} rows
     */
    process: (rows) => rows,
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
    const query = await loadSqlFile(jobDef.sqlFile);

    const options = {
      query,
      location,
      params: jobDef.params,
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
    const processed = typeof jobDef.process === "function" ? await jobDef.process(rows) : rows;
    await writeLocalData(jobDef.outputFile, processed);
  }

  console.log("BigQuery data pipeline completed.");
}

main().catch((error) => {
  console.error("Error running BigQuery data pipeline:", error.message || error);
  process.exitCode = 1;
});
