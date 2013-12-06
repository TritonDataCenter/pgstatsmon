/*
 * pgstatsmon.js: periodically query Postgres stat tables and shovel the stats
 * to one or more targets.
 */

var mod_assertplus = require('assert-plus');
var mod_jsprim = require('jsprim');
var mod_pg = require('pg');
var mod_statsd_client = require('statsd-client');
var mod_util = require('util');
var mod_vasync = require('vasync');

/* Public interface */
module.exports = pgstatsmon;

var queries = [ {
    'name': 'usertbl',
    'sql': 'SELECT * from pg_stat_user_tables',
    'statkey': 'relname',
    'counters': [
	'analyze_count',
	'autoanalyze_count',
	'autovacuum_count',
	'idx_scan',
	'idx_tup_fetch',
	'n_tup_del',
	'n_tup_hot_upd',
	'n_tup_ins',
	'n_tup_upd',
	'seq_scan',
	'seq_tup_read',
	'vacuum_count'
    ],
    'gauges': [
	'n_live_tup',
	'n_dead_tup'
    ]
}, {
    'name': 'repl',
    'sql': [
	'SELECT ',
	'sync_state, ',
	'pg_xlog_location_diff(sent_location, write_location) as write_lag, ',
	'pg_xlog_location_diff(write_location, flush_location) as flush_lag, ',
	'pg_xlog_location_diff(flush_location, replay_location) as replay_lag',
	'from pg_stat_replication'
    ].join('\n'),
    'gauges': [ 'write_lag', 'flush_lag', 'replay_lag' ],
    'xlatename': function (fieldname, row) {
	return (row['sync_state'] + '_' + fieldname);
    },
    'minfrequency': 10000 // XXX not used
} ];

/*
 * Monitor several postgres instances.  Configuration requires several
 * properties:
 *
 *    statprefix    prefix to use for all statsd stats.
 *
 *    interval      period at which to query Postgres instances.  We use an
 *                  interval timer rather than timeouts to try to keep
 *                  intervals as regular as possible.  If a query is still
 *                  outstanding when it's time to fire the next one, the
 *                  subsequent one is skipped entirely.
 *
 *    dbs           array of databases to monitor, each with:
 *
 *         name     human-readable label, used as part of stat names
 *
 *         url      Postgres url (i.e., "postgres://user@host:port/database")
 *
 *    targets       array of targets to send stats data to; each may have:
 *
 *         statsd   hostname of a statsd service to send to
 *
 *    log           bunyan-style logger
 */
function pgstatsmon(config)
{
	mod_assertplus.string(config['statprefix'], 'config.statprefix');
	mod_assertplus.number(config['interval'], 'config.interval');
	mod_assertplus.arrayOfObject(config['dbs'], 'config.dbs');
	mod_assertplus.arrayOfObject(config['targets'], 'config.targets');
	mod_assertplus.object(config['log'], 'config.log');

	config['dbs'].forEach(function (dbconf, pi) {
		mod_assertplus.string(dbconf['name'],
		    'config.dbs[' + pi + '].name');
		mod_assertplus.string(dbconf['url'],
		    'config.dbs[' + pi + '].url');
	});

	config['targets'].forEach(function (targetconf, pi) {
		mod_assertplus.string(targetconf['statsd'],
		    'config.targets[' + pi + '].statsd');
	});

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
	this.pm_targetconfs = mod_jsprim.deepCopy(config['targets']);
	this.pm_interval = config['interval'];
	this.pm_prefix = config['statprefix'];

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
	/* target objects */
	this.pm_targets = this.pm_targetconfs.map(
	    function (targetconf) { return (mon.createTarget(targetconf)); });

	/* always prepend a "log" target */
	this.pm_targets.unshift(new LogTarget(log));

}

/*
 * [private] Create a backend target.  Only statsd targets are currently
 * supported, which is validated by the caller.
 */
PgMon.prototype.createTarget = function (targetconf)
{
	return (new StatsdTarget(targetconf['statsd'], this.pm_log));
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
	});
};

/*
 * [private] Invoked once per INTERVAL to run checks.
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

		if (err) {
			/* XXX does this do the right thing? */
			mon.emitCounter(mon.estatname(pi, qi, 'queryerr'), 1);
			log.error({
			    'url': url,
			    'query': query.q_name
			}, 'query failed');
			return;
		}

		/*
		 * Record the datapoint, which will emit several counter
		 * stats, and then emit a separate timer stat for the
		 * query itself.
		 */
		mon.record(pi, qi, result);
		mon.emitTimer(
		    mon.qstatname(pi, qi, null, 'querytime'),
		    (time[0] * 1000 + Math.floor(time[1] / 1000000)));
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
		/*
		 * This assumes that if there's no statkey, then there's exactly
		 * one row.  This isn't necessarily true if you're doing
		 * replication to multiple peers from the same postgres
		 * instance.  XXX Is that supported?
		 */
		var key = query.q_statkey ? row[query.q_statkey] : 'repl';
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
			    row[c] - oldrow[c]);
		});

		query.q_gauges.forEach(function (g) {
			mon.emitGauge(
			    mon.qstatname(pi, qi, row, g), row[g]);
		});
	});
};

/*
 * [private] Returns the statsd counter name for the the error called "label"
 * when encountered processing query "qi" from postgres instance "pi".
 */
PgMon.prototype.estatname = function (pi, qi, label)
{
	var dbname = this.pm_dbs[pi]['name'];
	var query = this.pm_queries[qi];
	return (mod_util.format('%s.%s.%s.%s',
	    this.pm_prefix, dbname, query.q_name, label));
};

/*
 * [private] Returns the statsd counter name for the value stored as
 * row[fieldname] for postgres instance "pi", query "qi".
 */
PgMon.prototype.qstatname = function (pi, qi, row, fieldname)
{
	var dbname = this.pm_dbs[pi]['name'];
	var query = this.pm_queries[qi];
	var xlated, breakout;

	if (row !== null && query.q_statkey !== null)
		breakout = row[query.q_statkey];
	else
		breakout = query.q_name;

	if (row !== null && query.q_xlate !== null)
		xlated = query.q_xlate(fieldname, row);
	else
		xlated = fieldname;

	return (mod_util.format('%s.%s.%s.%s',
	    this.pm_prefix, dbname, breakout, xlated));
};

/*
 * Emit the named counter to all targets.
 */
PgMon.prototype.emitCounter = function (name, value)
{
	this.pm_targets.forEach(function (t) { t.emitCounter(name, value); });
};

/*
 * Emit the named gauge to all targets.
 */
PgMon.prototype.emitGauge = function (name, value)
{
	this.pm_targets.forEach(function (t) { t.emitGauge(name, value); });
};

/*
 * Emit the named timer to all targets.
 */
PgMon.prototype.emitTimer = function (name, duration)
{
	this.pm_targets.forEach(function (t) { t.emitTimer(name, duration); });
};


/*
 * Wrap one of the above query configurations.
 */
function Query(conf, log)
{
	this.q_name = conf['name'];
	this.q_sql = conf['sql'];
	this.q_statkey = conf['statkey'] || null;
	this.q_xlate = conf['xlatename'] || null;
	this.q_counters = (conf['counters'] || []).slice(0);
	this.q_gauges = (conf['gauges'] || []).slice(0);
}


/*
 * Backend target that just logs all recorded stats at the TRACE level.
 */
function LogTarget(log)
{
	this.lt_log = log;
}

LogTarget.prototype.emitCounter = function (name, value)
{
	this.lt_log.trace(name, value);
};

LogTarget.prototype.emitGauge = function (name, value)
{
	this.lt_log.trace(name, value);
};

LogTarget.prototype.emitTimer = function (name, duration)
{
	this.lt_log.trace(name, duration);
};


/*
 * Backend target that reports data to statsd.
 * XXX This prototype implementation uses the statsd-client package, but that's
 * not very efficient because it sends one packet *per stat* emitted, every
 * time.  Since we know we're going to emit a bunch of stats on the same tick,
 * we'd be much better off buffering them for a tick and then emitting them all
 * in as few packets as possible.  (Maximum IP packet size (and not MTU) will
 * prevent that from being one packet, so we also have to deal with
 * fragmentation.)
 */
function StatsdTarget(host, log)
{
	this.st_log = log;
	this.st_host = host;
	this.st_client = new mod_statsd_client({ 'host': host });
	this.st_emitted = {};
	log.info({ 'host': host }, 'creating statsd target');
}

StatsdTarget.prototype.emitCounter = function (name, value)
{
	if (value === 0 && this.st_emitted[name])
		return;

	this.st_emitted[name] = true;
	this.st_client.counter(name, value);
};

StatsdTarget.prototype.emitGauge = function (name, value)
{
	this.st_client.gauge(name, value);
};

StatsdTarget.prototype.emitTimer = function (name, duration)
{
	this.st_client.timing(name, duration);
};
