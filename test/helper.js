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
var mod_url = require('url');
var mod_util = require('util');
var mod_vasync = require('vasync');
var pgstatsmon = require('../lib/pgstatsmon');

var VError = require('verror').VError;

/* Globals */
var config;

/* allow table names with alphanumeric characters, _, and - */
var table_name_regex = new RegExp('^[a-zA-Z0-9_-]*$');

/* allow roles and databases with alphabet characters */
var user_database_regex = new RegExp('^[a-zA-Z]*$');

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
function createClient(user, database, cb)
{
	var url_obj = mod_url.parse(config.dbs[0].url);
	var url_str = mod_util.format('postgres://%s@%s/%s', user, url_obj.host,
	    database);

	var client = new mod_pg.Client(url_str);
	client.connect(function (err) {
		if (err) {
			config.log.error(err, config.dbs[0], 'failed to' +
				' create connection to backend Postgres');
		}
		cb(err, client);
	});
}

/*
 * Create a table for testing
 */
function createTable(table_name, client, cb)
{
	if (table_name_regex.test(table_name) === false) {
		throw new VError('invalid table name: "%s"', table_name);
	}

	var query = 'CREATE TABLE ' + table_name + ' (animal text, sound text)';
	client.query(query, function (err) {
		cb(err);
	});
}

/*
 * Destroy the table used for testing
 */
function dropTable(table_name, client, cb)
{
	if (table_name_regex.test(table_name) === false) {
		throw new VError('invalid table name: "%s"', table_name);
	}

	var query = 'DROP TABLE IF EXISTS ' + table_name;
	client.query(query, function (err) {
		cb(err);
	});
}

/*
 * Create the user and database for testing
 */
function createUser(user_name, cb)
{
	var query;
	var user_exists_error_code = '42710';

	if (user_database_regex.test(user_name) === false) {
		throw new VError('invalid Postgres user: "%s"', user_name);
	}

	/* connect to the database as a superuser */
	createClient('postgres', 'postgres', function (err, client) {
		if (err) {
			cb(err);
			return;
		}
		/*
		 * create a role that isn't a superuser
		 */
		query = 'CREATE ROLE ' + user_name + ' WITH LOGIN NOSUPERUSER';
		client.query(query, function (err1, res) {
			/*
			 * ignore errors from trying to recreate an existing
			 * user
			 */
			if (err1 && err1.code === user_exists_error_code) {
				err1 = null;
			}
			client.end();
			cb(err1);
		});
	});

}

/*
 * Create a scratch space database for testing
 */
function createDatabase(database_name, cb)
{
	var query;
	var database_exists_error_code = '42P04';

	if (user_database_regex.test(database_name) === false) {
		throw new VError('invalid database name: "%s"', database_name);
	}

	/* connect to the database as a superuser */
	createClient('postgres', 'postgres', function (err, client) {
		if (err) {
			cb(err);
			return;
		}
		query = 'CREATE DATABASE ' + database_name;
		client.query(query, function (err1, res) {
			/*
			 * ignore errors from trying to recreate an existing
			 * database
			 */
			if (err1 && err1.code === database_exists_error_code) {
				err1 = null;
			}
			client.end();
			cb(err1);
		});
	});
}

module.exports = {
	getMon: getMon,
	createClient: createClient,
	createTable: createTable,
	dropTable: dropTable,
	createUser: createUser,
	createDatabase: createDatabase
};
