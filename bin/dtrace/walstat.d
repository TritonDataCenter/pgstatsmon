#!/usr/sbin/dtrace -Cs

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2018, Joyent, Inc.
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

artedi*:::counter-add
/copyinstr(arg0) == "pg_stat_replication_wal_sent_bytes"/
{
	labels = copyinstr(arg2);
	shard = strtok(json(labels, "backend"), ".");
	sync_state = json(labels, "sync_state");

	strtok(json(labels, "backend"), "-");
	zone = strtok(NULL, "-");

	@sent[shard, zone, sync_state] = sum(arg1);
}

artedi*:::counter-add
/copyinstr(arg0) == "pg_stat_replication_replica_wal_written_bytes"/
{
	labels = copyinstr(arg2);
	shard = strtok(json(labels, "backend"), ".");
	sync_state = json(labels, "sync_state");

	strtok(json(labels, "backend"), "-");
	zone = strtok(NULL, "-");

	@written[shard, zone, sync_state] = sum(arg1);
}

artedi*:::counter-add
/copyinstr(arg0) == "pg_stat_replication_replica_wal_flushed_bytes"/
{
	labels = copyinstr(arg2);
	shard = strtok(json(labels, "backend"), ".");
	sync_state = json(labels, "sync_state");

	strtok(json(labels, "backend"), "-");
	zone = strtok(NULL, "-");

	@flushed[shard, zone, sync_state] = sum(arg1);
}

artedi*:::counter-add
/copyinstr(arg0) == "pg_stat_replication_replica_wal_replayed_bytes"/
{
	labels = copyinstr(arg2);
	shard = strtok(json(labels, "backend"), ".");
	sync_state = json(labels, "sync_state");

	strtok(json(labels, "backend"), "-");
	zone = strtok(NULL, "-");

	@replayed[shard, zone, sync_state] = sum(arg1);
}

pgstatsmon*:::tick-done
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
