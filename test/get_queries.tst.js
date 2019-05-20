var mod_assertplus = require('assert-plus');

var lib_queries = require('../lib/queries');

var tests = [ {
    'args': {
	'interval': 100,
	'pg_version': 90200
    },
    'expected': {
	'nqueries': 8
    }
}, {
    'args': {
	'interval': 100,
	'pg_version': 90500
    },
    'expected': {
	'nqueries': 10
    }
} ];


tests.forEach(function (t) {
	var q = lib_queries.getQueries(t.args);

	mod_assertplus.equal(q.length, t.expected.nqueries);
});

console.log(new Date());
