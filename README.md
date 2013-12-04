# pgstatsmon

This is a *prototype* Node service to use the Postgres client interface to
periodically fetch stats from multiple postgres instances and shovel them to
statsd.


## Running

Create a configuration file from the template in etc/config.json:

    cp etc/config.json myconfig.json
    vim myconfig.json

Then run the monitor with:

    node bin/pgstatsmon.js myconfig.json

It logs to stdout using bunyan.
