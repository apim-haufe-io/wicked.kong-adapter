'use strict';

var async = require('async');
var debug = require('debug')('kong-adapter:oauth2');
var qs = require('querystring');
var request = require('request');
var wicked = require('wicked-sdk');

var utils = require('./utils');
var sync = require('./sync');
var kong = require('./kong');

// We need this to accept self signed and Let's Encrypt certificates
var https = require('https');
var agentOptions = { rejectUnauthorized: false };
var sslAgent = new https.Agent(agentOptions);

var oauth2 = function () { };

oauth2.getImplicitToken = function (app, res, inputData) {
    debug('getImplicitToken()');
    debug(inputData);
    async.series({
        validate: function (callback) { validateInputData(inputData, callback); },
        redirectUri: function (callback) { getImplicitToken(app, inputData, callback); }
    }, function (err, results) {
        if (err) {
            console.error(err.message);
            console.error(err.stack);
            if (!err.statusCode && !err.status)
                err.statusCode = 500;
            return res.status(err.statusCode || err.status).json({
                message: err.message
            });
        }

        // Fetch result of getImplicitToken
        const redirectUri = results.redirectUri;

        res.json({
            redirect_uri: redirectUri
        });
    });
};

oauth2.getPasswordToken = function (app, res, inputData) {
    debug('getPasswordToken()');
    debug(inputData);
    async.series({
        validate: function (callback) { validateInputData(inputData, callback); },
        accessToken: function (callback) { getPasswordToken(app, inputData, callback); }
    }, function (err, results) {
        if (err) {
            console.error(err.message);
            console.error(err.stack);
            if (!err.statusCode && !err.status)
                err.statusCode = 500;
            return res.status(err.statusCode || err.status).json({
                message: err.message
            });
        }

        // Fetch result of getPasswordToken
        const accessToken = results.accessToken;

        res.json(accessToken);
    });
};

oauth2.getRefreshedToken = function (app, res, inputData) {
    debug('getRefreshToken()');
    debug(inputData);
    async.series({
        validate: function (callback) { validateRefreshInputData(inputData, callback); },
        accessToken: function (callback) { getRefreshedToken(app, inputData, callback); }
    }, function (err, results) {
        if (err) {
            console.error(err.message);
            console.error(err.stack);
            if (!err.statusCode && !err.status)
                err.statusCode = 500;
            return res.status(err.statusCode || err.status).json({
                message: err.message
            });
        }

        // Fetch result of getPasswordToken
        const accessToken = results.accessToken;

        res.json(accessToken);
    });
};

oauth2.getTokenData = function (app, res, accessToken, refreshToken) {
    debug('getTokenData(), access_token = ' + accessToken + ', refresh_token = ' + refreshToken);
    let tokenUrl = 'oauth2_tokens?';
    if (accessToken)
        tokenUrl = tokenUrl + 'access_token=' + qs.escape(accessToken);
    else if (refreshToken)
        tokenUrl = tokenUrl + 'refresh_token=' + qs.escape(refreshToken);
    utils.kongGet(app, tokenUrl, function (err, resultList) {
        if (err) {
            console.error(err.message);
            console.error(err.stack);
            if (!err.statusCode && !err.status)
                err.statusCode = 500;
            return res.status(err.statusCode || err.status).json({
                message: err.message
            });
        }

        if (resultList.total <= 0 || !resultList.data || resultList.data.length <= 0) {
            return res.status(404).json({ message: 'Not found.' });
        }

        return res.json(resultList.data[0]);
    });
};

// Ok, this just looks as if it were async, but isn't.
function validateInputData(userInfo, callback) {
    debug('validateUserInfo()');
    if (!userInfo.authenticated_userid)
        return callback(buildError('authenticated_userid is mandatory.'));
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

function validateRefreshInputData(inputData, callback) {
    debug('validateRefreshInputData()');
    if (!inputData.refresh_token)
        return callback(buildError('refresh_token is mandatory.'));
    if (!inputData.client_id)
        return callback(buildError('client_id is mandatory.'));
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


function getImplicitToken(app, inputData, callback) {
    debug('getImplicitToken()');
    // We'll add info to this thing along the way; this is how it will look:
    // {
    //   inputData: {
    //     authenticated_userid: (user custom ID, e.g. from 3rd party DB),
    //     api_id: (API ID)
    //     client_id: (The app's client ID, from subscription)
    //     scope: [ list of wanted scopes ] (optional, depending on API definition)
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
    //     username: (app id)$(api_id)
    //     custom_id: (subscription id)
    //   },
    //   apiInfo: {
    //     strip_request_path: true,
    //     preserve_host: false,
    //     name: "mobile",
    //     request_path : "/mobile/v1",
    //     id: "7baec4f7-131d-44e9-a746-312352cedab1",
    //     upstream_url: "https://upstream.url/api/v1",
    //     created_at: 1477320419000
    //   }
    //   redirectUri: (redirect URI including access token)
    // }
    const oauthInfo = { inputData: inputData };

    async.series([
        callback => lookupSubscription(app, oauthInfo, callback),
        //callback => lookupApplication(app, oauthInfo, callback),
        callback => getProvisionKey(app, oauthInfo, callback),
        callback => lookupConsumer(app, oauthInfo, callback),
        callback => lookupApi(app, oauthInfo, callback),
        callback => authorizeConsumerImplicitGrant(app, oauthInfo, callback)
    ], function (err, results) {
        debug('getImplicitToken async series returned.');
        if (err) {
            debug('but failed.');
            console.error(err);
            console.error(err.stack);
            return callback(err);
        }

        // Oh, wow, that worked.
        callback(null, oauthInfo.redirectUri);
    });
}

function getPasswordToken(app, inputData, callback) {
    debug('getPasswordToken()');
    // We'll add info to this thing along the way; this is how it will look:
    // {
    //   inputData: {
    //     authenticated_userid: (user custom ID, e.g. from 3rd party DB),
    //     api_id: (API ID)
    //     client_id: (The app's client ID, from subscription)
    //     scope: [ list of wanted scopes ] (optional, depending on API definition)
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
    //     username: (app id)$(api_id)
    //     custom_id: (subscription id)
    //   },
    //   apiInfo: {
    //     strip_request_path: true,
    //     preserve_host: false,
    //     name: "mobile",
    //     request_path : "/mobile/v1",
    //     id: "7baec4f7-131d-44e9-a746-312352cedab1",
    //     upstream_url: "https://upstream.url/api/v1",
    //     created_at: 1477320419000
    //   }
    //   accessToken: {
    //     access_token: "w493479837498374987984387498",
    //     expires_in: 3600,
    //     refresh_token: "843987409wr987498t743o56873456983475698",
    //     token_type: "bearer"
    //   }        
    // }
    const oauthInfo = { inputData: inputData };

    async.series([
        callback => lookupSubscription(app, oauthInfo, callback),
        //callback => lookupApplication(app, oauthInfo, callback),
        callback => getProvisionKey(app, oauthInfo, callback),
        callback => lookupConsumer(app, oauthInfo, callback),
        callback => lookupApi(app, oauthInfo, callback),
        callback => authorizeConsumerPasswordGrant(app, oauthInfo, callback)
    ], function (err, results) {
        debug('getPasswordToken async series returned.');
        if (err) {
            debug('but failed.');
            console.error(err);
            console.error(err.stack);
            return callback(err);
        }

        // Oh, wow, that worked.
        callback(null, oauthInfo.accessToken);
    });    
}

function getRefreshedToken(app, inputData, callback) {
    debug('getRefreshedToken()');
    // We'll add info to this thing along the way; this is how it will look:
    // {
    //   inputData: {
    //     authenticated_userid: (user custom ID, e.g. from 3rd party DB),
    //     api_id: (API ID)
    //     client_id: (The app's client ID, from subscription)
    //     scope: [ list of wanted scopes ] (optional, depending on API definition)
    //   }
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
    //     username: (app id)$(api_id)
    //     custom_id: (subscription id)
    //   },
    //   apiInfo: {
    //     strip_request_path: true,
    //     preserve_host: false,
    //     name: "mobile",
    //     request_path : "/mobile/v1",
    //     id: "7baec4f7-131d-44e9-a746-312352cedab1",
    //     upstream_url: "https://upstream.url/api/v1",
    //     created_at: 1477320419000
    //   }
    //   accessToken: {
    //     access_token: "w493479837498374987984387498",
    //     expires_in: 3600,
    //     refresh_token: "843987409wr987498t743o56873456983475698",
    //     token_type: "bearer"
    //   }        
    // }
    const oauthInfo = { inputData: inputData };

    async.series([
        callback => lookupSubscription(app, oauthInfo, callback),
        //callback => lookupApplication(app, oauthInfo, callback),
        callback => getProvisionKey(app, oauthInfo, callback),
        callback => lookupConsumer(app, oauthInfo, callback),
        callback => lookupApi(app, oauthInfo, callback),
        callback => authorizeConsumerRefreshToken(app, oauthInfo, callback)
    ], function (err, results) {
        debug('getRefreshedToken async series returned.');
        if (err) {
            debug('but failed.');
            console.error(err);
            console.error(err.stack);
            return callback(err);
        }

        // Oh, wow, that worked.
        callback(null, oauthInfo.accessToken);
    });    
}

function lookupSubscription(app, oauthInfo, callback) {
    debug('lookupSubscription()');
    utils.apiGet(app, 'subscriptions/' + oauthInfo.inputData.client_id, function (err, subscription) {
        if (err) {
            console.error(err);
            console.error(err.stack);
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
            console.error(err.stack);
            return callback(err);
        }
        if (body.data.length <= 0)
            return callback(buildError('For API ' + apiId + ', no oauth2 plugin seems to be configured.'));
        const oauth2Plugin = body.data[0];
//        if (!oauth2Plugin.config.enable_implicit_grant)
//            return callback(buildError('API ' + apiId + ' is not configured for the OAuth2 implicit grant.'));
        if (!oauth2Plugin.config.provision_key)
            return callback(buildError('API ' + apiId + ' does not have a valid provision_key.'));
        // Looks good, remember dat thing
        oauthInfo.oauth2Config = oauth2Plugin.config;
        oauthInfo.provisionKey = oauth2Plugin.config.provision_key;
        callback(null, oauthInfo);
    });
}

function lookupConsumer(app, oauthInfo, callback) {
    const customId = oauthInfo.subsInfo.id;
    debug('lookupConsumer() for subscription ' + customId);

    utils.kongGet(app, 'consumers?custom_id=' + qs.escape(customId), function (err, consumer) {
        if (err) {
            console.error(err);
            console.error(err.stack);
            return callback(err);
        }

        debug('Found these consumers for subscription ' + customId);
        debug(consumer);

        if (!consumer.total || 
            consumer.total <= 0 || 
            !consumer.data || 
            consumer.data.length <= 0)
            return callback(buildError('Could not retrieve Kong consumer for API consumer with custom_id ' + customId));

        oauthInfo.consumer = consumer.data[0];
        callback(null, oauthInfo);
    });
}

function lookupApi(app, oauthInfo, callback) {
    const apiId = oauthInfo.subsInfo.api;
    debug('lookupApi() for API + ' + apiId);
    utils.kongGet(app, 'apis/' + apiId, function (err, apiInfo) {
        if (err) {
            console.error(err);
            console.error(err.stack);
            return callback(err);
        }
        if (!apiInfo.request_path)
            return callback(buildError('API ' + apiId + ' does not have a valid request_path setting.'));
        oauthInfo.apiInfo = apiInfo;
        return callback(null, oauthInfo);
    });
}

function buildAuthorizeUrl(apiUrl, requestPath, additionalPath) {
    let hostUrl = apiUrl;
    let reqPath = requestPath;
    let addPath = additionalPath;  
    if (!hostUrl.endsWith('/'))
        hostUrl = hostUrl + '/';
    if (reqPath.startsWith('/'))
        reqPath = reqPath.substring(1); // cut leading /
    if (!reqPath.endsWith('/'))
        reqPath = reqPath + '/';
    if (addPath.startsWith('/'))
        addPath = addPath.substring(1); // cut leading /
    return hostUrl + reqPath + addPath;
}

function authorizeConsumerImplicitGrant(app, oauthInfo, callback) {
    debug('authorizeConsumerImplicitGrant()');
    // Check that the API is configured for implicit grant
    if (!oauthInfo.oauth2Config ||
        !oauthInfo.oauth2Config.enable_implicit_grant)
        return callback(buildError('The API ' + oauthInfo.inputData.api_id + ' is not configured for the OAuth2 implicit grant.'), 400);
    let apiUrl = wicked.getExternalApiUrl();
    const authorizeUrl = buildAuthorizeUrl(apiUrl, oauthInfo.apiInfo.request_path, '/oauth2/authorize');
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
        client_id: oauthInfo.subsInfo.clientId,
        redirect_uri: oauthInfo.appInfo.redirectUri,
        authenticated_userid: oauthInfo.inputData.authenticated_userid
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
            console.error(err.stack);
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

function authorizeConsumerPasswordGrant(app, oauthInfo, callback) {
    debug('authorizeConsumerPasswordGrant()');
    // Check that the API is configured for password grant
    if (!oauthInfo.oauth2Config ||
        !oauthInfo.oauth2Config.enable_password_grant)
        return callback(buildError('The API ' + oauthInfo.inputData.api_id + ' is not configured for the OAuth2 resource owner password grant.'), 400);
    let apiUrl = wicked.getExternalApiUrl();
    const tokenUrl = buildAuthorizeUrl(apiUrl, oauthInfo.apiInfo.request_path, '/oauth2/token');
    debug('tokenUrl: ' + tokenUrl);

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
        grant_type: 'password',
        provision_key: oauthInfo.provisionKey,
        client_id: oauthInfo.subsInfo.clientId,
        client_secret: oauthInfo.subsInfo.clientSecret,
        authenticated_userid: oauthInfo.inputData.authenticated_userid
    };
    if (scope)
        oauthBody.scope = scope;
    debug(oauthBody);

    // Jetzt kommt der spannende Moment, wo der Frosch ins Wasser rennt
    request.post({
        url: tokenUrl,
        headers: headers,
        agent: agent,
        json: true,
        body: oauthBody
    }, function (err, res, body) {
        if (err) {
            console.error(err);
            console.error(err.stack);
            return callback(err);
        }
        if (res.statusCode > 299) {
            debug('Kong did not create an access token, response body:');
            debug(body);
            return callback(buildError('Authorize user with password grant in Kong failed: ' + utils.getText(body), res.statusCode));
        }
        const jsonBody = utils.getJson(body);
        debug('Created access token via password grant:');
        debug(jsonBody);
        oauthInfo.accessToken = jsonBody;
        return callback(null, oauthInfo);
    });
}

function authorizeConsumerRefreshToken(app, oauthInfo, callback) {
    debug('authorizeConsumerPasswordGrant()');
    // Check that the API is configured for password grant
    if (!oauthInfo.oauth2Config ||
        (!oauthInfo.oauth2Config.enable_password_grant && !oauthInfo.oauth2Config.enable_authorization_code)) {
        debug(oauthInfo.oauth2Config);
        return callback(buildError('The API ' + oauthInfo.inputData.api_id + ' is not configured for granting refresh token requests.'), 400);
    }
    let apiUrl = wicked.getExternalApiUrl();
    const tokenUrl = buildAuthorizeUrl(apiUrl, oauthInfo.apiInfo.request_path, '/oauth2/token');
    debug('tokenUrl: ' + tokenUrl);

    let headers = null;
    let agent = null;

    // Workaround for local connections and testing
    if ('http' === app.kongGlobals.network.schema) {
        headers = { 'X-Forwarded-Proto': 'https' };
    } else if ('https' === app.kongGlobals.network.schema) {
        // Make sure we accept self signed certs
        agent = sslAgent;
    }

    const oauthBody = {
        grant_type: 'refresh_token',
        client_id: oauthInfo.subsInfo.clientId,
        client_secret: oauthInfo.subsInfo.clientSecret,
        refresh_token: oauthInfo.inputData.refresh_token
    };

    // Jetzt kommt der spannende Moment, wo der Frosch ins Wasser rennt
    request.post({
        url: tokenUrl,
        headers: headers,
        agent: agent,
        json: true,
        body: oauthBody
    }, function (err, res, body) {
        if (err) {
            console.error(err);
            console.error(err.stack);
            return callback(err);
        }
        if (res.statusCode > 299) {
            debug('Kong did not create an access token, response body:');
            debug(body);
            return callback(buildError('Refresh token in Kong failed: ' + utils.getText(body), res.statusCode));
        }
        const jsonBody = utils.getJson(body);
        debug('Created access token via refresh token:');
        debug(jsonBody);
        oauthInfo.accessToken = jsonBody;
        return callback(null, oauthInfo);
    });
}

////// CODE ATTIC //////

/*
 * The below code is not bad, but it does things for which Kong
 * was not really intended. It federates a user email and custom_id
 * as a consumer into Kong, instead of just passing in the "authenticated_userid"
 * into the OAuth2 token (this is intended). I don't want to throw the
 * code away, but have just commented it out for the time being.
 *
 * It may be that this code is re-used some time in the future, but
 * for the first support of the oauth2 implicit grant flow, I will
 * leave it out.
 * 
 * /Martin
//
 
oauth2.registerUser = function (app, res, inputData) {
    debug('registerUser()');
    debug(inputData);
    async.series({
        validate: function (callback) { validateInputData(inputData, callback); },
        redirectUri: function (callback) { registerOAuthUser(app, inputData, callback); }
    }, function (err, results) {
        if (err) {
            console.error(err.message);
            console.error(err.stack);
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
            console.error(err.stack);
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
            console.error(err.stack);
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
            console.error(err.stack);
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
            console.error(err.stack);
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
            console.error(err.stack);
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
            console.error(err.stack);
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
            console.error(err.stack);
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
            console.error(err.stack);
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
                console.error(err.stack);
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
            console.error(err.stack);
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

//*/

module.exports = oauth2;