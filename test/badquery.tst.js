/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2019, Joyent, Inc.
 */

var helper = require('./helper');

var mod_assert = require('assert-plus');
var mod_bunyan = require('bunyan');
var mod_path = require('path');
var mod_vasync = require('vasync');

var VError = require('verror').VError;

/*
 * badquery.tst.js: run some invalid queries and see how pgstatsmon handles it.
 */
var TEST_USER = 'pgstatsmon';
var TEST_DATABASE = 'pgstatsmon';

function main()
{
	var badQuery;

	/* spin up the dependent pgstatsmon and run the test cases */
	mod_vasync.pipeline({
		'funcs': [
			function (_, cb) {
				badQuery = new BadQuery(cb);
			},
			function (_, cb) {
				badQuery.run_invalid_query(cb);
			}
		]
	}, function (err, res) {
		mod_assert.ifError(err);
		badQuery.shutDown(function (err2) {
			mod_assert.ifError(err2);
		});
	});
}

function BadQuery(callback)
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

	this.mon = helper.getMon(mon_args);

	mod_vasync.pipeline({
		'funcs': [
			function (_, cb) {
				self.mon.start(cb);
			},
			function (_, cb) {
				helper.createUser(TEST_USER, cb);
			},
			function (_, cb) {
				helper.createDatabase(TEST_DATABASE, cb);
			},
			function (_, cb) {
				helper.createClient(TEST_USER, TEST_DATABASE,
				    function (err, client) {

					if (err) {
						self.log.error(err,
						    'error creating client');
					}
					self.client = client;
					cb();
				});
			},
			function (_, cb) {
				/*
				 * pgstatsmon first tries to set up its
				 * backend(s) by creating a user and some
				 * functions for that user to call. We don't
				 * want that user because we want to do weird
				 * things that the user pgstatsmon creates isn't
				 * allowed to do. pgstatsmon won't run any
				 * queries against a backend if it hasn't first
				 * tried to set up the user.
				 *
				 * Anyway, it takes a little while for this
				 * to happen so we have to sleep for just a few
				 * ms while pgstatsmon does its thing.
				 *
				 * XXX Maybe we can make user creation optional,
				 * or somehow have pgstatsmon wait to call the
				 * 'start' function's callback until at least
				 * one backend is verified set up.
				 */
				setTimeout(cb, 500);
			},
			function (_, cb) {
				clearInterval(self.mon.pm_intervalObj);
				cb();
			}
		]
	}, function (err, results) {
		if (err) {
			callback(new VError(err, 'error preparing tests'));
			return;
		}
		self.prom_target = self.mon.getTarget();
		callback();
	});
}

BadQuery.prototype.shutDown = function (callback) {
	this.mon.stop();
	this.client.end(callback);
};

/* Tests */

/*
 * Make pgstatsmon run a query that results in an error being returned from
 * Postgres.
 */
BadQuery.prototype.run_invalid_query = function (callback)
{
	var self = this;
	var queries;
	var counter;
	var initial_value;

	/* bogus query that causes Postgres to return an error */
	queries = [ {
		'q_name': 'test_bad_query',
		'q_sql': 'SELECT *',
		'q_statkey': 'non_existent',
		'q_metadata': [ 'no_metadata' ],
		'q_counters': [],
		'q_gauges': []
	} ];

	var labels = {
		'query': queries[0].q_name,
		'backend': self.mon.pm_pgs[0]['name']
	};

	/*
	 * since mon.initializeMetrics() drops all of the data, we need to get
	 * a pointer to the new PrometheusTarget
	 */
	self.prom_target = this.mon.getTarget();

	mod_vasync.pipeline({
		'funcs': [
			function (_, cb) {
				self.mon.pm_pools[0].queries = queries;
				cb();
			},
			/* make sure counters are created */
			function (_, cb) {
				self.mon.tick(cb);
			},
			/* get the initial query error count */
			function (_, cb) {
				counter =
				    self.prom_target.pe_collector.getCollector(
					'pg_query_error');
				initial_value = counter.getValue(labels);
				self.log.debug({ 'iv': initial_value });
				cb();
			},
			/*
			 * kick off another round of stat updates
			 *
			 * In this case only one query is executed, and it
			 * should result in an error counter being incremented.
			 */
			function (_, cb) {
				self.mon.tick(cb);
			}
		]
	/* make sure pgstatsmon incremented the error counter */
	}, function (err, results) {
		if (err) {
			callback(new VError(err, 'error running invalid' +
			    ' query'));
			return;
		}
		mod_assert.equal(counter.getValue(labels),
		    initial_value + 1, 'one query error');

		callback();
	});
};

main();
