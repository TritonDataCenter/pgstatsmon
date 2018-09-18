# pgstatsmon Changelog

## Not yet released
none

## 1.2.0
* #21 allow tunable superuser for pgstatsmon setup routines

## 1.1.0
* #18 pgstatsmon shouldn't try to create functions that depend on missing functions
* #17 pgstatsmon should support discovering backend IPs via nic_tag regex
* #14 Collect metrics about vacuum progress
* #13 pgstatsmon could poll pg_statio_user_tables and pg_statio_user_indexes

## 1.0.0
* #12 postgres peers could report their own WAL positions
* #11 create scripts to get basic stats from pgstatsmon
* #10 connection count query isn't always accurate
* #8 create a Postgres user for pgstatsmon
* #7 add 'release' and 'publish' targets
* #5 add and improve queries
* #4 improve connection handling and backend discovery
* #3 need a test suite
* #2 repo housekeeping
* #1 support Prometheus-style metric collection

## Pre-1.0
* Support for statsd Postgres metrics
