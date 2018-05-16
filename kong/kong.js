'use strict';

const async = require('async');
const { debug, info, warn, error } = require('portal-env').Logger('kong-adapter:kong');
const qs = require('querystring');
const utils = require('./utils');

const kong = function () { };

// The maximum number of async I/O calls we fire off against
// the Kong instance for one single call.
const MAX_PARALLEL_CALLS = 10;
const KONG_BATCH_SIZE = 100; // Used when wiping the consumers

kong.getKongApis = function (app, done) {
    debug('kong.getKongApis()');
    utils.kongGet(app, 'apis?size=1000000', function (err, rawApiList) {
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
            utils.kongGet(app, 'apis/' + apiDef.api.id + '/plugins?size=1000000', function (err, apiConfig) {
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

kong.addKongApis = function (app, addList, done) {
    // Bail out early if list empty
    if (addList.length === 0)
        return setTimeout(done, 0);
    debug('addKongApis()');
    // Each item in addList contains:
    // - portalApi: The portal's API definition, including plugins
    async.eachSeries(addList, function (addItem, callback) {
        utils.kongPost(app, 'apis', addItem.portalApi.config.api, function (err, apiResponse) {
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
            kong.addKongPlugins(app, addList, callback);
        });
    }, function (err) {
        if (err)
            return done(err);
        done(null);
    });
};

kong.updateKongApis = function (app, sync, updateList, done) {
    // Bail out early if list empty
    if (updateList.length === 0)
        return setTimeout(done, 0);
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
            utils.kongPatch(app, 'apis/' + kongApi.api.id, portalApi.config.api, function (err, patchResult) {
                if (err)
                    return callback(err);

                // Plugins
                sync.syncPlugins(app, portalApi, kongApi, callback);
            });
        } else {
            debug("API '" + portalApi.name + "' matches.");

            // Plugins
            sync.syncPlugins(app, portalApi, kongApi, callback);
        }
    }, function (err) {
        if (err)
            return done(err);
        return done(null);
    });
};

kong.deleteKongApis = function (app, deleteList, done) {
    // Bail out early if list empty
    if (deleteList.length === 0)
        return setTimeout(done, 0);
    debug('deleteKongApis()');
    // Each item in deleteList contains:
    // - kongApi
    async.eachSeries(deleteList, function (deleteItem, callback) {
        const kongApiUrl = 'apis/' + deleteItem.kongApi.api.id;
        utils.kongDelete(app, kongApiUrl, callback);
    }, function (err) {
        if (err)
            return done(err);
        return done(null);
    });
};

kong.addKongPlugins = function (app, addList, done) {
    // Bail out early if list empty
    if (addList.length === 0)
        return setTimeout(done, 0);
    debug('addKongPlugins()');
    // Each entry in addList contains:
    // - portalApi: The portal's API definition
    // - portalPlugin: The portal's Plugin definition
    // - kongApi: Kong's API representation (for ids)
    async.eachSeries(addList, function (addItem, callback) {
        const kongPluginUrl = 'apis/' + addItem.kongApi.api.id + '/plugins';
        utils.kongPost(app, kongPluginUrl, addItem.portalPlugin, callback);
    }, function (err) {
        if (err)
            return done(err);
        return done(null);
    });
};

kong.updateKongPlugins = function (app, updateList, done) {
    // Bail out early if list empty
    if (updateList.length === 0)
        return setTimeout(done, 0);
    debug('updateKongPlugins()');
    // Each entry in updateList contains:
    // - portalApi: The portal's API definition
    // - portalPlugin: The portal's Plugin definition
    // - kongApi: Kong's API representation (for ids)
    // - kongPlugin: Kong's Plugin representation (for ids)
    async.eachSeries(updateList, function (updateItem, callback) {
        const kongPluginUrl = 'apis/' + updateItem.kongApi.api.id + '/plugins/' + updateItem.kongPlugin.id;
        utils.kongPatch(app, kongPluginUrl, updateItem.portalPlugin, callback);
    }, function (err) {
        if (err)
            return done(err);
        done(null);
    });
};

kong.deleteKongPlugins = function (app, deleteList, done) {
    // Bail out early if list empty
    if (deleteList.length === 0)
        return setTimeout(done, 0);
    debug('deleteKongPlugins()');
    // Each entry in deleteList contains:
    // - kongApi: Kong's API representation (for ids)
    // - kongPlugin: Kong's Plugin representation (for ids)
    async.eachSeries(deleteList, function (deleteItem, callback) {
        const kongPluginUrl = 'apis/' + deleteItem.kongApi.api.id + '/plugins/' + deleteItem.kongPlugin.id;
        utils.kongDelete(app, kongPluginUrl, callback);
    }, function (err) {
        if (err)
            return done(err);
        done(null);
    });
};

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

kong.getKongConsumers = function (app, portalConsumers, callback) {
    debug('getKongConsumers()');
    async.mapLimit(
        portalConsumers,
        MAX_PARALLEL_CALLS,
        (portalConsumer, callback) => getKongConsumerInfo(app, portalConsumer, callback),
        function (err, results) {
            if (err) {
                console.error(err);
                console.error(err.stack);
                return callback(err);
            }
            debug('getKongConsumers() succeeded.');
            return callback(null, results);
        });
    /*
    utils.kongGet(app, 'consumers?size=1000000', function (err, rawConsumerList) {
        if (err)
            return done(err);

        async.mapSeries(rawConsumerList.data, function (kongConsumer, callback) {
            enrichConsumerInfo(app, kongConsumer, callback);
        }, function (err, results) {
            if (err)
                return done(err);

            debug(utils.getText(results));
            return done(null, results);
        });
    });
    */
};

function getKongConsumerInfo(app, portalConsumer, callback) {
    debug('getKongConsumerInfo() for ' + portalConsumer.consumer.username);
    async.waterfall([
        callback => getKongConsumer(app, portalConsumer.consumer.username, callback),
        (kongConsumer, callback) => enrichConsumerInfo(app, kongConsumer, callback)
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

function getKongConsumer(app, username, callback) {
    debug('getKongConsumer(): ' + username);
    utils.kongGet(app, 'consumers/' + username, function (err, consumer) {
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

kong.CONSUMER_PLUGINS = [
    "acls",
    "oauth2",
    "key-auth",
    "basic-auth",
    "hmac-auth"
];

function enrichConsumerInfo(app, kongConsumer, done) {
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
            enrichConsumerPlugins(app, consumerInfo, callback);
        },
        apiPlugins: function (callback) {
            kong.enrichConsumerApiPlugins(app, consumerInfo, null, callback);
        }
    }, function (err) {
        if (err)
            return done(err);
        return done(null, consumerInfo);
    });
}

function enrichConsumerPlugins(app, consumerInfo, done) {
    debug('enrichConsumerPlugins()');
    async.each(kong.CONSUMER_PLUGINS, function (pluginName, callback) {
        utils.kongGet(app, 'consumers/' + consumerInfo.consumer.id + '/' + pluginName, function (err, pluginData) {
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

function extractApiName(consumerName) {
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

kong.enrichConsumerApiPlugins = function (app, consumerInfo, /* optional */apiId, done) {
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
    utils.kongGet(app, 'apis/' + apiName + '/plugins?consumer_id=' + qs.escape(consumerId), function (err, apiPlugins) {
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

function addKongConsumerApiPlugin(app, portalConsumer, consumerId, portalApiPlugin, done) {
    debug('addKongConsumerApiPlugin()');
    portalApiPlugin.consumer_id = consumerId;
    // Uargh
    const apiName = extractApiName(portalConsumer.consumer.username);
    utils.kongPost(app, 'apis/' + apiName + '/plugins', portalApiPlugin, done);
}

function deleteKongConsumerApiPlugin(app, kongConsumer, kongApiPlugin, done) {
    debug('deleteKongConsumerApiPlugin()');
    // This comes from Kong
    const deleteUrl = 'apis/' + kongApiPlugin.api_id + '/plugins/' + kongApiPlugin.id;
    utils.kongDelete(app, deleteUrl, done);
}

kong.addKongConsumerApiPlugins = function (app, addList, consumerId, done) {
    // Bail out early if list empty
    if (addList.length === 0)
        return setTimeout(done, 0);
    debug('addKongConsumerApiPlugins()');
    async.eachSeries(addList, function (addItem, addCallback) {
        addKongConsumerApiPlugin(app, addItem.portalConsumer, consumerId, addItem.portalApiPlugin, addCallback);
    }, function (err) {
        if (err)
            return done(err);
        return done(null);
    });
};

kong.patchKongConsumerApiPlugins = function (app, patchList, done) {
    // Bail out early if list empty
    if (patchList.length === 0)
        return setTimeout(done, 0);
    debug('patchKongConsumerApiPlugins()');
    async.eachSeries(patchList, function (patchItem, patchCallback) {
        patchKongConsumerApiPlugin(app, patchItem.portalConsumer, patchItem.kongConsumer, patchItem.portalApiPlugin, patchItem.kongApiPlugin, patchCallback);
    }, function (err) {
        if (err)
            return done(err);
        return done(null);
    });
};

kong.deleteKongConsumerApiPlugins = function (app, deleteList, done) {
    // Bail out early if list empty
    if (deleteList.length === 0)
        return setTimeout(done, 0);
    debug('deleteKongConsumerApiPlugins()');
    async.eachSeries(deleteList, function (deleteItem, deleteCallback) {
        deleteKongConsumerApiPlugin(app, deleteItem.kongConsumer, deleteItem.kongApiPlugin, deleteCallback);
    }, function (err) {
        if (err)
            return done(err);
        return done(null);
    });
};

function patchKongConsumerApiPlugin(app, portalConsumer, kongConsumer, portalApiPlugin, kongApiPlugin, done) {
    debug('patchKongConsumerApiPlugin()');
    // Delete and re-add to make sure we don't have dangling properties
    async.series([
        callback => deleteKongConsumerApiPlugin(app, kongConsumer, kongApiPlugin, callback),
        callback => addKongConsumerApiPlugin(app, portalConsumer, kongConsumer.consumer.id, portalApiPlugin, callback)
    ], function (err) {
        if (err)
            return done(err);
        return done(null);
    });
}

function addKongConsumer(app, addItem, done) {
    debug('addKongConsumer()');
    debug(JSON.stringify(addItem.portalConsumer.consumer));
    utils.kongPost(app, 'consumers', addItem.portalConsumer.consumer, function (err, apiResponse) {
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

                    addKongConsumerPlugin(app, consumerId, pluginName, pluginInfo, callback);
                }, function (err2) {
                    if (err2)
                        return pluginsCallback(err2);
                    pluginsCallback(null);
                });
            },
            function (pluginsCallback) {
                // Then the API level plugins
                async.eachSeries(apiPlugins, function (apiPlugin, callback) {
                    //addKongConsumerApiPlugin(app, )
                    addKongConsumerApiPlugin(app, addItem.portalConsumer, consumerId, apiPlugin, callback);
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

kong.addKongConsumers = function (app, addList, done) {
    debug('addKongConsumers()');
    // addItem has:
    // - portalConsumer
    async.eachSeries(addList, function (addItem, callback) {
        addKongConsumer(app, addItem, callback);
    }, function (err) {
        if (err)
            return done(err);
        return done(null);
    });
};

function addKongConsumerPlugin(app, consumerId, pluginName, pluginDataList, done) {
    debug('addKongConsumerPlugin()');
    async.eachSeries(pluginDataList, function (pluginData, callback) {
        utils.kongPost(app, 'consumers/' + consumerId + '/' + pluginName, pluginData, callback);
    }, function (err) {
        if (err)
            return done(err);
        done(null);
    });
}

function deleteKongConsumerPlugin(app, consumerId, pluginName, pluginDataList, done) {
    debug('deleteKongConsumerPlugin()');
    async.eachSeries(pluginDataList, function (pluginData, callback) {
        utils.kongDelete(app, 'consumers/' + consumerId + '/' + pluginName + '/' + pluginData.id, callback);
    }, function (err) {
        if (err)
            return done(err);
        done(null);
    });
}

function updateKongConsumerPlugins(app, portalConsumer, kongConsumer, done) {
    debug('updateKongConsumerPlugins() for ' + portalConsumer.consumer.username);
    async.eachSeries(kong.CONSUMER_PLUGINS, function (pluginName, callback) {
        debug("Checking Consumer plugin '" + pluginName + "'.");
        let portalHasPlugin = !!portalConsumer.plugins[pluginName];
        let kongHasPlugin = !!kongConsumer.plugins[pluginName];

        if (portalHasPlugin && !kongHasPlugin) {
            // Add Plugin
            let portalPlugin = portalConsumer.plugins[pluginName];
            return addKongConsumerPlugin(app, kongConsumer.consumer.id, pluginName, portalPlugin, callback);
        } else if (!portalHasPlugin && kongHasPlugin) {
            // Delete Plugin
            let kongPlugin = kongConsumer.plugins[pluginName];
            return deleteKongConsumerPlugin(app, kongConsumer.consumer.id, pluginName, kongPlugin, callback);
        } else if (portalHasPlugin && kongHasPlugin) {
            // Update Plugin
            let portalPlugin = portalConsumer.plugins[pluginName];
            let kongPlugin = kongConsumer.plugins[pluginName];
            if (!utils.matchObjects(portalPlugin, kongPlugin)) {
                async.series({
                    deletePlugin: function (innerCallback) {
                        deleteKongConsumerPlugin(app, kongConsumer.consumer.id, pluginName, kongPlugin, innerCallback);
                    },
                    addPlugin: function (innerCallback) {
                        addKongConsumerPlugin(app, kongConsumer.consumer.id, pluginName, portalPlugin, innerCallback);
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

kong.updateKongConsumers = function (app, sync, updateList, done) {
    debug('updateKongConsumers()');
    // updateItem has:
    // - portalConsumer
    // - kongConsumer

    async.eachSeries(updateList, function (updateItem, callback) {
        async.series([
            function (asyncCallback) {
                updateKongConsumer(app, updateItem.portalConsumer, updateItem.kongConsumer, asyncCallback);
            },
            function (asyncCallback) {
                updateKongConsumerPlugins(app, updateItem.portalConsumer, updateItem.kongConsumer, asyncCallback);
            },
            function (asyncCallback) {
                sync.syncConsumerApiPlugins(app, updateItem.portalConsumer, updateItem.kongConsumer, asyncCallback);
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
};

function updateKongConsumer(app, portalConsumer, kongConsumer, callback) {
    // The only thing which may differ here is the custom_id
    if (portalConsumer.consumer.custom_id === kongConsumer.consumer.custom_id) {
        debug('Custom ID for consumer username ' + portalConsumer.consumer.username + ' matches: ' + portalConsumer.consumer.custom_id);
        return callback(null); // Nothing to do.
    }
    debug('Updating Kong Consumer ' + kongConsumer.consumer.id + ' (username ' + kongConsumer.consumer.username + ') with new custom_id: ' + portalConsumer.consumer.custom_id);
    utils.kongPatch(app, 'consumers/' + kongConsumer.consumer.id, {
        custom_id: portalConsumer.consumer.custom_id
    }, callback);
}

kong.deleteConsumerWithUsername = function (app, username, callback) {
    debug('deleteConsumer() - username: ' + username);
    utils.kongGet(app, 'consumers?username=' + qs.escape(username), function (err, consumerList) {
        if (err)
            return callback(err);
        // Gracefully accept if already deleted
        if (consumerList.total <= 0) {
            console.error('Could not find user with username ' + username + ', cannot delete');
            return callback(null);
        }
        // This should be just one call, but the consumer is in an array, so this does not hurt.
        async.map(consumerList.data, (consumer, callback) => deleteConsumerWithId(app, consumer.id, callback), function (err, results) {
            if (err)
                return callback(err);
            callback(null);
        });
    });
};

kong.deleteConsumerWithCustomId = function (app, customId, callback) {
    debug('deleteConsumerWithCustomId() - custom_id: ' + customId);
    utils.kongGet(app, 'consumers?custom_id=' + qs.escape(customId), function (err, consumerList) {
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
        async.map(consumerList.data, (consumer, callback) => deleteConsumerWithId(app, consumer.id, callback), function (err, results) {
            if (err)
                return callback(err);
            callback(null);
        });
    });
};

function deleteConsumerWithId(app, consumerId, callback) {
    debug('deleteConsumerWithId(): ' + consumerId);
    utils.kongDelete(app, 'consumers/' + consumerId, callback);
}

// Use with care ;-) This will wipe ALL consumers from the Kong database.
kong.wipeAllConsumers = function (app, callback) {
    debug('wipeAllConsumers()');
    wipeConsumerBatch(app, 'consumers?size=' + KONG_BATCH_SIZE, callback);
};

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
function wipeConsumerBatch(app, consumerUrl, callback) {
    debug('wipeConsumerBatch() ' + consumerUrl);
    utils.kongGet(app, consumerUrl, function (err, consumerData) {
        if (err)
            return callback(err);
        async.mapSeries(consumerData.data, function (consumer, callback) {
            utils.kongDelete(app, 'consumers/' + consumer.id, callback);
        }, function (err, results) {
            if (err)
                return callback(err);
            if (!consumerData.next) // no next link --> we're done
                return callback(null);

            // Continue with next batch; get fresh, as we deleted the other ones.
            wipeConsumerBatch(app, consumerUrl, callback);
        });
    });
}

module.exports = kong;