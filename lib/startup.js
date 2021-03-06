/**
 * Created by guoyu on 15/11/8.
 */
'use strict';

var ProxyServer = require('./proxy'),
    WebServer = require('./web'),
    log4js = require('log4js'),
    logger = log4js.getLogger('Startup');

log4js.replaceConsole();

module.exports = function (port) {

    ProxyServer.load();

    WebServer(port);

    process.on('uncaughtException', function(err) {
        logger.error(err.stack);
        throw err;
    });

};