'use strict';

var request = require('request');
var debug = require('debug')('kong-adapter:utils');
var crypto = require('crypto');
var wicked = require('wicked-sdk');
var fs = require('fs');
var path = require('path');

var utils = function() { };

utils.getUtc = function () {
    return Math.floor((new Date()).getTime() / 1000);
};

utils.createRandomId = function () {
    return crypto.randomBytes(20).toString('hex');
};

utils.getJson = function(ob) {
    if (ob instanceof String || typeof ob === "string") {
        if (ob === "")
            return null;
        return JSON.parse(ob);
    }
    return ob;
};

utils.getText = function(ob) {
    if (ob instanceof String || typeof ob === "string")
        return ob;
    return JSON.stringify(ob, null, 2);
};

utils.clone = function (ob) {
    return JSON.parse(JSON.stringify(ob));
};

utils.getIndexBy = function(anArray, predicate) {
    for (var i=0; i<anArray.length; ++i) {
        if (predicate(anArray[i]))
            return i;
    }
    return -1;
};

// Check for left side inclusion in right side, NOT vice versa
utils.matchObjects = function(apiObject, kongObject) {
    debug('matchObjects()');
    var returnValue = matchObjectsInternal(apiObject, kongObject);
    if (!returnValue) {
        debug(' - objects do not match.');
        debug('apiObject: ' + JSON.stringify(apiObject, null, 2));
        debug('kongObject: ' + JSON.stringify(kongObject, null, 2));
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

utils.apiGet = function(app, url, callback) {
    debug('apiGet(): ' + url);
    wicked.apiGet(url, callback);
};

utils.apiGetAsUser = function (app, url, userId, callback) {
    debug('apiGetAsUser(): ' + url + ', as ' + userId);
    wicked.apiGet(url, userId, callback);
};

utils.apiPut = function(app, url, body, callback) {
    debug('apiPut() ' + url);
    wicked.apiPut(url, body, callback);
};

utils.apiDelete = function(app, url, callback) {
    debug('apiDelete() ' + url);
    wicked.apiDelete(url, callback);
};

function kongAction(app, method, url, body, expectedStatusCode, callback) {
    //console.log('$$$$$$ kongAction: ' + method + ' ' + url);
    //console.log(body);
    debug('kongAction(), ' + method + ', ' + url);
    var kongUrl = app.get('kong_url');
    var methodBody = {
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
    
    request(methodBody, function(err, apiResponse, apiBody) {
        if (err)
            return callback(err);
        if (expectedStatusCode != apiResponse.statusCode) {
            const err = new Error('kongAction ' + method + ' on ' + url + ' did not return the expected status code (got: ' + apiResponse.statusCode + ', expected: ' + expectedStatusCode + ').');
            err.status = apiResponse.statusCode;
            debug(apiBody);
            console.error(apiBody);
            return callback(err);
        }
        callback(null, utils.getJson(apiBody));
    });
}

utils.kongGet = function(app, url, callback) {
    kongAction(app, 'GET', url, null, 200, callback);
};

utils.kongPost = function(app, url, body, callback) {
    kongAction(app, 'POST', url, body, 201, callback);
};

utils.kongDelete = function(app, url, callback) {
    kongAction(app, 'DELETE', url, null, 204, callback);
};

utils.kongPatch = function(app, url, body, callback) {
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
    for (var i = 0; i < someArray.length; ++i) {
        if (someArray[i].name === name)
            return someArray[i];
    }
    return null;
};

utils.makeUserName = function (appId, apiId) {
    return appId + '$' + apiId;
};

utils._packageVersion = null;
utils.getVersion = function () {
    if (!utils._packageVersion) {
        const packageFile = path.join(__dirname, '..', 'package.json');
        if (fs.existsSync(packageFile)) {
            try {
                const packageInfo = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
                if (packageInfo.version)
                    utils._packageVersion = packageInfo.version;
            } catch (ex) {
                console.error(ex);
            }
        }
        if (!utils._packageVersion) // something went wrong
            utils._packageVersion = "0.0.0";
    }
    return utils._packageVersion;
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