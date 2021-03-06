/**
 * Created by guoyu on 15/11/8.
 */

'use strict';

var ProxyRules = require('./rules'),
  ProxyReporter = require('./reporter'),
  http = require('http'),
  https = require('https'),
  tls = require('tls'),
  url = require('url'),
  net = require('net'),
  path = require('path'),
  fs = require('fs'),
  uuid = require('node-uuid'),
  baseDir = require('./directory'),
  saveToDir = path.join(baseDir, 'servers'),
  logger = require('log4js').getLogger('ProxyServer'),
  cert = new require('node-easy-cert')({
    rootDirPath : path.join(baseDir, 'certs')
  }),
  servers = new Map(),
  certPromise = new Promise((resolve, reject) => {
    cert.generateRootCA({
      commonName : 'FunnyProxy',
      overwrite : false
    }, (ignore) => {
      resolve();
    });
  });

if (!fs.existsSync(saveToDir)) {
  fs.mkdirSync(saveToDir);
}

class ProxyServer {

  constructor(id, file) {
    this._id = id;
    this._file = file;
    this._status = 'sleeping';
    this._reporter = new ProxyReporter();
    this.reload();
  }

  start() {
    let port = this._config['port'];
    this.stop();
    return certPromise
      .then(() => {
        return this._createServer();
      })
      .then(() => {
        if (this._config.https)
          return this._createInternalServer();
        return;
      });
  }

  stop() {
    if (!this._server) {
      return Promise.resolve(this);
    }
    this._server.close();
    if (this._server2) {
      this._server2.close();
    }
    this._server = null;
    this._status = 'sleeping';
    logger.info(`Proxy [${this.name}] stopped`);
    return Promise.resolve(this);
  }

  reload() {
    let json = JSON.parse(fs.readFileSync(this._file, 'utf-8'));
    this._config = json;
    this._rules = new ProxyRules(this, this._config['rules'] || []);
    return Promise.resolve(this);
  }

  get id() {
    return this._id;
  }

  get name() {
    return this._config['name'];
  }

  get port() {
    return this._server && this._server.address() ? this._server.address().port : null;
  }

  get status() {
    return this._status;
  }

  get reporter() {
    return this._reporter;
  }

  get config() {
    return this._config;
  }

  set config(config) {
    this._config = config;
  }

  * [Symbol.iterator]() {
    for (let rule of this._rules) {
      yield rule;
    }
  }

  toJSON() {
    return {
      "id": this.id,
      "name": this.name,
      "port": this.port,
      "status": this.status
    }
  }

  _createServer() {
    return new Promise((resolve, reject) => {
      this._server = http.createServer(
        (req, res) => this._handleRequest(req, res));
      this._server.on('connect',
        (req, incoming, head) => this._handleConnect(req, incoming, head));
      this._server.on('error', reject);
      this._server.listen(this._config.port, () => {
        this._status = 'running';
        this._server.removeListener('error', reject);
        logger.info(`Proxy [${this.name}] listening on port ${this.port}`);
        resolve();
      })
    });
  }

  _createInternalServer() {
    return this._getCertificate('internal_https')
      .then((secure) => {
        return new Promise((resolve, reject) => {
          this._server2 = https.createServer({
            key : secure.key,
            cert : secure.crt,
            SNICallback : (serverName, cb) =>
              this._resolveSecureContext(serverName, cb)
          }, (req, res) => this._handleRequest(req, res, true));
          this._server2.listen(0, (e) => {
            if (e) return reject(e);
            logger.info(`Proxy [${this.name}] https server listening on port ${this._server2.address().port}`);
            resolve();
          });
        });
      })

  }

  _handleRequest(req, res) {
    let secure = !!req.connection.encrypted && !/^http:/.test(req.url),
      host = req.headers.host,
      url = !secure ? req.url : 'https://' + host + req.url,
      report = this._reporter.create(url, req);
    res.on('error', (e) => {
      logger.warn(`Response write error ${e.message}`);
    });
    this._rules.dispatch(url, req, res, report);
  }

  _handleConnect(req, downstream, head) {
    if (this._config.https) {
      this._forwardConnect(
        'localhost', this._server2.address().port,
        req, downstream, head);
    } else {
      let opt = url.parse('http://' + req.url);
      this._forwardConnect(opt.hostname, opt.port || 443, req, downstream, head);
    }
  }

  _forwardConnect(host, port, req, downstream, head) {
    let upstream = net.connect(
      port , host,
      () => {
        downstream.write('HTTP/' + req.httpVersion + ' 200 OK\r\n\r\n');
        downstream.write(head);
        upstream.pipe(downstream);
        downstream.pipe(upstream);
      });
    upstream.on('error', (e) => downstream.emit('error', e));
  }

  _getCertificate(host) {
    return new Promise((resolve, reject) => {
      cert.getCertificate(host, (e, key, crt) => {
        if (e) return reject(e);
        resolve({
          key : key,
          crt : crt
        });
      });
    });
  }

  _resolveSecureContext(serverName, cb) {
    this._getCertificate(serverName)
      .then((secure) => {
        cb(null, tls.createSecureContext({
          key  : secure.key,
          cert : secure.crt
        }));
      })
      .catch(cb)
  }

  static *[Symbol.iterator]() {
    for (let server of servers.values()) {
      yield server;
    }
    return;
  }

  static create(config) {
    let id = uuid.v4(),
      dir = path.resolve(saveToDir, id),
      file = path.resolve(dir, 'server.json'),
      server;
    fs.mkdirSync(dir);
    fs.writeFileSync(file, JSON.stringify(config));
    server = new this(id, file);
    servers.set(id, server);
    return Promise.resolve(server);
  }

  static save(server, config) {
    fs.writeFileSync(server._file, JSON.stringify(config));
    server.reload();
    return Promise.resolve(server);
  }

  static delete(server) {
    server.stop();
    servers.delete(server.id);
    fs.unlinkSync(server._file);
    return Promise.resolve(server);
  }

  static load() {
    fs.readdirSync(saveToDir).forEach((serverDir) => {
      let id = serverDir,
        metaFile = path.resolve(saveToDir, serverDir, 'server.json'),
        server = new ProxyServer(id, metaFile);
      server.start();
      servers.set(id, server);
    });
  }

  static get(id) {
    return Promise.resolve(servers.get(id) || null);
  }

}

module.exports = ProxyServer;