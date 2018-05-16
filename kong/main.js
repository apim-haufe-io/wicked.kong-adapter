'use strict';

const async = require('async');
const { debug, info, warn, error } = require('portal-env').Logger('kong-adapter:main');

const utils = require('./utils');
//const kong = require('./kong');
//const portal = require('./portal');
const sync = require('./sync');

const kongMain = function () { };

const MAX_ASYNC_CALLS = 10;

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
        processPendingEvents: function (callback) {
            if (options.syncConsumers) {
                processPendingWebhooks(app, callback);
            } else {
                callback(null);
            }
        },
        syncConsumers: function (callback) {
            if (options.syncConsumers) {
                debug('Calling sync.syncConsumers()');
                sync.syncAllConsumers(app, callback);
            } else {
                callback(null);
            }
        }
    }, function (err) {
        if (err) {
            return done(err);
        }
        debug("kong.init() done.");
        console.log('=========================================');
        console.log('========== INITIALIZATION DONE ==========');
        console.log('=========================================');
        done(null);
    });
};

kongMain.resync = function (app, done) {
    const initOptions = {
        syncApis: true,
        syncConsumers: true
    };
    kongMain.init(app, initOptions, done);
};

kongMain.processWebhooks = function (app, webhookList, done) {
    debug('processWebhooks()');
    const onlyDelete = false;
    async.eachSeries(webhookList, (webhookData, callback) => dispatchWebhookAction(app, webhookData, onlyDelete, callback), done);
};

function processPendingWebhooks(app, done) {
    debug('processPendingWebhooks()');
    utils.apiGet(app, 'webhooks/events/kong-adapter', function (err, pendingEvents) {
        if (err)
            return done(err);
        const onlyDelete = true;
        if (!containsImportEvent(pendingEvents)) {
            async.eachSeries(pendingEvents, (webhookData, callback) => dispatchWebhookAction(app, webhookData, onlyDelete, callback), done);
        } else {
            // we have seen an import since we last lived; wipe consumers, re-sync them, and acknowledge everything.
            async.series([
                callback => doPostImport(app, callback),
                callback => acknowledgeEvents(app, pendingEvents, callback)
            ], done);
        }
    });
}

function containsImportEvent(eventList) {
    if (!eventList)
        return false;
    const importEvent = eventList.find(e => e.entity === 'import');
    return !!importEvent;
}

function dispatchWebhookAction(app, webhookData, onlyDelete, callback) {
    debug('dispatchWebhookAction()');
    const action = webhookData.action;
    const entity = webhookData.entity;
    debug('action = ' + action + ', entity = ' + entity);
    let syncAction = null;
    if (entity === 'application' && (action === 'add' || action === 'update') && !onlyDelete)
        syncAction = callback => syncAppConsumers(app, webhookData.data.applicationId, callback);
    else if (entity === 'application' && action === 'delete')
        syncAction = callback => deleteAppConsumers(app, webhookData.data.applicationId, webhookData.data.subscriptions, callback);
    else if (entity === 'subscription' && (action === 'add' || action === 'update') && !onlyDelete)
        syncAction = callback => syncAppConsumers(app, webhookData.data.applicationId, callback);
    else if (entity === 'subscription' && action === 'delete')
        syncAction = callback => deleteAppSubscriptionConsumer(app, webhookData.data, callback);
    else if (entity === 'import') // Woooo!
        syncAction = callback => doPostImport(app, callback);

    async.series([
        callback => {
            if (syncAction)
                return syncAction(callback);
            return callback(null);
        },
        callback => acknowledgeEvent(app, webhookData.id, callback)
    ], function (err) {
        if (err)
            return callback(err);
        callback(null);
    });
}

function syncAppConsumers(app, appId, callback) {
    // Relay to sync
    sync.syncAppConsumers(app, appId, callback);
}

function deleteAppConsumers(app, appId, subscriptionList, callback) {
    // Just relay
    sync.deleteAppConsumers(app, appId, subscriptionList, callback);
}

function deleteAppSubscriptionConsumer(app, webhookSubsInfo, callback) {
    // The subsInfo in the webhook is a little different from the persisted ones.
    // We need to translate them.
    const subsInfo = {
        id: webhookSubsInfo.subscriptionId,
        application: webhookSubsInfo.applicationId,
        api: webhookSubsInfo.apiId,
        userId: webhookSubsInfo.userId,
        auth: webhookSubsInfo.auth
    };
    sync.deleteAppSubscriptionConsumer(app, subsInfo, callback);
}

function acknowledgeEvents(app, eventList, done) {
    debug('acknowledgeEvents()');
    async.mapLimit(eventList, MAX_ASYNC_CALLS, (event, callback) => acknowledgeEvent(app, event.id, callback), done);
}

function acknowledgeEvent(app, eventId, callback) {
    utils.apiDelete(app, 'webhooks/events/kong-adapter/' + eventId, callback);
}

function doPostImport(app, done) {
    debug('doPostImport()');
    async.series([
        callback => sync.wipeAllConsumers(app, callback),
        callback => sync.syncAllConsumers(app, callback)
    ], done);
}

kongMain.deinit = function (app, done) {
    // Don't do this; this can result in glitches in the database; let
    // the wicked API store our events until we return.
    //utils.apiDelete(app, 'webhooks/listeners/kong-adapter', done);
    setTimeout(done, 0);
};

// ====== INTERNALS =======

function initGlobals(app, done) {
    debug('initGlobals()');
    const myUrl = app.get('my_url');

    async.parallel({
        registerWebhook: function (callback) {
            const putPayload = {
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
