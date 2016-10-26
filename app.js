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
    var health = {
        name: 'kong-adapter',
        message: 'Up and running',
        uptime: (utils.getUtc() - app._startupSeconds),
        healthy: 1,
        pingUrl: app.get('my_url') + 'ping'
    };
    if (!app.initialized) {
        var msg = 'Initializing - Waiting for API and Kong';
        if (app.apiAvailable && !app.kongAvailable)
            msg = 'Initializing - Waiting for Kong';
        else if (!app.apiAvailable && app.kongAvailable)
            msg = 'Initializing - Waiting for API'; // Shouldn't be possible
        health.healthy = 2;
        health.message = msg;
        res.status(503);
    } else if (app.lastErr) {
        health.healthy = 0;
        health.message = lastErr.message;
        health.error = JSON.stringify(lastErr, null, 2);
        res.status(500);
    }
    res.json(health);
});

app.post('/kill', function (req, res, next) {
    debug('/kill');
    if (!process.env.ALLOW_KILL) {
        debug('/kill rejected, ALLOW_KILL is not set.');
        return res.status(403).json({});
    }
    debug('/kill accepted. Shutting down.');
    res.status(204).json({});
    setTimeout(function() {
        process.exit(0);
    }, 1000);
});

/*
 End point for authorizing end users for use with the oauth2
 implicit grant. This requires a payload which looks like this:

 {
     "email":"hello@company.com",
     "custom_id":"1234567",
     "api_id":"some_api",
     "client_id":"ab7364bd9ef0992838dfab9384",
     "scope": ["scope1", "scope2"] // This is optional, depending on the API def.
     "headers": [
         {"X-SomeHeader": "some-value"}
     ]
 }

 If there is registered application for the given client_id,
 and there is a subscription for the given API for that application,
 the user is created, the OAuth2 app is registered with it, and
 an access token is returned in form of a redirect_uri with a
 fragment.
 */
app.post('/oauth2/register', function (req, res, next) {
    debug('/oauth2/register');
    oauth2.registerUser(req.app, res, req.body);
});

// catch 404 and forward to error handler
app.use(function (req, res, next) {
    var err = new Error('Not Found');
    err.status = 404;
    next(err);
});

// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
    app.use(function (err, req, res, next) {
        res.status(err.status || 500);
        res.jsonp({
            message: err.message,
            error: err
        });
    });
}

// production error handler
// no stacktraces leaked to user
app.use(function (err, req, res, next) {
    res.status(err.status || 500);
    res.jsonp({
        message: err.message,
        error: {}
    });
});

module.exports = app;
