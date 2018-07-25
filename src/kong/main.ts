'use strict';

const async = require('async');
const { debug, info, warn, error } = require('portal-env').Logger('kong-adapter:main');

import * as wicked from 'wicked-sdk';
import * as utils from './utils';
import { sync } from './sync';
import { WickedEvent, WickedWebhookListener, WickedGlobals } from 'wicked-sdk';

const MAX_ASYNC_CALLS = 10;

// ====== PUBLIC INTERFACE ======

export const kongMain = {

    init: function (options, done) {
        debug('init()');
        async.series({
            initGlobals: function (callback) {
                if (options.initGlobals) {
                    debug('Calling initGlobals()');
                    registerWebhookListener(callback);
                } else {
                    callback(null);
                }
            },
            syncApis: function (callback) {
                if (options.syncApis) {
                    debug('Calling sync.syncApis()');
                    sync.syncApis(callback);
                } else {
                    callback(null);
                }
            },
            processPendingEvents: function (callback) {
                if (options.syncConsumers) {
                    processPendingWebhooks(callback);
                } else {
                    callback(null);
                }
            },
            syncConsumers: function (callback) {
                if (options.syncConsumers) {
                    debug('Calling sync.syncConsumers()');
                    sync.syncAllConsumers(callback);
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
    },

    resync: function (done) {
        const initOptions = {
            syncApis: true,
            syncConsumers: true
        };
        kongMain.init(initOptions, done);
    },

    processWebhooks: function (webhookList, done) {
        debug('processWebhooks()');
        const onlyDelete = false;
        async.eachSeries(webhookList, (webhookData, callback) => dispatchWebhookAction(webhookData, onlyDelete, callback), done);
    },

    deinit: function (done) {
        // Don't do this; this can result in glitches in the database; let
        // the wicked API store our events until we return.
        //utils.apiDelete('webhooks/listeners/kong-adapter', done);
        setTimeout(done, 0);
    }
};


function processPendingWebhooks(done) {
    debug('processPendingWebhooks()');
    wicked.getWebhookEvents('kong-adapter', function (err, pendingEvents) {
        if (err)
            return done(err);
        const onlyDelete = true;
        if (!containsImportEvent(pendingEvents)) {
            async.eachSeries(pendingEvents, (webhookData, callback) => dispatchWebhookAction(webhookData, onlyDelete, callback), done);
        } else {
            // we have seen an import since we last lived; wipe consumers, re-sync them, and acknowledge everything.
            async.series([
                callback => doPostImport(callback),
                callback => acknowledgeEvents(pendingEvents, callback)
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

function dispatchWebhookAction(webhookData, onlyDelete, callback) {
    debug('dispatchWebhookAction()');
    const action = webhookData.action;
    const entity = webhookData.entity;
    debug('action = ' + action + ', entity = ' + entity);
    let syncAction = null;
    if (entity === 'application' && (action === 'add' || action === 'update') && !onlyDelete)
        syncAction = callback => syncAppConsumers(webhookData.data.applicationId, callback);
    else if (entity === 'application' && action === 'delete')
        syncAction = callback => deleteAppConsumers(webhookData.data.applicationId, webhookData.data.subscriptions, callback);
    else if (entity === 'subscription' && (action === 'add' || action === 'update') && !onlyDelete)
        syncAction = callback => syncAppConsumers(webhookData.data.applicationId, callback);
    else if (entity === 'subscription' && action === 'delete')
        syncAction = callback => deleteAppSubscriptionConsumer(webhookData.data, callback);
    else if (entity === 'import') // Woooo!
        syncAction = callback => doPostImport(callback);

    async.series([
        callback => {
            if (syncAction)
                return syncAction(callback);
            return callback(null);
        },
        callback => acknowledgeEvent(webhookData.id, callback)
    ], function (err) {
        if (err)
            return callback(err);
        callback(null);
    });
}

function syncAppConsumers(appId, callback) {
    // Relay to sync
    sync.syncAppConsumers(appId, callback);
}

function deleteAppConsumers(appId, subscriptionList, callback) {
    // Just relay
    sync.deleteAppConsumers(appId, subscriptionList, callback);
}

function deleteAppSubscriptionConsumer(webhookSubsInfo, callback) {
    // The subsInfo in the webhook is a little different from the persisted ones.
    // We need to translate them.
    const subsInfo = {
        id: webhookSubsInfo.subscriptionId,
        application: webhookSubsInfo.applicationId,
        api: webhookSubsInfo.apiId,
        userId: webhookSubsInfo.userId,
        auth: webhookSubsInfo.auth
    };
    sync.deleteAppSubscriptionConsumer(subsInfo, callback);
}

function acknowledgeEvents(eventList: WickedEvent[], done) {
    debug('acknowledgeEvents()');
    async.mapLimit(eventList, MAX_ASYNC_CALLS, (event, callback) => acknowledgeEvent(event.id, callback), done);
}

function acknowledgeEvent(eventId, callback) {
    wicked.deleteWebhookEvent('kong-adapter', eventId, callback);
}

function doPostImport(done) {
    debug('doPostImport()');
    async.series([
        callback => sync.wipeAllConsumers(callback),
        callback => sync.syncAllConsumers(callback)
    ], done);
}

// ====== INTERNALS =======

function registerWebhookListener(done) {
    debug('registerWebhookListener()');
    const myUrl = utils.getMyUrl();

    const putPayload: WickedWebhookListener = {
        id: 'kong-adapter',
        url: myUrl
    };
    wicked.upsertWebhookListener('kong-adapter', putPayload, done);
}
