/*jshint esversion: 8*/
/*jshint node: true*/
'use strict';

const cron = require('cron'),
	projects = require('./lib/projects');

// GLOBAL VARIABLES.
var CONFIG;
var logger;
var triskell, triskellPromise;


/**
 * Intialize the main application.
 * @returns a Promise.
 */
function initialize(config, app, jobs, libs) {
    const TRISKELL_ACCOUNT = config.TRISKELL.accounts.api;

    // Set global variables.
    CONFIG = config;
    logger = libs.logger;
    triskell = new libs.triskell.Connection(CONFIG.TRISKELL.tenant, CONFIG.TRISKELL.url, TRISKELL_ACCOUNT.user, TRISKELL_ACCOUNT.md5);
    triskellPromise = triskell.promisify();

    // Connect to Triskell.
    return triskellPromise.login().then(function() {
		return triskellPromise.initialize(CONFIG.TRISKELL);
	}).then(function() {
        // Initialize the libraries.
		libs.projects = projects.initialize(CONFIG, logger, libs, triskell);

        return {
            triskell: triskell
        };
	});
}

function start() {
    return new Promise(function (resolve, reject) {
        resolve();
    });
}

function stop() {
    return new Promise(function (resolve, reject) {
        resolve();
    });
}

module.exports = {
    initialize: initialize,
    start: start,
    stop: stop
};