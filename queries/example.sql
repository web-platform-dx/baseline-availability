-- Placeholder BigQuery query.
-- Replace with actual Cloudflare Beacon / UserAgents queries.
SELECT
  'baseline-widely-available' AS status,
  COUNT(1) AS sample_count
FROM
  UNNEST([1, 2, 3]) AS item
GROUP BY
  status
