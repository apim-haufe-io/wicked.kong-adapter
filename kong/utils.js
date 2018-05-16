'use strict';

const request = require('request');
const { debug, info, warn, error } = require('portal-env').Logger('kong-adapter:utils');
const crypto = require('crypto');
const wicked = require('wicked-sdk');
const fs = require('fs');
const path = require('path');

const utils = function () { };

utils.getUtc = function () {
    return Math.floor((new Date()).getTime() / 1000);
};

utils.createRandomId = function () {
    return crypto.randomBytes(20).toString('hex');
};

utils.getJson = function (ob) {
    if (ob instanceof String || typeof ob === "string") {
        if (ob === "")
            return null;
        return JSON.parse(ob);
    }
    return ob;
};

utils.getText = function (ob) {
    if (ob instanceof String || typeof ob === "string")
        return ob;
    return JSON.stringify(ob, null, 2);
};

utils.clone = function (ob) {
    return JSON.parse(JSON.stringify(ob));
};

utils.getIndexBy = function (anArray, predicate) {
    for (let i = 0; i < anArray.length; ++i) {
        if (predicate(anArray[i]))
            return i;
    }
    return -1;
};

// Check for left side inclusion in right side, NOT vice versa
utils.matchObjects = function (apiObject, kongObject) {
    debug('matchObjects()');
    const returnValue = matchObjectsInternal(apiObject, kongObject);
    if (!returnValue) {
        debug(' - objects do not match.');
        debug('apiObject: ' + JSON.stringify(apiObject, null, 2));
        debug('kongObject: ' + JSON.stringify(kongObject, null, 2));
        if (utils._keepChangingActions) {
            // Store mismatching matches; this is a debugging mechanism for the
            // integration tests mostly. Find out which objects do not match and
            // and enable checking on them.
            utils._statistics.failedComparisons.push({
                apiObject: apiObject,
                kongObject: kongObject
            });
        }
    }
    return returnValue;
};

function matchObjectsInternal(apiObject, kongObject) {
    for (let prop in apiObject) {
        if (!kongObject.hasOwnProperty(prop)) {
            //console.log('Kong object does not have property "' + prop + '".');
            return false;
        }
        if ((typeof apiObject[prop]) != (typeof kongObject[prop]))
            return false;
        if (typeof apiObject[prop] == "object") { // Recurse please
            if (!matchObjectsInternal(apiObject[prop], kongObject[prop]))
                return false;
        } else { // other types
            if (apiObject[prop] != kongObject[prop]) {
                //console.log('Property "' + prop + '" does not match ("' + apiObject[prop] + '" vs "' + kongObject[prop] + '").');
                return false;
            }
        }
    }
    return true;
}

utils.apiGet = function (app, url, callback) {
    debug('apiGet(): ' + url);
    wicked.apiGet(url, callback);
};

utils.apiGetAsUser = function (app, url, userId, callback) {
    debug('apiGetAsUser(): ' + url + ', as ' + userId);
    wicked.apiGet(url, userId, callback);
};

utils.apiPut = function (app, url, body, callback) {
    debug('apiPut() ' + url);
    wicked.apiPut(url, body, callback);
};

utils.apiDelete = function (app, url, callback) {
    debug('apiDelete() ' + url);
    wicked.apiDelete(url, callback);
};

utils._kongAvailable = true; // Otherwise the first call will not succeed
utils._kongMessage = null;
utils._kongClusterStatus = null;
utils.markKongAvailable = function (kongAvailable, kongMessage, clusterStatus) {
    utils._kongAvailable = kongAvailable;
    utils._kongMessage = kongMessage;
    utils._kongClusterStatus = clusterStatus;
};

utils.getKongClusterStatus = function () {
    return utils._kongClusterStatus;
};

function defaultStatistics() {
    return {
        actions: [],
        failedComparisons: []
    };
}
utils._statistics = defaultStatistics();
utils._keepChangingActions = false;
/*
    Resets the counters of actions taken against the Kong API; useful when debugging
    why changes are redone over and over again, and used specifically in the integration
    test suite to make sure the models created from the portal API configuration and the
    ones present in the Kong database match.

    See kongMain.resync() (the /resync end point).
*/
utils.resetStatistics = function (keepChangingActions) {
    utils._statistics = defaultStatistics();
    if (keepChangingActions)
        utils._keepChangingActions = true;
    else
        utils._keepChangingActions = false;
};

/*
    Retrieves a list of usage statistics, including a list of "changing" API calls
    to Kong, in case the flag "keep changing settings" was activated when the statistics
    were reset. This is used in conjunction with the /resync end point to check
    whether a resync is a complete NOP after the sync queue has already been worked off.

    Part of the statistics is also a list of objects which did not match when comparing,
    see "matchObjects" for more information.
*/
utils.getStatistics = function () {
    utils._keepChangingActions = false;
    return utils._statistics;
};

/*
    Helper method to record Kong API action statistics, and possible also to record
    a list of changing API calls for debugging purposes (integration tests).
*/
function kongActionStat(method, url, body) {
    if (!utils._statistics[method])
        utils._statistics[method] = 0;
    utils._statistics[method]++;
    if (utils._keepChangingActions &&
        method != 'GET') {
        utils._statistics.actions.push({
            method: method,
            url: url,
            body: body
        });
    }
}

function kongAction(app, method, url, body, expectedStatusCode, callback) {
    //console.log('$$$$$$ kongAction: ' + method + ' ' + url);
    //console.log(body);
    debug('kongAction(), ' + method + ', ' + url);
    kongActionStat(method, url, body);

    // If for some reason, we think Kong is not available, tell the upstream
    if (!utils._kongAvailable) {
        const err = new Error('kong admin end point not available: ' + utils._kongMessage);
        err.status = 500;
        return callback(err);
    }

    // Now do our thing
    const kongUrl = app.get('kong_url');
    const methodBody = {
        method: method,
        url: kongUrl + url
    };
    if (method != 'DELETE' &&
        method != 'GET') {
        methodBody.json = true;
        methodBody.body = body;
        if (process.env.KONG_CURL)
            console.error('curl -X ' + method + ' -d \'' + JSON.stringify(body) + '\' -H \'Content-Type: application/json\' ' + methodBody.url);
    } else {
        if (process.env.KONG_CURL)
            console.error('curl -X ' + method + ' ' + methodBody.url);
    }

    request(methodBody, function (err, apiResponse, apiBody) {
        if (err)
            return callback(err);
        if (expectedStatusCode != apiResponse.statusCode) {
            const err = new Error('kongAction ' + method + ' on ' + url + ' did not return the expected status code (got: ' + apiResponse.statusCode + ', expected: ' + expectedStatusCode + ').');
            err.status = apiResponse.statusCode;
            debug(method + ' /' + url);
            debug(methodBody);
            debug(apiBody);
            //console.error(apiBody);
            return callback(err);
        }
        callback(null, utils.getJson(apiBody));
    });
}

utils.kongGet = function (app, url, callback) {
    kongAction(app, 'GET', url, null, 200, callback);
};

utils.kongPost = function (app, url, body, callback) {
    kongAction(app, 'POST', url, body, 201, callback);
};

utils.kongDelete = function (app, url, callback) {
    kongAction(app, 'DELETE', url, null, 204, callback);
};

utils.kongPatch = function (app, url, body, callback) {
    kongAction(app, 'PATCH', url, body, 200, callback);
};

utils.getPlan = function (app, planId, callback) {
    debug('getPlan() - ' + planId);
    utils.getPlans(app, function (err, plans) {
        if (err)
            return callback(err);
        internalGetPlan(plans, planId, callback);
    });
};

utils._plans = null;
utils.getPlans = function (app, callback) {
    debug('getPlans()');
    if (!utils._plans) {
        utils.apiGet(app, 'plans', function (err, results) {
            if (err)
                return callback(err);
            utils._plans = results;
            return callback(null, utils._plans);
        });
    } else {
        return callback(null, utils._plans);
    }
};

function internalGetPlan(plans, planId, callback) {
    const plan = plans.plans.find(p => p.id === planId);
    if (!plan)
        return callback(new Error('Unknown plan ID: ' + planId));
    return callback(null, plan);
}

utils.findWithName = function (someArray, name) {
    for (let i = 0; i < someArray.length; ++i) {
        if (someArray[i].name === name)
            return someArray[i];
    }
    return null;
};

utils.makeUserName = function (appId, apiId) {
    return appId + '$' + apiId;
};

utils._packageFile = null;
utils.getPackageJson = function () {
    if (!utils._packageFile) {
        // Deliberately do not do any error handling here! package.json MUST exist.
        const packageFile = path.join(__dirname, '..', 'package.json');
        utils._packageFile = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    }
    return utils._packageFile;
};

utils._packageVersion = null;
utils.getVersion = function () {
    if (!utils._packageVersion) {
        const packageInfo = utils.getPackageJson();
        if (packageInfo.version)
            utils._packageVersion = packageInfo.version;
    }
    if (!utils._packageVersion) // something went wrong
        utils._packageVersion = "0.0.0";
    return utils._packageVersion;
};

utils._expectedKongVersion = null;
utils.getExpectedKongVersion = function () {
    if (!utils._expectedKongVersion) {
        const packageInfo = utils.getPackageJson();
        if (packageInfo.config && packageInfo.config.kongversion)
            utils._expectedKongVersion = packageInfo.config.kongversion;
    }
    if (!utils._expectedKongVersion)
        throw new Error('package.json does not contain config.kongversion!');
    return utils._expectedKongVersion;
};

utils._gitLastCommit = null;
utils.getGitLastCommit = function () {
    if (!utils._gitLastCommit) {
        const lastCommitFile = path.join(__dirname, '..', 'git_last_commit');
        if (fs.existsSync(lastCommitFile))
            utils._gitLastCommit = fs.readFileSync(lastCommitFile, 'utf8');
        else
            utils._gitLastCommit = '(no last git commit found - running locally?)';
    }
    return utils._gitLastCommit;
};

utils._gitBranch = null;
utils.getGitBranch = function () {
    if (!utils._gitBranch) {
        const gitBranchFile = path.join(__dirname, '..', 'git_branch');
        if (fs.existsSync(gitBranchFile))
            utils._gitBranch = fs.readFileSync(gitBranchFile, 'utf8');
        else
            utils._gitBranch = '(unknown)';
    }
    return utils._gitBranch;
};

utils._buildDate = null;
utils.getBuildDate = function () {
    if (!utils._buildDate) {
        const buildDateFile = path.join(__dirname, '..', 'build_date');
        if (fs.existsSync(buildDateFile))
            utils._buildDate = fs.readFileSync(buildDateFile, 'utf8');
        else
            utils._buildDate = '(unknown build date)';
    }
    return utils._buildDate;
};

module.exports = utils;