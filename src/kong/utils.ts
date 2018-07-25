import { SyncStatistics } from "./types";

'use strict';

const request = require('request');
const { debug, info, warn, error } = require('portal-env').Logger('kong-adapter:utils');
const crypto = require('crypto');
const wicked = require('wicked-sdk');
const fs = require('fs');
const path = require('path');

export function getUtc() {
    return Math.floor((new Date()).getTime() / 1000);
}

export function createRandomId() {
    return crypto.randomBytes(20).toString('hex');
}

export function getJson(ob) {
    if (typeof ob === "string") {
        if (ob === "")
            return null;
        return JSON.parse(ob);
    }
    return ob;
}

export function getText(ob) {
    if (typeof ob === "string")
        return ob;
    return JSON.stringify(ob, null, 2);
};

export function clone(ob) {
    return JSON.parse(JSON.stringify(ob));
};

export function getIndexBy(anArray, predicate) {
    for (let i = 0; i < anArray.length; ++i) {
        if (predicate(anArray[i]))
            return i;
    }
    return -1;
};

/**
 * Check for left side inclusion in right side, NOT vice versa
 */
export function matchObjects(apiObject, kongObject) {
    debug('matchObjects()');
    const returnValue = matchObjectsInternal(apiObject, kongObject);
    if (!returnValue) {
        debug(' - objects do not match.');
        debug('apiObject: ' + JSON.stringify(apiObject, null, 2));
        debug('kongObject: ' + JSON.stringify(kongObject, null, 2));
        if (_keepChangingActions) {
            // Store mismatching matches; this is a debugging mechanism for the
            // integration tests mostly. Find out which objects do not match and
            // and enable checking on them.
            _statistics.failedComparisons.push({
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

export function apiGet(app, url, callback) {
    debug('apiGet(): ' + url);
    wicked.apiGet(url, callback);
};

export function apiGetAsUser(app, url, userId, callback) {
    debug('apiGetAsUser(): ' + url + ', as ' + userId);
    wicked.apiGet(url, userId, callback);
};

export function apiPut(app, url, body, callback) {
    debug('apiPut() ' + url);
    wicked.apiPut(url, body, callback);
};

export function apiDelete(app, url, callback) {
    debug('apiDelete() ' + url);
    wicked.apiDelete(url, callback);
};

let _kongAvailable = true; // Otherwise the first call will not succeed
let _kongMessage = null;
let _kongClusterStatus = null;
export function markKongAvailable(kongAvailable, kongMessage, clusterStatus) {
    _kongAvailable = kongAvailable;
    _kongMessage = kongMessage;
    _kongClusterStatus = clusterStatus;
}

export function getKongClusterStatus() {
    return _kongClusterStatus;
};

function defaultStatistics(): SyncStatistics {
    return {
        actions: [],
        failedComparisons: []
    };
}
let _statistics = defaultStatistics();
let _keepChangingActions = false;

/**
 * Resets the counters of actions taken against the Kong API; useful when debugging
 * why changes are redone over and over again, and used specifically in the integration
 * test suite to make sure the models created from the portal API configuration and the
 * ones present in the Kong database match.
 *
 * See also kongMain.resync() (the /resync end point).
*/
export function resetStatistics(keepChangingActions) {
    _statistics = defaultStatistics();
    if (keepChangingActions)
        _keepChangingActions = true;
    else
        _keepChangingActions = false;
};

/**
 * Retrieves a list of usage statistics, including a list of "changing" API calls
 * to Kong, in case the flag "keep changing settings" was activated when the statistics
 * were reset. This is used in conjunction with the /resync end point to check
 * whether a resync is a complete NOP after the sync queue has already been worked off.
 *
 * Part of the statistics is also a list of objects which did not match when comparing,
 * see "matchObjects" for more information.
 */
export function getStatistics(): SyncStatistics {
    _keepChangingActions = false;
    return _statistics;
};

/**
 * Helper method to record Kong API action statistics, and possible also to record
 * a list of changing API calls for debugging purposes (integration tests).
 */
function kongActionStat(method, url, body) {
    if (!_statistics[method])
        _statistics[method] = 0;
    _statistics[method]++;
    if (_keepChangingActions &&
        method != 'GET') {
        _statistics.actions.push({
            method: method,
            url: url,
            body: body
        });
    }
}

function kongAction(app, method, url, body, expectedStatusCode, callback) {
    debug('kongAction(), ' + method + ', ' + url);
    kongActionStat(method, url, body);

    // If for some reason, we think Kong is not available, tell the upstream
    if (!_kongAvailable) {
        const err: any = new Error('kong admin end point not available: ' + _kongMessage);
        err.status = 500;
        return callback(err);
    }

    // Now do our thing
    const kongUrl = app.get('kong_url');
    const methodBody: any = {
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
            const err: any = new Error('kongAction ' + method + ' on ' + url + ' did not return the expected status code (got: ' + apiResponse.statusCode + ', expected: ' + expectedStatusCode + ').');
            err.status = apiResponse.statusCode;
            debug(method + ' /' + url);
            debug(methodBody);
            debug(apiBody);
            //console.error(apiBody);
            return callback(err);
        }
        callback(null, getJson(apiBody));
    });
}

export function kongGet(app, url, callback) {
    kongAction(app, 'GET', url, null, 200, callback);
};

export function kongPost(app, url, body, callback) {
    kongAction(app, 'POST', url, body, 201, callback);
};

export function kongDelete(app, url, callback) {
    kongAction(app, 'DELETE', url, null, 204, callback);
};

export function kongPatch(app, url, body, callback) {
    kongAction(app, 'PATCH', url, body, 200, callback);
};

export function getPlan(app, planId, callback) {
    debug('getPlan() - ' + planId);
    getPlans(app, function (err, plans) {
        if (err)
            return callback(err);
        internalGetPlan(plans, planId, callback);
    });
};

let _plans = null;
export function getPlans(app, callback) {
    debug('getPlans()');
    if (!_plans) {
        apiGet(app, 'plans', function (err, results) {
            if (err)
                return callback(err);
            _plans = results;
            return callback(null, _plans);
        });
    } else {
        return callback(null, _plans);
    }
};

function internalGetPlan(plans, planId, callback) {
    const plan = plans.plans.find(p => p.id === planId);
    if (!plan)
        return callback(new Error('Unknown plan ID: ' + planId));
    return callback(null, plan);
}

let _groups = null;
export function getGroups() {
    debug(`getGroups()`);
    if (!_groups)
        throw new Error('utils: _groups is not initialized; before calling getGroups(), initGroups() must have been called.');
    return _groups;
};

/**
 * Initialize the cache for the wicked user groups so that getGroups() can be
 * implemented synchronuously.
 * 
 * @param callback 
 */
export function initGroups(callback) {
    debug(`initGroups()`);
    wicked.getGroups((err, groups) => {
        if (err)
            return callback(err);
        _groups = groups;
        return callback(null, groups);
    });
};

export function findWithName(someArray: any[], name: string): any {
    for (let i = 0; i < someArray.length; ++i) {
        if (someArray[i].name === name)
            return someArray[i];
    }
    return null;
};

export function makeUserName(appId, apiId) {
    return appId + '$' + apiId;
};

let _packageFile = null;
export function getPackageJson() {
    if (!_packageFile) {
        // Deliberately do not do any error handling here! package.json MUST exist.
        const packageFile = path.join(__dirname, '..', 'package.json');
        _packageFile = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    }
    return _packageFile;
};

let _packageVersion = null;
export function getVersion() {
    if (!_packageVersion) {
        const packageInfo = getPackageJson();
        if (packageInfo.version)
            _packageVersion = packageInfo.version;
    }
    if (!_packageVersion) // something went wrong
        _packageVersion = "0.0.0";
    return _packageVersion;
};

let _expectedKongVersion = null;
export function getExpectedKongVersion() {
    if (!_expectedKongVersion) {
        const packageInfo = getPackageJson();
        if (packageInfo.config && packageInfo.config.kongversion)
            _expectedKongVersion = packageInfo.config.kongversion;
    }
    if (!_expectedKongVersion)
        throw new Error('package.json does not contain config.kongversion!');
    return _expectedKongVersion;
};

let _gitLastCommit = null;
export function getGitLastCommit() {
    if (!_gitLastCommit) {
        const lastCommitFile = path.join(__dirname, '..', 'git_last_commit');
        if (fs.existsSync(lastCommitFile))
            _gitLastCommit = fs.readFileSync(lastCommitFile, 'utf8');
        else
            _gitLastCommit = '(no last git commit found - running locally?)';
    }
    return _gitLastCommit;
};

let _gitBranch = null;
export function getGitBranch() {
    if (!_gitBranch) {
        const gitBranchFile = path.join(__dirname, '..', 'git_branch');
        if (fs.existsSync(gitBranchFile))
            _gitBranch = fs.readFileSync(gitBranchFile, 'utf8');
        else
            _gitBranch = '(unknown)';
    }
    return _gitBranch;
};

let _buildDate = null;
export function getBuildDate() {
    if (!_buildDate) {
        const buildDateFile = path.join(__dirname, '..', 'build_date');
        if (fs.existsSync(buildDateFile))
            _buildDate = fs.readFileSync(buildDateFile, 'utf8');
        else
            _buildDate = '(unknown build date)';
    }
    return _buildDate;
};
