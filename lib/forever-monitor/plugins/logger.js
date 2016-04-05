/*
 * logger.js: Plugin for `Monitor` instances which adds stdout and stderr logging.
 *
 * (C) 2010 Charlie Robbins & the Contributors
 * MIT LICENCE
 *
 */

var fs = require('fs');

//
// Name the plugin
//
exports.name = 'logger';

//
// ### function attach (options)
// #### @options {Object} Options for attaching to `Monitor`
//
// Attaches functionality for logging stdout and stderr to `Monitor` instances.
//
exports.attach = function (options) {
  options = options || {};
  var monitor = this;
  if (options.outFile) {
    monitor.stdout = options.stdout || fs.createWriteStream(options.outFile, {
      flags: monitor.append ? 'a+' : 'w+',
      encoding: 'utf8',
      mode: 0644
    });
  }

  if (options.errFile) {
    monitor.stderr = options.stderr || fs.createWriteStream(options.errFile, {
      flags: monitor.append ? 'a+' : 'w+',
      encoding: 'utf8',
      mode: 0644
    });
  }

  // monitor.on('start', startLogs);
  // monitor.on('restart', startLogs);
  monitor.on('worker:start', startLogs);
  monitor.on('worker:restart', startLogs);
  monitor.on('stop', stopAllLogs);
  monitor.on('exit', stopAllLogs);

  function stopLogs(pid, index, child) {
    if (child && child.stdout && child.stderr) {

      if (monitor.stdout) {
        //
        // Remark: 0.8.x doesnt have an unpipe method
        //
        child.stdout.unpipe && child.stdout.unpipe(monitor.stdout);
        monitor.stdout.destroy();
        monitor.stdout = null;
      }
      //
      // Remark: 0.8.x doesnt have an unpipe method
      //
      if (monitor.stderr) {
        child.stderr.unpipe && child.stderr.unpipe(monitor.stderr);
        monitor.stderr.destroy();
        monitor.stderr = null;
      }
    }
  }

  function stopAllLogs() {
    if (monitor.children) {
      monitor.children.forEach(function (child) {
        stopLogs(child.pid, child.index, child);
      });
    }
  }

  function startLogs(pid, index, child) {
    if (child && child.stdout && child.stderr) {
      // child.stdout.on('data', function onStdout(data) {
      //   monitor.emit('stdout', data);
      // });

      // child.stderr.on('data', function onStderr(data) {
      //   monitor.emit('stderr', data);
      // });

      if (monitor.stdout) {
        child.stdout.pipe(monitor.stdout, {
          end: false
        });
      }

      if (monitor.stderr) {
        child.stderr.pipe(monitor.stderr, {
          end: false
        });
      }
    }
  }
};
