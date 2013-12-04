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

/*
 * Query configuration: right now, we only query the user table stats.  This
 * facility may be generalized to support replication and query information.
 */
var query = 'SELECT * from pg_stat_user_tables';
var counters = [
    'seq_scan',
    'seq_tup_read',
    'idx_scan',
    'idx_tup_fetch',
    'n_tup_ins',
    'n_tup_upd',
    'n_tup_del',
    'n_tup_hot_upd',
    'n_live_tup',
    'n_dead_tup',
    'vacuum_count',
    'autovacuum_count',
    'analyze_count',
    'autoanalyze_count'
];

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

	config['dbs'].forEach(function (dbconf, i) {
		mod_assertplus.string(dbconf['name'],
		    'config.dbs[' + i + '].name');
		mod_assertplus.string(dbconf['url'],
		    'config.dbs[' + i + '].url');
	});

	config['targets'].forEach(function (targetconf, i) {
		mod_assertplus.string(targetconf['statsd'],
		    'config.targets[' + i + '].statsd');
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

	/* postgres client objects */
	this.pm_pgs = new Array(this.pm_dbs.length);
	/* current state of each instance's request */
	this.pm_state = this.pm_dbs.map(function () { return (null); });
	/* last-seen datapoints for each instance */
	this.pm_data = this.pm_dbs.map(function () { return ({}); });
	/* target objects */
	this.pm_targets = this.pm_targetconfs.map(
	    function (targetconf) { return (mon.createTarget(targetconf)); });

	/* always prepend a "log" target */
	this.pm_targets.unshift(new LogTarget(log));

}

PgMon.prototype.start = function ()
{
	var mon = this;
	var log = this.pm_log;
	var barrier = mod_vasync.barrier();

	log.info('starting service');

	this.pm_dbs.forEach(function (pgconf, i) {
		var client;

		barrier.start(pgconf['url']);
		client = mon.pm_pgs[i] = new mod_pg.Client(pgconf['url']);
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
	var mon = this;
	this.pm_pgs.forEach(function (_, i) {
		var url = mon.pm_dbs[i];
		var client = mon.pm_pgs[i];
		var state = mon.pm_state[i];
		var time;

		/*
		 * If the last check is still running, either the interval is
		 * configured too short, the database is swamped, or something
		 * else has gone horribly wrong (e.g., network issue).  Do not
		 * initiate another check, since that can generally only make
		 * things worse.
		 * XXX should likely have a timeout on the query, disconnect the
		 * client, and reconnect.
		 */
		if (state !== null) {
			mon.pm_log.error({
			    'url': url,
			    'last': state
			}, 'skipping check (still pending)');
			return;
		}

		time = process.hrtime();
		mon.pm_state[i] = new Date().toISOString();
		mon.pm_log.debug(url, 'check: start');
		client.query(query, function (err, result) {
			mon.pm_log.debug(url, 'check: done');
			mon.pm_state[i] = null;
			time = process.hrtime(time);

			if (err) {
				/* XXX does this do the right thing? */
				mon.emitCounter(
				    mon.statname(i, 'pgmon', 'queryerr'), 1);
				mon.pm_log.error({
				    'url': url,
				    'query': query
				}, 'query failed');
				return;
			}

			/*
			 * Record the datapoint, which will emit several counter
			 * stats, and then emit a separate timer stat for the
			 * query itself.
			 */
			mon.record(i, result);
			mon.emitTimer(
			    mon.statname(i, 'pgmon', 'querytime'),
			    (time[0] * 1000 + Math.floor(time[1] / 1000000)));
		});
	});
};

/*
 * [private] Record a query result "datum" for monitored postgres instance "i".
 * Store the new datapoint, and if there was a previous data point, emit the
 * deltas since then.
 */
PgMon.prototype.record = function (i, datum)
{
	var mon = this;
	var url = this.pm_dbs[i]['url'];
	var oldresult, oldrow;

	oldresult = this.pm_data[i];
	this.pm_data[i] = {};
	datum['rows'].forEach(function (row) {
		mon.pm_data[i][row['relname']] = row;
		oldrow = oldresult[row['relname']];

		if (!oldrow) {
			mon.pm_log.info({
			    'url': url,
			    'table': row['relname']
			}, 'table detected');
			return;
		}

		counters.forEach(function (c) {
			mon.emitCounter(
			    mon.statname(i, row['relname'], c),
			    row[c] - oldrow[c]);
		});
	});
};

PgMon.prototype.statname = function (i, table, counter)
{
	return (mod_util.format('%s.%s.%s.%s',
	    this.pm_prefix, this.pm_dbs[i]['name'], table, counter));
};

PgMon.prototype.createTarget = function (targetconf)
{
	return (new StatsdTarget(targetconf['statsd'], this.pm_log));
};

PgMon.prototype.emitCounter = function (name, value)
{
	this.pm_targets.forEach(function (t) { t.emitCounter(name, value); });
};

PgMon.prototype.emitTimer = function (name, duration)
{
	this.pm_targets.forEach(function (t) { t.emitTimer(name, duration); });
};


/*
 * Target that just logs all recorded stats at the TRACE level.
 */
function LogTarget(log)
{
	this.lt_log = log;
}

LogTarget.prototype.emitCounter = function (name, value)
{
	this.lt_log.trace(name, value);
};

LogTarget.prototype.emitTimer = function (name, duration)
{
	this.lt_log.trace(name, duration);
};


/*
 * Target that reports data to statsd.
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

StatsdTarget.prototype.emitTimer = function (name, duration)
{
	this.st_client.timing(name, duration);
};
