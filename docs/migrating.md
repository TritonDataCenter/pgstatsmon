# Migrating from pgstatsmon v1.x to v2.x

pgstatsmon#23 intoduced a pair of breaking changes:
- Data retrieved from pg_stat_replication is now intepreted as a set of gauges
  rather than counters.
- Updated the node-artedi dependency from v1.4.0 to v2.0.0.

We'll cover below how to overcome these two breaking changes.

## pg_stat_replication change

In short, this change modifies the pg_stat_replication data from representing
the number of WAL bytes written since the backend was discovered to representing
the number of WAL bytes written since the beginning of the backend's existence.

How this change affects your systems depends on how you're using the
pg_stat_replication data. If your monitoring system is currently measuring these
data points in relation to other data points within the pg_stat_replication data
it is likely no change is necessary for your monitoring system. For example, if
you are trying to monitor a downstream peer's apply lag in bytes, today you
might use a query like this:

```
pg_stat_replication_wal_sent_bytes - pg_stat_replication_replica_wal_replayed_bytes
```

Good news! Queries like that will now be more accurate and no change is
necessary to get the benefits of the #23 bug fix.

However, if your monitoring system measures pg_stat_replication values against
non-pg_stat_replication data, the result of the query will likely be drastically
different in pgstatsmon v2. Take this example which is a query for trying to
track WAL receive lag between the upstream and downstream peers in a Postgres
deployment:

```
pg_stat_replication_wal_sent_bytes - pg_recovery_wal_received_bytes
```

In this example we are comparing two different data types, which is a problem.
The first is a gauge type and the second is a counter type. In pgstatsmon v1
both were counter types, so this was valid (though the data probably wasn't
accurate).

## node-artedi update

The node-artedi change only affects histogram types. Currently the histogram
type is only used by the 'querytime' set of metrics. These metrics measure the
amount of time it took to execute each statistics gathering query against each
backend. If you aren't consuming the querytime metrics then this breaking
change does not apply.

If your monitoring system consumes the querytime metrics, note that two changes
were made:
- query times are now reported in seconds rather than milliseconds.
- the buckets used are now the 'standard' Prometheus histogram buckets instead
  of a snowflake set of node-artedi buckets.

This document is a good place to start to read about the breaking node-artedi
change:
https://github.com/joyent/node-artedi/blob/54b21b7631fbd6ea3f0ce48490f00c649596022e/docs/migrating.md

To reduce the technical debt carried by pgstatsmon we've decided to shift the
load of this change from pgstatsmon to the monitoring system. We recommend you
do the following if you want to continue consuming the querytime metrics:

- duplicate your querytime queries and graphs to consume both the
  millisecond- and second-based querytime stats in your monitoring system.
  - to fully avoid a breaking change each of the second-based statistics will
    need to be multiplied by 1000 to convert them back into milliseconds.
- update all pgstatsmon instances.
- the (old) millisecond- and (new) second-based querytime stats should appear in
  sequence together.
- you can choose to keep both versions of the querytime queries in your
  monitoring system, or drop the millisecond-based queries after the data has
  passed through your metric data retention policy period.
