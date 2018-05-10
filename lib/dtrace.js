/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * dtrace.js: DTrace probe definitions.
 */

var mod_dtrace_provider = require('dtrace-provider');

var PROBES = {
	/* Postgres client probes */
	/* sql, backend name */
	'query-start': ['char *', 'char *'],

	/* sql, row, backend name */
	'query-row': ['char *', 'json', 'char *'],

	/* sql, error message, backend name */
	'query-error': ['char *', 'char *', 'char *'],

	/* sql, backend name */
	'query-timeout': ['char *', 'char *'],

	/* sql, end data, backend name */
	'query-done': ['char *', 'json', 'char *'],

	/* pgstatsmon probes */
	/* no arguments */
	'tick-start': [],

	/* no arguments */
	'tick-done': [],

	/* backend name */
	'backend-start': ['char *'],

	/* backend name */
	'backend-done': ['char *'],

	/* backend name, query name */
	'backend-query-start': ['char *', 'char *'],

	/* backend name, query name */
	'backend-query-done': ['char *', 'char *']

};
var PROVIDER;

module.exports = function exportStaticProvider() {
	if (!PROVIDER) {
		PROVIDER = mod_dtrace_provider.createDTraceProvider(
		    'pgstatsmon');

		Object.keys(PROBES).forEach(function (p) {
			var args = PROBES[p].splice(0);
			args.unshift(p);

			PROVIDER.addProbe.apply(PROVIDER, args);
		});
		PROVIDER.enable();
	}
	return (PROVIDER);
}();
