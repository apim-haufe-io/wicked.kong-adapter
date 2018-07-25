'use strict';

const express = require('express');
const logger = require('morgan');
const bodyParser = require('body-parser');
const { debug, info, warn, error } = require('portal-env').Logger('kong-adapter:app');

import * as wicked from 'wicked-sdk';
const correlationIdHandler = wicked.correlationIdHandler();

import { WickedError } from 'wicked-sdk';

import { kongMain } from './kong/main';
import * as utils from  './kong/utils';

const app = express();
app.initialized = false;
app.kongAvailable = false;
app.apiAvailable = false;
app.lastErr = null;

// Correlation ID
app.use(correlationIdHandler);

logger.token('correlation-id', function (req, res) {
    return req.correlationId;
});
app.use(logger('{"date":":date[iso]","method":":method","url":":url","remote-addr":":remote-addr","version":":http-version","status":":status","content-length":":res[content-length]","referrer":":referrer","response-time":":response-time","correlation-id":":correlation-id"}'));
// Make sure we get the body directly as JSON. Thanks.
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

app.post('/', function (req, res, next) {
    debug('/ (main processing loop)');
    if (!app.initialized)
        return res.status(503).json({ message: 'Not yet initialized.' });
    if (req.app.processingWebhooks) {
        debug('Still processing last webhook load.');
        console.error('Still processing.');
        return res.send('OK');
    }

    req.app.processingWebhooks = true;
    kongMain.processWebhooks(app, req.body, function (err) {
        req.app.processingWebhooks = false;
        if (err) {
            app.lastErr = err;
            console.error(err);
            console.error(err.stack);
            return res.status(500).json(err);
        }
        app.lastErr = null;
        return res.send('OK');
    });
});

app._startupSeconds = utils.getUtc();
app.get('/ping', function (req, res, next) {
    debug('/ping');
    const health: any = {
        name: 'kong-adapter',
        message: 'Up and running',
        uptime: (utils.getUtc() - app._startupSeconds),
        healthy: 1,
        pingUrl: app.get('my_url') + 'ping',
        version: utils.getVersion(),
        gitLastCommit: utils.getGitLastCommit(),
        gitBranch: utils.getGitBranch(),
        buildDate: utils.getBuildDate(),
        kongVersion: utils.getExpectedKongVersion(),
        kongStatus: JSON.stringify(utils.getKongClusterStatus())
    };
    if (!app.initialized) {
        let msg = 'Initializing - Waiting for API and Kong';
        if (app.apiAvailable && !app.kongAvailable)
            msg = 'Initializing - Waiting for Kong';
        else if (!app.apiAvailable && app.kongAvailable)
            msg = 'Initializing - Waiting for API'; // Shouldn't be possible
        health.healthy = 2;
        health.message = msg;
        res.status(503);
    } else if (app.lastErr) {
        health.healthy = 0;
        health.message = app.lastErr.message;
        health.error = JSON.stringify(app.lastErr, null, 2);
        res.status(500);
    }
    res.json(health);
});

/*
    End point to trigger a full resync of the Kong settings, similar
    as at initial startup of the component. This is used in conjunection
    with the integration tests to check whether a full resync triggers
    any actions on Kong (POST, PUT, DELETE), which should not be the case.

    Returns a list with counts of actions since this resync.

    Requires the env variable ALLOW_RESYNC to be set; if the variable is
    not set, a POST to this end point will just render a 404.
*/
if (process.env.ALLOW_RESYNC) {
    app.post('/resync', function (req, res, next) {
        debug('/resync');
        // Reset usage statistics and keep changing actions/non-matching objects
        utils.resetStatistics(true);
        kongMain.resync(req.app, function (err) {
            // Retrieve the list of statistics, we will definitely return these,
            // disregarding of the success of the action.
            const stats = utils.getStatistics();
            debug('Statistics for the /resync call:');
            debug(JSON.stringify(stats, null, 2));
            if (err) {
                console.error(err);
                stats.err = err;
                res.status(500);
            } else {
                res.status(200);
            }
            return res.send(stats);
        });
    });
}

/*
    End point used to kill the Kong Adapter process. This is used
    in conjunction with the integration tests in the wicked.portal-test
    project. For this endpoint to work, the ALLOW_KILL environment
    variable must be set to a non-null and non-empty value.

    In other cases, a POST to this end point will just render a 404
    answer, as the end point is not even registered.
*/
if (process.env.ALLOW_KILL) {
    app.post('/kill', function (req, res, next) {
        debug('/kill accepted. Shutting down.');
        res.status(204).json({});
        setTimeout(function() {
            process.exit(0);
        }, 1000);
    });
}

// catch 404 and forward to error handler
app.use(function (req, res, next) {
    const err = new WickedError('Not Found');
    err.status = 404;
    next(err);
});

// error handlers

// production error handler
// no stacktraces leaked to user
app.use(function (err, req, res, next) {
    res.status(err.status || 500);
    console.error(err);
    console.error(err.stack);
    res.jsonp({
        message: err.message,
        error: {}
    });
});

export default app;
