# pgstatsmon overview

This is a description of the basic architecture of pgstatsmon.

## Postgres discovery

pgstatsmon supports two ways of discovering Postgres instances from which to
retrieve metrics. pgstatsmon defaults to using the VMAPI-based discovery
mechanism. If both VMAPI and static discovery parameters are provided, the
static parameters are ignored.

### VMAPI discovery

If you have a Triton installation you can instruct pgstatsmon to poll VMAPI
for information about deployed (and running) Postgres instances. pgstatsmon
will poll VMAPI at a user-defined interval. VMAPI VM and NIC tags must be
provided to help pgstatsmon find the proper instances. The NIC tag is in the
form of a regular expression.

Only one VMAPI can currently be targeted. This means that if you have a three
datacenter Triton deployment you will need to stand up three instances of
pgstatsmon to collect metrics from the Postgres instances in the three
datacenters.

The VMAPI-based service discovery mechanism uses
[node-vmapi-resolver](https://github.com/joyent/node-vmapi-resolver) to poll
VMAPI.

### Static discovery

The other configuration option is to use a static list of Postgres backends.
This is especially useful for development. You can hard-code a list of
Postgres instances for pgstatsmon to collect metrics from. The tests use this
discovery method.

## Connection management

pgstatsmon uses [node-cueball](https://github.com/joyent/node-cueball) to
manage connection to Postgres. pgstatsmon creates a cueball connection pool
with only one connection for each Postgres backend. Cueball will ensure that
connections are destroyed when backends disappear temporarily, and that only one
connection is maintained for each backend.

If a backend is permanently removed, node-vmapi-resolver will emit a 'removed'
event, which will cause pgstatsmon to remove all data and connections related
to that instance.

## Metric collection

pgstatsmon retrieves metric data from backend Postgres instances by
periodically polling at a user-defined interval. The polling interval isn't
"smart," so manual intervention will be required to adjust the polling interval
if pgstatsmon is overloaded or if pgstatsmon overloads Postgres.

During each polling interval the following occurs:

* Each Postgres backend is enqueued for metric collection
  * Only a certain number of Postgres backends are actually polled at any given
    time. The current (hard-coded) number of outstanding backends being polled
    is ten.
* A connection to each in-flight Postgres is claimed from Cueball
  * If no connection exists, one will attempt to be created
  * If a connection cannot be created, an error is noted in the logs, and
    a failed connection counter is incremented
* All queries are kicked off and will run asynchronously
  * If a query times out, the backend connection is closed
  * The execution time of each queries is tracked
  * Any query error results in logging and incrementing of error metrics

Metrics are maintained in memory using
[node-artedi](https://github.com/joyent/node-artedi).

## Metric retrieval

pgstatsmon supports two metric exposition formats.

### Prometheus

As documented in the README, pgstatsmon exposes metrics in the Prometheus
text format. In addition to the metrics collected from Postgres, pgstatsmon
maintains counters for errors and histograms for query latency.

### Log

pgstatsmon also logs each metric that is observed. These are available at the
'trace' log level and useful for debugging.

## Initial setup

When pgstatsmon first encounters a new backend it attempts to do a few things.

- Connects to the database as the 'postgres' user
- Check if the database is a synchronous or asynchronous peer. If it is,
  pgstatsmon doesn't perform the rest of these steps
- Collects the database server version number
- Creates a non-superuser (defined in the pgstatsmon configuration file) that
  pgstatsmon will use on subsequent Postgres connection attempts
- Creates functions to allow pgstatsmon to glean information about Postgres
  that is usually hidden from non-superusers. Examples of these are
  'get_stat_activity()' and 'get_stat_replication()'.

If this initial setup operation fails for some reason, pgstatsmon will continue
to attempt to run the setup on every metric collection 'tick' and skip metric
collection for the backend needing to be set up.

If one of the initial setup steps is known to be incompatible with certain
PG versions it is skipped, which may result in query errors during metric
collection.

## Metrics collected

pgstatsmon collects a lot of metrics from Postgres. The most up-to-date list of
things that will be collected is in the lib/queries.js file. To aid those just
wanting to see what pgstatsmon provides, here is a list that's easier to read.

Each metric is broken down by an arbitrary number of metadata labels provided
in the pgstatsmon configuration file (target.metadata). The default
configuration files include a label for 'datacenter.' Other metrics have their
own set of labels that will be added in addition to whatever the user provides
in the configuration file. Usually this includes at least the name of the
backend that the stat came from (e.g. 2.moray.us-east.joyent.us-12345).

| Data Source | Values | Metadata | Notes |
|-------------|--------|----------|-------|
|pg_stat_user_tables | Information about things done on a relation. This includes number of dead tuples, number of vacuum operations, table scan counts, and more | relname| |
|pg_stat_replication | Absolute WAL positions in bytes (mostly downstream peers)| sync_state | Only works on PG 9.4+, recovering peers return little data |
|WAL admin functions | Absolute WAL positions in bytes (local peer only) | | Data returned varies depending on whether or not the backend is in recovery |
|pg_statio_user_tables | Information about I/O done on a table. This includes the number of buffer hits and disk block reads for the table's heap and index tuples | relname | |
|pg_statio_user_indexes | Information about I/O done on an index. This includes the number of buffer hits and disk block reads for tuples of the index | indexrelname, relname | |
|pg_stat_activity    | Connection counts | datname, state | |
|pg_stat_database    | Information about given databases. This includes transaction counts, tuple counts, the time spent reading from and writing to disk, and more | datname | |
|pg_class            | Size of relations in bytes | relname | |
|pg_class            | Distance to/from wraparound autovacuum | relname | |
|pg_stat_bgwriter    | Information about the background writer process. This includes checkpoint stats and information about buffer activity | | | |
| pg_stat_get_progress_info('VACUUM')  | Progress information about vacuum processes | relname | |

An instance of pgstatsmon may run a different number of queries to each
backend/database depending on the version reported by that database.  pgstatsmon
queries the backend for its "server_version_num" setting, which is the integer
representation of the running version of PG.  A given query has a set of SQL
strings that are keyed to either:

- The minimum version of PG that a particular SQL string is supported against
  as a string in the same format as "server_version_num".
- The string "all", to denote that this query is expected to run against all
  versions of PG.

For example, the "pg_stat_replication" queries are only supported in PG 9.4+,
so these queries are not executed against a database that is reporting a version
lower than this.  The lowest version that lib/queries.js uses for this case is
`90400`, so a server reporting `90204` would not run this particular query.

To determine how many queries are being executed, the "pg_query_count" metric
is exposed for each backend.
