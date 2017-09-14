'use strict';

var express = require('express');
var path = require('path');
var logger = require('morgan');
var bodyParser = require('body-parser');
var async = require('async');
var debug = require('debug')('kong-adapter:app');
var correlationIdHandler = require('wicked-sdk').correlationIdHandler();
var kongMain = require('./kong/main');
var oauth2 = require('./kong/oauth2');
var utils = require('./kong/utils');

var app = express();
app.initialized = false;
app.kongAvailable = false;
app.apiAvailable = false;
app.lastErr = null;

// Correlation ID
app.use(correlationIdHandler);

logger.token('correlation-id', function (req, res) {
    return req.correlationId;
});
app.use(logger('{"date":":date[clf]","method":":method","url":":url","remote-addr":":remote-addr","version":":http-version","status":":status","content-length":":res[content-length]","referrer":":referrer","response-time":":response-time","correlation-id":":correlation-id"}'));
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
    const health = {
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

/*
 End point for authorizing end users for use with the oauth2
 implicit grant. This requires a payload which looks like this:

 {
     "authenticated_userid":"your-user-id"
     "api_id":"some_api",
     "client_id":"ab7364bd9ef0992838dfab9384",
     "scope": ["scope1", "scope2"] // This is optional, depending on the API def.
 }

 If there is registered application for the given client_id,
 and there is a subscription for the given API for that application,
 the user is created, the OAuth2 app is registered with it, and
 an access token is returned in form of a redirect_uri with a
 fragment.
 */
app.post('/oauth2/token/implicit', function (req, res, next) {
    debug('/oauth2/token/implicit');
    oauth2.getImplicitToken(req.app, res, req.body);
});

/*
 End point for authorizing end users for use with the oauth2
 authorization code grant. This requires a payload which looks like this:

 {
     "authenticated_userid":"your-user-id"
     "api_id":"some_api",
     "client_id":"ab7364bd9ef0992838dfab9384",
     "scope": ["scope1", "scope2"] // This is optional, depending on the API def.
 }

 If there is registered application for the given client_id,
 and there is a subscription for the given API for that application,
 the user is created, the OAuth2 app is registered with it, and
 an authorization code is returned in form of a redirect_uri with a
 query parameter https://good.uri?code=62bdfa8e29f29dfe82
 */
app.post('/oauth2/token/code', function (req, res, next) {
    debug('/oauth2/token/code');
    oauth2.getAuthorizationCode(req.app, res, req.body);
});

/*
 End point for authorizing end users for use with the oauth2
 implicit grant. This requires a payload which looks like this:

 {
     "authenticated_userid":"your-user-id"
     "api_id":"some_api",
     "client_id":"ab7364bd9ef0992838dfab9384",
     "scope": ["scope1", "scope2"] // This is optional, depending on the API def.
 }

 If there is registered application for the given client_id,
 and there is a subscription for the given API for that application,
 the user is created, the OAuth2 app is registered with it, and
 an access token is returned in form of a JSON return object:

 {
     "access_token":"37498w7498weiru3487568376593485",
     "token_type":"bearer",
     "expires_in":3600,
     "refresh_token":"4938409238450938p59g49587gj4utgeiou6tioge56hoig76"
 }
 */
app.post('/oauth2/token/password', function (req, res, next) {
    debug('/oauth2/token/password');
    oauth2.getPasswordToken(req.app, res, req.body);
});

/*
 End point for refreshing an access token using a refresh token.
 This requires a payload which looks like this:

 {
     "refresh_token":"or798347598374593745ikrtk",
     "client_id":"ab7364bd9ef0992838dfab9384",
 }

 The Kong Adapter will check that the given client still has a 
 valid subscription to the API, and if successful, issue a new
 pair of access token and refresh token:

 {
     "access_token":"37498w7498weiru3487568376593485",
     "token_type":"bearer",
     "expires_in":3600,
     "refresh_token":"4938409238450938p59g49587gj4utgeiou6tioge56hoig76"
 }
*/
app.post('/oauth2/token/refresh', function (req, res, next) {
    debug('/oauth2/token/refresh');
    oauth2.getRefreshedToken(req.app, res, req.body);
});

/*
 Retrieve information on an access token. Use this in order to
 find out which authenticated user is tied to a specific access token
 or refresh token. This can be used to do additional authorization
 based on the actually authenticated user before e.g. allowing a refresh
 token request to be granted.

 GET /oauth2/token?access_token=<....>
 GET /oauth2/token?refresh_token=<....>

 Returns, if successful, the access token information:

 {
     "access_token":"er9e8ut49jtoirtjoiruoti",
     "refresh_token":"7594598475g89j567gj5o6go5675ojh65",
     "authenticated_userid":"8495874985ogituojgtulor5uh6o5",
     "authenticated_scopes":["scope1", "scope2"]
 }
*/
app.get('/oauth2/token', function (req, res, next) {
    debug('/oauth2/token');
    let access_token = null;
    let refresh_token = null;
    if (req.query.access_token)
        access_token = req.query.access_token;
    else if (req.query.refresh_token)
        refresh_token = req.query.refresh_token;
    oauth2.getTokenData(req.app, res, access_token, refresh_token);
});

/*
 Deletes/revokes access tokens by either the access token itself, or
 by authenticated user id. Pass in either access_token or
 authenticated_userid as query parameter:

 DELETE /oauth2/token?access_token=<...>
 DELETE /oauth2/token?authenticated_userid=<...>

 Does not return anything (but a 204 if successful).
*/
app.delete('/oauth2/token', function (req, res, next) {
    debug('DELETE /oauth2/token');
    let access_token = null;
    let authenticated_userid = null;
    if (req.query.access_token)
        access_token = req.query.access_token;
    else if (req.query.authenticated_userid)
        authenticated_userid = req.query.authenticated_userid;
    oauth2.deleteTokens(req, res, access_token, authenticated_userid);
});

// catch 404 and forward to error handler
app.use(function (req, res, next) {
    const err = new Error('Not Found');
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

module.exports = app;
