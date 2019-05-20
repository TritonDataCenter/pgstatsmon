/*
 * test/validate_queries.tst.js
 *
 * Tests to ensure the query schema defined in lib/queries.js validates the type
 * of query structure that's documented.
 *
 * This test suite only confirms that the expected number of errors are returned
 * from attempted validation, not that the errors themselves are of the correct
 * type.
 */

var mod_assertplus = require('assert-plus');
var mod_ajv = require('ajv');

var lib_queries = require('../lib/queries');

var tests = [ {
    'queries': [ {} ],
    'expected': {
	'nerrors': 3
    }
}, {
    'queries': {},
    'expected': {
	'nerrors': 1
    }
}, {
    'queries': 'select 1;',
    'expected': {
	'nerrors': 1
    }
}, {
    'queries': [ {
	'name': 'test_query',
	'versionToSql': { 'all': 'select 1;' },
	'statkey': 'testing'
    } ],
    'expected': {
	'nerrors': 0
    }
}, {
    'queries': [ {
	'name': 'test_query',
	'versionToSql': { 'not_a_valid_key': 'select 1;' },
	'statkey': 'testing'
    } ],
    'expected': {
	'nerrors': 5
    }
}, {
    'queries': [ {
	'name': 'test_query',
	'statkey': 'testing',
	'versionToSql': { '123': 'select 123;' }
    } ],
    'expected': {
	'nerrors': 0
    }
}, {
    'queries': [ {
	'name': 'test_query',
	'versionToSql': {
	    '900': 'select 900;',
	    '1000': 'select 1000;'
	},
	'statkey': 'testing'
    } ],
    'expected': {
	'nerrors': 0
    }
}, {
    'queries': [ {
	'name': 'test_query',
	'versionToSql': {
	    'all': 'select 1;',
	    'all': 'select 1;'
	},
	'statkey': 'testing'
    } ],
    'expected': {
	'nerrors': 0
    }
}, {
    'queries': [ {
	'name': 'test_query',
	'versionToSql': {
	    'all': 'select 1;',
	    '123': 'select 1;'
	},
	'statkey': 'testing'
    } ],
    'expected': {
	'nerrors': 6
    }
}, {
    'queries': [ {
	'name': 'test_query',
	'versionToSql': {
	    '5786327846932794236475326596927': 'select 1;'
	},
	'statkey': 'testing'
    } ],
    'expected': {
	'nerrors': 0
    }
} ];

tests.forEach(function (t) {
	var validator = mod_ajv({ 'allErrors': true });
	validator.validate(lib_queries._schema, t.queries);

	mod_assertplus.equal((validator.errors || []).length, t.expected.nerrors);
});

console.log(new Date());
