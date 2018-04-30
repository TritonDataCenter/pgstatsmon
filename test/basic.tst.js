/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2018, Joyent, Inc.
 */

var helper = require('./helper');

var mod_assert = require('assert-plus');
var mod_bunyan = require('bunyan');
var mod_path = require('path');
var mod_vasync = require('vasync');

var VError = require('verror').VError;

/*
 * basic.tst.js: basic tests to ensure pgstatsmon is operating properly.
 *
 * According to the PG docs, the backend Postgres process will only send stats
 * to the main Postgres process on 500ms intervals when idle (the
 * PGSTAT_STAT_INTERVAL constant), so we have to wait in various places after
 * ensuring sessions aren't in use to update counters. Unfortunately this is
 * only tunable before Postgres is compiled.
 */
var WAIT_PERIOD = 500; /* milliseconds to wait for stat updates */
var TEST_USER = 'pgstatsmon';
var TEST_DATABASE = 'pgstatsmon';

function main()
{
	var basicTest;

	/* spin up the dependent pgstatsmon and run the test cases */
	mod_vasync.pipeline({
		'funcs': [
			function (_, cb) {
				basicTest = new BasicTest(cb);
			},
			function (_, cb) {
				basicTest.check_connections(cb);
			},
			function (_, cb) {
				basicTest.check_tuple_count(cb);
			}
		]
	}, function (err, results) {
		mod_assert.ifError(err);
		basicTest.shutDown(function (err2) {
			mod_assert.ifError(err2);
		});
	});
}

function BasicTest(callback)
{
	var self = this;

	/* allow user to provide an alternate configuration file path */
	var mon_args = {};
	if (process.argv.length === 3) {
		mon_args.config_file = process.argv[2];
	}

	this.log = new mod_bunyan({
		'name': mod_path.basename(__filename),
		'level': process.env['LOG_LEVEL'] || 'fatal'
	});
	mon_args.log = this.log;

	this.table_name = 'pgstatsmon_basic';
	this.mon = helper.getMon(mon_args);
	this.prom_target = this.mon.getTarget();

	mod_vasync.pipeline({
		'funcs': [
			function (_, cb) {
				helper.createUser(TEST_USER, cb);
			},
			function (_, cb) {
				helper.createDatabase(TEST_DATABASE, cb);
			},
			function (_, cb) {
				helper.createClient(TEST_USER,
				    TEST_DATABASE, function (err, client) {
					    self.client = client;
					    cb(err);
				    });
			},
			function (_, cb) {
				helper.dropTable(self.table_name, self.client,
				    cb);
			},
			function (_, cb) {
				helper.createTable(self.table_name, self.client,
				    cb);
			},
			function (_, cb) {
				self.mon.tick(cb);
			}
		]
	}, function (err, results) {
		if (err) {
			callback(new VError(err, 'error preparing tests'));
			return;
		}
		clearInterval(self.mon.pm_intervalObj);
		callback();
	});
}

BasicTest.prototype.shutDown = function (callback)
{
	var self = this;
	mod_vasync.pipeline({
		'funcs': [
			function (_, cb) {
				helper.dropTable(self.table_name, self.client,
				    cb);
			},
			function (_, cb) {
				self.mon.stop();
				cb();
			},
			function (_, cb) {
				self.client.end(cb);
			}
		]
	}, function (err, results) {
		if (err) {
			callback(new VError(err, 'error during shutdown'));
			return;
		}
		callback(err);
	});
};

/* Tests */

/*
 * Get the tuple count, add a tuple, get the count again and make sure
 * pgstatsmon recognizes the added tuple.
 */
BasicTest.prototype.check_tuple_count = function (callback)
{
	var self = this;
	var mclient;
	var gauge, counter;
	var initial_value;
	var q;
	var labels = {
		'name': this.mon.pm_dbs[0].name,
		'relname': this.table_name
	};

	mod_vasync.pipeline({
		'funcs': [
			/* collect initial metrics */
			function (_, cb) {
				self.mon.tick(cb);
			},
			/*
			 * Make sure we have a fresh start - counters and gauges
			 * set to zero.
			 */
			function (_, cb) {
				gauge =
				    self.prom_target.pe_collector.getCollector(
					'pg_stat_user_tables_n_live_tup');
				counter =
				    self.prom_target.pe_collector.getCollector(
					'pg_stat_user_tables_n_tup_ins');

				self.log.debug({ 'iv': initial_value });
				mod_assert.equal(gauge.getValue(labels),
				    counter.getValue(labels),
				    'live tuples === tuples inserted');
				initial_value = gauge.getValue(labels);

				cb();
			},
			/* insert a single tuple */
			function (_, cb) {
				helper.createClient(TEST_USER,
				    TEST_DATABASE, function (err, client) {
					    mclient = client;
					    cb(err);
				    });
			},
			function (_, cb) {
				q = 'INSERT INTO ' + self.table_name +
				    ' VALUES (\'dog\', \'woof\');';
				mclient.query(q, function (err, res) {
					mod_assert.ifError(err);
					setTimeout(cb, WAIT_PERIOD);
				});
			},
			function (_, cb) {
				mclient.end(cb);
			},
			/* collect metrics again */
			function (_, cb) {
				self.mon.tick(cb);
			}
		]
	/*
	 * verify that we didn't have errors and the tuple counters were updated
	 * properly
	 */
	}, function (err, results) {
		if (err) {
			callback(new VError(err, 'error checking tuple count'));
			return;
		}

		mod_assert.equal(gauge.getValue(labels), initial_value + 1,
		    'one live tuple');
		mod_assert.equal(counter.getValue(labels), initial_value + 1,
		    'one tuple inserted');
		callback();
	});
};

/*
 * Get the idle connection count, create an idle connection, and make sure
 * pgstatsmon recognized an added idle connection.
 */
BasicTest.prototype.check_connections = function (callback)
{
	var self = this;
	var gauge;
	var initial_value;
	var mclient;
	var labels = {
		'name': this.mon.pm_dbs[0].name,
		'datname': this.client.database,
		'state': 'idle'
	};

	mod_vasync.pipeline({
		'funcs': [
			/* make sure we have gauges initialized */
			function (_, cb) {
				self.mon.tick(cb);
			},
			/*
			 * discover initial idle connection count, then
			 * create a new idle connection
			 */
			function (_, cb) {
				gauge =
				    self.prom_target.pe_collector.getCollector(
					'pg_stat_activity_connections');
				initial_value = gauge.getValue(labels);
				self.log.debug({ 'iv': initial_value });

				helper.createClient(TEST_USER, TEST_DATABASE,
				    function (err, client) {

					if (err) {
						self.log.error(err, 'failed to'
						    + ' create client');
						cb(err);
					}
					mclient = client;
					setTimeout(cb, WAIT_PERIOD);
				});
			},
			/* kick off another round of stat updates */
			function (_, cb) {
				self.mon.tick(cb);
			},
			/* close the idle client connection */
			function (_, cb) {
				mclient.end(cb);
			}
		]
	/* make sure pgstatsmon set the idle connection gauge properly */
	}, function (err, results) {
		if (err) {
			callback(new VError(err, 'error checking connections'));
		}

		mod_assert.equal(gauge.getValue(labels), initial_value + 1,
		    'one connection added');
		callback();
	});
};

main();
