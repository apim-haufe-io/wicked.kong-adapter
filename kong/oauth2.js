'use strict';

var async = require('async');
var debug = require('debug')('kong-adapter:oauth2');
var qs = require('querystring');
var request = require('request');

var utils = require('./utils');
var sync = require('./sync');
var kong = require('./kong');

// We need this to accept self signed and Let's Encrypt certificates
var https = require('https');
var agentOptions = { rejectUnauthorized: false };
var sslAgent = new https.Agent(agentOptions);

var oauth2 = function () { };

oauth2.registerUser = function (app, res, inputData) {
    debug('registerUser()');
    debug(inputData);
    async.series({
        validate: function (callback) { validateInputData(inputData, callback); },
        redirectUri: function (callback) { registerOAuthUser(app, inputData, callback); }
    }, function (err, results) {
        if (err) {
            console.error(err.message);
            console.error(err.stackTrace);
            if (!err.statusCode && !err.status)
                err.statusCode = 500;
            return res.status(err.statusCode || err.status).json({
                message: err.message
            });
        }

        // Fetch result of registerOAuthUser
        const redirectUri = results.redirectUri;

        res.json({
            redirect_uri: redirectUri
        });
    });
};

// Ok, this just looks as if it were async, but isn't.
function validateInputData(userInfo, callback) {
    debug('validateUserInfo()');
    if (!userInfo.email)
        return callback(buildError('email is mandatory.'));
    if (!userInfo.custom_id)
        return callback(buildError('custom_id is mandatory.'));
    if (!userInfo.api_id)
        return callback(buildError('api_id is mandatory.'));
    if (!userInfo.client_id)
        return callback(buildError('client_id is mandatory.'));
    if (userInfo.scope) {
        if ((typeof(userInfo.scope) !== 'string') &&
            !Array.isArray(userInfo.scope))
            return callback(buildError('scope has to be either a string or a string array'));
    }
    callback(null);
}

function buildError(message, statusCode) {
    debug('buildError(): ' + message + ', status code: ' + statusCode);
    const err = new Error();
    err.statusCode = 400;
    if (statusCode)
        err.statusCode = statusCode;
    err.message = 'Kong Adapter - Register OAuth user: ' + message;
    return err;
}

function registerOAuthUser(app, inputData, callback) {
    debug('registerOAuthUser()');
    // We'll add info to this thing along the way; this is how it will look:
    // {
    //   inputData: {
    //     email: (user email),
    //     custom_id: (user custom ID, e.g. from 3rd party DB),
    //     api_id: (API ID)
    //     client_id: (The app's client ID, from subscription)
    //     scope: [ list of wanted scopes ] (optional)
    //   }
    //   provisionKey: ...
    //   subsInfo: {
    //     application: (app ID)
    //     api: (api ID)
    //     auth: 'oauth2-implicit',
    //     plan: (plan ID)
    //     clientId: (client ID)
    //     clientSecret: (client secret)
    //     ...
    //   },
    //   appInfo: {
    //     id: (app ID),
    //     name: (Application friendly name),
    //     redirectUri: (App's redirect URI)   
    //   },
    //   consumer: {
    //     id: (Kong consumer ID),
    //     username: (input email)$(api_id)
    //     custom_id: (input custom_id)
    //   }
    //   consumerClient: {
    //     clientId: (oauth2 app's client_id)
    //     clientSecret: (oauth2 app's client_secret)
    //   }
    //   accessToken: (Access Token)
    // }
    const oauthInfo = { inputData: inputData };

    async.series([
        callback => lookupSubscription(app, oauthInfo, callback),
        //callback => lookupApplication(app, oauthInfo, callback),
        callback => getProvisionKey(app, oauthInfo, callback),
        callback => checkForConsumer(app, oauthInfo, callback),
        callback => createConsumer(app, oauthInfo, callback),
        callback => checkForConsumerApp(app, oauthInfo, callback),
        callback => deleteFaultyConsumerApp(app, oauthInfo, callback),
        callback => createConsumerApp(app, oauthInfo, callback),
        callback => syncConsumerApiPlugins(app, oauthInfo, callback),
        callback => authorizeConsumer(app, oauthInfo, callback)
    ], function (err, results) {
        debug('registerOAuthUser async series returned.');
        if (err) {
            debug('but failed.');
            console.error(err);
            console.error(err.stackTrace);
            return callback(err);
        }

        // Oh, wow, that worked.
        callback(null, oauthInfo.redirectUri);
    });
}

//function lookupApplication(app, oauthInfo, callback) {
//    callback(null);
//}

function lookupSubscription(app, oauthInfo, callback) {
    debug('lookupSubscription()');
    utils.apiGet(app, 'subscriptions/' + oauthInfo.inputData.client_id, function (err, subscription) {
        if (err) {
            console.error(err);
            console.error(err.stackTrace);
            return callback(err);
        }
        const subsInfo = subscription.subscription;
        debug('subsInfo:');
        debug(subsInfo);
        const appInfo = subscription.application;
        debug('appInfo:');
        debug(appInfo);
        // Validate that the subscription is for the correct API
        if (oauthInfo.inputData.api_id !== subsInfo.api) {
            debug('inputData:');
            debug(oauthInfo.inputData);
            debug('subInfo:');
            debug(subsInfo);
            return callback(buildError('Subscription API does not match client_id'));
        }
        oauthInfo.subsInfo = subsInfo;
        oauthInfo.appInfo = appInfo;
        return callback(null, oauthInfo);
    });
}

oauth2.provisionKeys = {};
function getProvisionKey(app, oauthInfo, callback) {
    debug('getProvisionKey() for ' + oauthInfo.inputData.api_id);
    const apiId = oauthInfo.inputData.api_id;
    if (oauth2.provisionKeys[apiId]) {
        oauthInfo.provisionKey = oauth2.provisionKeys[apiId];
        return callback(null, oauthInfo);
    }

    // We haven't seen this API yet, get it from le Kong.
    utils.kongGet(app, 'apis/' + apiId + '/plugins?name=oauth2', function (err, body) {
        if (err) {
            console.error(err);
            console.error(err.stackTrace);
            return callback(err);
        }
        if (body.data.length <= 0)
            return callback(buildError('For API ' + apiId + ' no oauth2 plugin seems to be configured.'));
        const oauth2Plugin = body.data[0];
        if (!oauth2Plugin.config.enable_implicit_grant)
            return callback(buildError('API ' + apiId + ' is not configured for the OAuth2 implicit grant.'));
        if (!oauth2Plugin.config.provision_key)
            return callback(buildError('API ' + apiId + ' does not have a valid provision_key.'));
        // Looks good, remember dat thing
        oauthInfo.provisionKey = oauth2Plugin.config.provision_key;
        callback(null, oauthInfo);
    });
}

function checkForConsumer(app, oauthInfo, callback) {
    debug('checkForConsumer(): custom_id=' + oauthInfo.inputData.custom_id);
    utils.kongGet(app, 'consumers?custom_id=' + qs.escape(oauthInfo.inputData.custom_id), function (err, result) {
        if (err) {
            // Something else went bogus
            return callback(err);
        }

        if (result.total <= 0) {
            // Don't know that guy, but it's okay. We'll create him.
            return callback(null, oauthInfo);
        }

        const kongConsumer = result.data[0];

        if (!kongConsumer)
            return callback(buildError('Could not retrieve consumer from Kong'));
        oauthInfo.consumer = kongConsumer;
        return callback(null, oauthInfo);
    });
}

function createConsumer(app, oauthInfo, callback) {
    debug('createConsumer()');
    if (oauthInfo.consumer && oauthInfo.consumer.id) {
        debug('not needed.');
        // We already have a Kong consumer; keep that
        return callback(null, oauthInfo);
    }
    debug('We need a new consumer, creating.');
    // We need to create a new Kong consumer
    utils.kongPost(app, 'consumers', {
        username: utils.makeUserName(oauthInfo.inputData.email, oauthInfo.inputData.api_id),
        custom_id: oauthInfo.inputData.custom_id
    }, function (err, result) {
        if (err) {
            console.error(err);
            console.error(err.stackTrace);
            return callback(err);
        }
        const consumer = result;
        if (!consumer || !consumer.id)
            return callback(buildError('Kong did not return new consumer (with id)'));
        oauthInfo.consumer = consumer;
        return callback(null, oauthInfo);
    });
}

function checkForConsumerApp(app, oauthInfo, callback) {
    debug('checkForConsumerApp()');
    debug('app name: ' + oauthInfo.appInfo.id);
    const oauth2AppUrl = 'consumers/' + oauthInfo.consumer.id + '/oauth2?name=' + qs.encode(oauthInfo.appInfo.id);
    debug(oauth2AppUrl);
    utils.kongGet(app, oauth2AppUrl, function (err, result) {
        if (err) {
            console.error(err);
            console.error(err.stackTrace);
            return callback(err);
        }
        if (result.total <= 0) {
            // Unknown name for oauth2 config; we'll create it in the next step
            return callback(null, oauthInfo);
        }

        const oauthApp = result.data[0];
        // Check that the redirect URI is correct
        const redirectUri = oauthApp.redirect_uri.find(uri => uri === oauthInfo.appInfo.redirectUri);
        if (!redirectUri) {
            // Different URI
            debug('Detected redirect_uri change; deleting oauth2 plugin for consumer ' + oauthInfo.inputData.emai);
            // Have it deleted in the next step
            oauthInfo.faultyConsumerAppId = oauthApp.id;
        } else {
            // Re-use the app, it's good for us.
            oauthInfo.consumerClient = {
                clientId: oauthApp.client_id,
                clientSecret: oauthApp.client_secret
            };
        }
        return callback(null, oauthInfo);
    });
}

function deleteFaultyConsumerApp(app, oauthInfo, callback) {
    debug('deleteFaultyConsumerApp()');
    if (!oauthInfo.faultyConsumerAppId) {
        debug('not needed.');
        return callback(null, oauthInfo);
    }
    debug('Deleting old app');
    const oauthAppUrl = 'consumers' + oauthInfo.consumer.id + '/oauth2/' + oauthInfo.deleteConsumerApp;
    utils.kongDelete(app, oauthAppUrl, function (err, result) {
        if (err) {
            console.error(err);
            console.error(err.stackTrace);
            return callback(err);
        }
        delete oauthInfo.faultyConsumerAppId;
        return callback(null, oauthInfo);
    });
}

function createConsumerApp(app, oauthInfo, callback) {
    debug('createConsumerApp()');
    if (oauthInfo.consumerClient) {
        debug('not needed.');
        // We're already good.
        return callback(null, oauthInfo);
    }
    debug('We need a new consumer app.');
    const consumerOAuthUrl = 'consumers/' + oauthInfo.consumer.id + '/oauth2';
    const consumerOAuthBody = {
        name: oauthInfo.appInfo.id,
        redirect_uri: [oauthInfo.appInfo.redirectUri]
    };
    utils.kongPost(app, consumerOAuthUrl, consumerOAuthBody, function (err, result) {
        if (err) {
            console.error(err);
            console.error(err.stackTrace);
            return callback(err);
        }

        if (!result.client_id || !result.client_secret)
            return callback(buildError('Adding an oauth2 app to consumer ' + oauthInfo.inputData.email + ' did not render client id or secret'));

        debug('Successfully created consumer oauth2 app.');
        oauthInfo.clientConsumer = {
            clientId: result.client_id,
            clientSecret: result.client_secret
        };
        return callback(null, oauthInfo);
    });
}

function syncConsumerApiPlugins(app, oauthInfo, callback) {
    debug('syncConsumerApiPlugins()');
    // We'll leverage some sync functionality from the sync.js implementation.
    const kongConsumer = {
        consumer: oauthInfo.consumer
    };
    const planId = oauthInfo.subsInfo.plan;
    const apiId = oauthInfo.inputData.api_id;
    debug('planId: ' + planId + ', apiId: ' + apiId);
    const portalConsumer = {
        consumer: oauthInfo.consumer,
        apiPlugins: []
    };
    async.parallel({
        getPlan: callback => utils.getPlan(app, planId, callback),
        enrichConsumer: callback => kong.enrichConsumerApiPlugins(app, kongConsumer, apiId, callback)
    }, function (err, results) {
        if (err) {
            console.error(err);
            console.error(err.stackTrace);
            return callback(err);
        }
        const plan = results.getPlan;
        debug('plan plugins:');
        debug(plan.config);
        // Add plugin configuration from plan, otherwise leave empty (no plugins)
        if (plan && plan.config && plan.config.plugins) {
            for (let i=0; i<plan.config.plugins.length; ++i) {
                let pluginData = plan.config.plugins[i];
                if (pluginData.name == 'request-transformer') // Clone this; we will change it
                    pluginData = JSON.parse(JSON.stringify(pluginData));
                portalConsumer.apiPlugins.push(pluginData);
            }
        }
        if (oauthInfo.inputData.headers)
            addRequestTransformerPlugin(oauthInfo, portalConsumer);
        sync.syncConsumerApiPlugins(app, portalConsumer, kongConsumer, function (err) {
            if (err) {
                console.error(err);
                console.error(err.stackTrace);
                return callback(err);
            }
            callback(null, oauthInfo);
        });
    });
}

function addRequestTransformerPlugin(oauthInfo, consumerInfo) {
    debug('addRequestTransformerPlugin()');
    let reqTPlugin = utils.findWithName(consumerInfo.apiPlugins, 'request-transformer');
    let needsAdd = false;
    if (!reqTPlugin) {
        reqTPlugin = {
            name: "request-transformer",
        };
        needsAdd = true;
    }
    // Now we can play with the thing
    let configNode = reqTPlugin.config;
    if (!configNode) {
        configNode = {};
        reqTPlugin.config = configNode;
    }
    let addNode = configNode.add;
    if (!addNode) {
        addNode = {};
        configNode.add = addNode;
    }
    let headersNode = addNode.headers;
    if (!headersNode) {
        headersNode = [];
        addNode.headers = headersNode;
    }

    // Now we have a headersNode we can add stuff to
    let addedHeader = false;
    for (let headerName in oauthInfo.inputData.headers) {
        const headerValue = oauthInfo.inputData.headers[headerName];
        headersNode.push(headerName + ':' + headerValue);
        addedHeader = true;
    }

    // Only add new plugin when necessary.
    if (needsAdd && addedHeader) {
        debug('Adding request-transformer plugin');
        debug(JSON.stringify(reqTPlugin));
        consumerInfo.apiPlugins.push(reqTPlugin);
    }
}

function authorizeConsumer(app, oauthInfo, callback) {
    debug('authorizeConsumer()');
    // Now we need to assemble the API host for this system. It's in globals.
    let apiUrl = app.kongGlobals.network.schema + '://' +
        app.kongGlobals.network.apiHost; // e.g., https://api.mycompany.com, or http://local.ip:8000
    if (!apiUrl.endsWith('/'))
        apiUrl = apiUrl + '/';
    const authorizeUrl = apiUrl + oauthInfo.subsInfo.api + '/oauth2/authorize';
    debug('authorizeUrl: ' + authorizeUrl);

    let headers = null;
    let agent = null;

    // Workaround for local connections and testing
    if ('http' === app.kongGlobals.network.schema) {
        headers = { 'X-Forwarded-Proto': 'https' };
    } else if ('https' === app.kongGlobals.network.schema) {
        // Make sure we accept self signed certs
        agent = sslAgent;
    }

    let scope = null;
    if (oauthInfo.inputData.scope) {
        let s = oauthInfo.inputData.scope;
        if (typeof(s) === 'string')
            scope = s;
        else if (Array.isArray(s))
            scope = s.join(' ');
        else // else: what?
            debug('unknown type of scope input parameter: ' + typeof(s));
    }
    debug('requested scope: ' + scope);

    const oauthBody = {
        response_type: 'token',
        provision_key: oauthInfo.provisionKey,
        client_id: oauthInfo.clientConsumer.clientId,
        redirect_uri: oauthInfo.appInfo.redirectUri,
        authenticated_userid: oauthInfo.inputData.custom_id
    };
    if (scope)
        oauthBody.scope = scope;
    debug(oauthBody);

    // Jetzt kommt der spannende Moment, wo der Frosch ins Wasser rennt
    request.post({
        url: authorizeUrl,
        headers: headers,
        agent: agent,
        json: true,
        body: oauthBody
    }, function (err, res, body) {
        if (err) {
            console.error(err);
            console.error(err.stackTrace);
            return callback(err);
        }
        if (res.statusCode > 299) {
            debug('Kong did not create an access token, response body:');
            debug(body);
            return callback(buildError('Authorize user with Kong failed: ' + utils.getText(body), res.statusCode));
        }
        const jsonBody = utils.getJson(body);
        oauthInfo.redirectUri = jsonBody.redirect_uri;
        return callback(null, oauthInfo);
    });
}

module.exports = oauth2;