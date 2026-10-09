-- Country-level daily aggregates of user agents and operating systems from RUM Archive.
-- Date partitioned starting from @startDate, excluding @existingDates already stored locally.
SELECT
  DATE,
  COUNTRY,
  USERAGENTFAMILY,
  USERAGENTVERSION,
  USERAGENTENGINE,
  USERAGENTENGINEVERSION,
  OS,
  OSVERSION,
  COUNT(1) AS ROWCOUNT,
  SUM(BEACONS) AS TOTAL
FROM
  `{{RUMARCHIVE_TABLE}}`
WHERE
  DATE >= @startDate
  AND DATE NOT IN UNNEST(@existingDates)
GROUP BY
  DATE,
  COUNTRY,
  USERAGENTFAMILY,
  USERAGENTVERSION,
  USERAGENTENGINE,
  USERAGENTENGINEVERSION,
  OS,
  OSVERSION
ORDER BY
  DATE ASC,
  COUNTRY ASC,
  TOTAL DESC
