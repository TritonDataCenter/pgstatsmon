/*
 * pgstatsmon: service that monitors Postgres stats tables and shovels data to
 * statsd.  See README.md for details.
 */

var mod_bunyan = require('bunyan');
var mod_fs = require('fs');
var pgstatsmon = require('../lib/pgstatsmon');

function main()
{
	var data, config, log;

	if (process.argv.length != 3) {
		console.error('usage: %s CONFIG_FILE',
		    process.argv[1]);
		process.exit(2);
	}

	try {
		data = mod_fs.readFileSync(process.argv[2]).toString('utf8');
	} catch (ex) {
		console.error('%s: failed to read file: %s',
		    process.argv[1], ex.message);
		process.exit(1);
	}

	try {
		config = JSON.parse(data);
	} catch (ex) {
		console.error('%s: failed to parse config: %s',
		    process.argv[1], ex.message);
		process.exit(1);
	}

	log = new mod_bunyan({
	    'name': 'pgstatsmon',
	    'level': process.env['LOG_LEVEL'] || 'info'
	});

	log.info('config', config);
	config['log'] = log;
	pgstatsmon(config);
}

main();
