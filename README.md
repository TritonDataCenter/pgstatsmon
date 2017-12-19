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

An SMF manifest is provided in order to run pgstatsmon as an SMF service.

    svccfg import ./smf/manifests/pgstatsmon.xml

If run as an SMF service, stdout is redirected to the service's log directory,
which can be found by using the `svcs` tool:
    svcs -L pgstatsmon

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

## License
MPL-v2. See the LICENSE file.

## Contributing
Contributions should be made via the [Joyent Gerrit](https://cr.joyent.us).
See the CONTRIBUTING file.
