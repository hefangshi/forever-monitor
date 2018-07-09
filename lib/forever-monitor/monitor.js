/*
 * monitor.js: Core functionality for the Monitor object.
 *
 * (C) 2010 Charlie Robbins & the Contributors
 * MIT LICENCE
 *
 */

var events = require('events'),
  fs = require('fs'),
  path = require('path'),
  child_process = require('child_process'),
  spawn = child_process.spawn,
  broadway = require('broadway'),
  psTree = require('ps-tree'),
  utile = require('utile'),
  common = require('./common'),
  cluster = require('cluster'),
  plugins = require('./plugins');

//
// ### function Monitor (script, options)
// #### @script {string} Location of the target script to run.
// #### @options {Object} Configuration for this instance.
// Creates a new instance of forever with specified `options`.
//
var Monitor = exports.Monitor = function (script, options) {
  //
  // Simple bootstrapper for attaching logger
  // and watch plugins by default. Other plugins
  // can be attached through `monitor.use(plugin, options)`.
  //
  function bootstrap(monitor) {
    plugins.logger.attach.call(monitor, options);
    if (options.watch) {
      plugins.watch.attach.call(monitor, options);
    }
  }

  var execPath = process.execPath,
    self = this;

  //
  // Setup basic configuration options
  //
  options = options || {};
  this.silent = options.silent || false;
  this.killTree = options.killTree !== false;
  this.uid = options.uid || utile.randomString(4);
  this.id = options.id || false;
  this.pidFile = options.pidFile;
  this.max = options.max;
  this.killTTL = options.killTTL || 1500;
  this.killSignal = options.killSignal || 'SIGKILL';
  this.childExists = false;
  this.checkFile = options.checkFile !== false;
  this.times = {};
  this.warn = console.error;
  this.isStopping = false;
  this.children = [];
  this.ctime = {};

  this.spawnMode = options.spawnMode;
  this.forkCount = options.forkCount;
  this.logFile = options.logFile;
  this.outFile = options.outFile;
  this.errFile = options.errFile;
  this.append = options.append;

  //
  // Define some safety checks for commands with spaces
  //
  this.parser = options.parser || Monitor.parseCommand;

  //
  // Setup restart timing. These options control how quickly forever restarts
  // a child process as well as when to kill a "spinning" process
  //
  this.minUptime = typeof options.minUptime !== 'number' ? 0 : options.minUptime;
  this.spinSleepTime = options.spinSleepTime || null;

  //
  // Special case Windows separately to decouple any
  // future changes
  //
  if (process.platform === 'win32') {
    execPath = '"' + execPath + '"';
  }

  if (options.options) {
    console.warn('options.options is deprecated. Use options.args instead.');
  }

  //
  // Setup the command to spawn and the options to pass
  // to that command.
  //
  this.command = options.command || execPath;
  this.args = options.args || options.options || [];
  this.spawnWith = options.spawnWith || {};
  this.sourceDir = options.sourceDir;
  this.fork = options.fork || false;
  this.cwd = options.cwd || process.cwd();
  this.hideEnv = options.hideEnv || [];
  this._env = options.env || {};
  this._hideEnv = {};

  //
  // Allow for custom stdio configuration of forked processes
  //
  this.stdio = options.stdio || null;

  //
  // Setup watch configuration options
  //
  this.watchIgnoreDotFiles = options.watchIgnoreDotFiles !== false;
  this.watchIgnorePatterns = options.watchIgnorePatterns || [];
  this.watchDirectory = options.watchDirectory || this.sourceDir;

  //
  // Create a simple mapping of `this.hideEnv` to an easily indexable
  // object
  //
  this.hideEnv.forEach(function (key) {
    self._hideEnv[key] = true;
  });

  if (Array.isArray(script)) {
    this.command = script[0];
    this.args = script.slice(1);
  }
  else {
    this.args.unshift(script);
  }

  if (this.sourceDir) {
    this.args[0] = path.join(this.sourceDir, this.args[0]);
  }

  //
  // Bootstrap this instance now that options
  // have been set
  //
  broadway.App.call(this, {
    bootstrapper: {
      bootstrap: bootstrap
    }
  });
};

// Inherit from events.EventEmitter
utile.inherits(Monitor, broadway.App);

//
// ### function start ([restart])
// #### @restart {boolean} Value indicating whether this is a restart.
// Start the process that this instance is configured for
//
Monitor.prototype.start = function (restart, count, index) {
  var self = this;
  index = index || 0;
  if (this.running && !restart) {
    process.nextTick(function () {
      self.emit('error', new Error('Cannot start process that is already running.'));
    });
    return this;
  }
  var newChildren = self.spawnMode ? this.trySpawn() : this.tryFork(count || self.forkCount);
  if (!newChildren || newChildren.length === 0) {
    process.nextTick(function () {
      self.emit('error', new Error('Target script does not exist: ' + self.args[0]));
    });
    return this;
  }

  this.running = true;
  this.isMaster = cluster.isMaster;

  function onMessage(msg) {
    self.emit('message', msg);
  }

  function removeChild(child) {
    for (var i = 0; i < self.children.length; i++) {
      if (self.children[i] === child) {
        self.children.splice(i, 1);
      }
    }
  }

  function onChildExit(code, signal) {
    var child = this;
    var pid = child.pid;
    var spinning = Date.now() - self.ctime[child.index] < self.minUptime;
    child.removeListener('message', onMessage);
    removeChild(child);
    self.emit('exit:code', pid, child.index, code, signal);

    function letChildDie() {
      self.forceStop = false;
      if (self.children.length === 0) {
        self.running = false;
        self.emit('exit', self, spinning);
      }
    }

    function restartChild() {
      // self.running = false;
      self.forceRestart = false;
      process.nextTick(function () {
        // 已经收到停止新号后不应继续触发重启
        if (self.isStopping) {
          this.isStopping = false;
          return;
        }
        self.start(true, 1, child.index);
      });
    }

    var restartTimes = self.times[child.index] = (self.times[child.index] || 0) + 1;

    if (self.forceStop ||
      (restartTimes >= self.max && !self.forceRestart) ||
      (spinning && typeof self.spinSleepTime !== 'number') &&
      !self.forceRestart) {
      letChildDie();
    }
    else if (spinning) {
      setTimeout(restartChild, self.spinSleepTime);
    }
    else {
      restartChild();
    }
  }


  newChildren.forEach(function (child, newIndex) {
    self.children.push(child);
    if (restart) {
      child.index = index;
    }
    else {
      child.index = newIndex;
    }
    self.ctime[child.index] = Date.now();
    // Re-emit messages from the child process
    child.on('message', onMessage);
    child.on('exit', onChildExit);
    process.nextTick(function () {
      self.emit(restart ? 'worker:restart' : 'worker:start', child.pid, child.index, child);
    });
  });


  // 发布启动完成的事件
  process.nextTick(function () {
    self.emit(restart ? 'restart' : 'start', self, self.data);
  });

  return this;
};


Monitor.prototype.tryFork = function (number) {
  number = number || 1;
  var run = this.parser(this.command, this.args.slice());
  if (/[^\w]node$/.test(this.command) && this.checkFile && !this.childExists) {
    try {
      fs.statSync(this.args[0]);
      this.childExists = true;
    }
    catch (ex) {
      return false;
    }
  }

  cluster.setupMaster({
    exec: run.args[0],
    args: run.args.slice(1),
    silent: true
  });

  var children = [];

  for (var i = 0; i < number; i++) {
    children.push(cluster.fork().process);
  }

  return children;
};

//
// ### function trySpawn()
// Tries to spawn the target Forever child process. Depending on
// configuration, it checks the first argument of the options
// to see if the file exists. This is useful is you are
// trying to execute a script with an env: e.g. node myfile.js
//
Monitor.prototype.trySpawn = function () {
  var run = this.parser(this.command, this.args.slice()),
    stats;
  if (/[^\w]node$/.test(this.command) && this.checkFile && !this.childExists) {
    try {
      stats = fs.statSync(this.args[0]);
      this.childExists = true;
    }
    catch (ex) {
      return false;
    }
  }

  this.spawnWith.cwd = this.spawnWith.cwd || this.cwd;
  this.spawnWith.env = this._getEnv();

  if (process.platform === 'win32') {
    this.spawnWith.detached = true;
  }

  if (this.stdio) {
    this.spawnWith.stdio = this.stdio;
  }

  if (this.fork) {
    if (!this.stdio) {
      this.spawnWith.stdio = ['pipe', 'pipe', 'pipe', 'ipc'];
    }
    return [spawn(run.command, run.args, this.spawnWith)];
  }
  return [spawn(run.command, run.args, this.spawnWith)];
};

//
// ### @data {Object}
// Responds with the appropriate information about
// this `Monitor` instance and it's associated child process.
//
Monitor.prototype.__defineGetter__('data', function () {
  var self = this,
    childData;

  childData = {
    ctime: this.ctime,
    command: this.command,
    file: this.args[0],
    foreverPid: process.pid,
    logFile: this.logFile,
    args: this.args.slice(1),
    pids: this.children.map(function (child) {
      return child.pid;
    }),
    silent: this.silent,
    uid: this.uid,
    id: this.id,
    spawnWith: this.spawnWith,
    running: this.running,
    restarts: this.times,
    isMaster: this.isMaster
  };

  ['pidFile', 'outFile', 'errFile', 'env', 'cwd'].forEach(function (key) {
    if (self[key]) {
      childData[key] = self[key];
    }
  });

  if (this.sourceDir) {
    childData.sourceDir = this.sourceDir;
    childData.file = childData.file.replace(this.sourceDir + '/', '');
  }

  this.childData = childData;
  return this.childData;

  //
  // Setup the forever process to listen to
  // SIGINT and SIGTERM events so that we can
  // clean up the *.pid file
  //
  // Remark: This should work, but the fd gets screwed up
  //         with the daemon process.
  //
  // process.on('SIGINT', function () {
  //   process.exit(0);
  // });
  //
  // process.on('SIGTERM', function () {
  //   process.exit(0);
  // });
  // process.on('exit', function () {
  //   fs.unlinkSync(childPath);
  // });
});

//
// ### function restart ()
// Restarts the target script associated with this instance.
//
Monitor.prototype.restart = function () {
  this.times = this.times || {};
  this.forceRestart = true;
  return !this.running ? this.start(true) : this.kill(false);
};

//
// ### function stop ()
// Stops the target script associated with this instance. Prevents it from auto-respawning
//
Monitor.prototype.stop = function () {
  this.isStopping = true;
  return this.kill(true);
};

//
// ### function kill (forceStop)
// #### @forceStop {boolean} Value indicating whether short circuit forever auto-restart.
// Kills the ChildProcess object associated with this instance.
//
Monitor.prototype.kill = function (forceStop) {
  var childrenCopy = this.children.slice(0, this.children.length);
  var self = this;
  if (!childrenCopy || !childrenCopy.length || (!this.running && !this.forceRestart)) {
    process.nextTick(function () {
      this.running = false;
      var err = new Error('Cannot stop process that is not running.');
      err.code = forceStop ? 'EFSEND' : 'ESEND';
      self.emit('error', err);
    });
  }
  else {
    childrenCopy.forEach(function (child) {
      //
      // Set an instance variable here to indicate this
      // stoppage is forced so that when `child.on('exit', ..)`
      // fires in `Monitor.prototype.start` we can short circuit
      // and prevent auto-restart
      //
      if (forceStop) {
        this.forceStop = true;
        //
        // If we have a time before we truly kill forcefully, set up a timer
        //
        if (self.killTTL) {
          var timer = setTimeout(function () {
            console.log(new Date().toISOString() + ' - info: Start force shutdown '
              + child.pid + ' with SIGKILL');
            common.kill(child.pid, self.killTree, 'SIGKILL');
          }, self.killTTL);
          child.once('exit', function () {
            clearTimeout(timer);
          });
        }
      }
      child.once('exit', function () {
        if (!self.forceRestart && self.children.length === 0) {
          self.emit('stop', self.child);
        }
      });
      console.log(new Date().toISOString() + ' - info: Start shutdown '
        + child.pid + ' with ' + self.killSignal);
      common.kill(child.pid, self.killTree, self.killSignal);
    });
  }
  childrenCopy = null;
  return this;
};

//
// ### function send ()
// Sends a message to a forked ChildProcess object associated with this instance.
// see http://nodejs.org/api/child_process.html#child_process_child_send_message_sendhandle
//
Monitor.prototype.send = function (msg) {
  var child = this.child,
    self = this;

  if (!child || !this.running) {
    process.nextTick(function () {
      self.emit('error', new Error('Cannot send to process that is not running.'));
    });
  }

  if (child.send) {
    child.send(msg);
  }
};

//
// ### function toString ()
// Override default toString behavior and just respond
// with JSON for this instance.
//
Monitor.prototype.toString = function () {
  return JSON.stringify(this);
};

//
// ### function inspect ()
// Set this to null so that `util.inspect` does not
// return `undefined`.'
//
Monitor.prototype.inspect = null;

//
// ### @private function _getEnv ()
// Returns the environment variables that should be passed along
// to the target process spawned by this instance.
//
Monitor.prototype._getEnv = function () {
  var self = this,
    merged = {};

  function addKey(key, source) {
    merged[key] = source[key];
  }

  //
  // Mixin the key:value pairs from `process.env` and the custom
  // environment variables in `this._env`.
  //
  Object.keys(process.env).forEach(function (key) {
    if (!self._hideEnv[key]) {
      addKey(key, process.env);
    }
  });

  Object.keys(this._env).forEach(function (key) {
    addKey(key, self._env);
  });

  return merged;
};

//
// ### function parseCommand (command, args)
// #### @command {String} Command string to parse
// #### @args    {Array}  Additional default arguments
//
// Returns the `command` and the `args` parsed
// from the command depending on the Platform.
//
Monitor.parseCommand = function (command, args) {
  var match = command.match(
    process.platform === 'win32' ? safetyChecks.windows : safetyChecks.linux
  );

  //
  // No match means it's a bad command. This is configurable
  // by passing a custom `parser` function into the `Monitor`
  // constructor function.
  //
  if (!match) {
    return false;
  }

  if (process.platform == 'win32') {
    command = match[1] || match[2];
    if (match[3]) {
      args = match[3].split(' ').concat(args);
    }
  }
  else {
    command = match[1];
    if (match[2]) {
      args = match[2].split(' ').concat(this.args);
    }
  }

  return {
    command: command,
    args: args
  };
};

//
// ### @private {Object} safetyChecks
// Define default safety checks for commands
// with spaces in Windows & Linux
//
var safetyChecks = {
  windows: /(?:"(.*[^\/])"|(\w+))(?:\s(.*))?/,
  linux: /(.*?[^\\])(?: (.*)|$)/
};
