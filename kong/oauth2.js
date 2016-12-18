'use strict';

var async = require('async');
var debug = require('debug')('kong-adapter:oauth2');
var qs = require('querystring');
var request = require('request');
var wicked = require('wicked-sdk');

var utils = require('./utils');
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

oauth2.getAuthorizationCode = function (app, res, inputData) {
    debug('getAuthorizationCode()');
    debug(inputData);
    async.series({
        validate: function (callback) { validateInputData(inputData, callback); },
        redirectUri: function (callback) { getAuthorizationCode(app, inputData, callback); }
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

        const redirectUri = results.redirectUri;

        res.json({
            redirect_uri: redirectUri
        });
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
    //     auth_server: (optional, which auth server is calling? Used to check that API is configured to use this auth server)
    //     scope: [ list of wanted scopes ] (optional, depending on API definition)
    //   }
    //   provisionKey: ...
    //   subsInfo: {
    //     application: (app ID)
    //     api: (api ID)
    //     auth: 'oauth2',
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

function getAuthorizationCode(app, inputData, callback) {
    const oauthInfo = { inputData: inputData };

    async.series([
        callback => lookupSubscription(app, oauthInfo, callback),
        //callback => lookupApplication(app, oauthInfo, callback),
        callback => getProvisionKey(app, oauthInfo, callback),
        callback => lookupConsumer(app, oauthInfo, callback),
        callback => lookupApi(app, oauthInfo, callback),
        callback => authorizeConsumerAuthCode(app, oauthInfo, callback)
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
    //     auth_server: (optional, which auth server is calling? Used to check that API is configured to use this auth server)
    //     scope: [ list of wanted scopes ] (optional, depending on API definition)
    //   }
    //   provisionKey: ...
    //   subsInfo: {
    //     application: (app ID)
    //     api: (api ID)
    //     auth: 'oauth2',
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
    //     refresh_token: (the refresh token)
    //     api_id: (API ID)
    //     client_id: (The app's client ID, from subscription)
    //     auth_server: (optional, which auth server is calling? Used to check that API is configured to use this auth server)
    //   }
    //   subsInfo: {
    //     application: (app ID)
    //     api: (api ID)
    //     auth: 'oauth2',
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
    debug('lookupApi() for API ' + apiId);
    async.parallel({
        kongApi: callback => utils.kongGet(app, 'apis/' + apiId, callback),
        portalApi: callback => utils.apiGet(app, 'apis/' + apiId, callback)
    }, function (err, results) {
        if (err) {
            console.error(err);
            console.error(err.stack);
            return callback(err);
        }
        const apiInfo = results.kongApi;
        const portalApiInfo = results.portalApi;

        if (!apiInfo.request_path)
            return callback(buildError('API ' + apiId + ' does not have a valid request_path setting.'));

        // Check auth_server?
        if (oauthInfo.inputData.auth_server) {
            debug('Checking auth server ' + oauthInfo.inputData.auth_server);
            debug(portalApiInfo);
            if (!portalApiInfo.authServers || portalApiInfo.authServers.length <= 0) {
                debug('No auth servers configured for API ' + apiId);
                return callback(buildError('API ' + apiId + ' does not have an authServers property, cannot verify Auth Server validity.'));
            }
            let foundAuthServer = false;
            for (let i = 0; i < portalApiInfo.authServers.length; ++i) {
                if(portalApiInfo.authServers[i] === oauthInfo.inputData.auth_server) {
                    foundAuthServer = true;
                    break;
                }
            }
            if (!foundAuthServer) {
                debug('Auth Server not found in authServers list.');
                return callback(buildError('API ' + apiId + ' is not configured for use with Authorization Server ' + oauthInfo.inputData.auth_server));
            }
            debug('Auth Server ' + oauthInfo.inputData.auth_server + ' is okay for API ' + apiId);
        }
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

function getAuthorizeRequest(app, responseType, oauthInfo) {
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
        response_type: responseType,
        provision_key: oauthInfo.provisionKey,
        client_id: oauthInfo.subsInfo.clientId,
        redirect_uri: oauthInfo.appInfo.redirectUri,
        authenticated_userid: oauthInfo.inputData.authenticated_userid
    };
    if (scope)
        oauthBody.scope = scope;
    debug(oauthBody);

    const requestParameters = {
        url: authorizeUrl,
        headers: headers,
        agent: agent,
        json: true,
        body: oauthBody
    };

    return requestParameters;
}

function authorizeConsumerImplicitGrant(app, oauthInfo, callback) {
    debug('authorizeConsumerImplicitGrant()');
    // Check that the API is configured for implicit grant
    if (!oauthInfo.oauth2Config ||
        !oauthInfo.oauth2Config.enable_implicit_grant)
        return callback(buildError('The API ' + oauthInfo.inputData.api_id + ' is not configured for the OAuth2 implicit grant.'), 400);

    const requestParameters = getAuthorizeRequest(app, 'token', oauthInfo);

    // Jetzt kommt der spannende Moment, wo der Frosch ins Wasser rennt
    request.post(requestParameters, function (err, res, body) {
        debug('Kong authorize response:');
        debug(body);
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
        debug('Kong authorize response:');
        debug(body);
        const jsonBody = utils.getJson(body);
        oauthInfo.redirectUri = jsonBody.redirect_uri;
        return callback(null, oauthInfo);
    });
}

function authorizeConsumerAuthCode(app, oauthInfo, callback) {
    debug('authorizeConsumerAuthCode()');
    // Check that the API is configured for implicit grant
    if (!oauthInfo.oauth2Config ||
        !oauthInfo.oauth2Config.enable_authorization_code)
        return callback(buildError('The API ' + oauthInfo.inputData.api_id + ' is not configured for the OAuth2 Authorization Code grant.'), 400);

    const requestParameters = getAuthorizeRequest(app, 'code', oauthInfo);

    // Jetzt kommt der spannende Moment, wo der Frosch ins Wasser rennt
    request.post(requestParameters, function (err, res, body) {
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
        debug('Kong authorize response:');
        debug(body);
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

module.exports = oauth2;