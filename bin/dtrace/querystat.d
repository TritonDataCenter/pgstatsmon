#!/usr/sbin/dtrace -Cs

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * querystat.d - print stats about queries for a given backend.
 *
 * This script prints information about the queries that are performed on a
 * given Postgres backend by pgstatsmon. This is a good second step after
 * looking at the output from backendstat.d.
 *
 * Arguments:
 *  - Name of backend (BACKEND column from backendstat.d)
 *
 * Fields:
 *
 * QUERY - name of the query being performed
 * LAT   - duration of query from the standpoint of pgstatsmon
 * QTIM  - queries timed out
 * QERR  - queries that resulted in error
 * NaN   - queries that returned NaN
 *
 * The name of the query generally corresponds to the Postgres table being
 * queried. If pgstatsmon joins tables the name is made up to represent the data
 * being returned.
 *
 * The possible values of QTIM, QERR, and NaN are zero and one.
 *
 * The last line of the output for every tick is the name of the backend.
 *
 * This script prints refreshed stats every tick. Output is sorted by LAT.
 *
 */

#pragma D option quiet
#pragma D option zdefs

BEGIN
{
	printf("waiting for tick...\n");
}

pgstatsmon*:::backend-query-start
/copyinstr(arg0) == $1/
{
	self->startts[copyinstr(arg1)] = timestamp;
}

pgstatsmon*:::backend-query-done
/self->startts[copyinstr(arg1)] && copyinstr(arg0) == $1/
{
	query = copyinstr(arg1);
	@lat[query] = sum((timestamp - self->startts[query]) / 1000000);
}

artedi*:::counter-add
/
json(copyinstr(arg2), "backend") == $1 &&
copyinstr(arg0) == "pg_query_error"
/
{
	@query_errors[json(copyinstr(arg2), "query")] = count();
}

artedi*:::counter-add
/
json(copyinstr(arg2), "backend") == $1 &&
copyinstr(arg0) == "pg_query_timeout"
/
{
	@query_timeouts[json(copyinstr(arg2), "query")] = count();
}

artedi*:::counter-add
/
json(copyinstr(arg2), "backend") == $1 &&
copyinstr(arg0) == "pg_NaN_error"
/
{
	@NaN_errors[json(copyinstr(arg2), "query")] = count();
}

pgstatsmon*:::tick-done
{
	printf("%s\n", $1);
	printf("%20s %6s %4s %4s %4s\n", "QUERY", "LAT", "QTIM", "QERR",
	    "NaN");
	printa("%20s %@6u %@4u %@4u %@4u \n", @lat, @query_timeouts,
	    @query_errors, @NaN_errors);
	printf("\n");

	/* reset the stats for the new tick */
	clear(@lat);
	clear(@query_timeouts);
	clear(@query_errors);
	clear(@NaN_errors);
}
