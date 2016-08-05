'use strict';

var request = require('request');
var async = require('async');
var debug = require('debug')('kong-adapter:main');

var utils = require('./utils');
//var kong = require('./kong');
//var portal = require('./portal');
var sync = require('./sync');

var kongMain = function () { };

// ====== PUBLIC INTERFACE ======

kongMain.init = function (app, options, done) {
    debug('init()');
    async.series({
        initGlobals: function (callback) {
            if (options.initGlobals) {
                debug('Calling initGlobals()');
                initGlobals(app, callback);
            } else {
                callback(null);
            }
        },
        syncApis: function (callback) {
            if (options.syncApis) {
                debug('Calling sync.syncApis()');
                sync.syncApis(app, callback);
            } else {
                callback(null);
            }
        },
        syncConsumers: function (callback) {
            if (options.syncConsumers) {
                debug('Calling sync.syncConsumers()');
                sync.syncConsumers(app, callback);
            } else {
                callback(null);
            }
        }
    }, function (err) {
        if (err) {
            return done(err);
        }
        debug("kong.init() done.");
        done(null);
    });
};

kongMain.deinit = function (app, done) {
    utils.apiDelete(app, 'webhooks/listeners/kong-adapter', done);
};

// ====== INTERNALS =======

function initGlobals(app, done) {
    debug('initGlobals()');
    var myUrl = app.get('my_url');

    async.parallel({
        registerWebhook: function (callback) {
            var putPayload = {
                id: 'kong-adapter',
                url: myUrl
            };
            utils.apiPut(app, 'webhooks/listeners/kong-adapter', putPayload, callback);
        },
        getGlobals: function (callback) {
            utils.apiGet(app, 'globals', function (err, kongGlobals) {
                if (err) {
                    return callback(err);
                }
                return callback(null, kongGlobals);
            });
        }
    }, function (err, results) {
        if (err) {
            return done(err);
        }

        app.kongGlobals = results.getGlobals;

        return done(null);
    });
}

module.exports = kongMain;
