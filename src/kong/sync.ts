'use strict';
/*jshint loopfunc: true */

import * as utils from './utils';

const async = require('async');
const { debug, info, warn, error } = require('portal-env').Logger('kong-adapter:sync');
import * as wicked from 'wicked-sdk';

import { kong } from './kong';
import { portal } from './portal';
import { ErrorCallback } from 'wicked-sdk';

const MAX_ASYNC_CALLS = 10;

// ========= INTERFACE FUNCTIONS ========

export const sync = {
    syncApis: function (done: ErrorCallback) {
        debug('syncApis()');
        async.parallel({
            portalApis: function (callback) { portal.getPortalApis(callback); },
            kongApis: function (callback) { kong.getKongApis(callback); }
        }, function (err, results) {
            if (err)
                return done(err);
            const portalApis = results.portalApis;
            const kongApis = results.kongApis;

            const todoLists = assembleApiTodoLists(portalApis, kongApis);
            debug('Infos on sync APIs todo list:');
            debug('  add items: ' + todoLists.addList.length);
            debug('  update items: ' + todoLists.updateList.length);
            debug('  delete items: ' + todoLists.deleteList.length);
            //debug(utils.getText(todoLists));

            async.series({
                updateApis: function (callback) {
                    // Will call syncPlugins
                    kong.updateKongApis(sync, todoLists.updateList, callback);
                },
                deleteApis: function (callback) {
                    kong.deleteKongApis(todoLists.deleteList, callback);
                },
                addApis: function (callback) {
                    kong.addKongApis(todoLists.addList, callback);
                }
            }, function (err) {
                if (err)
                    return done(err);
                debug("syncApis() finished.");
                return done(null);
            });
        });
    },

    syncPlugins: function (portalApi, kongApi, done) {
        debug('syncPlugins()');
        const todoLists = assemblePluginTodoLists(portalApi, kongApi);
        //debug(utils.getText(todoLists));
        debug('Infos on sync API Plugins todo list:');
        debug('  add items: ' + todoLists.addList.length);
        debug('  update items: ' + todoLists.updateList.length);
        debug('  delete items: ' + todoLists.deleteList.length);

        /*
        debug('portalApi');
        debug(portalApi);
        debug('kongApi');
        debug(kongApi);
        */

        async.series({
            addPlugins: function (callback) {
                kong.addKongPlugins(todoLists.addList, callback);
            },
            updatePlugins: function (callback) {
                kong.updateKongPlugins(todoLists.updateList, callback);
            },
            deletePlugins: function (callback) {
                kong.deleteKongPlugins(todoLists.deleteList, callback);
            }
        }, function (err) {
            if (err)
                return done(err);
            debug("sync.syncPlugins() done.");
            return done(null);
        });
    },

    // =========== CONSUMERS ============

    syncAllConsumers: function (callback) {
        debug('syncAllConsumers()');
        portal.getAllPortalConsumers(function (err, portalConsumers) {
            if (err)
                return callback(err);
            syncConsumers(portalConsumers, callback);
        });
    },

    syncAppConsumers: function (appId, callback) {
        debug('syncAppConsumers(): ' + appId);
        async.waterfall([
            callback => portal.getAppConsumers(appId, callback), // One app may result in multiple consumers (one per subscription)
            (appConsumers, callback) => syncConsumers(appConsumers, callback)
        ], function (err) {
            if (err)
                return callback(err);
            // We're fine.
            debug('syncAppConsumers() succeeded for app ' + appId);
            callback(null);
        });
    },

    /*
     If we delete an application, we also need to know which subscriptions
     it has, as the consumers in kong are not per application, but rather
     per subscription. I.e., we cannot deduce which Kong consumers belong
     to a registered application in the API Portal.
    
     See below what needs to be in the subscriptionList.
     */
    deleteAppConsumers: function (appId, subscriptionList, callback) {
        debug('deleteAppConsumers(): ' + appId);
        async.mapLimit(subscriptionList, MAX_ASYNC_CALLS, function (subsInfo, callback) {
            sync.deleteAppSubscriptionConsumer(subsInfo, callback);
        }, function (err, results) {
            if (err)
                return callback(err);
            debug('deleteAppConsumers() for app ' + appId + ' succeeded.');
            callback(null);
        });
    },

    /*
     At least the following is needed
    
     subsInfo: {
         application: <...>,
         api: <...>,
         auth: <auth method> (one of key-auth, oauth2)
         plan: <...>, // optional
         userId: <...> // optional
     }
     */
    deleteAppSubscriptionConsumer: function (subsInfo, callback) {
        debug('deleteAppSubscriptionConsumer() appId: ' + subsInfo.application + ', api: ' + subsInfo.api);
        kong.deleteConsumerWithUsername(utils.makeUserName(subsInfo.application, subsInfo.api), callback);
    },

    syncConsumerApiPlugins: function (portalConsumer, kongConsumer, done) {
        debug('syncConsumerApiPlugins()');
        const todoLists = assembleConsumerApiPluginsTodoLists(portalConsumer, kongConsumer);

        async.series([
            function (callback) {
                kong.addKongConsumerApiPlugins(todoLists.addList, kongConsumer.consumer.id, callback);
            },
            function (callback) {
                kong.patchKongConsumerApiPlugins(todoLists.patchList, callback);
            },
            function (callback) {
                kong.deleteKongConsumerApiPlugins(todoLists.deleteList, callback);
            }
        ], function (err) {
            if (err)
                return done(err);
            debug('syncConsumerApiPlugins() finished.');
            return done(null);
        });
    },

    wipeAllConsumers: function (done) {
        debug('wipeAllConsumers()');
        kong.wipeAllConsumers(done);
    }
};

function syncConsumers(portalConsumers, done) {
    if (portalConsumers.length === 0) {
        debug('syncConsumers() - nothing to do (empty consumer list).');
        setTimeout(done, 0);
        return;
    }
    debug('syncConsumers()');
    // Get the corresponding Kong consumers
    kong.getKongConsumers(portalConsumers, function (err, resultConsumers) {
        if (err)
            return done(err);
        const kongConsumers = [];
        for (let i = 0; i < resultConsumers.length; ++i) {
            if (resultConsumers[i])
                kongConsumers.push(resultConsumers[i]);
        }

        debug('syncConsumers(): Creating Todo lists.');
        const todoLists = assembleConsumerTodoLists(portalConsumers, kongConsumers);
        debug('Infos on sync consumers todo list:');
        debug('  add items: ' + todoLists.addList.length);
        debug('  update items: ' + todoLists.updateList.length);
        debug('  delete items: ' + todoLists.deleteList.length);

        async.series({
            addConsumers: callback => kong.addKongConsumers(todoLists.addList, callback),
            updateConsumers: callback => kong.updateKongConsumers(sync, todoLists.updateList, callback), // Will call syncConsumerApiPlugins
            deleteConsumers: function (callback) {
                if (todoLists.deleteList.length > 0) {
                    console.error(todoLists.deleteList);
                    throw new Error('deleteConsumer in sync.syncConsumers() must not be called anymore.');
                }
                setTimeout(callback, 0);
                //kong.deleteKongConsumers(todoLists.deleteList, callback);
            }
        }, function (err, results) {
            if (err)
                return done(err);
            debug('syncConsumers() done.');
            return done(null);
        });
    });
}

// ========= INTERNALS ===========

function assembleApiTodoLists(portalApis, kongApis) {
    debug('assembleApiTodoLists()');
    const updateList = [];
    const addList = [];
    const deleteList = [];

    const handledKongApis = {};

    for (let i = 0; i < portalApis.apis.length; ++i) {
        let portalApi = portalApis.apis[i];

        let kongApi = kongApis.apis.find(function (thisApi) { return thisApi.api.name == portalApi.id; });
        if (kongApi) {
            // Found in both Portal and Kong, check for updates
            updateList.push({
                portalApi: portalApi,
                kongApi: kongApi
            });
            handledKongApis[kongApi.api.name] = true;
        }
        else {
            debug('Did not find API ' + portalApi.id + ' in Kong, will add.');
            // Api not known in Kong, we need to add this
            addList.push({
                portalApi: portalApi
            });
        }
    }

    // Now do the mop up, clean up APIs in Kong but not in the Portal;
    // these we want to delete.
    for (let i = 0; i < kongApis.apis.length; ++i) {
        let kongApi = kongApis.apis[i];
        if (!handledKongApis[kongApi.api.name]) {
            debug('API ' + kongApi.api.name + ' not found in portal definition, will delete.');
            deleteList.push({
                kongApi: kongApi
            });
        }
    }

    return {
        addList: addList,
        updateList: updateList,
        deleteList: deleteList
    };
}

function shouldIgnore(name) {
    const ignoreList = wicked.getKongAdapterIgnoreList();

    if (ignoreList.length === 0) {
        return false;
    }
    if (!name) {
        return false;
    }
    for (let i = 0; i < ignoreList.length; ++i) {
        if (ignoreList[i] === name) {
            return true;
        }
    }
    return false;
}

function assemblePluginTodoLists(portalApi, kongApi) {
    debug('assemblePluginTodoLists()');
    const addList = [];
    const updateList = [];
    const deleteList = [];

    const handledKongPlugins = {};
    for (let i = 0; i < portalApi.config.plugins.length; ++i) {
        let portalPlugin = portalApi.config.plugins[i];
        let kongPluginIndex = utils.getIndexBy(kongApi.plugins, function (plugin) { return plugin.name == portalPlugin.name; });
        if (kongPluginIndex < 0) {
            addList.push({
                portalApi: portalApi,
                portalPlugin: portalPlugin,
                kongApi: kongApi
            });
        } else {
            let kongPlugin = kongApi.plugins[kongPluginIndex];
            if (!utils.matchObjects(portalPlugin, kongPlugin) && !shouldIgnore(kongPlugin.name)) {
                updateList.push(
                    {
                        portalApi: portalApi,
                        portalPlugin: portalPlugin,
                        kongApi: kongApi,
                        kongPlugin: kongPlugin
                    });
            } // Else: Matches, all is good
            handledKongPlugins[kongPlugin.name] = true;
        }
    }

    // Mop up needed?
    for (let i = 0; i < kongApi.plugins.length; ++i) {
        let kongPlugin = kongApi.plugins[i];
        if (!handledKongPlugins[kongPlugin.name] && !shouldIgnore(kongPlugin.name)) {
            deleteList.push({
                kongApi: kongApi,
                kongPlugin: kongPlugin
            });
        }
    }

    return {
        addList: addList,
        updateList: updateList,
        deleteList: deleteList
    };
}

function assembleConsumerTodoLists(portalConsumers, kongConsumers) {
    debug('assembleConsumerTodoLists()');
    const addList = [];
    const updateList = [];
    const deleteList = [];

    const handledKongConsumers = {};
    for (let i = 0; i < portalConsumers.length; ++i) {
        let portalConsumer = portalConsumers[i];
        let kongConsumer = kongConsumers.find(function (kongConsumer) { return portalConsumer.consumer.username == kongConsumer.consumer.username; });
        if (!kongConsumer) {
            debug('Username "' + portalConsumer.consumer.username + '" in portal, but not in Kong, add needed.');
            // Not found
            addList.push({
                portalConsumer: portalConsumer
            });
            continue;
        }

        // We have the consumer in both the Portal and Kong
        debug('Found username "' + kongConsumer.consumer.username + '" in portal and Kong, check for update.');
        updateList.push({
            portalConsumer: portalConsumer,
            kongConsumer: kongConsumer
        });

        handledKongConsumers[kongConsumer.consumer.username] = true;
    }

    // Mop up?
    for (let i = 0; i < kongConsumers.length; ++i) {
        let kongConsumer = kongConsumers[i];
        if (!handledKongConsumers[kongConsumer.consumer.username]) {
            debug('Username "' + kongConsumer.consumer.username + "' found in Kong, but not in portal, delete needed.");
            // Superfluous consumer; we control them
            deleteList.push({
                kongConsumer: kongConsumer
            });
        }
    }

    return {
        addList: addList,
        updateList: updateList,
        deleteList: deleteList
    };
}

function assembleConsumerApiPluginsTodoLists(portalConsumer, kongConsumer) {
    debug('assembleConsumerApiPluginsTodoLists()');
    const addList = [];
    const patchList = [];
    const deleteList = [];
    const handledPlugins = {};
    for (let i = 0; i < portalConsumer.apiPlugins.length; ++i) {
        let portalApiPlugin = portalConsumer.apiPlugins[i];
        let kongApiPlugin = kongConsumer.apiPlugins.find(function (p) { return p.name == portalApiPlugin.name; });
        if (!kongApiPlugin) { // not found, add it
            addList.push({
                portalConsumer: portalConsumer,
                portalApiPlugin: portalApiPlugin
            });
            continue;
        }

        if (kongApiPlugin &&
            !utils.matchObjects(portalApiPlugin, kongApiPlugin) && !shouldIgnore(kongApiPlugin.name)) {
            patchList.push({
                portalConsumer: portalConsumer,
                portalApiPlugin: portalApiPlugin,
                kongConsumer: kongConsumer,
                kongApiPlugin: kongApiPlugin
            });
        }

        handledPlugins[portalApiPlugin.name] = true;
    }

    // Mop up
    for (let i = 0; i < kongConsumer.apiPlugins.length; ++i) {
        let kongApiPlugin = kongConsumer.apiPlugins[i];
        if (!handledPlugins[kongApiPlugin.name] && !shouldIgnore(kongApiPlugin.name)) {
            deleteList.push({
                kongConsumer: kongConsumer,
                kongApiPlugin: kongApiPlugin
            });
        }
    }

    return {
        addList: addList,
        patchList: patchList,
        deleteList: deleteList
    };
}
