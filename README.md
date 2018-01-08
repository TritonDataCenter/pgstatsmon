# pgstatsmon

This is a *prototype* Node service to use the Postgres client interface to
periodically fetch stats from multiple Postgres instances and export them
through a Prometheus server.

## Running

Create a configuration file from the template in etc/config.json:

    cp etc/config.json myconfig.json
    vim myconfig.json

Then run the monitor with:

    node bin/pgstatsmon.js myconfig.json

It logs to stdout using bunyan.

## Example
```
$ cat etc/myconfig.json
{
    "interval": 10000,
    "dbs": [ {
        "name": "primary",
        "url": "postgres://postgres@10.99.99.16:5432/moray"
    } ],
    "target": {
        "ip": "0.0.0.0",
        "port": 9187,
        "route": "/metrics"
    }
}
$ node ./bin/pgstatsmon.js etc/myconfig.json > pgstatsmon.log &

... wait <interval> seconds ...

$ curl http://localhost:9187/metrics
...
# HELP pg_relation_size_toast_bytes bytes used by toast files
# TYPE pg_relation_size_toast_bytes gauge
pg_relation_size_toast_bytes{name="primary",relname="manta"} 8192
pg_relation_size_toast_bytes{name="primary",relname="marlin_tasks_v2"} 8192
pg_relation_size_toast_bytes{name="primary",relname="marlin_jobs_v2"} 3072000
pg_relation_size_toast_bytes{name="primary",relname="marlin_taskinputs_v2"} 8192
pg_relation_size_toast_bytes{name="primary",relname="marlin_taskoutputs_v2"} 8192
pg_relation_size_toast_bytes{name="primary",relname="medusa_sessions"} 8192
# HELP pg_stat_bgwriter_checkpoints_timed scheduled checkpoints
# TYPE pg_stat_bgwriter_checkpoints_timed counter
pg_stat_bgwriter_checkpoints_timed{name="primary"} 2
# HELP pg_stat_bgwriter_checkpoints_req requested checkpoints
# TYPE pg_stat_bgwriter_checkpoints_req counter
pg_stat_bgwriter_checkpoints_req{name="primary"} 0
# HELP pg_stat_bgwriter_checkpoint_write_time_ms time spent writing checkpoints to disk
# TYPE pg_stat_bgwriter_checkpoint_write_time_ms counter
pg_stat_bgwriter_checkpoint_write_time_ms{name="primary"} 10388
# HELP pg_stat_bgwriter_checkpoint_sync_time_ms time spent synchronizing checkpoints to disk
# TYPE pg_stat_bgwriter_checkpoint_sync_time_ms counter
pg_stat_bgwriter_checkpoint_sync_time_ms{name="primary"} 19
...
```

## Prometheus
pgstatsmon makes metrics available in the Prometheus text format.  A user can
issue `GET /metrics` to retrieve all of the metrics pgstatsmon collects from
every Postgres instance being monitored.

The listening IP address and port numbers are specified in the pgstatsmon
configuration file.

## Testing
Automated tests can be run using the `make test` target. The tests require the
'catest' tool, which can be found here:

* https://github.com/joyent/catest

pgstatsmon requires a standalone Postgres instance to run functional
tests.  The testing suite uses a configuration file that has the same format as
the usual pgstatsmon configuration file.  There is a template configuration file
at `./test/etc/testconfig.json`.  Each test optionally allows specifying a
configuration file path as the first argument.  The 'make test' target will
only use the default configuration file ('./test/etc/testconfig.json').

A few things to note:
* Do not point the tests at a production Postgres instance.  The tests will
  create and drop tables in the given test database as they see fit.
* The tests assume that the user and database listed in the test configuration
  file are created before the tests are run.
* Tests will generally ignore the 'interval' configuration field.  The tests
  will instead manually kick off metric collection from the specified Postgres
  instances when they find it necessary.  Modifying the 'interval' field won't
  make the tests run shorter or longer.

It's easy to create a test user and database once you have a Postgres instance
running:

    psql -U postgres -c 'CREATE ROLE pgstatsmon WITH LOGIN;'
    psql -U postgres -c 'CREATE DATABASE pgstatsmon;'

It may be useful to give the user additional privileges depending on what you
will be testing.  Allowing the test user to log in to Postgres may be helpful
for debugging failed tests.

Assuming you're running your Postgres instance on the same machine you'll use
to run the tests, your configuration file may look like this:
```
{
    "interval": 2000,
    "dbs": [ {
        "name": "test",
        "url": "postgres://pgstatsmon@localhost:5432/pgstatsmon"
    } ],
    "target": {
        "ip": "0.0.0.0",
        "port": 9187,
        "route": "/metrics"
    }
}
```

## License
MPL-v2. See the LICENSE file.

## Contributing
Contributions should be made via the [Joyent Gerrit](https://cr.joyent.us).
See the CONTRIBUTING file.
