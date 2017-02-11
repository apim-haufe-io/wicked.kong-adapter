'use strict';

const wicked = require('wicked-sdk');
const async = require('async');
const debug = require('debug')('kong-adapter:monitor');

const utils = require('./utils');

const monitor = function() {};

monitor.init = function (app, callback) {
    debug('init()');

    app.set('kong_url', wicked.getInternalKongAdminUrl());

    pingKong(app, function (err) {
        if (err)
            return callback(err);
        // Set up Kong Monitor every ten seconds (retrieve version and cluster status)
        setInterval(pingKong, 10000, app);

        // OK, we're fine!
        callback(null);
    });
};

const checkKongVersion = function (app, callback) {
    utils.kongGet(app, '/', function (err, body) {
        if (err)
            return callback(err);
        if (!body.version) {
            const err = new Error('Did not get expected "version" property from Kong.');
            err.status = 500;
            return callback(err);
        }
        const expectedVersion = utils.getExpectedKongVersion();
        if (expectedVersion !== body.version) {
            const err = new Error('Unexpected Kong version. Got "' + body.version + '", expected "' + expectedVersion + '"');
            err.status = 500;
            return callback(err);
        }
        return callback(null, body.version);
    });
};

const checkKongCluster = function (app, callback) {
    utils.kongGet(app, 'cluster', function (err, body) {
        if (err)
            return callback(err);
        if (!body.total) {
            const err = new Error('Kong answer from /cluster did not contain "total" property.');
            err.status = 500;
            return callback(err);
        }
        return callback(null, body);
    });
};

const pingKong = function (app, callback) {
    debug('pingKong()');

    async.series([
        callback => checkKongVersion(app, callback),
        callback => checkKongCluster(app, callback)
    ], function (err, results) {
        if (err) {
            console.error('*** KONG does not behave!');
            console.error(err);
            utils.markKongAvailable(false, err.message, null);
            setTimeout(forceExit, 2000);
            if (callback)
                return callback(err);
            return;
        }
        utils.markKongAvailable(true, null, results[1]);
        if (callback)
            return callback(null);
    });
};

function forceExit() {
    console.log('Exiting component due to misbehaving Kong (see log).');
    process.exit(0);
}

module.exports = monitor;
