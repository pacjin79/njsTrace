var util = require('util'),
	extend = require('extend'),
	Module = require('module'),
	EventEmitter = require('events').EventEmitter,
	Injector = require('./lib/injector.js'),
	Output = require('./lib/output.js'),
	Tracer = require('./lib/tracer.js');

var DEFAULT_CONFIG = {
	enabled: true,
	logger: false,
	trace: true,
	prof: false,
	onTraceEntry: null,
	onTraceExit: null
};

 /**
 * Creates a new instance of NJSTrace
 * @class The main class that is responsible for the entire njsTrace functionality
 * @extends EventEmitter
 * @param {NJSTrace~NJSConfig} [config] - A configuration object
 * @constructor
 */
function NJSTrace(config) {
	EventEmitter.call(this);

	// Merge the config with the default config
	this.config = {};
	extend(true, this.config, DEFAULT_CONFIG, config);

	if (!this.config.enabled) {
		return;
	}

	// Set the logger
	this.logger = new Output(this.config.logger);

	this.log('New instance of NJSTrace created with config:', this.config);

	// Validate trace functions (if provided).
    if (this.config.onTraceEntry && typeof this.config.onTraceEntry !== 'function') {
        throw new Error('onTraceEntry in config object must be a function');
    } else if (this.config.onTraceExit && typeof this.config.onTraceExit !== 'function') {
        throw new Error('onTraceExit in config object must be a function');
    }

	// Make sure that both traceEntry/Exit are provided (or both not provided).
    this.config.onTraceEntry = this.config.onTraceEntry || null;
    this.config.onTraceExit = this.config.onTraceExit || null;
    if (typeof this.config.onTraceEntry !== typeof this.config.onTraceExit) {
		throw new Error('onTraceEntry and onTraceExit must be both provided or both be null');
	}

	// Set the tracer, this is relevant only in case no custom trace handler provided
	this.tracer = this.config.onTraceEntry ? null : new Tracer(this.config.trace, this.config.prof);

	this.hijackCompile();
	this.setGlobalFunction();

	this.log('njsTrace done loading...');
 }
util.inherits(NJSTrace, EventEmitter);

/**
 * NJSTrace exposed event names
 * @type {object}
 * @property {string} Error - An error event
 * @property {string} Warn - A warning event
 * @example
 * njsTrace.on(NJSTrace.events.error, function() {...});
 */
NJSTrace.events = {
	error: 'error',
	warn: 'warn'
};

// Define some properties with get/set on the prototype
Object.defineProperties(NJSTrace.prototype, {
	/**
	 * See "prof" property on {@link NJSTrace~NJSConfig}
	 * @memberOf! NJSTrace.prototype
	 */
	'prof': {
		get: function() {return this.config.prof;},
		set: function(value) {
			this.config.prof = value;
			this.log('NJSTrace prof property changed to: ', this.config.prof);
			if (this.config.onTraceEntry) {
				this.log('warn: prof property will be ignored as a custom onTraceEntry was provided');
			}
			if (this.tracer) {
				this.tracer.prof = this.config.prof;
			}
		}
	},
	/**
	 * See "trace" property on {@link NJSTrace~NJSConfig}
	 * @memberOf NJSTrace.prototype
	 */
	'trace': {
		get: function() {return this.config.trace;},
		set: function(value) {
			this.config.trace = value;
			this.log('NJSTrace trace property changed to: ', this.config.trace);
			if (this.config.onTraceEntry) {
				this.log('warn: trace property will be ignored as a custom onTraceEntry was provided');
			}
			if (this.tracer) {
				this.tracer.trace = this.config.trace;
			}
		}
	}
});

/**
 * Simple logger function
 * @param {...string|number|object} arguments
 * @private
 */
NJSTrace.prototype.log = function() {
	if (!this.logger) {
		return;
	}

	// Don't want to insert our prefix into args (can effect format strings), so use print which doesn't put newline.
	this.logger.print('njsTrace: ');
	this.logger.write.apply(this.logger, arguments);
};

/**
 * Hijack Node.js Module._compile method and inject the tracing stuff...
 * @private
 */
NJSTrace.prototype.hijackCompile = function() {
	this.log('Creating new Injector and hijacking Module.prototype._compile');
	var self = this;
	var injector = new Injector(this, {entryHandler: '__njsTraceEntry__', exitHandler: '__njsTraceExit__', entryDataVar: '__njsEntryData__'});

	// Save a reference to the _compile function and hijack it.
	var origCompile = Module.prototype._compile;
	Module.prototype._compile = function(content, filename) {
		self.log('Instrumenting:', filename);
		content = injector.injectTracing(filename, content, true);
		self.log('Done:', filename);

		// And continue with the original compile...
		origCompile.call(this, content, filename);
	};
};

/**
 * Sets njsTrace tracing functions on the global context
 * @private
 */
NJSTrace.prototype.setGlobalFunction = function() {
	var self = this;

	this.log('Setting global.__njsTraceEntry__ function');
	global.__njsTraceEntry__ = function(args) {
		if (self.config.onTraceEntry) {
			return self.config.onTraceEntry(args);
		} else {
			return self.tracer.onEntry(args);
		}
	};

	this.log('Setting global.__njsTraceExit__ function');
	global.__njsTraceExit__ = function(args) {
		if (self.config.onTraceExit) {
			return self.config.onTraceExit(args);
		} else {
			return self.tracer.onExit(args);
		}
	};
};

var instance = null;

/**
 * Creates or gets a reference to an NJSTrace instance
 * @param {NJSTrace~NJSConfig} config
 * @returns {NJSTrace} An instance of NJSTrace
 */
module.exports.inject = function(config) {
	if (!instance) {
		instance = new NJSTrace(config);
	}
	return instance;
};

/**
 * This callback is called when there is a message to log
 * @callback NJSTrace~onLog
 * @property {string} message - The log message
 */

/**
 * The callback type that is raised on traced functions entry
 * @callback NJSTrace~onFunctionEntry
 * @property {NJSTrace~functionEntryArgs} args - Object with info about the traced function
 * @returns {Object} An object that will be passed as argument to NJSTrace~onFunctionExit
 */

/**
 * The callback type that is raised on traced functions exit
 * @callback NJSTrace~onFunctionExit
 * @property {NJSTrace~functionExitArgs} args - Object with info about the traced function
 */

/**
 * @typedef {object} NJSTrace~functionEntryArgs
 * @property {string} name - The traced function name
 * @property {string} file - The traced file
 * @property {Number} line - The traced function line number
 * @property {Object} args - The function arguments object
 */

/**
 * @typedef {object} NJSTrace~functionExitArgs
 * @property {Object} entryData - An object that was returned from NJSTrace~onFunctionEntry
 * @property {String} exception - Whether the exit occurred due to exception (throw Statement).
 *                                if "TRUE" then it was an unhandled exception
 * @property {number} line - The line number where the exit is
 * @property {*|undefined} returnValue - The function return value
 */

/**
 * @typedef {object} NJSTrace~NJSConfig
 * @property {boolean} [enabled=true] - Whether njsTrace should instrument the code.

 * @property {boolean|string|NJSTrace~onLog} [logger=false] - If Boolean, indicates whether NJSTrace will log (to the console) its progress.
 *                                                            If string, a path to an output file (absolute or relative to current working dir).
 *                                                            If function, this function will be used as logger
 *
 * @property {boolean|string|function} [trace=true] - If Boolean, indicates whether NJSTrace will output (to the console) trace info.
 *                                                     If string, a path to a trace output file (absolute or relative to current working dir).
 *                                                     If function then this function will be used for output.
 *
 * @property {boolean|string|function} [prof=false]   - If Boolean, indicates whether NJSTrace will output (to the console) profiler info.
 *                                                     If string, a path to a profiler output file (absolute or relative to current working dir).
 *                                                     If function then this function will be used for output.
 *
 * @property {NJSTrace~onFunctionEntry} [onTraceEntry=null] - A custom trace handler that will be called on functions entry.
 *                                                                    If provided, then the trace and prof settings above are ignored.
 *                                                                    If provided, functionExitHandler must be provided as well.
 *
 * @property {NJSTrace~onFunctionExit}  [onTraceExit=null]  - A custom trace handler that will be called on functions exit.
 *                                                                    If provided, then the trace and prof settings above are ignored.
 *                                                                    If provided, functionEntryHandler must be provided as well.
 */
