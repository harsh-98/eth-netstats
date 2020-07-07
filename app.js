var _ = require('lodash');
var logger = require('./lib/utils/logger');
var chalk = require('chalk');
var http = require('http');

// Init WS SECRET
var WS_SECRET;

if( !_.isUndefined(process.env.WS_SECRET) && !_.isNull(process.env.WS_SECRET) )
{
	if( process.env.WS_SECRET.indexOf('|') > 0 )
	{
		WS_SECRET = process.env.WS_SECRET.split('|');
	}
	else
	{
		WS_SECRET = [process.env.WS_SECRET];
	}
}
else
{
	try {
		var tmp_secret_json = require('./ws_secret.json');
		WS_SECRET = _.values(tmp_secret_json);
	}
	catch (e)
	{
		console.error("WS_SECRET NOT SET!!!");
	}
}

var banned = require('./lib/utils/config').banned;

// Init http server
if( process.env.NODE_ENV !== 'production' )
{
	var app = require('./lib/express');
	server = http.createServer(app);
}
else
	server = http.createServer();

// Init socket vars
var Primus = require('primus');
var api;
var client;
var server;


// Init API Socket connection
api = require('socket.io')(server).of('/api');


// Init Client Socket connection
client = new Primus(server, {
	transformer: 'websockets',
	pathname: '/primus',
	parser: 'JSON'
});

client.plugin('emit', require('primus-emit'));


// Init external API
external = new Primus(server, {
	transformer: 'websockets',
	pathname: '/external',
	parser: 'JSON'
});

external.plugin('emit', require('primus-emit'));

// Init collections
var Collection = require('./lib/collection');
var Nodes = new Collection(external);

Nodes.setChartsCallback(function (err, charts)
{
	if(err !== null)
	{
		console.error('COL', 'CHR', 'Charts error:', err);
	}
	else
	{
		client.write({
			action: 'charts',
			data: charts
		});
	}
});

function getLatencyMs(socket) {
	return (
		socket.handshake.issued -
		parseFloat(socket.handshake.query.t) * 1000
	);
}
// Init API Socket events
api.on('connection', function (socket)
{
	socket.on('hello', function (data)
	{
		console.info('API', 'CON', 'Hello', data['id']);
		let url = socket.handshake.headers.host.split(':');
		ip = url[0];
		port = url[1];
		if( _.isUndefined(data.secret) || WS_SECRET.indexOf(data.secret) === -1 || banned.indexOf(socket.handshake.headers.host) >= 0 )
		{
			socket.end(undefined, { reconnect: false });
			console.error('API', 'CON', 'Closed - wrong auth', data);

			return false;
		}

		if( !_.isUndefined(data.id) && !_.isUndefined(data.info) )
		{
			data.ip = url.join(":");
			data.spark = socket.id;
			data.latency = getLatencyMs(socket) || 0;

			Nodes.add( data, function (err, info)
			{
				if(err !== null)
				{
					console.error('API', 'CON', 'Connection error:', err);
					return false;
				}

				if(info !== null)
				{
					socket.emit('ready');

					console.success('API', 'CON', 'Connected', data.id);

					client.write({
						action: 'add',
						data: info
					});
				}
			});
		}
	});

	// TODO UPDATE
	socket.on('update', function (data)
	{
		if( !_.isUndefined(data.id) && !_.isUndefined(data.stats) )
		{
			Nodes.update(data.id, data.stats, function (err, stats)
			{
				if(err !== null)
				{
					console.error('API', 'UPD', 'Update error:', err);
				}
				else
				{
					if(stats !== null)
					{
						client.write({
							action: 'update',
							data: stats
						});

						console.info('API', 'UPD', 'Update from:', data.id, 'for:', stats);

						Nodes.getCharts();
					}
				}
			});
		}
		else
		{
			console.error('API', 'UPD', 'Update error:', data);
		}
	});


	socket.on('block', function (data)
	{
		if( !_.isUndefined(data.id) && !_.isUndefined(data.block) )
		{
			Nodes.addBlock(data.id, data.block, function (err, stats)
			{
				if(err !== null)
				{
					console.error('API', 'BLK', 'Block error:', err);
				}
				else
				{
					if(stats !== null)
					{
						client.write({
							action: 'block',
							data: stats
						});

						console.success('API', 'BLK', 'Block:', data.block['number'], 'from:', data.id);

						Nodes.getCharts();
					}
				}
			});
		}
		else
		{
			console.error('API', 'BLK', 'Block error:', data);
		}
	});


	socket.on('pending', function (data)
	{
		if( !_.isUndefined(data.id) && !_.isUndefined(data.stats) )
		{
			Nodes.updatePending(data.id, data.stats, function (err, stats) {
				if(err !== null)
				{
					console.error('API', 'TXS', 'Pending error:', err);
				}

				if(stats !== null)
				{
					client.write({
						action: 'pending',
						data: stats
					});

					console.success('API', 'TXS', `Pending VTT: ${stats.pendingVTT} RAD: ${stats.pendingRAD}`, 'from:', data.id);
				}
			});
		}
		else
		{
			console.error('API', 'TXS', 'Pending error:', data);
		}
	});

	socket.on('activePkh', function (data)
	{
		if( !_.isUndefined(data.id) && !_.isUndefined(data.count) )
		{
			Nodes.updateActivePkh(data, function (count) {
				if(count == null)
				{
					console.error('API', 'PKH', data.id, "failed");
				}

				if(count !== null)
				{
					client.write({
						action: 'activePkh',
						data: {
							activePkh: count
						}
					});

					console.success('API', 'PKH', `Active pkh count update to ${count}`, data.id);
				}
			});
		}
		else
		{
			console.error('API', 'PKH', 'ActivePkh error:', data);
		}
	});

	socket.on('superBlock', function (data)
	{
		if( !_.isUndefined(data.id) && !_.isUndefined(data.super) )
		{
			Nodes.updateSuperBlock(data, function (sblk_details) {
				if(sblk_details == null)
				{
					console.error('API', 'SUP', data.id, "failed");
				}

				if(sblk_details !== null)
				{
					client.write({
						action: 'superBlock',
						data: sblk_details,
					});

					console.success('API', 'SUP', `super block index updated to ${sblk_details.index}[${sblk_details.hash}]`, data.id);
				}
			});
		}
		else
		{
			console.error('API', 'SUP', 'super block error:', data);
		}
	});


	socket.on('stats', function (data)
	{
		if( !_.isUndefined(data.id) && !_.isUndefined(data.stats) )
		{

			Nodes.updateStats(data.id, data.stats, function (err, stats)
			{
				if(err !== null)
				{
					console.error('API', 'STA', 'Stats error:', err);
				}
				else
				{
					if(stats !== null)
					{
						client.write({
							action: 'stats',
							data: stats
						});

						console.success('API', 'STA', 'Stats from:', data.id);
					}
				}
			});
		}
		else
		{
			console.error('API', 'STA', 'Stats error:', data);
		}
	});


	socket.on('history', function (data)
	{
		console.success('API', 'HIS', 'Got history from:', data.id);

		var time = chalk.reset.cyan((new Date()).toJSON()) + " ";
		console.time(time, 'COL', 'CHR', 'Got charts in');

		Nodes.addHistory(data.id, data.history, function (err, history)
		{
			console.timeEnd(time, 'COL', 'CHR', 'Got charts in');

			if(err !== null)
			{
				console.error('COL', 'CHR', 'History error:', err);
			}
			else
			{
				client.write({
					action: 'charts',
					data: history
				});
			}
		});
	});


	socket.on('node-ping', function (data)
	{
		var start = (!_.isUndefined(data) && !_.isUndefined(data.clientTime) ? data.clientTime : null);

		socket.emit('node-pong', {
			clientTime: start,
			serverTime: _.now()
		});

		console.info('API', 'PIN', 'Ping from:', data['id']);
	});


	socket.on('latency', function (data)
	{
		if( !_.isUndefined(data.id) )
		{
			Nodes.updateLatency(data.id, data.latency, function (err, latency)
			{
				if(err !== null)
				{
					console.error('API', 'PIN', 'Latency error:', err);
				}

				if(latency !== null)
				{
					// client.write({
					// 	action: 'latency',
					// 	data: latency
					// });

					console.info('API', 'PIN', 'Latency:', latency, 'from:', data.id);
				}
			});

			if( Nodes.requiresUpdate(data.id) )
			{
				var range = Nodes.getHistory().getHistoryRequestRange();

				socket.emit('history', range);
				console.info('API', 'HIS', 'Asked:', data.id, 'for history:', range.min, '-', range.max);

				Nodes.askedForHistory(true);
			}
		}
	});


	socket.on('end', function (data)
	{
		Nodes.inactive(socket.id, function (err, stats)
		{
			if(err !== null)
			{
				console.error('API', 'CON', 'Connection end error:', err);
			}
			else
			{
				client.write({
					action: 'inactive',
					data: stats
				});

				console.warn('API', 'CON', 'Connection with:', socket.id, 'ended:', data);
			}
		});
	});
});


client.on('disconnection', function(spark){
	console.error('CLI', 'CON', `Connection end error from ${spark.address.ip}:${spark.address.port}`);
});

client.on('connection', function (clientSpark)
{
	console.success('CLI', 'CON', `connected to ${clientSpark.address.ip}:${clientSpark.address.port}`);
	clientSpark.on('ready', function (data)
	{
		clientSpark.emit('init', Nodes.all());

		Nodes.getCharts();
	});

	clientSpark.on('client-pong', function (data)
	{
		var serverTime = _.get(data, "serverTime", 0);
		var latency = Math.ceil( (_.now() - serverTime) / 2 );

		clientSpark.emit('client-latency', { latency: latency });
	});
});

var latencyTimeout = setInterval( function ()
{
	client.write({
		action: 'client-ping',
		data: {
			serverTime: _.now()
		}
	});
}, 5000);


// Cleanup old inactive nodes
var nodeCleanupTimeout = setInterval( function ()
{
	client.write({
		action: 'init',
		data: Nodes.all()
	});

	Nodes.getCharts();

}, 1000*60*60);

server.listen(process.env.PORT || 3000);

module.exports = server;
