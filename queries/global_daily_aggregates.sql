-- Global daily aggregates of user agents and operating systems from RUM Archive.
-- Date partitioned starting from @startDate, excluding @existingDates already stored locally.
SELECT
  DATE,
  USERAGENTFAMILY,
  USERAGENTVERSION,
  USERAGENTENGINE,
  USERAGENTENGINEVERSION,
  OS,
  OSVERSION,
  COUNT(1) AS row_count,
  SUM(COALESCE(PLTCOUNT, 1)) AS count
FROM
  `{{RUMARCHIVE_TABLE}}`
WHERE
  DATE >= @startDate
  AND DATE NOT IN UNNEST(@existingDates)
GROUP BY
  DATE,
  USERAGENTFAMILY,
  USERAGENTVERSION,
  USERAGENTENGINE,
  USERAGENTENGINEVERSION,
  OS,
  OSVERSION
ORDER BY
  DATE ASC,
  count DESC
