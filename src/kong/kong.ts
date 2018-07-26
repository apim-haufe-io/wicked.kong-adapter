'use strict';

const async = require('async');
const { debug, info, warn, error } = require('portal-env').Logger('kong-adapter:kong');
const qs = require('querystring');

import * as utils from './utils';
import { KongApi, KongPlugin, Callback } from 'wicked-sdk';
import { KongCollection, KongConsumer } from './types';

// The maximum number of async I/O calls we fire off against
// the Kong instance for one single call.
const MAX_PARALLEL_CALLS = 10;
const KONG_BATCH_SIZE = 100; // Used when wiping the consumers

export const kong = {
    getKongApis: function (done) {
        debug('kong.getKongApis()');
        utils.kongGetAllApis(function (err, rawApiList) {
            if (err)
                return done(err);

            let apiList = {
                apis: []
            };

            // Add an "api" property for the configuration, makes it easier
            // to compare the portal and Kong configurations.
            for (let i = 0; i < rawApiList.data.length; ++i) {
                apiList.apis.push({
                    api: rawApiList.data[i]
                });
            }

            // Fire off this sequentially, not in parallel (renders 500's sometimes)
            async.eachSeries(apiList.apis, function (apiDef, callback) {
                utils.kongGetApiPlugins(apiDef.api.id, function (err, apiConfig) {
                    if (err)
                        return callback(err);
                    apiDef.plugins = apiConfig.data;
                    return callback(null);
                });
            }, function (err) {
                if (err)
                    return done(err);

                // Plugins which are referring to consumers are not global, and must not be taken
                // into account when comparing.
                apiList = removeKongConsumerPlugins(apiList);

                return done(null, apiList);
            });
        });
    },

    addKongApis: function (addList, done): void {
        // Bail out early if list empty
        if (addList.length === 0) {
            setTimeout(done, 0);
            return;
        }
        debug('addKongApis()');
        // Each item in addList contains:
        // - portalApi: The portal's API definition, including plugins
        async.eachSeries(addList, function (addItem, callback) {
            utils.kongPostApi(addItem.portalApi.config.api, function (err, apiResponse) {
                if (err)
                    return done(err);
                const kongApi = { api: apiResponse };
                debug(kongApi);

                const addList = [];
                for (let i = 0; i < addItem.portalApi.config.plugins.length; ++i) {
                    addList.push({
                        portalApi: addItem,
                        portalPlugin: addItem.portalApi.config.plugins[i],
                        kongApi: kongApi,
                    });
                }
                kong.addKongPlugins(addList, callback);
            });
        }, function (err) {
            if (err)
                return done(err);
            done(null);
        });
    },

    updateKongApis: function (sync, updateList, done): void {
        // Bail out early if list empty
        if (updateList.length === 0) {
            setTimeout(done, 0);
            return;
        }
        debug('updateKongApis()');
        // Each item in updateList contains
        // - portalApi: The portal's API definition, including plugins
        // - kongApi: Kong's API definition, including plugins
        async.eachSeries(updateList, function (updateItem, callback) {
            const portalApi = updateItem.portalApi;
            const kongApi = updateItem.kongApi;

            debug('portalApi: ' + JSON.stringify(portalApi.config.api, null, 2));
            debug('kongApi: ' + JSON.stringify(kongApi.api, null, 2));
            const apiUpdateNeeded = !utils.matchObjects(portalApi.config.api, kongApi.api);

            if (apiUpdateNeeded) {
                debug("API '" + portalApi.name + "' does not match.");
                utils.kongPatchApi(kongApi.api.id, portalApi.config.api, function (err, patchResult) {
                    if (err)
                        return callback(err);

                    // Plugins
                    sync.syncPlugins(portalApi, kongApi, callback);
                });
            } else {
                debug("API '" + portalApi.name + "' matches.");

                // Plugins
                sync.syncPlugins(portalApi, kongApi, callback);
            }
        }, done);
    },

    deleteKongApis: function (deleteList, done): void {
        // Bail out early if list empty
        if (deleteList.length === 0) {
            setTimeout(done, 0);
            return;
        }

        debug('deleteKongApis()');
        // Each item in deleteList contains:
        // - kongApi
        async.eachSeries(deleteList, function (deleteItem, callback) {
            utils.kongDeleteApi(deleteItem.kongApi.api.id, callback);
        }, function (err) {
            if (err)
                return done(err);
            return done(null);
        });
    },

    addKongPlugins: function (addList, done) {
        // Bail out early if list empty
        if (addList.length === 0) {
            setTimeout(done, 0);
            return;
        }
        debug('addKongPlugins()');
        // Each entry in addList contains:
        // - portalApi: The portal's API definition
        // - portalPlugin: The portal's Plugin definition
        // - kongApi: Kong's API representation (for ids)
        async.eachSeries(addList, function (addItem, callback) {
            utils.kongPostApiPlugin(addItem.kongApi.api.id, addItem.portalPlugin, callback);
        }, function (err) {
            if (err)
                return done(err);
            return done(null);
        });
    },

    updateKongPlugins: function (updateList, done) {
        // Bail out early if list empty
        if (updateList.length === 0) {
            setTimeout(done, 0);
            return;
        }
        debug('updateKongPlugins()');
        // Each entry in updateList contains:
        // - portalApi: The portal's API definition
        // - portalPlugin: The portal's Plugin definition
        // - kongApi: Kong's API representation (for ids)
        // - kongPlugin: Kong's Plugin representation (for ids)
        async.eachSeries(updateList, function (updateItem, callback) {
            utils.kongPatchApiPlugin(updateItem.kongApi.api.id, updateItem.kongPlugin.id, updateItem.kongPlugin, callback);
        }, function (err) {
            if (err)
                return done(err);
            done(null);
        });
    },

    deleteKongPlugins: function (deleteList, done) {
        // Bail out early if list empty
        if (deleteList.length === 0) {
            setTimeout(done, 0);
            return;
        }
        debug('deleteKongPlugins()');
        // Each entry in deleteList contains:
        // - kongApi: Kong's API representation (for ids)
        // - kongPlugin: Kong's Plugin representation (for ids)
        async.eachSeries(deleteList, function (deleteItem, callback) {
            utils.kongDeleteApiPlugin(deleteItem.kongApi.api.id, deleteItem.kongPlugin.id, callback);
        }, function (err) {
            if (err)
                return done(err);
            done(null);
        });
    },

    // ======= CONSUMERS =======

    /*
    [
        {
            "consumer": {
                "username": "my-app$petstore",
                "custom_id": "5894850948509485094tldkrjglskrzniw3769"
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
                        "uris": ["http://dummy.org"]
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

    getKongConsumers: function (portalConsumers, callback) {
        debug('getKongConsumers()');
        async.mapLimit(
            portalConsumers,
            MAX_PARALLEL_CALLS,
            (portalConsumer, callback) => getKongConsumerInfo(portalConsumer, callback),
            function (err, results) {
                if (err) {
                    console.error(err);
                    console.error(err.stack);
                    return callback(err);
                }
                debug('getKongConsumers() succeeded.');
                return callback(null, results);
            });
    },

    addKongConsumerApiPlugins: function (addList, consumerId, done) {
        // Bail out early if list empty
        if (addList.length === 0) {
            setTimeout(done, 0);
            return;
        }
        debug('addKongConsumerApiPlugins()');
        async.eachSeries(addList, function (addItem, addCallback) {
            addKongConsumerApiPlugin(addItem.portalConsumer, consumerId, addItem.portalApiPlugin, addCallback);
        }, function (err) {
            if (err)
                return done(err);
            return done(null);
        });
    },

    patchKongConsumerApiPlugins: function (patchList, done) {
        // Bail out early if list empty
        if (patchList.length === 0) {
            setTimeout(done, 0);
            return;
        }
        debug('patchKongConsumerApiPlugins()');
        async.eachSeries(patchList, function (patchItem, patchCallback) {
            patchKongConsumerApiPlugin(patchItem.portalConsumer, patchItem.kongConsumer, patchItem.portalApiPlugin, patchItem.kongApiPlugin, patchCallback);
        }, function (err) {
            if (err)
                return done(err);
            return done(null);
        });
    },

    deleteKongConsumerApiPlugins: function (deleteList, done) {
        // Bail out early if list empty
        if (deleteList.length === 0) {
            setTimeout(done, 0);
            return;
        }
        debug('deleteKongConsumerApiPlugins()');
        async.eachSeries(deleteList, function (deleteItem, deleteCallback) {
            deleteKongConsumerApiPlugin(deleteItem.kongConsumer, deleteItem.kongApiPlugin, deleteCallback);
        }, function (err) {
            if (err)
                return done(err);
            return done(null);
        });
    },

    addKongConsumers: function (addList, done) {
        debug('addKongConsumers()');
        // addItem has:
        // - portalConsumer
        async.eachSeries(addList, function (addItem, callback) {
            addKongConsumer(addItem, callback);
        }, function (err) {
            if (err)
                return done(err);
            return done(null);
        });
    },

    updateKongConsumers: function (sync, updateList, done) {
        debug('updateKongConsumers()');
        // updateItem has:
        // - portalConsumer
        // - kongConsumer

        async.eachSeries(updateList, function (updateItem, callback) {
            async.series([
                function (asyncCallback) {
                    updateKongConsumer(updateItem.portalConsumer, updateItem.kongConsumer, asyncCallback);
                },
                function (asyncCallback) {
                    updateKongConsumerPlugins(updateItem.portalConsumer, updateItem.kongConsumer, asyncCallback);
                },
                function (asyncCallback) {
                    sync.syncConsumerApiPlugins(updateItem.portalConsumer, updateItem.kongConsumer, asyncCallback);
                }
            ], function (pluginsErr) {
                if (pluginsErr)
                    return callback(pluginsErr);
                callback(null);
            });
        }, function (err) {
            if (err)
                return done(err);
            debug("updateKongConsumers() finished.");
            done(null);
        });
    },

    deleteConsumerWithUsername: function (username, callback) {
        debug('deleteConsumer() - username: ' + username);
        utils.kongGetConsumersByUsername(username, function (err, consumerList) {
            if (err)
                return callback(err);
            // Gracefully accept if already deleted
            if (consumerList.total <= 0) {
                console.error('Could not find user with username ' + username + ', cannot delete');
                return callback(null);
            }
            // This should be just one call, but the consumer is in an array, so this does not hurt.
            async.map(consumerList.data, (consumer, callback) => utils.kongDeleteConsumer(consumer.id, callback), function (err, results) {
                if (err)
                    return callback(err);
                callback(null);
            });
        });
    },

    deleteConsumerWithCustomId: function (customId, callback) {
        debug('deleteConsumerWithCustomId() - custom_id: ' + customId);
        utils.kongGetConsumersByCustomId(customId, function (err, consumerList) {
            if (err)
                return callback(err);
            // Gracefully accept if already deleted
            if (consumerList.total <= 0) {
                console.error('Could not find user with custom_id ' + customId + ', cannot delete');
                return callback(null);
            }
            if (consumerList.total > 1)
                console.error('Multiple consumers with custom_id ' + customId + ' found, killing them all.');
            // This should be just one call, but the consumer is in an array, so this does not hurt.
            async.map(consumerList.data, (consumer, callback) => utils.kongDeleteConsumer(consumer.id, callback), function (err, results) {
                if (err)
                    return callback(err);
                callback(null);
            });
        });
    },

    // Use with care ;-) This will wipe ALL consumers from the Kong database.
    wipeAllConsumers: function (callback) {
        debug('wipeAllConsumers()');
        wipeConsumerBatch('consumers?size=' + KONG_BATCH_SIZE, callback);
    }
};

function removeKongConsumerPlugins(apiList) {
    debug('removeKongConsumerPlugins()');
    for (let i = 0; i < apiList.apis.length; ++i) {
        const thisApi = apiList.apis[i];
        let consumerPluginIndex = 0;
        while (consumerPluginIndex >= 0) {
            consumerPluginIndex = utils.getIndexBy(thisApi.plugins, function (plugin) { return !!plugin.consumer_id; });
            if (consumerPluginIndex >= 0)
                thisApi.plugins.splice(consumerPluginIndex, 1);
        }
    }
    return apiList;
}

function getKongConsumerInfo(portalConsumer, callback) {
    debug('getKongConsumerInfo() for ' + portalConsumer.consumer.username);
    async.waterfall([
        callback => getKongConsumer(portalConsumer.consumer.username, callback),
        (kongConsumer, callback) => enrichConsumerInfo(kongConsumer, callback)
    ], function (err, consumerInfo) {
        if (err) {
            //            console.error(err);
            //            console.error(err.stack);
            return callback(err);
        }
        // Note that the result may be null if the user is not present
        return callback(null, consumerInfo);
    });
}

function getKongConsumer(username, callback: Callback<KongConsumer>) {
    debug('getKongConsumer(): ' + username);
    utils.kongGetConsumerByName(username, function (err, consumer) {
        if (err && err.status == 404) {
            debug('getKongConsumer(): Not found.');
            return callback(null, null); // Consider "normal", user not (yet) found
        } else if (err) {
            return callback(err);
        }
        debug('getKongConsumer(): Success, id=' + consumer.id);
        return callback(null, consumer);
    });
}

const CONSUMER_PLUGINS = [
    "acls",
    "oauth2",
    "key-auth",
    "basic-auth",
    "hmac-auth"
];

function enrichConsumerInfo(kongConsumer, done) {
    debug('enrichConsumerInfo()');
    if (!kongConsumer) {
        debug('Not applicable, consumer not found.');
        return done(null, null);
    }
    const consumerInfo = {
        consumer: kongConsumer,
        plugins: {},
        apiPlugins: []
    };

    async.series({
        consumerPlugins: function (callback) {
            enrichConsumerPlugins(consumerInfo, callback);
        },
        apiPlugins: function (callback) {
            enrichConsumerApiPlugins(consumerInfo, null, callback);
        }
    }, function (err) {
        if (err)
            return done(err);
        return done(null, consumerInfo);
    });
}

function enrichConsumerPlugins(consumerInfo, done) {
    debug('enrichConsumerPlugins()');
    async.each(CONSUMER_PLUGINS, function (pluginName, callback) {
        utils.kongGetConsumerPluginData(consumerInfo.consumer.id, pluginName, function (err, pluginData) {
            if (err)
                return callback(err);
            if (pluginData.total > 0)
                consumerInfo.plugins[pluginName] = pluginData.data;
            return callback(null);
        });
    }, function (err) {
        if (err)
            return done(err);
        return done(null, consumerInfo);
    });
}

function extractApiName(consumerName: string): string {
    debug('extractApiName()');
    // consumer names are like this: portal-application-name$api-name
    const dollarIndex = consumerName.indexOf('$');
    if (dollarIndex >= 0)
        return consumerName.substring(dollarIndex + 1);
    const atIndex = consumerName.indexOf('@');
    if (atIndex >= 0)
        return 'portal-api-internal';
    return null;
}

function enrichConsumerApiPlugins(consumerInfo, /* optional */apiId, done) {
    debug('enrichConsumerApiPlugins');
    const consumerId = consumerInfo.consumer.id;
    // Pass null for apiId if you want to extract it from the consumer's username
    let apiName = apiId;
    if (!apiId)
        apiName = extractApiName(consumerInfo.consumer.username);
    if (!apiName) {
        debug('enrichConsumerApiPlugins: Could not extract API name from name "' + consumerInfo.consumer.username + '", and API was not passed into function.');
        // Do nothing then, no plugins
        return;
    }
    utils.kongGetApiPluginsByConsumer(apiName, consumerId, function (err, apiPlugins) {
        if (err) {
            // 404? If so, this may happen if the API was removed and there are still consumers on it. Ignore.
            if (err.status == 404)
                return done(null, consumerInfo);
            return done(err);
        }
        if (!apiPlugins.data)
            return done(null, consumerInfo);
        consumerInfo.apiPlugins = apiPlugins.data;
        done(null, consumerInfo);
    });
};

function addKongConsumerApiPlugin(portalConsumer, consumerId, portalApiPlugin: KongPlugin, done) {
    debug('addKongConsumerApiPlugin()');
    portalApiPlugin.consumer_id = consumerId;
    // Uargh
    const apiName = extractApiName(portalConsumer.consumer.username);
    utils.kongPostApiPlugin(apiName, portalApiPlugin, done);
}

function deleteKongConsumerApiPlugin(kongConsumer, kongApiPlugin: KongPlugin, done) {
    debug('deleteKongConsumerApiPlugin()');
    // This comes from Kong (the api_id)
    utils.kongDeleteApiPlugin(kongApiPlugin.api_id, kongApiPlugin.id, done);
}

function patchKongConsumerApiPlugin(portalConsumer, kongConsumer, portalApiPlugin, kongApiPlugin, done) {
    debug('patchKongConsumerApiPlugin()');
    // Delete and re-add to make sure we don't have dangling properties
    async.series([
        callback => deleteKongConsumerApiPlugin(kongConsumer, kongApiPlugin, callback),
        callback => addKongConsumerApiPlugin(portalConsumer, kongConsumer.consumer.id, portalApiPlugin, callback)
    ], function (err) {
        if (err)
            return done(err);
        return done(null);
    });
}

function addKongConsumer(addItem, done) {
    debug('addKongConsumer()');
    debug(JSON.stringify(addItem.portalConsumer.consumer));
    utils.kongPostConsumer(addItem.portalConsumer.consumer, function (err, apiResponse) {
        if (err)
            return done(err);
        const consumerId = apiResponse.id;

        const pluginNames = [];
        for (let pluginName in addItem.portalConsumer.plugins)
            pluginNames.push(pluginName);

        const apiPlugins = addItem.portalConsumer.apiPlugins; // Array []

        async.series([
            function (pluginsCallback) {
                // First the auth/consumer plugins
                async.eachSeries(pluginNames, function (pluginName, callback) {
                    const pluginInfo = addItem.portalConsumer.plugins[pluginName];

                    addKongConsumerPlugin(consumerId, pluginName, pluginInfo, callback);
                }, function (err2) {
                    if (err2)
                        return pluginsCallback(err2);
                    pluginsCallback(null);
                });
            },
            function (pluginsCallback) {
                // Then the API level plugins
                async.eachSeries(apiPlugins, function (apiPlugin, callback) {
                    //addKongConsumerApiPlugin()
                    addKongConsumerApiPlugin(addItem.portalConsumer, consumerId, apiPlugin, callback);
                }, function (err2) {
                    if (err2)
                        return pluginsCallback(err2);
                    pluginsCallback(null);
                });
            }
        ], function (pluginsErr) {
            if (pluginsErr)
                return done(pluginsErr);
            return done(null);
        });
    });
}

function addKongConsumerPlugin(consumerId, pluginName, pluginDataList, done) {
    debug('addKongConsumerPlugin()');
    async.eachSeries(pluginDataList, function (pluginData, callback) {
        utils.kongPostConsumerPlugin(consumerId, pluginName, pluginData, callback);
    }, function (err) {
        if (err)
            return done(err);
        done(null);
    });
}

function deleteKongConsumerPlugin(consumerId, pluginName, pluginDataList, done) {
    debug('deleteKongConsumerPlugin()');
    async.eachSeries(pluginDataList, function (pluginData, callback) {
        utils.kongDeleteConsumerPlugin(consumerId, pluginName, pluginData.id, callback);
    }, function (err) {
        if (err)
            return done(err);
        done(null);
    });
}

function updateKongConsumerPlugins(portalConsumer, kongConsumer, done) {
    debug('updateKongConsumerPlugins() for ' + portalConsumer.consumer.username);
    async.eachSeries(CONSUMER_PLUGINS, function (pluginName, callback) {
        debug("Checking Consumer plugin '" + pluginName + "'.");
        let portalHasPlugin = !!portalConsumer.plugins[pluginName];
        let kongHasPlugin = !!kongConsumer.plugins[pluginName];

        if (portalHasPlugin && !kongHasPlugin) {
            // Add Plugin
            let portalPlugin = portalConsumer.plugins[pluginName];
            return addKongConsumerPlugin(kongConsumer.consumer.id, pluginName, portalPlugin, callback);
        } else if (!portalHasPlugin && kongHasPlugin) {
            // Delete Plugin
            let kongPlugin = kongConsumer.plugins[pluginName];
            return deleteKongConsumerPlugin(kongConsumer.consumer.id, pluginName, kongPlugin, callback);
        } else if (portalHasPlugin && kongHasPlugin) {
            // Update Plugin
            let portalPlugin = portalConsumer.plugins[pluginName];
            let kongPlugin = kongConsumer.plugins[pluginName];
            if (!utils.matchObjects(portalPlugin, kongPlugin)) {
                async.series({
                    deletePlugin: function (innerCallback) {
                        deleteKongConsumerPlugin(kongConsumer.consumer.id, pluginName, kongPlugin, innerCallback);
                    },
                    addPlugin: function (innerCallback) {
                        addKongConsumerPlugin(kongConsumer.consumer.id, pluginName, portalPlugin, innerCallback);
                    }
                }, function (err2, results) {
                    if (err2)
                        return callback(err2);
                    debug("updateKongConsumerPlugins - Update finished.");
                    return callback(null);
                });
            } else {
                // This is a synchronuous call inside async, which assumes it is asynchronuous. process.nextTick defers
                // execution until the next tick, so that this also gets async. If you don't do this, you will fairly
                // easily end up in a 'RangeError: Maximum call stack size exceeded' error.
                return process.nextTick(callback);
            }
            // Nothing to do here.
        } else { // Else: Plugin not used for consumer
            // See above regarding process.nextTick()
            return process.nextTick(callback);
        }
    }, function (err) {
        if (err)
            return done(err);
        debug("updateKongConsumerPlugins() finished.");
        done(null);
    });
}

function updateKongConsumer(portalConsumer, kongConsumer, callback) {
    // The only thing which may differ here is the custom_id
    if (portalConsumer.consumer.custom_id === kongConsumer.consumer.custom_id) {
        debug('Custom ID for consumer username ' + portalConsumer.consumer.username + ' matches: ' + portalConsumer.consumer.custom_id);
        return callback(null); // Nothing to do.
    }
    debug('Updating Kong Consumer ' + kongConsumer.consumer.id + ' (username ' + kongConsumer.consumer.username + ') with new custom_id: ' + portalConsumer.consumer.custom_id);
    utils.kongPatchConsumer(kongConsumer.consumer.id, {
        custom_id: portalConsumer.consumer.custom_id
    }, callback);
}

function deleteConsumerWithId(consumerId, callback) {
    debug('deleteConsumerWithId(): ' + consumerId);
    utils.kongDeleteConsumer(consumerId, callback);
}

/*
 consumerData: {
     total: <...>
     next: 'http://....'
     data: [
         {
            ...    
         },
         {
             ...
         }
     ]
 }
 */
function wipeConsumerBatch(consumerUrl, callback) {
    debug('wipeConsumerBatch() ' + consumerUrl);
    utils.kongGetRaw(consumerUrl, function (err, consumerData: KongCollection<KongConsumer>) {
        if (err)
            return callback(err);
        async.mapSeries(consumerData.data, function (consumer, callback) {
            utils.kongDeleteConsumer(consumer.id, callback);
        }, function (err, results) {
            if (err)
                return callback(err);
            if (!consumerData.next) // no next link --> we're done
                return callback(null);

            // Continue with next batch; get fresh, as we deleted the other ones.
            wipeConsumerBatch(consumerUrl, callback);
        });
    });
}
