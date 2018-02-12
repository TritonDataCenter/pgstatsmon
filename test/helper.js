/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2018, Joyent, Inc.
 */

var mod_assert = require('assert-plus');
var mod_bunyan = require('bunyan');
var mod_fs = require('fs');
var mod_pg = require('pg');
var mod_util = require('util');
var mod_vasync = require('vasync');
var pgstatsmon = require('../lib/pgstatsmon');

var VError = require('verror').VError;

/* Globals */
var config;

/* allow table names with alphanumeric characters, _, and - */
var table_name_regex = new RegExp('^[a-zA-Z0-9_-]*$');

/* helper.js: helper functions to make writing tests easier. */

/*
 * This is the testing analog to the main() method in bin/pgstatsmon.js. This
 * function will read the provided configuration file and start a new instance
 * of pgstatsmon in this process using the provided configuration values. An
 * instance of the PgMon class is returned to the caller.
 *
 * The args object can have the following fields:
 *
 *    log		bunyan-style logger
 *
 *    config_file	(optional) path to the testing configuration file.
 *    			The default value is 'test/etc/testconfig.json'.
 *
 */
function getMon(args)
{
	mod_assert.object(args.log, 'args.log');
	mod_assert.optionalString(args.config_file, 'args.config_file');

	var filename;
	if (args.config_file) {
		filename = args.config_file;
	} else {
		filename = './etc/testconfig.json';
	}

	var data;
	var mon;
	var log;

	try {
		data = mod_fs.readFileSync(filename).toString('utf8');
	} catch (ex) {
		console.error('%s: failed to read file: %s',
		    filename, ex.message);
		process.exit(1);
	}

	try {
		config = JSON.parse(data);
	} catch (ex) {
		console.error('%s: failed to parse config: %s',
		    filename, ex.message);
		process.exit(1);
	}

	log = args.log;
	log.info('config', config);

	config['log'] = log;

	mon = pgstatsmon(config);

	return (mon);
}

/*
 * Get a connection to the Postgres database
 */
function createClient()
{
	var conf = config['static'];
	var url = mod_util.format('postgresql://%s@%s:%d/%s',
	    conf['user'], conf['dbs'][0]['ip'], conf['backend_port'],
	    conf['user']);
	var client = new mod_pg.Client(url);
	client.connect(function (err) {
		if (err) {
			config.log.error(err, config.dbs[0], 'failed to' +
				' create connection to backend Postgres');
		}
	});
	return (client);
}

/*
 * Create a table for testing
 */
function createTable(table_name, client, cb)
{
	if (table_name_regex.test(table_name) === false) {
		cb(new VError('invalid table name: "%s"', table_name));
		return;
	}

	var query = 'CREATE TABLE ' + table_name + ' (animal text, sound text)';
	doSql(query, client, function (err) {
		cb(err);
	});
}

/*
 * Destroy the table used for testing
 */
function dropTable(table_name, client, cb)
{
	if (table_name_regex.test(table_name) === false) {
		cb(new VError('invalid table name: "%s"', table_name));
		return;
	}

	var query = 'DROP TABLE IF EXISTS ' + table_name;
	doSql(query, client, function (err) {
		cb(err);
	});
}

/*
 * Sql transaction wrapper
 */
function doSql(sql, client, callback)
{
	mod_vasync.pipeline({
		'funcs': [
			function (_, cb) {
				client.query('BEGIN', cb);
			},
			function (_, cb) {
				client.query(sql, cb);
			},
			function (_, cb) {
				client.query('COMMIT', cb);
			}
		]
	}, function (err, results) {
		/* return any error and the results from the query */
		callback(err, results[1]);
	});
}

module.exports = {
	getMon: getMon,
	createClient: createClient,
	createTable: createTable,
	dropTable: dropTable,
	doSql: doSql
};
