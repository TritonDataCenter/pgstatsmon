#!/usr/sbin/dtrace -Cs

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * walstat.d - print WAL stats from backends monitored by pgstatsmon
 *
 * This script makes WAL information available. This is useful if someone is
 * trying to quickly understand the throughput and lag (both in terms of bytes)
 * of various Postgres instances.
 *
 * Arguments: none
 *
 * Fields:
 * SHARD    - name or number of Postgres shard
 * ZONE     - first portion of the backend's zonename
 * REPL     - replication role of WAL replica's server process
 * SENT     - WAL bytes sent to replica
 * WRITTEN  - WAL bytes written to disk by replica
 * FLUSHED  - WAL bytes flushed to disk by replica
 * REPLAYED - WAL bytes replayed by replica
 *
 * SENT, WRITTEN, FLUSHED, and REPLAYED are all the amount written since the
 * last scrape by pgstatsmon.
 *
 * WRITTEN, FLUSHED, and REPLAYED are the values reported by the downstream
 * replica. This is the very similar to the output format that
 * `manatee-adm pg-status` uses.
 *
 * Note: This script currently is only useful in sharded deployments that have
 * dot delineated shard names (e.g. 1.moray.mydomain.com).
 *
 */

#pragma D option quiet
#pragma D option zdefs
#pragma D option aggsortkey

BEGIN
{
	do_print = 0;
	self->prev["unused", "val"] = 10; /* Initialize an associative array. */
	printf("waiting for tick...\n");
}

artedi*:::gauge-set
/
copyinstr(arg0) == "pg_stat_replication_wal_sent_bytes"
/
{
	labels = copyinstr(arg2);
	backend = json(labels, "backend");
	shard = strtok(backend, ".");
	sync_state = json(labels, "sync_state");
	zone = substr(backend, strlen(backend) - 8);

	diff = arg1 - self->prev[zone, "sent"];

	@sent[shard, zone, sync_state] = sum(diff);
	self->prev[zone, "sent"] = arg1;
}

artedi*:::gauge-set
/
copyinstr(arg0) == "pg_stat_replication_replica_wal_written_bytes"
/
{
	labels = copyinstr(arg2);
	backend = json(labels, "backend");
	shard = strtok(backend, ".");
	sync_state = json(labels, "sync_state");
	zone = substr(backend, strlen(backend) - 8);

	diff = arg1 - self->prev[zone, "write"];

	@written[shard, zone, sync_state] = sum(diff);
	self->prev[zone, "write"] = arg1;
}

artedi*:::gauge-set
/
copyinstr(arg0) == "pg_stat_replication_replica_wal_flushed_bytes"
/
{
	labels = copyinstr(arg2);
	backend = json(labels, "backend");
	shard = strtok(backend, ".");
	sync_state = json(labels, "sync_state");
	zone = substr(backend, strlen(backend) - 8);

	diff = arg1 - self->prev[zone, "flush"];

	@flushed[shard, zone, sync_state] = sum(diff);
	self->prev[zone, "flush"] = arg1;
}

artedi*:::gauge-set
/copyinstr(arg0) == "pg_stat_replication_replica_wal_replayed_bytes"/
{
	labels = copyinstr(arg2);
	backend = json(labels, "backend");
	shard = strtok(backend, ".");
	sync_state = json(labels, "sync_state");
	zone = substr(backend, strlen(backend) - 8);

	diff = arg1 - self->prev[zone, "replayed"];

	@replayed[shard, zone, sync_state] = sum(diff);
	self->prev[zone, "replayed"] = arg1;
}


pgstatsmon*:::tick-done
/do_print/
{
	/* headers */
	printf("%30s %40s\n", "----- CLUSTER STATE -----",
	    "----- THROUGHPUT (Bytes/tick) -----");

	printf("%10s %10s %10s %10s %10s %10s %10s \n", "SHARD", "ZONE", "REPL",
	    "SENT", "WRITTEN", "FLUSHED", "REPLAYED");

	/* data */
	printa("%10s %10s %10s %@10u %@10u %@10u %@10u \n",
	    @sent, @written, @flushed, @replayed);

	printf("\n");

	clear(@sent);
	clear(@written);
	clear(@flushed);
	clear(@replayed);
}

/* Enable printing after the first tick. */
pgstatsmon*:::tick-done
/do_print == 0/
{
	do_print = 1;

	clear(@sent);
	clear(@written);
	clear(@flushed);
	clear(@replayed);
}
