'use strict';

var async = require('async');
var debug = require('debug')('kong-adapter:kong');
var utils = require('./utils');

var kong = function () { };

kong.getKongApis = function (app, done) {
    debug('kong.getKongApis()');
    utils.kongGet(app, 'apis?size=1000000', function (err, rawApiList) {
        if (err)
            return done(err);

        var apiList = {
            apis: []
        };

        // Add an "api" property for the configuration, makes it easier
        // to compare the portal and Kong configurations.
        for (var i = 0; i < rawApiList.data.length; ++i) {
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
    for (var i = 0; i < apiList.apis.length; ++i) {
        var thisApi = apiList.apis[i];
        var consumerPluginIndex = 0;
        while (consumerPluginIndex >= 0) {
            consumerPluginIndex = utils.getIndexBy(thisApi.plugins, function (plugin) { return !!plugin.consumer_id; });
            if (consumerPluginIndex >= 0)
                thisApi.plugins.splice(consumerPluginIndex, 1);
        }
    }
    return apiList;
}

kong.addKongApis = function (app, addList, done) {
    debug('addKongApis()');
    // Each item in addList contains:
    // - portalApi: The portal's API definition, including plugins
    async.eachSeries(addList, function (addItem, callback) {
        utils.kongPost(app, 'apis', addItem.portalApi.config.api, function (err, apiResponse) {
            if (err)
                return done(err);
            var kongApi = { api: apiResponse };
            debug(kongApi);

            var addList = [];
            for (var i = 0; i < addItem.portalApi.config.plugins.length; ++i) {
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
    debug('updateKongApis()');
    // Each item in updateList contains
    // - portalApi: The portal's API definition, including plugins
    // - kongApi: Kong's API definition, including plugins
    async.eachSeries(updateList, function (updateItem, callback) {
        var portalApi = updateItem.portalApi;
        var kongApi = updateItem.kongApi;

        debug('portalApi: ' + JSON.stringify(portalApi.config.api, null, 2));
        debug('kongApi: ' + JSON.stringify(kongApi.api, null, 2));
        var apiUpdateNeeded = !utils.matchObjects(portalApi.config.api, kongApi.api);

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
    debug('deleteKongApis()');
    // Each item in deleteList contains:
    // - kongApi
    async.eachSeries(deleteList, function (deleteItem, callback) {
        var kongApiUrl = 'apis/' + deleteItem.kongApi.api.id;
        utils.kongDelete(app, kongApiUrl, callback);
    }, function (err) {
        if (err)
            return done(err);
        return done(null);
    });
};

kong.addKongPlugins = function (app, addList, done) {
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
    debug('updateKongPlugins()');
    // Each entry in updateList contains:
    // - portalApi: The portal's API definition
    // - portalPlugin: The portal's Plugin definition
    // - kongApi: Kong's API representation (for ids)
    // - kongPlugin: Kong's Plugin representation (for ids)
    async.eachSeries(updateList, function (updateItem, callback) {
        var kongPluginUrl = 'apis/' + updateItem.kongApi.api.id + '/plugins/' + updateItem.kongPlugin.id;
        utils.kongPatch(app, kongPluginUrl, updateItem.portalPlugin, callback);
    }, function (err) {
        if (err)
            return done(err);
        done(null);
    });
};

kong.deleteKongPlugins = function (app, deleteList, done) {
    debug('deleteKongPlugins()');
    // Each entry in deleteList contains:
    // - kongApi: Kong's API representation (for ids)
    // - kongPlugin: Kong's Plugin representation (for ids)
    async.eachSeries(deleteList, function (deleteItem, callback) {
        var kongPluginUrl = 'apis/' + deleteItem.kongApi.api.id + '/plugins/' + deleteItem.kongPlugin.id;
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
                    "redirect_uri": "http://dummy.org"
                }
            ]
        },
        "apiPlugins": [
            {
                "name": "rate-limiting",
                "config": {
                    "hour": 100,
                    "async": true
                }
            }
        ]
    }
]
*/

kong.getKongConsumers = function (app, done) {
    debug('getKongConsumers()');
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
};

kong.CONSUMER_PLUGINS = [
    "acls",
    "oauth2",
    "key-auth",
    "basic-auth",
    "hmac-auth"
];

function enrichConsumerInfo(app, kongConsumer, done) {
    debug('enrichConsumerInfo()');
    var consumerInfo = {
        consumer: kongConsumer,
        plugins: {},
        apiPlugins: []
    };

    async.series({
        consumerPlugins: function (callback) {
            enrichConsumerPlugins(app, consumerInfo, callback);
        },
        apiPlugins: function (callback) {
            enrichConsumerApiPlugins(app, consumerInfo, callback);
        }
    }, function (err) {
        if (err)
            return done(err);
        return done(null, consumerInfo);
    });
}

function enrichConsumerPlugins(app, consumerInfo, done) {
    debug('enrichConsumerPlugins()');
    async.eachSeries(kong.CONSUMER_PLUGINS, function (pluginName, callback) {
        utils.kongGet(app, 'consumers/' + consumerInfo.consumer.id + '/' + pluginName, function (err, pluginData) {
            if (err)
                return callback(err);
            if (pluginData.total > 0)
                consumerInfo.plugins[pluginName] = fiddleIfOAuth2(pluginName, pluginData.data);
            return callback(null);
        });
    }, function (err) {
        if (err)
            return done(err);
        return done(null, consumerInfo);
    });
}

// Kong - for whatever reason - encodes the redirect_uri list
// as JSON inside a JSON property. We have to unpack it to make
// match the portal JSON. This is how it looks when retrieving from
// the API:
// {
//    name: 'oauth2',
//    client_id: '...'
//    client_secret: '...'
//    ...
//    redirect_uri: "[\"http:\\/\\/dummy.org\"]"
// }
// This is stupid. But this fixes it.
function fiddleIfOAuth2(pluginName, kongConsumerPlugin) {
    if ("oauth2" != pluginName)
        return kongConsumerPlugin;
    debug('fiddleIfOAuth2()');
    for (var i=0; i<kongConsumerPlugin.length; ++i) {
        var redirect_uri = kongConsumerPlugin[i].redirect_uri;
        if (!redirect_uri ||
            !redirect_uri.startsWith('['))
            continue;
            
        kongConsumerPlugin[i].redirect_uri = JSON.parse(redirect_uri);
    }
    return kongConsumerPlugin;
}

function extractApiName(consumerName) {
    debug('extractApiName()');
    // consumer names are like this: portal-application-name$api-name
    var dollarIndex = consumerName.indexOf('$');
    if (dollarIndex >= 0)
        return consumerName.substring(dollarIndex + 1);
    var atIndex = consumerName.indexOf('@');
    if (atIndex >= 0)
        return 'portal-api-internal';
    return null;
}

function enrichConsumerApiPlugins(app, consumerInfo, done) {
    debug('enrichConsumerApiPlugins');
    var consumerId = consumerInfo.consumer.id;
    var apiName = extractApiName(consumerInfo.consumer.username);
    if (!apiName) {
        debug('enrichConsumerApiPlugins: Could not extract API name from name "' + consumerInfo.consumer.username + '".');
        // Do nothing then, no plugins
        return;
    }
    utils.kongGet(app, 'apis/' + apiName + '/plugins?consumer_id=' + consumerId, function (err, apiPlugins) {
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
}

function addKongConsumerApiPlugin(app, portalConsumer, consumerId, portalApiPlugin, done) {
    debug('addKongConsumerApiPlugin()');
    portalApiPlugin.consumer_id = consumerId;
    // Uargh
    var apiName = extractApiName(portalConsumer.consumer.username);
    utils.kongPost(app, 'apis/' + apiName + '/plugins', portalApiPlugin, done);
}

function deleteKongConsumerApiPlugin(app, kongConsumer, kongApiPlugin, done) {
    debug('deleteKongConsumerApiPlugin()');
    // This comes from Kong
    var deleteUrl = 'apis/' + kongApiPlugin.api_id + '/plugins/' + kongApiPlugin.id;
    utils.kongDelete(app, deleteUrl, done);
}

kong.addKongConsumerApiPlugins = function (app, addList, consumerId, done) {
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
    deleteKongConsumerApiPlugin(app, kongConsumer, kongApiPlugin, function (err) {
        if (err)
            return done(err);
        addKongConsumerApiPlugin(app, portalConsumer, kongConsumer.consumer.id, portalApiPlugin, done);
    });
}

function addKongConsumer(app, addItem, done) {
    debug('addKongConsumer()');
    debug(JSON.stringify(addItem.portalConsumer.consumer));
    utils.kongPost(app, 'consumers', addItem.portalConsumer.consumer, function (err, apiResponse) {
        if (err)
            return done(err);
        var consumerId = apiResponse.id;

        var pluginNames = [];
        for (var pluginName in addItem.portalConsumer.plugins)
            pluginNames.push(pluginName);

        var apiPlugins = addItem.portalConsumer.apiPlugins; // Array []

        async.series([
            function (pluginsCallback) {
                // First the auth/consumer plugins
                async.eachSeries(pluginNames, function (pluginName, callback) {
                    var pluginInfo = addItem.portalConsumer.plugins[pluginName];

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
        // Actually, the "consumer" bit cannot differ, so we just have to check out the plugins
        async.series([
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

kong.deleteKongConsumers = function (app, deleteList, done) {
    debug('deleteKongConsumers()');
    // deleteItem has:
    // - kongConsumer
    async.eachSeries(deleteList, function (deleteItem, callback) {
        utils.kongDelete(app, 'consumers/' + deleteItem.kongConsumer.consumer.id, callback);
    }, function (err) {
        if (err)
            return done(err);
        done(null);
    });
};

module.exports = kong;