# pgstatsmon

This is a Node.js service to use the Postgres client interface to
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

Using a configuration file for static backends:
```
$ cat etc/myconfig.json
{
    "interval": 10000,
    "connections": {
        "query_timeout": 1000,
        "connect_timeout": 3000,
        "connect_retries": 3
    },
    "backend_port": 5432,
    "user": "pgstatsmon",
    "database": "moray",
    "static": {
        "dbs": [{
            "name": "primary",
            "ip": "10.99.99.16"
        }]
    },
    "target": {
        "ip": "0.0.0.0",
        "port": 8881,
        "route": "/metrics",
        "metadata": {
            "datacenter": "my-dc"
        }
    }
}

$ node ./bin/pgstatsmon.js etc/myconfig.json > pgstatsmon.log &

... wait <interval> milliseconds ...

$ curl -s http://localhost:8881/metrics
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

## VMAPI Discovery

pgstatsmon can optionally be configured to use VMAPI for discovery of backend
Postgres instances. This configuration will cause pgstatsmon to poll VMAPI at
the given interval for information about running Postgres instances.

The VMAPI discovery configuration takes a number of arguments:
* 'url' - URL or IP address of the VMAPI server
* 'pollInterval' - rate (in milliseconds) at which to poll VMAPI
* 'tags' - an object describing which VMs to discover
  * 'vm_tag_name' - name of the VM tag key for Postgres VMs
  * 'vm_tag_value' - value of the VM tag for Postgres VMs
  * 'nic_tag' - NIC tag of interface to use for connecting to Postgres
* 'backend_port' - port number used to connect to Postgres instances
* 'user' - pgstatsmon's Postgres user

Example VMAPI configuration file:
```
$ cat etc/vmapiconfig.json
{
    "interval": 10000,
    "connections": {
        "query_timeout": 1000,
        "connect_timeout": 3000,
        "connect_retries": 3
    },
    "backend_port": 5432,
    "user": "pgstatsmon",
    "database": "moray",
    "vmapi": {
        "url": "http://vmapi.coal-1.example.com",
        "pollInterval": 600000,
        "tags": {
            "vm_tag_name": "manta_role",
            "vm_tag_value": "postgres",
            "nic_tag": "manta"
        }
    },
    "target": {
        "ip": "0.0.0.0",
        "port": 8881,
        "route": "/metrics",
        "metadata": {
            "datacenter": "my-dc"
        }
    }
}
```

## Prometheus

pgstatsmon makes metrics available in the Prometheus text format.  A user can
issue `GET /metrics` to retrieve all of the metrics pgstatsmon collects from
every Postgres instance being monitored.

The listening IP address and port numbers are specified in the pgstatsmon
configuration file.

## Testing
Automated tests can be run using the `make test` target.

pgstatsmon requires a standalone Postgres instance to run functional
tests.  The testing suite uses a configuration file that has the same format as
the usual pgstatsmon configuration file.  There is a template configuration file
at `./test/etc/testconfig.json`.  Each test optionally allows specifying a
configuration file path as the first argument.  The 'make test' target will
only use the default configuration file ('./test/etc/testconfig.json').

A few things to note:
* Do not point the tests at a production Postgres instance.  The tests will
  create and drop tables in the given test database as they see fit.
* The tests will connect to Postgres as the 'postgres' superuser and create
  new users and databases for the tests.
* Tests will generally ignore the 'interval' configuration field.  The tests
  will instead manually kick off metric collection from the specified Postgres
  instances when they find it necessary.  Modifying the 'interval' field won't
  make the tests run shorter or longer.

Assuming you're running your Postgres instance on the same machine you'll use
to run the tests, your configuration file may look like this:
```
{
    "interval": 2000,
    "connections": {
        "query_timeout": 1000,
        "connect_timeout": 3000,
        "connect_retries": 3,
        "max_connections": 10
    },
    "user": "pgstatsmon",
    "database": "pgstatsmon",
    "backend_port": 5432,
    "static": {
        "dbs": [ {
            "name": "test",
            "ip": "127.0.0.1"
        } ]
    },
    "target": {
        "ip": "0.0.0.0",
        "port": 8881,
        "route": "/metrics",
        "metadata": {
            "datacenter": "testing-dc"
        }
    }
}
```

## DTrace

There are a number of DTrace probes built in to pgstatsmon.  The full
listing of probes specific to pgstatsmon and their arguments can be found in
the [lib/dtrace.js](./lib/dtrace.js) file.

[node-artedi](https://github.com/joyent/node-artedi), which pgstatsmon uses to
perform aggregation and serialize metrics, also exposes DTrace probes.

## License
MPL-v2. See the LICENSE file.

## Contributing
Contributions should be made via the [Joyent Gerrit](https://cr.joyent.us).
See the CONTRIBUTING file.
