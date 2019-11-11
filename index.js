/*jshint esversion: 8*/
/*jshint node: true*/
'use strict';

// EXTERNAL MODULES.
const express = require('express'),
	bodyParser = require('body-parser'),
	cors = require('cors'),
	path = require('path'),
	errorhandler = require('errorhandler'),
	moment = require('moment'),
	cron = require('cron'),
	winston = require('winston'),
	WinstonMail = require('winston-mail').Mail;

// INTERNAL MODULES.
const code = require('./package'),
	pages = require('./routes/pages'),
	webhooks = require('./routes/webhooks'),
	TriskellAPI = require('@argentix/triskell_api'),
	main = require('./main');

// GLOBAL CONSTANTS
const BUILD_NUMBER = (code.com_soluster) ? code.com_soluster.build : undefined;
const app = express();

// LOAD THE CONFIGURATION.
var CONFIG = require('./config.json');

// Define the execution mode.
CONFIG.MODE_DEV = 'development' === app.get('env');		// Runs in development mode. No logs sent by mail.
CONFIG.MODE_BACKUP = 'backup' === app.get('env');		// Runs in backup mode (failover server). No scheduled tasks are executed.
CONFIG.MODE_PROD = 'production' === app.get('env');		// Run in production mode.
// Update some of the configuartion file values with the values of the environment variables.
if (process.env.LOG_LEVEL) { CONFIG.LOG_LEVEL = process.env.LOG_LEVEL; } else { CONFIG.LOG_LEVEL = CONFIG.LOG_LEVEL || 'info'; }
if (process.env.MAIL_CONFIG) {
	let config = process.env.MAIL_CONFIG.split('|');

	CONFIG.MAIL_CONFIG.level = config[0];
	CONFIG.MAIL_CONFIG.host = config[1];
	CONFIG.MAIL_CONFIG.username = config[2];
	CONFIG.MAIL_CONFIG.password = config[3];
}
if (process.env.MAIL_ADDRESSES) {
	let emails = process.env.MAIL_ADDRESSES.split('|');

	CONFIG.MAIL_CONFIG.from = emails[0];
	CONFIG.MAIL_CONFIG.sender = emails[1];
	CONFIG.MAIL_CONFIG.to = emails[2];
}
if (process.env.PORT) { CONFIG.PORT = parseInt(process.env.PORT); }
if (process.env.TRISKELL_URL) { CONFIG.TRISKELL.url = process.env.TRISKELL_URL; }
if (process.env.TENANT_ID) { CONFIG.TRISKELL.tenant = parseInt(process.env.TENANT_ID); }
if (process.env.TRISKELL_ACCOUNTS) {
	let accounts = {};

	for (const userData of process.env.TRISKELL_ACCOUNTS.split(',')) {
		let user = userData.split('|');

		accounts[user[0]] = { "user": user[1], "user_id": user[2], "md5": user[3] };
	}
	CONFIG.TRISKELL.accounts = accounts;
}
// Only process the project with corresponding name when using @see projectsProcessor.
if (process.env.ONLY_PROJECT) { CONFIG.ONLY_PROJECT = process.env.ONLY_PROJECT; }

// SETUP EVENT LOGGING.
const consoleTransport = new (winston.transports.Console)( {level: 'info', timestamp: true} );
const fileTransport = new (winston.transports.File)({ level: CONFIG.LOG_LEVEL, filename: path.join(__dirname, 'logs', 'system.log'), maxsize: 1*1048576, maxFiles: 10, tailable: true, json: false });
const mailTransport = new (WinstonMail)(Object.assign({level: 'warn'}, CONFIG.MAIL_CONFIG));
const exceptionsTransport = new winston.transports.File({ filename: path.join(__dirname, 'exceptions.log'), maxsize: 4*1048576, maxFiles: 1, tailable: true });
const transports = (CONFIG.MODE_DEV) ? [consoleTransport, fileTransport] : [consoleTransport, fileTransport, mailTransport];
const logger = new winston.Logger({ level: CONFIG.LOG_LEVEL, exitOnError: false, transports: transports });
if (!CONFIG.MODE_DEV) { logger.handleExceptions([exceptionsTransport, mailTransport]); }
logger.info(`${code.description} / version ${code.version} build ${BUILD_NUMBER} started in ${app.get('env')} mode.`);

// SETUP EXPRESS ENVIRONMENT.
app.set('port', CONFIG.PORT);
app.set('views', __dirname + '/views');
app.set('view engine', 'pug');
/*
app.use(express.logger('dev'));
app.use(express.methodOverride());
 */
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cors());
if (CONFIG.MODE_DEV) {
	app.use(errorhandler());
}

app.get('/...', function (req, res, next) { res.send(`Server is up since ${moment.duration(process.uptime(), 'seconds').humanize()}`).end(); });	// Server monitoring
app.get('/webhook/:object/:event', [webhooks.connect, webhooks.run]);
app.post('/webhook/:object/:event', [webhooks.connect, webhooks.run]);
app.get('/connections/:id/keep', [pages.keepConnection]);
app.get('/actions/:object/:id/:action', [pages.validateAction, pages.runAction]);
app.get('/:object', [pages.connect, pages.buildReport]);
app.get('/', function (req, res, next) { res.sendStatus(404).end(); });

// INITIALIZE LIBRARIES.
var libs = {
	logger: logger,
	triskell: new TriskellAPI(logger)
};
var jobs = {};
var triskell;

/*************************
 **** START EXECUTION ****
 *************************/
logger.info("Start initialization...");
main.initialize(CONFIG, app, jobs, libs).then(function (data) {
	triskell = data.triskell;
	return main.start();
}).then(function () {
	logger.info("Initialization completed");

	try {
		var job;

		// INITIALIZE LIBRARIES.
		pages.initialize(CONFIG, logger, libs, triskell);
		webhooks.initialize(CONFIG, logger, libs, triskell);

		// START THE SCHEDULED JOBS.
		if (CONFIG.MODE_DEV) {
			const inOneSecond = new cron.CronTime(new Date(Date.now() + 1000));
			// Schedule all the jobs to start in one second.
			Object.values(jobs).forEach(job => job.setTime(inOneSecond));
			if (process.env.TEST_JOBS) {
				for (const jobName of process.env.TEST_JOBS.split(',')) {
					if ((job = jobs[jobName]) === undefined) {
						logger.error("JOB %s DOESN'EXISTS!", jobName);
					} else {
						job.start();
						logger.info("JOB %s STARTED", jobName);
					}
				}
			}
		} else if (CONFIG.MODE_PROD) {
			logger.info("%d scheduled jobs started.", Object.values(jobs).reduce((count, job) => { job.start(); return count+1; }, 0));
		}

		// START EXPRESS BY LISTENING ON SPECIFIED PORT.
		app.listen(app.get('port'), function() {
			logger.info("Application listening on %s:%d", this.address().address, this.address().port);
		});

	} catch (e) {
		logger.info("JOBS STARTUP ERROR:", e);
		throw e;
	}
}).catch(function (error) {
	logger.error("APPLICATION STOPPED BECAUSE OF INITIALIZATION ERROR:", error);
	// Force exit in 10 seconds.
	setTimeout(process.exit, 10000, 0);
	main.stop().catch(function () {
		logger.error("ERROR STOPPING MAIN:", error);
	}).finally(function () {
		process.exit(0);
	});
});