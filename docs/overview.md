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
provided to help pgstatsmon find the proper instances.

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
