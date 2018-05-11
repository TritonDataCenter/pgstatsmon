#!/usr/sbin/dtrace -Cs

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * backendstat.d - print stats from pgstatsmon broken down by backend.
 *
 * This script prints information about the backends that pgstatsmon is
 * scraping metrics from. This is probably a good first step to finding what's
 * causing ticks to slow down. From here you can dive deeper using querystat.d
 * to determine which queries are slowest and causing errors.
 *
 * Arguments: none
 *
 * Fields:
 * BACKEND - name or IP and port combination of Postgres backend
 * LAT     - scrape duration from start to finish in milliseconds
 * QTIM    - queries timed out in the last tick
 * QERR    - query errors in the last tick
 * CERR    - connection errors since the last tick
 * NaN     - bogus values received over the wire
 *
 * The last line of output should have a backend named 'tick.' This represents
 * the end-to-end latency from querying _every_ backend. Backends are queried
 * with some parallelism, so the sum of the LAT column won't equal the LAT
 * value for 'tick.'
 *
 * If any of the values to the right of LAT are non-zero, that indicates there's
 * a problem somewhere.
 *
 * This script prints refreshed stats every tick. Output is sorted by LAT.
 *
 */

#pragma D option quiet
#pragma D option zdefs

/* track end-to-end tick latency */
pgstatsmon*:::tick-start
{
	self->startts["tick"] = timestamp;
}

pgstatsmon*:::tick-done
/self->startts["tick"]/
{
	@tick_lat["tick"] = sum(
	    (timestamp - self->startts["tick"]) / (1000000)
	);
}

/* track latency of individual backends */
pgstatsmon*:::backend-start
{
	self->bestartts[copyinstr(arg0)] = timestamp;
}

pgstatsmon*:::backend-done
/self->bestartts[copyinstr(arg0)]/
{
	backend = copyinstr(arg0);
	@backend_lat[backend] = sum(
	    (timestamp - self->bestartts[backend]) / (1000000)
	);
}

/* count the errors that pgstatsmon has reported */
artedi*:::counter-add
/copyinstr(arg0) == "pg_query_error"/
{
	backend = json(copyinstr(arg2), "backend");
	@query_errors[backend] = count();
}

artedi*:::counter-add
/copyinstr(arg0) == "pg_connect_error"/
{
	backend = json(copyinstr(arg2), "backend");
	@conn_errors[backend] = count();
}

artedi*:::counter-add
/copyinstr(arg0) == "pg_NaN_error"/
{
	backend = json(copyinstr(arg2), "backend");
	@NaN_errors[backend] = count();
}

artedi*:::counter-add
/copyinstr(arg0) == "pg_query_timeout"/
{
	backend = json(copyinstr(arg2), "backend");
	@query_timeouts[backend] = count();
}

/*
 * print the results every tick.
 *
 * This prints one line for every backend, and then one final line displaying
 * the end-to-end tick latency.
 */
pgstatsmon*:::tick-done
{
	/* we use %40s because that's how long backend names are in prod */
	printf("%40s %6s %4s %4s %4s %4s\n", "BACKEND", "LAT", "QTIM", "QERR",
	    "CERR", "NaN");
	printa("%40s %@6u %@4u %@4u %@4u %@4u \n", @backend_lat,
	    @query_timeouts, @query_errors, @conn_errors, @NaN_errors);
	printa("%40s %@6u\n", @tick_lat);
	printf("\n");

	/* reset the stats for the new tick */
	clear(@backend_lat);
	clear(@query_timeouts);
	clear(@query_errors);
	clear(@conn_errors);
	clear(@NaN_errors);
	clear(@tick_lat);
}