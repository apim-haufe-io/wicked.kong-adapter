'use strict';

import * as wicked from 'wicked-sdk';
import { WickedError } from 'wicked-sdk';

const async = require('async');
const { debug, info, warn, error } = require('portal-env').Logger('kong-adapter:monitor');

import * as utils from './utils';

export const kongMonitor = {
    init: function (callback) {
        debug('init()');

        utils.setKongUrl(wicked.getInternalKongAdminUrl());

        pingKong(function (err) {
            if (err)
                return callback(err);
            // Set up Kong Monitor every ten seconds (retrieve version and cluster status)
            setInterval(pingKong, 10000);

            // OK, we're fine!
            callback(null);
        });
    },
};

function checkKongVersion(callback) {
    utils.kongGet('/', function (err, body) {
        if (err)
            return callback(err);
        if (!body.version) {
            const err = new WickedError('Did not get expected "version" property from Kong.', 500, body);
            return callback(err);
        }
        const expectedVersion = utils.getExpectedKongVersion();
        if (expectedVersion !== body.version) {
            const err = new WickedError('Unexpected Kong version. Got "' + body.version + '", expected "' + expectedVersion + '"', 500, body);
            return callback(err);
        }
        return callback(null, body.version);
    });
};

function checkKongCluster(callback) {
    utils.kongGet('status', function (err, body) {
        if (err)
            return callback(err);
        if (!body.database) {
            const err = new WickedError('Kong answer from /status did not contain "database" property.', 500, body);
            return callback(err);
        }
        return callback(null, body);
    });
};

function pingKong(callback) {
    debug('pingKong()');

    async.series([
        callback => checkKongVersion(callback),
        callback => checkKongCluster(callback)
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
