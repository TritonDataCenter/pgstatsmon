/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2019 Joyent, Inc.
 */

var mod_ajv = require('ajv');
var mod_assertplus = require('assert-plus');
var mod_jsprim = require('jsprim');

/*
 * queries.js: Exposes a function that returns a list of queries to be executed
 * by pgstatsmon to collect
 * metrics.
 *
 * Each object in the query array contains a number of required fields:
 *
 *    queries          array of query objects
 *
 *        name         human-readable name of the resulting metric
 *
 *        versionToSql an object whose values are a sql statement string, and
 *                     whose keys are a string of the minimum supported postgres
 *                     version that the query is expected to run against.  the
 *                     special key "all" denotes that the query can be expected
 *                     to run against all versions of postgres.  a mixture of
 *                     "all" and specific versions are not allowed.
 *
 *        statkey      unique per-row attribute name that pgstatsmon will use as
 *                     an index to store metrics in memory
 *
 *        metadata     array of attribute names to be used as metadata labels in
 *                     the resulting metric
 *
 *        counters     array of counter objects. Each counter object tracks the
 *                     value of the provided attribute from the sql result set.
 *                     Counters are used to represent things that only move up,
 *                     like bytes written or vacuum counts.
 *
 *            attr     attribute name from the sql result set. Used to find the
 *                     value of the metric.
 *
 *            help     human-readable string to assist in understanding what a
 *                     metric represents
 *
 *            unit     [optional] unit by which the metric should be measured
 *                     (e.g. 'ms' for 'milliseconds')
 *
 *        gauges       array of gauge objects. Each gauge object tracks the
 *                     value of the provided attribute from teh sql result set.
 *                     Gauges are used to represent things that can move up or
 *                     down, like connection counts and table sizes.
 *
 *            attr     attribute name from the sql result set. Used to find the
 *                     value of the metric.
 *
 *            help     human-readable string to assist in understanding what a
 *                     metric represents
 *
 *            unit     [optional] unit by which the metric should be measured
 *                     (e.g. 'ms' for 'milliseconds')
 *
 *
 * The query schema is validated when a consumer requests the set of queries.
 */

var METRIC_PROPERTY = {
    'type': 'array',
    'items': {
	'type': 'object',
	'properties': {
	    'attr': { 'type': 'string' },
	    'help': { 'type': 'string' },
	    'unit': { 'type': 'string' },
	    'expires': { 'type': 'boolean' }
	},
	'required': [ 'attr', 'help' ]
    }
};

var QUERY_SCHEMA = {
    'type': 'array',
    'items': {
	'type': 'object',
	'properties': {
	    'name': { 'type': 'string' },
	    'versionToSql': {
		'type': 'object',
		'minProperties': 1,
		'patternProperties': {
		    '^.*$': { 'type': 'string' }
		},
		'oneOf': [ {
		    'propertyNames': {
			'pattern': '^[0-9]+$'
		    }
		}, {
		    'propertyNames': {
			'pattern': 'all'
		    },
		    'maxProperties': 1
		} ]
	    },
	    'statkey': { 'type': 'string' },
	    'metadata': {
		'type': 'array',
		'items': { 'type': 'string' }
	    },
	    'counters': METRIC_PROPERTY,
	    'gauges': METRIC_PROPERTY
	},
	'required': [ 'name', 'statkey', 'versionToSql' ]
    }
};

/*
 * A pgstatsmon instance can be responsible for querying a number of backend
 * PostgreSQL instances of differing versions.  Because of this, we need some
 * way of directing certain queries to certain versions of PostgreSQL, and we do
 * so in "versionToSql".  The reasons for the version mediation are:
 *
 *   - Version 10 of PostgreSQL standardised on a set of naming conventions for
 *     its WAL interactions (e.g. "xlog" to "wal", "location" to "lsn").  This
 *     has resulted in subtle changes to the function names that we use in our
 *     queries.
 *   - Version 9.2 of PostgreSQL doesn't support some of the types, functions,
 *     or views that we require, such as the "pg_stat_progress_vacuum" view, or
 *     the "pg_lsn" type.
 */
var QUERIES = [ {
    'name': 'pg_stat_user_tables',
    'statkey': 'relid',
    'metadata': [ 'schemaname', 'relname' ],
    'versionToSql': { 'all': 'SELECT * FROM pg_stat_user_tables;' },
    'counters': [ {
	'attr': 'analyze_count',
	'help': 'manual anaylze operations'
    }, {
	'attr': 'autoanalyze_count',
	'help': 'autoanalyze operations'
    }, {
	'attr': 'autovacuum_count',
	'help': 'autovacuum operations'
    }, {
	'attr': 'idx_scan',
	'help': 'index scans'
    }, {
	'attr': 'idx_tup_fetch',
	'help': 'index tuples fetched'
    }, {
	'attr': 'n_tup_del',
	'help': 'tuples deleted'
    }, {
	'attr': 'n_tup_hot_upd',
	'help': 'tuples updated (hot)'
    }, {
	'attr': 'n_tup_ins',
	'help': 'tuples inserted'
    }, {
	'attr': 'n_tup_upd',
	'help': 'tuples updated'
    }, {
	'attr': 'seq_scan',
	'help': 'sequential table scans'
    }, {
	'attr': 'seq_tup_read',
	'help': 'sequential tuples read'
    }, {
	'attr': 'vacuum_count',
	'help': 'manual vacuum operations'
    } ],
    'gauges': [ {
	'attr': 'n_live_tup',
	'help': 'estimated live tuples'
    }, {
	'attr': 'n_dead_tup',
	'help': 'estimated dead tuples'
    } ]
}, {
    'name': 'pg_statio_user_tables',
    'statkey': 'relid',
    'metadata': [ 'schemaname', 'relname' ],
    'versionToSql': { 'all': 'SELECT * FROM pg_statio_user_tables;' },
    'counters': [ {
	'attr': 'heap_blks_read',
	'help': 'number of disk blocks read from this table'
    }, {
	'attr': 'heap_blks_hit',
	'help': 'number of buffer hits in this table'
    }, {
	'attr': 'idx_blks_read',
	'help': 'number of disk blocks read from all indexes on this table'
    }, {
	'attr': 'idx_blks_hit',
	'help': 'number of disk blocks hit in all indexes on this table'
    } ]
}, {
    'name': 'pg_statio_user_indexes',
    'statkey': 'indexrelid',
    'metadata': [ 'indexrelname', 'schemaname', 'relname' ],
    'versionToSql': { 'all': 'SELECT * FROM pg_statio_user_indexes;' },
    'counters': [ {
	'attr': 'idx_blks_read',
	'help': 'number of disk blocks read from this index'
    }, {
	'attr': 'idx_blks_hit',
	'help': 'number of buffer hits in this index'
    } ]
}, {
    'name': 'pg_stat_replication',
    'statkey': 'application_name',
    'metadata': [ 'sync_state' ],
    'versionToSql': {
	'90400': [
	    'SELECT ',
	    'sync_state, ',
	    'sent_location - CAST (\'0/0\' AS pg_lsn) AS wal_sent, ',
	    'write_location - CAST (\'0/0\' AS pg_lsn) ',
	    'AS replica_wal_written, ',
	    'flush_location - CAST (\'0/0\' AS pg_lsn) ',
	    'AS replica_wal_flushed, ',
	    'replay_location - CAST (\'0/0\' AS pg_lsn) AS ',
	    'replica_wal_replayed ',
	    'FROM get_stat_replication();' ].join('\n'),
	'100000': [
	    'SELECT ',
	    'sync_state, ',
	    'sent_lsn - CAST (\'0/0\' AS pg_lsn) AS wal_sent, ',
	    'write_lsn - CAST (\'0/0\' AS pg_lsn) ',
	    'AS replica_wal_written, ',
	    'flush_lsn - CAST (\'0/0\' AS pg_lsn) ',
	    'AS replica_wal_flushed, ',
	    'replay_lsn - CAST (\'0/0\' AS pg_lsn) AS ',
	    'replica_wal_replayed ',
	    'FROM get_stat_replication();' ].join('\n')
    },
    'counters': [ {
	'attr': 'wal_sent',
	'help': 'wal bytes sent to replica', 'unit': 'bytes'
    }, {
	'attr': 'replica_wal_written',
	'help': 'wal bytes written by replica', 'unit': 'bytes'
    }, {
	'attr': 'replica_wal_flushed',
	'help': 'wal bytes flushed by replica', 'unit': 'bytes'
    }, {
	'attr': 'replica_wal_replayed',
	'help': 'wal bytes replayed into database by replica',
	'unit': 'bytes'
    } ]
}, {
    'name': 'pg_recovery',
    'statkey': 'recovery',
    'metadata': [],
    'versionToSql': {
	'90400': [
	    'SELECT \'recovery\' as recovery, ',
	    'pg_last_xlog_replay_location() - CAST (\'0/0\' AS pg_lsn) ',
	    '		AS wal_replayed_bytes, ',
	    '',
	    'CASE pg_is_in_recovery() WHEN \'t\' ',
	    'THEN (SELECT pg_last_xlog_receive_location() - ',
	    '		CAST (\'0/0\' AS pg_lsn))',
	    'ELSE (NULL) END AS wal_received_bytes, ',
	    '',
	    'CASE pg_is_in_recovery() WHEN \'t\' ',
	    'THEN (NULL) ',
	    'ELSE (SELECT pg_current_xlog_flush_location() - ',
	    '		CAST (\'0/0\' AS pg_lsn)) END ',
	    '              AS wal_flushed_bytes, ',
	    '',
	    'CASE pg_is_in_recovery() WHEN \'t\' ',
	    'THEN (NULL) ',
	    'ELSE (SELECT pg_current_xlog_insert_location() - ',
	    '		CAST (\'0/0\' AS pg_lsn)) END ',
	    '              AS wal_inserted_bytes;' ].join('\n'),
	'100000': [
	    'SELECT \'recovery\' as recovery, ',
	    'pg_last_wal_replay_lsn() - CAST (\'0/0\' AS pg_lsn) ',
	    '		AS wal_replayed_bytes, ',
	    '',
	    'CASE pg_is_in_recovery() WHEN \'t\' ',
	    'THEN (SELECT pg_last_wal_receive_lsn() - ',
	    '		CAST (\'0/0\' AS pg_lsn))',
	    'ELSE (NULL) END AS wal_received_bytes, ',
	    '',
	    'CASE pg_is_in_recovery() WHEN \'t\' ',
	    'THEN (NULL) ',
	    'ELSE (SELECT pg_current_wal_flush_lsn() - ',
	    '		CAST (\'0/0\' AS pg_lsn)) END ',
	    '              AS wal_flushed_bytes, ',
	    '',
	    'CASE pg_is_in_recovery() WHEN \'t\' ',
	    'THEN (NULL) ',
	    'ELSE (SELECT pg_current_wal_insert_lsn() - ',
	    '		CAST (\'0/0\' AS pg_lsn)) END ',
	    '              AS wal_inserted_bytes;' ].join('\n')
    },
    'counters': [ {
	'attr': 'wal_inserted_bytes',
	'help': 'WAL bytes inserted'
    }, {
	'attr': 'wal_replayed_bytes',
	'help': 'WAL bytes replayed into DB'
    }, {
	'attr': 'wal_received_bytes',
	'help': 'WAL bytes received from upstream server'
    }, {
	'attr': 'wal_flushed_bytes',
	'help': 'WAL bytes flushed to disk'
    } ]
}, {
    'name': 'pg_stat_activity',
    'statkey': 'datname',
    'metadata': [ 'datname', 'state' ],
    'versionToSql': { 'all': [
	'SELECT ',
	'pg_database.datname, states.state, ',
	'COALESCE(connections, 0) as connections ',
	'FROM ( ',
	'		VALUES ',
	'		(\'active\'), ',
	'		(\'idle\'), ',
	'		(\'idle in transaction\'), ',
	'		(\'idle in transaction (aborted)\'), ',
	'		(\'fastpath function call\'), ',
	'		(\'disabled\') ',
	') AS states(state) CROSS JOIN pg_database ',
	'LEFT JOIN ( ',
	'		SELECT ',
	'		datname, state, count(*) AS connections ',
	'		FROM get_stat_activity() ',
	'               GROUP BY datname,state) AS active ',
	'ON states.state = active.state ',
	'AND pg_database.datname = active.datname ',
	'WHERE pg_database.datname NOT LIKE \'template%\';' ].join('\n') },
    'gauges': [ {
	'attr': 'connections',
	'help': 'worker process state'
    } ]
}, {
    'name': 'pg_stat_database',
    'statkey': 'datname',
    'metadata': [ 'datname' ],
    'versionToSql': { 'all': [
	'SELECT * ',
	'FROM pg_stat_database ',
	'WHERE datname NOT LIKE \'postgres\' AND ',
	'datname NOT LIKE \'template%\';' ].join('\n') },
    'gauges': [ {
	'attr': 'numbackends',
	'help': 'number of connections'
    } ],
    'counters': [ {
	'attr': 'tup_returned',
	'help': 'tuples returned'
    }, {
	'attr': 'tup_fetched',
	'help': 'tuples fetched'
    }, {
	'attr': 'tup_inserted',
	'help': 'tuples inserted'
    }, {
	'attr': 'tup_updated',
	'help': 'tuples updated'
    }, {
	'attr': 'tup_deleted',
	'help': 'tuples deleted'
    }, {
	'attr': 'blks_read',
	'help': 'blocks read from disk'
    }, {
	'attr': 'blks_hit',
	'help': 'blocks read from buffercache'
    }, {
	'attr': 'xact_commit',
	'help': 'transactions committed'
    }, {
	'attr': 'xact_rollback',
	'help': 'transactions rolled back'
    }, {
	'attr': 'blk_read_time',
	'help': 'time spent reading blocks',
	'unit': 'ms'
    }, {
	'attr': 'blk_write_time',
	'help': 'time spent writing blocks',
	'unit': 'ms'
    } ]
}, {
    'name': 'pg_relation_size',
    'statkey': 'relfilenode',
    'metadata': [ 'schemaname', 'relname' ],
    'versionToSql': { 'all': [
	'SELECT relname, ',
	'		n.nspname AS schemaname,',
	'		c.reltuples AS row_estimate,',
	'		pg_total_relation_size(c.oid) AS total_bytes,',
	'		pg_indexes_size(c.oid) AS index_bytes,',
	'		pg_total_relation_size(reltoastrelid) AS',
	'               toast_bytes ',
	'FROM pg_class c ',
	'LEFT JOIN pg_namespace n ON n.oid = c.relnamespace ',
	'WHERE relkind = \'r\' ',
	'AND (n.nspname LIKE \'public\' ',
	'    OR n.nspname LIKE \'manta%\');' ].join('\n') },
    'gauges': [ {
	'attr': 'row_estimate',
	'help': 'estimated number of tuples'
    }, {
	'attr': 'total_bytes',
	'help': 'total bytes used'
    }, {
	'attr': 'index_bytes',
	'help': 'bytes used by indexes'
    }, {
	'attr': 'toast_bytes',
	'help': 'bytes used by toast files'
    } ]
}, {
    'name': 'pg_stat_bgwriter',
    'statkey': 'bgwriter',
    'metadata': [],
    'versionToSql': { 'all': 'SELECT * FROM pg_stat_bgwriter;' },
    'counters': [ {
	'attr': 'checkpoints_timed',
	'help': 'scheduled checkpoints'
    }, {
	'attr': 'checkpoints_req',
	'help': 'requested checkpoints'
    }, {
	'attr': 'checkpoint_write_time',
	'help': 'time spent writing checkpoints to disk',
	'unit': 'ms'
    }, {
	'attr': 'checkpoint_sync_time',
	'help': 'time spent synchronizing checkpoints to disk',
	'unit': 'ms'
    }, {
	'attr': 'buffers_checkpoint',
	'help': 'buffers written during checkpoints'
    }, {
	'attr': 'buffers_clean',
	'help': 'buffers written by bgwriter'
    }, {
	'attr': 'maxwritten_clean',
	'help': 'number of times bgwriter stopped a cleaning scan because ' +
	    'too many buffers were written'
    }, {
	'attr': 'buffers_backend',
	'help': 'buffers written by a backend'
    }, {
	'attr': 'buffers_backend_fsync',
	'help': 'number of fsync calls by backends'
    }, {
	'attr': 'buffers_alloc',
	'help': 'number of buffers allocated'
    } ]
}, {
    'name': 'pg_vacuum',
    'statkey': 'relfileid',
    'metadata': [ 'schemaname', 'relname' ],
    'versionToSql': { 'all': [
	// relowner 10 is hard-coded to be the 'postgres' superuser
	'SELECT ',
	'	relname, age(relfrozenxid) AS xid_age, ',
	'	(SELECT ',
	'	    setting::int FROM pg_settings ',
	'	    WHERE',
	'	    name = \'autovacuum_freeze_max_age\') - ',
	'	    age(relfrozenxid) AS tx_until_wraparound_autovacuum, ',
	'	n.nspname AS schemaname ',
	'FROM pg_class c ',
	'LEFT JOIN pg_namespace n on n.oid = c.relnamespace ',
	'WHERE relowner != 10 AND relkind = \'r\';' ].join('\n')
    },
    'gauges': [ {
	'attr': 'xid_age',
	'help': 'transactions since last wraparound autovacuum'
    }, {
	'attr': 'tx_until_wraparound_autovacuum',
	'help': 'transactions until the next wraparound autovacuum'
    } ]
}, {
    'name': 'pg_stat_progress_vacuum',
    'statkey': 'relname',
    'metadata': [ 'schemaname', 'relname', 'vacuum_mode' ],
    'versionToSql': {
	'90600': 'SELECT * FROM get_stat_progress_vacuum();'
    },
    'gauges': [ {
	'attr': 'phase',
	'help': 'current processing phase of vacuum',
	'expires': true
    }, {
	'attr': 'query_start',
	'help': 'unix epoch timestamp of the vacuum began',
	'expires': true
    }, {
	'attr': 'heap_blks_total',
	'help': 'total number of heap blocks in the table as of the ' +
	    'beginning of the scan',
	'expires': true
    }, {
	'attr': 'heap_blks_scanned',
	'help': 'number of heap blocks scanned',
	'expires': true
    }, {
	'attr': 'heap_blks_vacuumed',
	'help': 'number of heap blocks vacuumed',
	'expires': true
    }, {
	'attr': 'index_vacuum_count',
	'help': 'number of completed index vacuum cycles',
	'expires': true
    }, {
	'attr': 'max_dead_tuples',
	'help': 'number of dead tuples that we can store before needing ' +
	    'to perform an index vacuum cycle',
	'expires': true
    }, {
	'attr': 'num_dead_tuples',
	'help': 'number of dead tuples collected since the last index ' +
	    'vacuum cycle',
	'expires': true
    } ]
} ];

function Query(args, sql) {
	this.q_name = args.name;
	this.q_statkey = args.statkey || null;
	this.q_gauges = (args.gauges || []).slice(0);
	this.q_counters = (args.counters || []).slice(0);
	this.q_metadata = (args.metadata || []).slice(0);

	this.q_sql = sql;
}

function getQueries(args) {
	mod_assertplus.object(args, 'args');
	mod_assertplus.number(args.interval, 'args.interval');
	mod_assertplus.number(args.pg_version, 'args.pg_version');
	mod_assertplus.object(args.log, 'args.log');

	var validator = mod_ajv({ 'allErrors': true });

	var log = args.log.child({ 'component': 'getQueries' });

	if (!validator.validate(QUERY_SCHEMA, QUERIES)) {
		log.fatal({
		    'errors': validator.errors
		}, 'query validation errors');
	}
	mod_assertplus.ok(!validator.errors, 'Query validation has failed');

	var applicableQueries = [];

	QUERIES.forEach(function (query) {
		if (query.hasOwnProperty('gauges')) {
			query.gauges.forEach(function (gauge) {
				/*
				 * The expiry period is the configured postgres
				 * query interval plus 30 seconds. This allows
				 * expired metrics to be quickly detected while
				 * avoiding false detections of expired metrics
				 * regardless of the value of the query
				 * interval.
				 */
				if (gauge.expires) {
					gauge.expiryPeriod =
					    args.interval + 30000;
				}
			});
		}

		/*
		 * It's possible for a query to not be applicable to the
		 * provided version of postgres, so we want to be sure that
		 * we're only passing back queries that we know will run
		 * against the provided version.
		 */
		var applicableSql = null;
		mod_jsprim.forEachKey(query.versionToSql,
		    function (min_pg_version, sql) {
			if (min_pg_version === 'all') {
				applicableSql = sql;
				return;
			}

			var min_pg_version_num =
			    mod_jsprim.parseInteger(min_pg_version);

			/*
			 * The query schema has already validated that our keys
			 * are strings of numbers by this point, but we make
			 * this assertion in case values that fit the schema get
			 * here but jsprim doesn't like them.
			 */
			mod_assertplus.ok(
			    !(min_pg_version_num instanceof Error),
			    min_pg_version_num);

			if (args.pg_version >= min_pg_version_num) {
				applicableSql = sql;
			}
		});
		if (applicableSql !== null) {
			mod_assertplus.string(applicableSql);
			applicableQueries.push(new Query(
			    query, applicableSql));
		} else {
			log.debug({
			    'query_name': query.name,
			    'pg_version': args.pg_version,
			    'supported_versions':
				Object.keys(query.versionToSql)
			}, 'ignoring inapplicable query');
		}
	});

	mod_assertplus.ok(applicableQueries.length > 0,
	    'found no applicable queries');

	return (applicableQueries);
}

module.exports.getQueries = getQueries;

/*
 * The schema is exported just for the purpose of the test suite.
 */
module.exports._schema = QUERY_SCHEMA;
