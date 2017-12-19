/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * pgstatsmon.js: periodically query Postgres stat tables and shovel the stats
 * to one or more targets.
 */

var mod_artedi = require('artedi');
var mod_assertplus = require('assert-plus');
var mod_jsprim = require('jsprim');
var mod_pg = require('pg');
var mod_restify = require('restify');
var mod_util = require('util');
var mod_vasync = require('vasync');

var queries = require('./queries').getQueries();

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
	mod_assertplus.number(config['interval'], 'config.interval');
	mod_assertplus.arrayOfObject(config['dbs'], 'config.dbs');
	mod_assertplus.object(config['target'], 'config.target');
	mod_assertplus.object(config['log'], 'config.log');

	config['dbs'].forEach(function (dbconf, pi) {
		mod_assertplus.string(dbconf['name'],
		    'config.dbs[' + pi + '].name');
		mod_assertplus.string(dbconf['url'],
		    'config.dbs[' + pi + '].url');
	});

	var target = config['target'];
	mod_assertplus.string(target['ip'], 'config.target.ip');
	mod_assertplus.number(target['port'], 'config.target.port');
	mod_assertplus.string(target['route'], 'config.target.route');

	var mon = new PgMon(config);
	mon.start();
	return (mon);
}

/*
 * Guts of the monitor.  Configuration is the same as pgstatsmon() above.  This
 * constructor just sets up state.  Call start() to connect to the databases and
 * start reporting data.
 */
function PgMon(config)
{
	var mon = this;
	var log = config['log'];

	/* Save log and configuration */
	this.pm_log = log;
	this.pm_dbs = mod_jsprim.deepCopy(config['dbs']);
	this.pm_targetconf = mod_jsprim.deepCopy(config['target']);
	this.pm_interval = config['interval'];
	this.pm_targets = [];

	/* queries to run */
	this.pm_queries = queries.map(
	    function (q) { return (new Query(q, log)); });
	/* postgres client objects */
	this.pm_pgs = new Array(this.pm_dbs.length);
	/* current state of each instance's request */
	this.pm_state = this.pm_dbs.map(function () {
		/* JSSTYLED */
		return (mon.pm_queries.map(function () { return (null); }));
	});
	/* last-seen datapoints for each instance */
	this.pm_data = this.pm_dbs.map(function () {
		/* JSSTYLED */
		return (mon.pm_queries.map(function () { return ({}); }));
	});
	/* Prometheus target */
	this.pm_targets.push(mon.createTarget(this.pm_targetconf));

	/* always add a "log" target */
	this.pm_targets.push(new LogTarget(log));

}

/*
 * [private] Create a backend target.  Only Prometheus targets are currently
 * supported, which is validated by the caller.
 */
PgMon.prototype.createTarget = function (targetconf)
{
	return (new PrometheusTarget(targetconf, this.pm_log));
};

PgMon.prototype.start = function ()
{
	var mon = this;
	var log = this.pm_log;
	var barrier = mod_vasync.barrier();

	log.info('starting service');

	this.pm_dbs.forEach(function (pgconf, pi) {
		var client;

		barrier.start(pgconf['url']);
		client = mon.pm_pgs[pi] = new mod_pg.Client(pgconf['url']);
		client.connect(function (err) {
			if (err) {
				log.error(err, pgconf, 'failed to connect');
				barrier.done(pgconf['url']);
				return;
			}

			log.info(pgconf, 'connected');
			barrier.done(pgconf['url']);
		});
	});

	barrier.on('drain', function () {
		log.info('all clients connected');
		mon.tick();
		setInterval(function () { mon.tick(); }, mon.pm_interval);
		mon.pm_targets.forEach(function (target) {
			target.start();
		});
	});
};

/*
 * [private] Invoked once per INTERVAL to run checks..
 */
PgMon.prototype.tick = function ()
{
	var pi, qi;
	for (pi = 0; pi < this.pm_pgs.length; pi++) {
		for (qi = 0; qi < this.pm_queries.length; qi++)
			this.tickPgQuery(pi, qi);
	}
};

PgMon.prototype.tickPgQuery = function (pi, qi)
{
	var mon = this;
	var log = this.pm_log;
	var url = this.pm_dbs[pi];
	var client = this.pm_pgs[pi];
	var query = this.pm_queries[qi];
	var state = this.pm_state[pi][qi];
	var time;
	var timer, errmetric;

	/*
	 * If the last check is still running, either the interval is configured
	 * too short, the database is swamped, or something else has gone
	 * horribly wrong (e.g., network issue).  Do not initiate another check,
	 * since that can generally only make things worse.
	 * XXX should likely have a timeout on the query, disconnect the client,
	 * and reconnect.
	 */
	if (state !== null) {
		log.error({
		    'url': url,
		    'query': query.q_name,
		    'last': state
		}, 'skipping check (still pending)');
		return;
	}

	time = process.hrtime();
	this.pm_state[pi][qi] = new Date().toISOString();
	log.debug({
	    'url': url,
	    'query': query.q_name
	}, 'check: start');
	client.query(query.q_sql, function (err, result) {
		log.debug({
		    'url': url,
		    'query': query.q_name
		}, 'check: done');
		mon.pm_state[pi][qi] = null;
		time = process.hrtime(time);

		/*
		 * If we see an error running the query, create a metric for
		 * the query we were running
		 */
		if (err) {
			errmetric = {
				'name': 'pg_query_error',
				'help': 'error performing PG query',
				'metadata': {
					'query': query.q_name
				}
			};
			log.error({
			    'url': url,
			    'query': query.q_name
			}, 'query failed');
			mon.emitCounter(errmetric, 1);
			return;
		}

		/*
		 * Record the datapoint, which will emit several counter
		 * stats, and then emit a separate timer stat for the
		 * query itself.
		 */
		mon.record(pi, qi, result);
		timer = {
			'attr': 'querytime',
			'help': 'time to run stat query',
			'unit': 'ms'
		};
		mon.emitTimer(mon.qstatname(pi, qi, null, timer),
		    mod_jsprim.hrtimeMillisec(time));
	});
};

/*
 * [private] Record a query result "datum" for monitored postgres instance "pi".
 * Store the new datapoint, and if there was a previous data point, emit the
 * deltas since then.
 */
PgMon.prototype.record = function (pi, qi, datum)
{
	var mon = this;
	var query = this.pm_queries[qi];
	var url = this.pm_dbs[pi]['url'];
	var oldresult, oldrow;

	oldresult = this.pm_data[pi][qi];
	this.pm_data[pi][qi] = {};
	datum['rows'].forEach(function (row) {
		var key = row[query.q_statkey];
		mon.pm_data[pi][qi][key] = row;
		oldrow = oldresult[key];

		if (!oldrow) {
			mon.pm_log.info({
			    'url': url,
			    'key': key
			}, 'row detected');
			return;
		}

		query.q_counters.forEach(function (c) {
			mon.emitCounter(
			    mon.qstatname(pi, qi, row, c),
			    row[c.attr] - oldrow[c.attr]);
		});

		query.q_gauges.forEach(function (g) {
			mon.emitGauge(
			    mon.qstatname(pi, qi, row, g), row[g.attr]);
		});
	});
};

/*
 * [private] Returns an object describing the metric stored as row[fieldname]
 * for postgres instance "pi", query "qi".
 */
PgMon.prototype.qstatname = function (pi, qi, row, field)
{
	var dbname = this.pm_dbs[pi]['name'];
	var query = this.pm_queries[qi];
	var fieldname = field.attr;
	var help = field.help;
	var metadata = query.q_metadata;
	var mdvalues = {};
	var name;

	mdvalues['name'] = dbname;
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
 * Emit the named counter to all targets.
 */
PgMon.prototype.emitCounter = function (metric, value)
{
	/*
	 * It's possible that the user we're using to connect to the DB doesn't
	 * have permissions to view certain tables, or we ran a bad query. In
	 * these cases we won't attempt to increment counters, but will log
	 * a warning and increment a separate counter to track this behavior.
	 */
	if (value === null) {
		this.pm_log.warn(metric, 'null value observed');
		this.pm_targets.forEach(function (t) {
			t.emitCounter({
				'name': 'pg_null_value_observed',
				'help': 'pgstatsmon read a null value from' +
				    ' a SQL query',
				'metadata': {
					'name': metric.name
				}
			}, 1);
		});
		return;
	}
	this.pm_targets.forEach(function (t) {
		t.emitCounter(metric, value);
	});
};

/*
 * Emit the named gauge to all targets.
 */
PgMon.prototype.emitGauge = function (metric, value)
{
	if (value === null) {
		this.pm_log.warn(metric, 'null value observed');
		this.pm_targets.forEach(function (t) {
			t.emitCounter({
				'name': 'pg_null_value_observed',
				'help': 'pgstatsmon read a null value from' +
				    ' a SQL query',
				'metadata': {
					'name': metric.name
				}
			}, 1);
		});
		return;
	}
	this.pm_targets.forEach(function (t) { t.emitGauge(metric, value); });
};

/*
 * Emit the named timer to all targets.
 */
PgMon.prototype.emitTimer = function (metric, duration)
{
	this.pm_targets.forEach(function (t) {
		t.emitTimer(metric, duration);
	});
};


/*
 * Wrap one of the above query configurations.
 */
function Query(conf, log)
{
	this.q_name = conf['name'];
	this.q_sql = conf['sql'];
	this.q_statkey = conf['statkey'] || null;
	this.q_counters = (conf['counters'] || []).slice(0);
	this.q_gauges = (conf['gauges'] || []).slice(0);
	this.q_metadata = (conf['metadata'] || []).slice(0);
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

/*
 * Exposes metrics in the Prometheus format via a Restify web server.
 */
function PrometheusTarget(conf, log)
{
	this.pe_log = log;
	this.pe_ip = conf.ip;
	this.pe_port = conf.port;
	this.pe_route = conf.route;
	this.pe_collector = mod_artedi.createCollector();
	this.pe_server = mod_restify.createServer({
		name: 'Monitor'
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
		help: metric.help
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
