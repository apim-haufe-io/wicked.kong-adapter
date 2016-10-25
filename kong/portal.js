'use strict';

var async = require('async');
var debug = require('debug')('kong-adapter:portal');
var utils = require('./utils');

var portal = function () { };

const MAX_PARALLEL_CALLS = 10;

// ======== INTERFACE FUNCTIONS =======

portal.getPortalApis = function (app, done) {
    debug('getPortalApis()');
    async.parallel({
        getApis: callback => getActualApis(app, callback),
        getAuthServers: callback => getAuthServerApis(app, callback)
    }, function (err, results) {
        if (err)
            return done(err);

        const apiList = results.getApis;
        const authServerList = results.getAuthServers;

        var portalHost = app.kongGlobals.network.portalUrl;
        if (!portalHost) {
            debug('portalUrl is not set in globals.json, defaulting to http://portal:3000');
            portalHost = 'http://portal:3000'; // Default
        }
        // Add the Swagger UI "API" for tunneling
        var swaggerApi = require('../resources/swagger-ui.json');
        swaggerApi.config.api.upstream_url = portalHost + '/swagger-ui';
        apiList.apis.push(swaggerApi);

        // And a Ping end point for monitoring            
        var pingApi = require('../resources/ping-api.json');
        pingApi.config.api.upstream_url = portalHost + '/ping';
        apiList.apis.push(pingApi);

        // Add the /deploy API
        var deployApi = require('../resources/deploy-api.json');
        var apiUrl = app.kongGlobals.network.apiUrl;
        if (!apiUrl) {
            debug('apiUrl is not set in globals.json, defaulting to http://portal-api:3001');
            apiUrl = 'http://portal-api:3001';
        }
        if (apiUrl.endsWith('/'))
            apiUrl = apiUrl.substring(0, apiUrl.length - 1);
        deployApi.config.api.upstream_url = apiUrl + '/deploy';
        apiList.apis.push(deployApi);

        // And the actual Portal API (OAuth 2.0)
        var portalApi = require('../resources/portal-api.json');
        portalApi.config.api.upstream_url = apiUrl;
        apiList.apis.push(portalApi);

        // And the auth Servers please
        for (let i = 0; i < authServerList.length; ++i)
            apiList.apis.push(authServerList[i]);

        debug('getPortalApis():');
        debug(apiList);

        try {
            injectAuthPlugins(app, apiList);
        } catch (injectErr) {
            return done(injectErr);
        }

        return done(null, apiList);
    });
};

function getActualApis(app, callback) {
    debug('getActualApis()');
    utils.apiGet(app, 'apis', function (err, apiList) {
        if (err)
            return callback(err);
        // Enrich apiList with the configuration.
        async.eachLimit(apiList.apis, MAX_PARALLEL_CALLS, function (apiDef, callback) {
            utils.apiGet(app, 'apis/' + apiDef.id + '/config', function (err, apiConfig) {
                if (err)
                    return callback(err);
                apiDef.config = checkApiConfig(app, apiConfig);
                return callback(null);
            });
        }, function (err) {
            if (err)
                return callback(err);
            return callback(null, apiList);
        });
    });
}

function getAuthServerApis(app, callback) {
    debug('getAuthServerApis()');
    utils.apiGet(app, 'auth-servers', function (err, authServerNames) {
        if (err)
            return callback(err);
        async.mapLimit(authServerNames, MAX_PARALLEL_CALLS, function (authServerName, callback) {
            utils.apiGet(app, 'auth-servers/' + authServerName, callback);
        }, function (err, authServers) {
            if (err)
                return callback(err);
            debug(JSON.stringify(authServers, null, 2));
            callback(null, authServers);
        });
    });
}

function checkApiConfig(app, apiConfig) {
    if (apiConfig.plugins) {
        for (var i = 0; i < apiConfig.plugins.length; ++i) {
            var plugin = apiConfig.plugins[i];
            if (!plugin.name)
                continue;

            switch (plugin.name.toLowerCase()) {
                case "request-transformer":
                    checkRequestTransformerPlugin(app, apiConfig, plugin);
                    break;
            }
        }
    }
    return apiConfig;
}

function checkRequestTransformerPlugin(app, apiConfig, plugin) {
    if (plugin.config &&
        plugin.config.add &&
        plugin.config.add.headers) {

        for (var i = 0; i < plugin.config.add.headers.length; ++i) {
            if (plugin.config.add.headers[i] == '%%Forwarded') {
                var prefix = apiConfig.api.request_path;
                var proto = app.kongGlobals.network.schema;
                var rawHost = app.kongGlobals.network.apiHost;
                var host;
                var port;
                if (rawHost.indexOf(':') > 0) {
                    var splitList = rawHost.split(':');
                    host = splitList[0];
                    port = splitList[1];
                } else {
                    host = rawHost;
                    port = (proto == 'https') ? 443 : 80;
                }

                plugin.config.add.headers[i] = 'Forwarded: host=' + host + ';port=' + port + ';proto=' + proto + ';prefix=' + prefix;
            }
        }
    }
}

/*

This is what we want from the portal:

[
    {
        "consumer": {
            "username": "my-app$petstore",
            "custom_id": "3476ghow89e746goihw576iger5how4576"
        },
        "plugins": {
            "key-auth": [
                { "key": "flkdfjlkdjflkdjflkdfldf" }
            ],
            "acls": [
                { "group": "petstore" }
            ],
            "oauth2": [
                { 
                    "name": "My Application",
                    "client_id": "my-app-petstore",
                    "client_secret": "uwortiu4eot8g7he59t87je59thoerizuoh",
                    "redirect_uri": ["http://dummy.org"]
                }
            ]
        },
        "apiPlugins": [
            {
                "name": "rate-limiting",
                "config": {
                    "hour": 100,
                    "fault_tolerant": true
                }
            }
        ]
    }
]
*/

/* One app can have multiple consumers (one per subscription) */
portal.getAppConsumers = function (app, appId, callback) {
    debug('getPortalConsumersForApp() ' + appId);
    const applicationList = [{ id: appId }];
    async.waterfall([
        callback => utils.getPlans(app, callback),
        (apiPlans, callback) => enrichApplications(app, applicationList, apiPlans, callback)
    ], function (err, appConsumers) {
        if (err)
            return callback(err);
        callback(null, appConsumers);
    });
};

/* One user can have max one consumer (possibly none) */
portal.getUserConsumer = function (app, userId, callback) {
    debug('getPortalConsumerForUser() ' + userId);
    if (!isInternalApiEnabled(app))
        return setTimeout(callback, 0, null, []); // async version of callback(null, [])
    const userList = [{ id: userId }];
    enrichUsers(app, userList, callback);
};

portal.getAllPortalConsumers = function (app, callback) {
    debug('getAllPortalConsumers()');
    async.parallel({
        appConsumers: callback => getAllAppConsumers(app, callback),
        userConsumers: callback => getAllUserConsumers(app, callback)
    }, function (err, results) {
        if (err)
            return callback(err);

        const appConsumers = results.appConsumers;
        const userConsumers = results.userConsumers;

        const allConsumers = appConsumers.concat(userConsumers);
        callback(null, allConsumers);
    });
};

function getAllAppConsumers(app, callback) {
    debug('getAllAppConsumers()');
    async.parallel({
        apiPlans: callback => utils.getPlans(app, callback),
        applicationList: callback => utils.apiGet(app, 'applications', callback)
    }, function (err, results) {
        if (err)
            return callback(err);

        const applicationList = results.applicationList;
        const apiPlans = results.apiPlans;

        enrichApplications(app, applicationList, apiPlans, callback);
    });
}

function getAllUserConsumers(app, callback) {
    debug('getAllUserConsumers()');
    if (isInternalApiEnabled(app)) {
        utils.apiGet(app, 'users', function (err, userList) {
            if (err)
                return callback(err);
            enrichUsers(app, userList, callback);
        });
    } else {
        process.nextTick(function () { callback(null, []); });
    }
}

function userHasGroup(userInfo, group) {
    if (userInfo &&
        userInfo.groups) {
        for (var i = 0; i < userInfo.groups.length; ++i) {
            if (userInfo.groups[i] == group)
                return true;
        }
        return false;
    } else {
        return false;
    }
}

function enrichUsers(app, userList, done) {
    console.log('enrichUsers()');
    debug('enrichUsers(), userList = ' + utils.getText(userList));
    // We need to use "apiGetAsUser" here in order to retrieve the client
    // credentials. You won't see those for other users in the UI. 
    async.mapLimit(userList, MAX_PARALLEL_CALLS, function (userInfo, callback) {
        utils.apiGetAsUser(app, 'users/' + userInfo.id, userInfo.id, function (err, userData) {
            if (err && err.status === 404) {
                // Half expected; may be if the user was deleted before the
                // webhook event was processed.
                console.error('*** Could not find user with id ' + userInfo.id);
                console.error('*** Skipping (not quitting).');
                return callback(null, null);
            } else if (err) {
                return callback(err);
            }
            return callback(null, userData);
        });
    }, function (err, results) {
        if (err) {
            console.error(err);
            return done(err);
        }

        var userConsumers = [];
        for (var i = 0; i < results.length; ++i) {
            // for (var i=0; i<5; ++i) {
            var thisUser = results[i];
            if (!thisUser) // May be from a 404
                continue;

            debug(thisUser);

            // If this user doesn't have a clientId and clientSecret,
            // we can quit immediately.
            if (!(thisUser.clientId && thisUser.clientSecret)) {
                console.log('User ' + thisUser.email + ' does not have client creds.');
                continue;
            }

            // If we're here, glob.api.portal.enableApi must be true
            var requiredGroup = app.kongGlobals.api.portal.requiredGroup;
            if (requiredGroup &&
                !userHasGroup(thisUser, requiredGroup)) {
                console.log('User ' + thisUser.email + ' does not have correct group.');
                continue;
            }
            var clientId = thisUser.clientId;
            var clientSecret = thisUser.clientSecret;

            var userConsumer = {
                consumer: {
                    username: thisUser.email,
                    custom_id: thisUser.id
                },
                plugins: {
                    acls: [{
                        group: 'portal-api-internal'
                    }],
                    oauth2: [{
                        name: thisUser.email,
                        client_id: clientId,
                        client_secret: clientSecret,
                        redirect_uri: ['http://dummy.org']
                    }]
                },
                apiPlugins: []
            };

            console.log(userConsumer);

            userConsumers.push(userConsumer);
        }

        debug('userConsumers.length == ' + userConsumers.length);

        done(null, userConsumers);
    });
}

// Returns
// {
//    application: { id: ,... }
//    subscriptions: [ ... ]
// }
function getApplicationData(app, appId, callback) {
    debug('getApplicationData() ' + appId);
    async.parallel({
        subscriptions: callback => utils.apiGet(app, 'applications/' + appId + '/subscriptions', function (err, subsList) {
            if (err && err.status == 404) {
                // Race condition; web hook processing was not finished until the application
                // was deleted again (can normally just happen when doing automatic testing).
                console.error('*** Get Subscriptions: Application with ID ' + appId + ' was not found.');
                return callback(null, []); // Treat as empty
            } else if (err) {
                return callback(err);
            }
            return callback(null, subsList);
        }),
        application: callback => utils.apiGet(app, 'applications/' + appId, function (err, appInfo) {
            if (err && err.status == 404) {
                // See above.
                console.error('*** Get Application: Application with ID ' + appId + ' was not found.');
                return callback(null, null);
            } else if (err) {
                return callback(err);
            }
            return callback(null, appInfo);

        })
    }, function (err, results) {
        if (err)
            return callback(err);
        callback(null, results);
    });
}

function enrichApplications(app, applicationList, apiPlans, done) {
    debug('enrichApplications(), applicationList = ' + utils.getText(applicationList));
    async.mapLimit(applicationList, MAX_PARALLEL_CALLS, function (appInfo, callback) {
        getApplicationData(app, appInfo.id, callback);
    }, function (err, results) {
        if (err)
            return done(err);

        const consumerList = [];
        for (var resultIndex = 0; resultIndex < results.length; ++resultIndex) {
            const appInfo = results[resultIndex].application;
            const appSubsInfo = results[resultIndex].subscriptions;
            for (let subsIndex = 0; subsIndex < appSubsInfo.length; ++subsIndex) {
                const appSubs = appSubsInfo[subsIndex];
                // Only propagate approved subscriptions
                if (!appSubs.approved)
                    continue;

                debug(utils.getText(appSubs));
                const consumerInfo = {
                    consumer: {
                        username: utils.makeUserName(appSubs.application, appSubs.api),
                        custom_id: appSubs.id
                    },
                    plugins: {
                        acls: [{
                            group: appSubs.api
                        }]
                    }
                };
                if ("oauth2" == appSubs.auth) {
                    consumerInfo.plugins.oauth2 = [{
                        name: appSubs.application,
                        client_id: appSubs.clientId,
                        client_secret: appSubs.clientSecret,
                        redirect_uri: ['http://dummy.org']
                    }];
                } else if ("oauth2-implicit" == appSubs.auth) {
                    consumerInfo.plugins.oauth2 = [{
                        name: appSubs.application,
                        client_id: appSubs.clientId,
                        client_secret: appSubs.clientSecret,
                        redirect_uri: [appInfo.redirectUri]
                    }];
                } else if (!appSubs.auth || "key-auth" == appSubs.auth) {
                    consumerInfo.plugins["key-auth"] = [{
                        key: appSubs.apikey
                    }];
                } else {
                    let err2 = new Error('Unknown auth strategy: ' + appSubs.auth + ', for application "' + appSubs.application + '", API "' + appSubs.api + '".');
                    return done(err2);
                }

                // Now the API level plugins from the Plan
                const apiPlan = getPlanById(apiPlans, appSubs.plan);
                if (!apiPlan) {
                    const err = new Error('Unknown API plan strategy: ' + appSubs.plan + ', for application "' + appSubs.application + '", API "' + appSubs.api + '".');
                    return done(err);
                }

                if (apiPlan.config && apiPlan.config.plugins)
                    consumerInfo.apiPlugins = apiPlan.config.plugins;
                else
                    consumerInfo.apiPlugins = [];

                consumerList.push(consumerInfo);
            }
        }

        debug(utils.getText(consumerList));

        return done(null, consumerList);
    });
}

function getPlanById(apiPlans, planId) {
    debug('getPlanById(' + planId + ')');
    return apiPlans.plans.find(function (plan) { return (plan.id == planId); });
}

// ======== INTERNAL FUNCTIONS =======

function injectAuthPlugins(app, apiList) {
    debug('injectAuthPlugins()');
    for (var i = 0; i < apiList.apis.length; ++i) {
        var thisApi = apiList.apis[i];
        if (!thisApi.auth ||
            "none" == thisApi.auth)
            continue;
        if ("key-auth" == thisApi.auth)
            injectKeyAuth(app, thisApi);
        else if ("oauth2" == thisApi.auth)
            injectClientCredentialsAuth(app, thisApi);
        else if ("oauth2-implicit" == thisApi.auth)
            injectImplicitAuth(app, thisApi);
        else
            throw new Error("Unknown 'auth' setting: " + thisApi.auth);
    }
}

function injectKeyAuth(app, api) {
    debug('injectKeyAuth()');
    if (!api.config.plugins)
        api.config.plugins = [];
    var plugins = api.config.plugins;
    var keyAuthPlugin = plugins.find(function (plugin) { return plugin.name == "key-auth"; });
    if (keyAuthPlugin)
        throw new Error("If you use 'key-auth' in the apis.json, you must not provide a 'key-auth' plugin yourself. Remove it and retry.");
    var aclPlugin = plugins.find(function (plugin) { return plugin.name == 'acl'; });
    if (aclPlugin)
        throw new Error("If you use 'key-auth' in the apis.json, you must not provide a 'acl' plugin yourself. Remove it and retry.");
    plugins.push({
        name: 'key-auth',
        enabled: true,
        config: {
            hide_credentials: true,
            key_names: [app.kongGlobals.api.headerName]
        }
    });
    plugins.push({
        name: 'acl',
        enabled: true,
        config: {
            whitelist: [api.id]
        }
    });
    return api;
}

function injectClientCredentialsAuth(app, api) {
    debug('injectClientCredentialsAuth()');
    if (!api.config.plugins)
        api.config.plugins = [];
    var plugins = api.config.plugins;
    var keyAuthPlugin = plugins.find(function (plugin) { return plugin.name == "key-auth"; });
    if (keyAuthPlugin)
        throw new Error("If you use 'oauth2' in the apis.json, you must not provide a 'oauth2' plugin yourself. Remove it and retry.");
    var aclPlugin = plugins.find(function (plugin) { return plugin.name == 'acl'; });
    if (aclPlugin)
        throw new Error("If you use 'oauth2' in the apis.json, you must not provide a 'acl' plugin yourself. Remove it and retry.");
    let token_expiration = 3600;
    if (api.settings && api.settings.token_expiration)
        token_expiration = Number(api.settings.token_expiration);
    plugins.push({
        name: 'oauth2',
        enabled: true,
        config: {
            scopes: ['api'],
            token_expiration: token_expiration,
            enable_authorization_code: false,
            enable_client_credentials: true,
            enable_implicit_grant: false,
            enable_password_grant: false,
            hide_credentials: true,
            accept_http_if_already_terminated: true
        }
    });
    plugins.push({
        name: 'acl',
        enabled: true,
        config: {
            whitelist: [api.id]
        }
    });
    return api;
}

function injectImplicitAuth(app, api) {
    debug('injectImplicitAuth()');
    if (!api.config.plugins)
        api.config.plugins = [];
    var plugins = api.config.plugins;
    var keyAuthPlugin = plugins.find(function (plugin) { return plugin.name == "key-auth"; });
    if (keyAuthPlugin)
        throw new Error("If you use 'oauth2-implicit' in the apis.json, you must not provide a 'oauth2' plugin yourself. Remove it and retry.");
    var aclPlugin = plugins.find(function (plugin) { return plugin.name == 'acl'; });
    if (aclPlugin)
        throw new Error("If you use 'oauth2-implicit' in the apis.json, you must not provide a 'acl' plugin yourself. Remove it and retry.");

    let scopes = ['api'];
    let mandatory_scope = false;
    let token_expiration = 3600;
    if (api.settings) {
        // Check overridden defaults
        if (api.settings.scopes)
            scopes = api.settings.scopes;
        if (api.settings.mandatory_scope)
            mandatory_scope = api.settings.mandatory_scope;
        if (api.settings.token_expiration)
            token_expiration = Number(api.settings.token_expiration);
    }

    plugins.push({
        name: 'oauth2',
        enabled: true,
        config: {
            scopes: scopes,
            mandatory_scope: mandatory_scope,
            token_expiration: token_expiration,
            enable_authorization_code: false,
            enable_client_credentials: false,
            enable_implicit_grant: true,
            enable_password_grant: false,
            hide_credentials: true,
            accept_http_if_already_terminated: true
        }
    });
}

function isInternalApiEnabled(app) {
    return (app.kongGlobals.api &&
        app.kongGlobals.api.portal &&
        app.kongGlobals.api.portal.enableApi);
}

module.exports = portal;