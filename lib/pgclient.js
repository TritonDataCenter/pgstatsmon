/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * pgclient.js: a Postgres client wrapper intended to be used with node-cueball.
 */

var mod_cueball = require('cueball');
var mod_dtrace = require('dtrace-provider');
var mod_pg = require('pg');
var mod_assertplus = require('assert-plus');
var mod_util = require('util');
var EventEmitter = require('events').EventEmitter;
var WError = require('verror').WError;

var dtrace = require('./dtrace');

function QueryTimeoutError(cause, sql) {
	WError.call(this, cause, 'query timeout: %s', sql);
	this.name = 'QueryTimeoutError';
}
mod_util.inherits(QueryTimeoutError, WError);

function pgCreate(opts) {
	var queryTimeout = opts.queryTimeout;
	var user = opts.user;
	var database = opts.database;
	var log = opts.log;

	function _pgCreate(backend) {
		mod_assertplus.object(backend, 'backend');
		mod_assertplus.string(backend.name, 'backend.name');
		mod_assertplus.string(backend.address, 'backend.address');
		mod_assertplus.number(backend.port, 'backend.port');

		/* construct the connection url */
		var url = mod_util.format('postgres://%s@%s:%d/%s',
		    user, backend.address, backend.port, database);

		return (new PGClient({
			'url': url,
			'name': backend.name,
			'queryTimeout': queryTimeout,
			'user': user,
			'database': database,
			'log': log
		}));
	}
	return (_pgCreate);
}

function PGClient(options) {
	mod_assertplus.object(options, 'options');
	mod_assertplus.string(options.url, 'options.url');
	mod_assertplus.string(options.name, 'options.name');
	mod_assertplus.string(options.user, 'options.user');
	mod_assertplus.string(options.database, 'options.database');
	mod_assertplus.object(options.log, 'options.log');
	mod_assertplus.number(options.queryTimeout, 'options.queryTimeout');

	var self = this;
	this.client = new mod_pg.Client({
		connectionString: options.url,
		keepAlive: true
	});
	this.client.on('error', this._handleClientError.bind(this));

	this.client.connect();
	this.client.on('connect', function () {
		self.log.info({
			'backend': options.name
		}, 'connected');
		self.emit('connect');
	});

	this.url = options.url;
	this.user = options.user;
	this.name = options.name;

	this.queryTimeout = options.queryTimeout;
	this.client_had_err = null;
	this.destroyed = false;

	this.log = options.log.child({
		component: 'PGClient'
	}, true);

	EventEmitter.call(this);
}
mod_util.inherits(PGClient, EventEmitter);

PGClient.prototype.isDestroyed = function () {
	return (this.destroyed);
};

/*
 * The underlying Postgres will emit errors when it has a connection
 * problem. This can fire multiple times: once when the connection goes
 * away, and again if we try to make a query using this client. When
 * this happens, we mark this client as having failed so that the pool
 * will remove us once we're released.
 */
PGClient.prototype._handleClientError = function (err) {
	this.log.error({
		err: err
	}, 'pg: client emitted an error');

	this.client_had_err = err;
};

PGClient.prototype.query = function clientQuery(sql) {
	mod_assertplus.string(sql, 'sql');

	/* Clean up whitespace so queries are normalized to DTrace */
	sql = sql.replace(/(\r\n|\n|\r)/gm, '').replace(/\s+/, ' ');

	var log = this.log;
	var req;
	var res = new EventEmitter();
	var self = this;
	var timer;

	var aborted = false;

	function done(event, arg) {
		if (aborted) {
			return;
		}

		res.emit(event, arg);
		clearTimeout(timer);
	}

	req = new mod_pg.Query(sql);

	req.on('row', function onRow(row) {
		dtrace['query-row'].fire(function () {
			return ([sql, row, self.url]);
		});

		log.debug({
			row: row
		}, 'query: row');

		if (aborted) {
			return;
		}

		clearTimeout(timer);
		res.emit('row', row);
	});

	req.on('end', function onQueryEnd(arg) {
		dtrace['query-done'].fire(function () {
			return ([sql, arg, self.url]);
		});


		log.debug({
			res: arg
		}, 'query: done');

		done('end', arg);
	});

	req.on('error', function onQueryError(err) {
		dtrace['query-error'].fire(function () {
			return ([sql, err.toString(), self.url]);
		});

		log.debug({
			err: err
		}, 'query: failed');

		/*
		 * node-postgres's client.query() will fire "error"
		 * synchronously, resulting in this handler firing in the same
		 * tick as the client.query() call. Since the PGClient.query()
		 * caller won't have had an opportunity to set up their own
		 * "error" listener, we delay firing the event until the next
		 * tick.
		 */
		setImmediate(done, 'error', err);
	});

	if (this.queryTimeout > 0) {
		timer = setTimeout(function onRowTimeout() {
			var err = new QueryTimeoutError(sql);
			self.client_had_err = err;
			dtrace['query-timeout'].fire(function () {
				return ([sql, self.url]);
			});

			/*
			 * We're timing out the query, but
			 * the Postgres query is still running. It may
			 * still return rows, return a SQL error, or end due
			 * to connection problems. We don't emit anything
			 * after this point, since we've already emitted an
			 * "error" and will have replied to the client. We
			 * do continue logging and firing DTrace probes for
			 * anyone who's observing the process, though.
			 */
			aborted = true;

			res.emit('error', err);
		}, this.queryTimeout);
	}

	this.client.query(req);

	dtrace['query-start'].fire(function () {
		return ([sql, self.url]);
	});

	log.debug({
		sql: sql
	}, 'pg.query: started');

	return (res);
};

PGClient.prototype.destroy = function closePGClient() {
	var self = this;

	this.destroyed = true;
	self.client.end(function () {
		self.emit('close');
	});
};

module.exports = {
	pgCreate: pgCreate
};
