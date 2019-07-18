/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2019 Joyent, Inc.
 */

/*
 * pgstatsmon.js: periodically query Postgres stat tables and shovel the stats
 * to one or more targets.
 */

var mod_artedi = require('artedi');
var mod_assertplus = require('assert-plus');
var mod_backoff = require('backoff');
var mod_cueball = require('cueball');
var mod_jsprim = require('jsprim');
var mod_pg = require('pg');
var mod_restify = require('restify');
var mod_util = require('util');
var mod_url = require('url');
var mod_vasync = require('vasync');
var mod_verror = require('verror');
var mod_vmapi_resolver = require('vmapi-resolver');

var mod_pgclient = require('./pgclient');
var mod_dbinit = require('./dbinit.js');

var dtrace = require('./dtrace');
var queries = require('./queries');

/* Public interface */
module.exports = pgstatsmon;

/*
 * Monitor several postgres instances.  Configuration requires several
 * properties:
 *
 *    interval      period at which to query Postgres instances.  We use an
 *                  interval timer rather than timeouts to try to keep
 *                  intervals as regular as possible.  If a query is still
 *                  outstanding when it's time to fire the next one, the
 *                  subsequent one is skipped entirely.
 *
 *    dbs           array of databases to monitor, each with:
 *
 *         name     human-readable label, used as a metadata label for metrics
 *
 *         url      Postgres url (i.e., "postgres://user@host:port/database")
 *
 *    target        object describing how to configure the Prometheus server.
 *                  It must include:
 *
 *         ip       ip address for server to listen on
 *
 *         port     port number for server to listen on
 *
 *         route    http route used to expose metrics
 *
 *    log           bunyan-style logger
 */
function pgstatsmon(config)
{
	/* XXX use a JSON schema validator? */
	mod_assertplus.object(config, 'config');
	mod_assertplus.number(config.interval, 'config.interval');
	mod_assertplus.object(config.connections, 'config.connections');
	mod_assertplus.number(config.connections.query_timeout,
	    'config.connections.query_timeout');
	mod_assertplus.number(config.connections.connect_timeout,
	    'config.connections.connect_timeout');
	mod_assertplus.number(config.connections.connect_retries,
	    'config.connections.connect_retries');
	mod_assertplus.object(config.target, 'config.target');
	mod_assertplus.object(config.log, 'config.log');

	if (config.vmapi) {
		/* default to using VMAPI to discover backends */
		var vmapi = config.vmapi;
		mod_assertplus.object(vmapi, 'config.vmapi');
		mod_assertplus.string(vmapi.url, 'config.vmapi.url');
		mod_assertplus.number(vmapi.pollInterval,
		    'config.vmapi.pollInterval');
		mod_assertplus.object(vmapi.tags, 'config.vmapi.tags');
		mod_assertplus.string(vmapi.tags.vm_tag_name,
		    'config.vmapi.tags.vm_tag_name');
		mod_assertplus.string(vmapi.tags.vm_tag_value,
		    'config.vmapi.tags.vm_tag_value');
		mod_assertplus.string(vmapi.tags.nic_tag,
		    'config.vmapi.tags.nic_tag');
	} else {
		/* use static backends if not using VMAPI */
		var static_conf = config.static;
		mod_assertplus.object(static_conf, 'config.static');
		mod_assertplus.arrayOfObject(static_conf.dbs,
		    'config.static.dbs');
		static_conf.dbs.forEach(function (dbconf, pi) {
			mod_assertplus.string(dbconf.name,
			    'config.static.dbs[' + pi + '].name');
			mod_assertplus.string(dbconf.ip,
			    'config.static.dbs[' + pi + '].ip');
		});
	}

	var target = config.target;
	mod_assertplus.string(target.ip, 'config.target.ip');
	mod_assertplus.number(target.port, 'config.target.port');
	mod_assertplus.string(target.route, 'config.target.route');
	mod_assertplus.object(target.metadata, 'config.target.metadata');

	mod_assertplus.string(config.user, 'user');
	mod_assertplus.string(config.database, 'database');
	mod_assertplus.number(config.backend_port, 'config.backend_port');

	return (new PgMon(config));
}

/*
 * Guts of the monitor.  Configuration is the same as pgstatsmon() above.  This
 * constructor just sets up state.  Call start() to connect to the databases and
 * start reporting data.
 */
function PgMon(config)
{
	mod_pg.defaults.parseInt8 = true; /* parse int8 into a numeric value */

	/* Save log and configuration */
	this.pm_log = config.log;
	this.pm_targetconf = mod_jsprim.deepCopy(config.target);
	this.pm_interval_rate = config.interval;
	this.pm_targets = [];
	this.pm_prometheus_target = null;

	this.pm_query_timeout = config.connections.query_timeout;
	this.pm_connect_timeout = config.connections.connect_timeout;
	this.pm_connect_retries = config.connections.connect_retries;

	if (config.vmapi) {
		/* VMAPI Resolver configuration */
		this.pm_vmapi = config.vmapi;

		this.pm_vmapi.backend_port = config.backend_port;
		this.pm_vmapi.log = this.pm_log.child({
			'component': 'VMResolver'
		});
	} else {
		/* list of static backends */
		this.pm_static = config.static;

		var port = config.backend_port;
		var backends = [];
		this.pm_static.dbs.forEach(function (db) {
			backends.push({
				'address': db.ip,
				'port': port,
				'name': db.name,
				'database': 'x'
			});
		});
		this.pm_backend_list = backends;
		this.pm_log.info(this.pm_backend_list, 'static backends');
	}

	this.pm_dbuser = config.user;

	/* interval returned from setInterval */
	this.pm_interval_object = null;

	/* current state of each instance's request */
	this.pm_state =	[];
	/* last-seen datapoints for each instance */
	this.pm_data = [];
	/* datapoints from the previous poll - for debugging */
	this.pm_old_data = [];
	/* postgres instance data */
	this.pm_pgs = [];
	/* cueball connection pools for each instance */
	this.pm_pools = [];

	this.initializeMetrics();
}

/*
 * [private] Create a backend target.  Only Prometheus targets are currently
 * supported, which is validated by the caller.
 */
PgMon.prototype.createTarget = function (targetconf)
{
	this.pm_prometheus_target = new PrometheusTarget(
	    targetconf, this.pm_log);
	return (this.pm_prometheus_target);
};

/*
 * [private] Returns the backend target.  Only Prometheus targets are currently
 * supported.
 */
PgMon.prototype.getTarget = function ()
{
	return (this.pm_prometheus_target);
};

/*
 * [private] This currently blows away all existing query information (state
 * and data) that the PgMon class tracks.  This isn't an issue unless this is
 * used after pgstatsmon has already collected some metrics.
 */
PgMon.prototype.initializeMetrics = function ()
{
	var mon = this;

	/* make sure old targets (if any) are stopped before we drop them */
	if (this.pm_targets) {
		this.pm_targets.forEach(function (target) {
			target.stop();
		});
	}

	this.pm_targets = [];

	/* Prometheus target */
	this.pm_targets.push(mon.createTarget(this.pm_targetconf));

	/* always add a "log" target */
	this.pm_targets.push(new LogTarget(this.pm_log));
};

/*
 * [private] Begin backend service discovery, and populate the requisite data
 * structures for each backend.
 */
PgMon.prototype.connect = function ()
{
	var mon = this;
	var log = mon.pm_log;
	var resolver, pg_client_constructor, pool;
	var ind;

	var delay = 1000; /* initial delay between reconnect tries */
	var maxDelay = 5000; /* max delay between reconnect tries */
	var maxTimeout = 10000; /* max connection attempt timeout */

	if (mon.pm_vmapi) {
		/* default to the VMAPI resolver */
		mon.pm_resolver =
			new mod_vmapi_resolver.VmapiResolver(mon.pm_vmapi);
	} else {
		/* use a cueball static IP resolver */
		mon.pm_resolver = new mod_cueball.StaticIpResolver({
			'backends': mon.pm_backend_list
		});
	}

	/*
	 * We'd like to maintain exactly one connection to each backend.
	 * Cueball provides us with nice connection management, but we don't
	 * need or want more than one connection per backend Postgres. We'll
	 * create one pool per backend Postgres instance.
	 */
	mon.pm_resolver.on('added', function (key, backend) {
		mod_assertplus.string(key, 'key');
		mod_assertplus.object(backend, 'backend');
		mod_assertplus.number(backend.port, 'backend.port');
		mod_assertplus.string(backend.name, 'backend.name');
		mod_assertplus.string(backend.address, 'backend.address');

		log.info({
		    'backend': backend
		}, 'backend discovered');

		/*
		 * XXX This is terrible but it works for now.
		 *
		 * This database name would be best stored in SAPI, but that
		 * whould require extra lookups.
		 *
		 * We may also consider storing this as part of the VM's tags,
		 * but the vmapi-resolver doesn't return tags (yet?).
		 */
		var database;
		if (backend.name.split('.')[1] === 'postgres') {
			database = 'moray';
		} else {
			mod_assertplus.equal(backend.name.split('.')[1],
			    'buckets-postgres');
			database = 'boray';
		}

		/* start a staticIpResolver for each backend */
		resolver = new mod_cueball.StaticIpResolver({
			'backends': [ {
				'address': backend.address,
				'port': backend.port
			} ]
		});
		resolver.start();

		pg_client_constructor = mod_pgclient.pgCreate({
		    'queryTimeout': mon.pm_query_timeout,
		    'user': mon.pm_dbuser,
		    'database': database,
		    'log': mon.pm_log
		});

		pool = new mod_cueball.ConnectionPool({
			'constructor': pg_client_constructor,
			'domain': backend.name, /* not actually used */
			'recovery': {
				'default': {
					'retries': mon.pm_connect_retries,
					'timeout': mon.pm_connect_timeout,
					'maxTimeout': maxTimeout,
					'delay': delay,
					'maxDelay': maxDelay
				}
			},
			'spares': 1, /* need one spare to recover failed pool */
			'maximum': 1, /* one connection per backend */
			'log': log.child({'component': 'cueball'}),
			'resolver': resolver
		});

		/* hold onto this pool and resolver */
		ind = mon.pm_pools.push({
			'key': key,
			'pool': pool,
			'resolver': resolver,
			'backend': backend,
			'database': database,
			'needs_setup': true,
			'setting_up': false
		});

		/* ensure this backend is kept track of */
		mon.add_connection_data({
			'key': key,
			'name': backend.name
		});

		setImmediate(function () {
			mon.setup_backend(ind - 1);
		});
	});

	/*
	 * When a backend is removed:
	 *  - Find the backend in the list of PG instances
	 *  - Stop the cueball connection pool, which destroys all connections
	 *  - Remove the data associated with the backend:
	 *    - Remove entry from the PG instance list
	 *    - Remove the data from the previous queries
	 *    - Remove the state value
	 */
	mon.pm_resolver.on('removed', function (key) {
		mod_assertplus.string(key, 'key');

		mon.pm_pools.forEach(function (backend, pi) {
			if (backend.key === key) {
				/*
				 * Stop the pool and it's staticIpResolver.
				 * This also destroys all open connections.
				 */
				backend.pool.stop();

				/* remove this connection's data */
				mon.wait_and_remove(key);
			}
		});

	});

	mon.pm_resolver.start();
};

/*
 * [private] Setup the backend. pgstatsmon needs a couple things before it can
 * operate safely:
 * - a non-superuser role with restricted permissions for connecting to the DB
 * - functions to call to view normally restricted pg_catalog tables, like
 *   pg_stat_replication and pg_stat_activity
 *
 * The function that this calls will attempt to connect as the 'postgres' user
 * to do these things, and then disconnect. Nothing will be done if the backend
 * is identified as being in recovery (a sync or async replica).
 */
PgMon.prototype.setup_backend = function setup_backend(pi)
{
	var mon = this;
	if (mon.pm_pools[pi].needs_setup === false ||
	    mon.pm_pools[pi].setting_up) {
		/*
		 * This backend is either already set up, or currently getting
		 * set up by another instance of this function.
		 */
		return;
	}
	mon.pm_pools[pi].setting_up = true; /* lock out other callers */

	mod_dbinit.setup_monitoring_user({
		'user': mon.pm_dbuser,
		'targetdb': mon.pm_pools[pi].database,
		'name': mon.pm_pools[pi].backend.name,
		'hostname': mon.pm_pools[pi].backend.address,
		'port': mon.pm_pools[pi].backend.port,
		'query_timeout': mon.pm_query_timeout,
		'connect_timeout': mon.pm_connect_timeout,
		'log': mon.pm_log.child({ 'component': 'backend_setup' })
	}, function (err, setup_result) {
		mon.pm_pools[pi].setting_up = false;
		if (err) {
			mon.pm_pools[pi].needs_setup = true;
			mon.pm_log.error({
				'error': err,
				'backend': mon.pm_pools[pi].backend.name
			}, 'error setting up backend');
			return;
		}

		var query_list = queries.getQueries({
		    'interval': mon.pm_interval_rate,
		    'pg_version': setup_result.pg_version,
		    'log': mon.pm_log
		});
		mon.pm_pools[pi].needs_setup = false;

		/* make sure we have the query data structures set up */
		mon.add_query_data(pi, query_list);
	});
};

/*
 * [private] Wait for queries to finish, then remove connection data. If the
 * connection is being stubborn, kill the connection.
 *
 * 'key' is used to find the PG instance in the pm_pgs structure.
 */
PgMon.prototype.wait_and_remove = function (key)
{
	var mon = this;
	var log = mon.pm_log;

	var num_backoffs = 2;
	var pi = -1;

	/* find the PG instance in question */
	mon.pm_pgs.forEach(function (pg, ind) {
		if (pg.key === key) {
			pi = ind;
		}
	});

	if (pi === -1) {
		/* key not found, data must be deleted already */
		return;
	}

	function is_running(_, cb) {
		var running = false;

		/*
		 * Iterate through the query state array. If any query
		 * has state (a timestamp), the query is still running,
		 * meaning that this backend is busy.
		 */
		mon.pm_state[pi].forEach(function (st) {
			if (st) {
				running = true;
			}
		});

		if (running) {
			cb(new mod_verror.VError('query state still present'));
		} else {
			cb();
		}
	}

	/*
	 * Use a backoff scheme to wait for the backend's queries to drain. If
	 * the queries don't drain after num_backoffs, forcibly remove the
	 * connection and its data.
	 */
	var call = mod_backoff.call(is_running, null, function (err) {
		if (err) {
			log.warn({
				'error': err,
				'backend': mon.pm_pgs[pi].name
			}, 'connection did not drain, forcing removal now');
		} else {
			log.info({
				'backend': mon.pm_pgs[pi].name
			}, 'connection drained, removing connection data');
		}
		mon.remove_connection_data(pi);
	});

	call.on('backoff', function (number, delay) {
		log.info({
			'backend': mon.pm_pgs[pi].name,
			'number': number,
			'delay': delay
		}, 'backoff');
	});

	call.setStrategy(new mod_backoff.ExponentialStrategy({
		'initialDelay': 1000
	}));
	call.failAfter(num_backoffs);
	call.start();
};

/*
 * [private] Remove data associated with a given Postgres instance.
 *
 * 'pi' is the index of the backend in the pm_pgs data structure.
 *
 */
PgMon.prototype.remove_connection_data = function (pi)
{
	var mon = this;
	var backend = mon.pm_pgs[pi].name;

	mon.pm_pgs.splice(pi, 1);
	mon.pm_data.splice(pi, 1);
	mon.pm_state.splice(pi, 1);
	mon.pm_pools.splice(pi, 1);
	mon.pm_old_data.splice(pi, 1);

	mon.pm_log.info({
		'backend': backend
	}, 'removed connection data');
};

/*
 * [private] Initialise this backend's slot in the list of discovered backends.
 */
PgMon.prototype.add_connection_data = function (backend)
{
	var mon = this;

	mon.pm_pgs.push({
		'key': backend.key,
		'name': backend.name,
		'conn': null,
		'handle': null,
		'queries': null
	});
};

/*
 * [private] Associate this backend's query data with the set of queries we've
 * determined it to be responsible for.  The query data includes:
 *   - The queries themselves.
 *   - An object to keep track of observed data points.
 *   - A 'state' array to idenfity in-flight queries.
 */
PgMon.prototype.add_query_data = function (pi, query_list)
{
	var mon = this;
	var num_queries = query_list.length;
	var data_array = new Array(num_queries);
	var old_data_array = new Array(num_queries);
	var state_array = new Array(num_queries);
	var backend = mon.pm_pgs[pi];

	for (var i = 0; i < num_queries; i++) {
		data_array[i] = {};
		old_data_array[i] = {};
		state_array[i] = null;
	}

	mon.pm_data[pi] = data_array;
	mon.pm_old_data[pi] = old_data_array;
	mon.pm_state[pi] = state_array;

	mon.pm_pgs[pi].queries = query_list;

	var queryCountMetric = {
	    'name': 'pg_query_count',
	    'help': 'Number of queries',
	    'metadata': {
		'backend': backend.name
	    }
	};

	mon.emitCounter(queryCountMetric, num_queries);
};


/*
 * Start pgstatsmon. The caller can optionally provde a callback to be notified
 * when it is safe to start using pgstatsmon.
 */
PgMon.prototype.start = function (callback)
{
	mod_assertplus.optionalFunc(callback, 'callback');

	var mon = this;

	mon.pm_log.info('starting service');

	/*
	 * discover backends, run initial tick, set up tick interval and
	 * start metric targets
	 */
	mon.connect();
	mon.tick(function (err) {
		if (err && callback) {
			callback(err);
		}

		mon.pm_interval_object = setInterval(function () {
			mon.tick();
		}, mon.pm_interval_rate);

		mon.pm_targets.forEach(function (target) {
			target.start();
		});

		if (callback) {
			callback();
		}
	});
};

/*
 * Stop pgstatsmon. This stops the tick interval, stops all metric targets,
 * and closes all of the database connections, and stops backend discovery.
 */
PgMon.prototype.stop = function ()
{
	var mon = this;

	clearInterval(mon.pm_interval_object);
	mon.pm_targets.forEach(function (target) {
		target.stop();
	});
	mon.pm_pools.forEach(function (backend, ind) {
		/* this stops both the pool and the resolver */
		backend.pool.stop();
		/* remove all of the data for this instance */
		mon.remove_connection_data(ind);
	});
	mon.pm_resolver.stop();
};

/*
 * [private] Invoked once per INTERVAL to run checks.
 * The caller may optionally provide a callback to be notified when all queries
 * have been completed.
 *
 * The implementation of this uses both a vasync queue and barriers. The queue
 * is used to ensure that we limit the number of Postgres instances being
 * concurrently queried. The barriers are used to coordinate kicking off all of
 * the queries for a given Postgres instance.
 */
PgMon.prototype.tick = function (callback)
{
	mod_assertplus.optionalFunc(callback);

	var mon = this;
	var queue;

	/* up to ten Postgres instances can be queried during a given tick() */
	var max_backends_in_flight = 10;

	dtrace['tick-start'].fire(function () { return ([]); });

	queue = mod_vasync.queue(function enqueue_queries(pi, cb) {
		/* kick off the Postgres queries for this instance */
		var error;
		var errmetric;
		var errors = [];
		var barrier = mod_vasync.barrier();
		var pool = mon.pm_pools[pi].pool;
		var backend = mon.pm_pgs[pi].name;

		dtrace['backend-start'].fire(function () {
			return ([backend]);
		});

		if (mon.pm_pools[pi].needs_setup) {
			setImmediate(function () {
				mon.setup_backend(pi);
			});

			dtrace['backend-done'].fire(function () {
				return ([backend]);
			});

			cb();
			return; /* skip this round, wait for setup */
		}

		barrier.start('enqueue queries');

		pool.claim({
			'timeout': mon.pm_connect_timeout
		}, function (err, handle, conn) {

			if (err) {
				/* couldn't connect, so short circuit */
				mon.pm_log.warn(err, 'could not connect');
				errors.push(err);
				barrier.done('enqueue queries');
				return;
			}

			mon.pm_pgs[pi].handle = handle;
			mon.pm_pgs[pi].conn = conn;
			backend = mon.pm_pgs[pi].name;

			mon.pm_pgs[pi].queries.forEach(function
			    kick_off_queries(query, qi) {

				/*
				 * barrier string looks like:
				 *  'backend [pg_index, query_index]'
				 */
				var query_id = mod_util.format('%s [%d, %d]',
				    backend, pi, qi);
				barrier.start(query_id);

				mon.tickPgQuery(pi, qi, function (err2) {
					if (err2) {
						errors.push(err2);
					}
					barrier.done(query_id);
				});
			});
			barrier.done('enqueue queries');
		});

		/*
		 * All of the queries are done executing for a particular
		 * backend. Now it's time to check for errors and handle them as
		 * appropriate.
		 *
		 * A few different errors can occur:
		 * - A query times out
		 *   - Gently close the connection
		 *   - The timeout has an error metric created in the
		 *     tickPgQuery function
		 * - The connection pool failed or connecting took too long
		 *   - Record that the error occurred
		 *   - Cueball will continue to try to reconnect
		 *
		 * If everything goes well pgstatsmon will release the
		 * connection back into the pool.
		 */
		barrier.on('drain', function barrier_drain() {
			error = mod_verror.errorFromList(errors);
			if (error && mod_verror.hasCauseWithName(error,
			    'QueryTimeoutError')) {

				mon.pm_log.warn({
					'error': error.message,
					'backend': backend
				}, 'query timeout, destroying connection');

				mon.pm_pgs[pi].handle.close();
			} else if (error && (mod_verror.hasCauseWithName(error,
			    'PoolFailedError') ||
			    mod_verror.hasCauseWithName(error,
			    'ClaimTimeoutError') ||
			    mod_verror.hasCauseWithName(error,
			    'PoolStoppingError'))) {

				/* no valid handle or connection */
				mon.pm_log.warn({
					'error': error.message,
					'backend': backend
				}, 'error connecting to backend');

				/* make sure we report the connection error */
				errmetric = {
					'name': 'pg_connect_error',
					'help': 'PG connection failed',
					'metadata': {
						'backend': backend
					}
				};
				mon.emitCounter(errmetric, 1);

			} else {
				/* done with the connection */
				mon.pm_pgs[pi].handle.release();

				mon.pm_pgs[pi].handle = null;
				mon.pm_pgs[pi].conn = null;
			}

			dtrace['backend-done'].fire(function () {
				return ([backend]);
			});

			cb(error);
		});
	}, max_backends_in_flight);

	/* enqueue all of the Postgres instances */
	mon.pm_pgs.forEach(function (pg, pi) {
		queue.push(pi);
	});

	queue.close();

	/* done with all of the work for this tick() */
	queue.on('end', function (err) {
		if (err) {
			mon.pm_log.error(err, 'error running queue');
		}

		dtrace['tick-done'].fire(function () { return ([]); });

		if (callback) {
			setImmediate(callback, err);
		}
	});
};

/*
 * [private] For a given backend and query, run the query and return the
 * results or errors asynchronously.
 *
 * If a query times out an error metric is recorded stating which query timed
 * out, and for which backend it occurred.
 */
PgMon.prototype.tickPgQuery = function (pi, qi, cb)
{
	mod_assertplus.number(pi, 'pi');
	mod_assertplus.number(qi, 'qi');
	mod_assertplus.func(cb, 'cb');

	var mon = this;
	var log = mon.pm_log;

	var backend = mon.pm_pgs[pi];

	var query = mon.pm_pgs[pi].queries[qi];
	var state = mon.pm_state[pi][qi];
	var client = backend.conn;

	var time;
	var timer, errmetric, res;
	var aborted = false;
	var rows = [];

	/*
	 * If the last check is still running, either the interval is configured
	 * too short, the database is swamped, or something else has gone
	 * horribly wrong (e.g., network issue).  Do not initiate another check,
	 * since that can generally only make things worse.
	 */
	if (state !== null) {
		log.warn({
		    'backend': backend.name,
		    'query': query.q_name,
		    'last': state
		}, 'skipping check (still pending)');
		setImmediate(cb);
		return;
	}

	time = process.hrtime();
	mon.pm_state[pi][qi] = new Date().toISOString();
	log.debug({
	    'backend': backend.name,
	    'query': query.q_name
	}, 'check: start');

	dtrace['backend-query-start'].fire(function () {
		return ([
		    backend.name,
		    query.q_name
		]);
	});

	res = client.query(query.q_sql);
	res.on('row', function on_query_row(row) {
		if (aborted) {
			log.warn({
				'backend': backend.name,
				'query': query.q_name
			}, 'query was aborted');
			return;
		}
		log.debug({
		    'backend': backend.name,
		    'query': query.q_name
		}, 'check: done');

		rows.push(row);
	});

	res.on('error', function on_query_error(err) {
		dtrace['backend-query-done'].fire(function () {
			return ([backend.name, query.q_name]);
		});

		mon.pm_state[pi][qi] = null;
		aborted = true;

		/*
		 * Record query timeouts. We could record other errors if we
		 * think the cardinality of the error type would be low.
		 */
		if (mod_verror.hasCauseWithName(err, 'QueryTimeoutError')) {
			errmetric = {
				'name': 'pg_query_timeout',
				'help': 'PG query timed out',
				'metadata': {
					'backend': backend.name,
					'query': query.q_name
				}
			};
			mon.emitCounter(errmetric, 1);

			setImmediate(cb, err);
			return;
		}

		/*
		 * If we see an error running the query, create a metric
		 * for the query we were running
		 */
		errmetric = {
			'name': 'pg_query_error',
			'help': 'error performing PG query',
			'metadata': {
				'backend': backend.name,
				'query': query.q_name
			}
		};
		log.warn(err, {
		    'backend': backend.name,
		    'query': query.q_name
		}, 'query failed');
		mon.emitCounter(errmetric, 1);
		setImmediate(cb, err);
		return;
	});

	res.once('end', function on_query_end() {
		dtrace['backend-query-done'].fire(function () {
			return ([backend.name, query.q_name]);
		});
		res.removeAllListeners();
		if (client.isDestroyed()) {
			mon.pm_log.info({
				'backend': backend.name
			}, 'client removed during query');
			setImmediate(cb);
			return;
		}
		time = process.hrtime(time);

		/*
		 * Record the datapoint, which will emit several counter
		 * stats, and then emit a separate timer stat for the
		 * query itself.
		 */
		if (rows.length > 0) {
			mon.record(pi, qi, rows);
		}
		timer = {
			'attr': 'querytime',
			'help': 'time to run stat query',
			'unit': 'ms'
		};
		mon.emitTimer(mon.qstatname(pi, qi, null, timer),
		    mod_jsprim.hrtimeMillisec(time));
		mon.pm_state[pi][qi] = null;
		setImmediate(cb);
	});
};

/*
 * [private] Record a query result "datum" for monitored postgres instance "pi".
 * Store the new datapoint, and if there was a previous data point, emit the
 * deltas since then.
 */
PgMon.prototype.record = function (pi, qi, datum)
{
	mod_assertplus.number(pi, 'pi');
	mod_assertplus.number(qi, 'qi');
	mod_assertplus.object(datum, 'datum');

	var mon = this;
	var backend = mon.pm_pgs[pi];

	var query = mon.pm_pgs[pi].queries[qi];
	var oldresult, oldrow;
	var reset_time;
	var last_reset_time;
	var new_value, old_value;
	var metric;

	function record_NaN(met) {
		mon.pm_log.warn({
			'metric': met
		}, 'NaN value observed');

		mon.pm_targets.forEach(function (t) {
			t.emitCounter({
				'name': 'pg_NaN_error',
				'help': 'pgstatsmon read a bad'
				    + ' value from a SQL query',
				'metadata': {
					'name': met.name,
					'backend': backend.name,
					'query': query.q_name
				}
			}, 1);
		});
	}

	oldresult = mon.pm_data[pi][qi];
	mon.pm_old_data[pi][qi] = oldresult;
	mon.pm_data[pi][qi] = {};
	datum.forEach(function record_metrics_for_row(row) {
		var key = row[query.q_statkey];
		mon.pm_data[pi][qi][key] = row;
		oldrow = oldresult[key];

		if (row.stats_reset && oldrow) {
			/*
			 * Try to detect a stat reset. Some relations reset
			 * stats when the PG instance restarts, and then record
			 * the reset time in the 'stats_reset' attribute. Other
			 * relations (pg_stat_user_tables in particular) reset
			 * stats when the PG instance restarts, but don't
			 * include a 'stats_reset' attribute.
			 *
			 * In either case, we've overwritten the pre-reset data
			 * with new data, so we should just skip this round
			 * of recording metrics.
			 */
			reset_time = Date.parse(row.stats_reset);
			last_reset_time = Date.parse(oldrow.stats_reset);
			if (reset_time > last_reset_time) {
				mon.pm_log.info({
					'backend': backend.name,
					'query': query.q_name,
					'stats_reset': row.stats_reset
				}, 'stats reset detected');
				return;
			}
		}

		if (!oldrow) {
			mon.pm_log.info({
			    'backend': backend.name,
			    'query': query.q_name,
			    'key': key
			}, 'row detected');
			return;
		}

		query.q_counters.forEach(function emit_counters(c) {
			metric = mon.qstatname(pi, qi, row, c);
			new_value = row[c.attr];
			old_value = oldrow[c.attr];

			/*
			 * Ways we can get bad data from Postgres:
			 * - corruption on the wire
			 * - our database user can't access certain tables or
			 *   values within a table
			 * - we ran a bad query
			 * In these cases we won't attempt to increment
			 * counters or gauges, but will log a warning and
			 * increment a separate counter to track this behavior.
			 */
			if (isNaN(new_value)) {
				record_NaN(metric);
				return;
			}

			/*
			 * Some queries return null values under normal
			 * operation (pg_recovery).
			 */
			if (new_value === null) {
				mon.pm_log.debug({
					'metric': metric
				}, 'null value observed');
				return;
			}

			if (old_value > new_value) {
				/* some relations don't advertise stat resets */
				mon.pm_log.info({
					'backend': backend.name,
					'key': key,
					'counter': c
				}, 'old value greater than new value -'
				    + ' skipping');
				return;
			}
			mon.emitCounter(metric, new_value - old_value);
		});

		query.q_gauges.forEach(function emit_gauges(g) {
			metric = mon.qstatname(pi, qi, row, g);
			new_value = row[g.attr];

			/* see previous comment for explanation */
			if (isNaN(new_value)) {
				record_NaN(metric);
				return;
			}

			if (new_value === null) {
				mon.pm_log.debug({
					'metric': metric
				}, 'null value observed');
				return;
			}

			if (g.expires) {
				metric.expires = g.expires;
				metric.expiryPeriod = g.expiryPeriod;
				metric.defaultValue = g.defaultValue;
			}

			mon.emitGauge(metric, new_value);
		});
	});
};

/*
 * [private] Returns an object describing the metric stored as row[fieldname]
 * for postgres instance "pi", query "qi".
 */
PgMon.prototype.qstatname = function (pi, qi, row, field)
{
	mod_assertplus.number(pi, 'pi');
	mod_assertplus.number(qi, 'qi');
	mod_assertplus.optionalObject(row, 'row');
	mod_assertplus.object(field, 'field');

	var mon = this;
	var query = mon.pm_pgs[pi].queries[qi];
	var fieldname = field.attr;
	var help = field.help;
	var metadata = query.q_metadata;
	var mdvalues = {};
	var name;

	mdvalues.backend = mon.pm_pgs[pi].name;
	if (metadata && row) {
		metadata.forEach(function (attr) {
			mdvalues[attr] = row[attr];
		});
	}

	/*
	 * Returns something like this:
	 * {
	 *   'name': 'postgres_repl_write_lag',
	 *   'help': 'write lag',
	 *   'metadata': {
	 *     'name': 'primary'
	 *     'sync_state': 'async',
	 * }
	 */
	name = mod_util.format('%s_%s', query.q_name, fieldname);
	if (field.unit) {
		/* many metrics provide units (e.g. 'ms') */
		name = mod_util.format('%s_%s', name, field.unit);
	}
	return ({
		'name': name,
		'help': help,
		'metadata': mdvalues
	});
};

/*
 * [private] Emit the named counter to all targets.
 */
PgMon.prototype.emitCounter = function (metric, value)
{
	mod_assertplus.object(metric, 'metric');
	mod_assertplus.number(value, 'value');

	this.pm_targets.forEach(function (t) { t.emitCounter(metric, value); });
};

/*
 * [private] Emit the named gauge to all targets.
 */
PgMon.prototype.emitGauge = function (metric, value)
{
	mod_assertplus.object(metric, 'metric');
	mod_assertplus.number(value, 'value');

	this.pm_targets.forEach(function (t) { t.emitGauge(metric, value); });
};

/*
 * [private] Emit the named timer to all targets.
 */
PgMon.prototype.emitTimer = function (metric, duration)
{
	mod_assertplus.object(metric, 'metric');
	mod_assertplus.number(duration, 'duration');

	this.pm_targets.forEach(function (t) {
		t.emitTimer(metric, duration);
	});
};


/*
 * Wrap one of the above query configurations.
 */
function Query(conf, log)
{
	this.q_sql = conf.sql;
	this.q_name = conf.name;
	this.q_statkey = conf.statkey || null;
	this.q_gauges = (conf.gauges || []).slice(0);
	this.q_counters = (conf.counters || []).slice(0);
	this.q_metadata = (conf.metadata || []).slice(0);
}


/*
 * Backend target that just logs all recorded stats at the TRACE level.
 */
function LogTarget(log)
{
	this.lt_log = log;
}

LogTarget.prototype.emitCounter = function (metric, value)
{
	this.lt_log.trace(metric.name, metric.metadata, value);
};

LogTarget.prototype.emitGauge = function (metric, value)
{
	this.lt_log.trace(metric.name, metric.metadata, value);
};

LogTarget.prototype.emitTimer = function (metric, duration)
{
	this.lt_log.trace(metric.name, metric.metadata, duration);
};

LogTarget.prototype.start = function ()
{
};

LogTarget.prototype.stop = function ()
{
};

/*
 * Exposes metrics in the Prometheus format via a Restify web server.
 */
function PrometheusTarget(conf, log)
{
	mod_assertplus.object(conf, 'conf');
	mod_assertplus.object(log, 'log');

	this.pe_log = log;
	this.pe_ip = conf.ip;
	this.pe_port = conf.port;
	this.pe_route = conf.route;
	this.pe_collector = mod_artedi.createCollector({
		'labels': conf.metadata
	});
	this.pe_server = mod_restify.createServer({
		'log': this.pe_log.child({ 'component': 'prometheus_server' }),
		'name': 'Monitor'
	});

	var prom = this;
	/*
	 * PgMon periodically 'ticks' to collect metrics from PG instances. When
	 * a user scrapes metrics we return the most recently collected data.
	 */
	this.pe_server.get('/metrics', function (req, res, next) {
		req.on('end', function () {
			prom.pe_collector.collect(mod_artedi.FMT_PROM,
			    function (err, metrics) {
				if (err) {
					next(err);
					return;
				}
				res.setHeader('Content-Type',
				    'text/plain; version=0.0.4');
				res.send(metrics);
				next();
			});
		});
		req.resume();
	});
}

PrometheusTarget.prototype.emitCounter = function (metric, value)
{
	this.pe_collector.counter({
		name: metric.name,
		help: metric.help
	}).add(value, metric.metadata);
};

PrometheusTarget.prototype.emitGauge = function (metric, value)
{
	this.pe_collector.gauge({
		name: metric.name,
		help: metric.help,
		expires: metric.expires,
		expiryPeriod: metric.expiryPeriod,
		defaultValue: metric.defaultValue
	}).set(value, metric.metadata);
};

PrometheusTarget.prototype.emitTimer = function (metric, duration)
{
	this.pe_collector.histogram({
		name: metric.name,
		help: metric.help
	}).observe(duration, metric.metadata);
};

PrometheusTarget.prototype.start = function ()
{
	var prom = this;
	this.pe_server.listen(this.pe_port, this.pe_ip, function () {
		prom.pe_log.info('monitoring server started on port %d',
		    prom.pe_port);
	});
};

PrometheusTarget.prototype.stop = function ()
{
	this.pe_server.close();
};
