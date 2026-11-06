#!/usr/bin/env node
// Dependencies and configuration
var http = require("http");
var express = require("express");
var app = express();
var nconf = require('nconf');
nconf.file({ file: './config.json' });
var fs = require('fs');
var Gpio = require('onoff').Gpio;
var temperatureSensor = require('node-dht-sensor');
var log4js = require("log4js");

log4js.configure({
    appenders: { fireplace: { type: "file", filename: "fireplace.log" } },
    categories: { default: { appenders: ["fireplace"], level: "debug" } }
  });

const fileLogger = log4js.getLogger("fireplace");

// Write a timestamped message to the console and application log.
var logMessage = function(module,message) {
    console.log("[%s] [%s] %s", new Date().toISOString(), module, message);
    fileLogger.info("[%s] %s", module, message);
}

logMessage("Modules","Modules loaded");

var httpPort = nconf.get('httpport');
var relayReportIntervalMs = nconf.get('relayReportIntervalMs');
var deviceRegistry = new Map();

// Log invalid configuration and stop startup before GPIO initialization.
function throwConfigurationError(message) {
    logMessage("Config","Configuration error: " + message);
    throw new Error('Configuration error: ' + message);
}

// Check that a value fits the positive interval range supported by Node timers.
function isValidTimerInterval(value) {
    return Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
}

// Validate configured devices and create their independent runtime state.
function loadConfiguredDevices() {
    var discovery = nconf.get('discover');
    var assignedPins = new Set();
    if (!Number.isSafeInteger(httpPort) || httpPort < 1 || httpPort > 65535) {
        throwConfigurationError('httpport must be an integer from 1 to 65535');
    }
    if (!isValidTimerInterval(relayReportIntervalMs)) {
        throwConfigurationError('relayReportIntervalMs must be a positive timer interval');
    }
    if (!discovery || discovery.type !== 'discover' || !Array.isArray(discovery.devices)) {
        throwConfigurationError('discover must contain type "discover" and a devices array');
    }

    // Reject invalid BCM pins and conflicting relay, sensor, or input assignments.
    function reserveGpioPin(pin,name) {
        if (!Number.isSafeInteger(pin) || pin < 0 || pin > 27) {
            throwConfigurationError(name + ' must use a BCM GPIO number from 0 to 27');
        }
        if (assignedPins.has(pin)) {
            throwConfigurationError('BCM GPIO' + pin + ' is assigned more than once (' + name + ')');
        }
        assignedPins.add(pin);
    }

    discovery.devices.forEach(function (config) {
        if (!config || typeof config.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(config.name)) {
            throwConfigurationError('each device needs a URL-safe name using letters, numbers, "_" or "-"');
        }
        if (deviceRegistry.has(config.name)) {
            throwConfigurationError('duplicate device name: ' + config.name);
        }
        if (typeof config.label !== 'string' || !config.label.trim() ||
            typeof config.devicetypename !== 'string' || !config.devicetypename.trim()) {
            throwConfigurationError(config.name + ' needs a label and devicetypename');
        }
        reserveGpioPin(config.gpio,config.name);
        if (config.type === 'switch') {
            if (typeof config.activeLow !== 'boolean' ||
                (config.mode !== 'maintained' && config.mode !== 'momentary')) {
                throwConfigurationError(config.name + ' needs activeLow and mode "maintained" or "momentary"');
            }
            if (config.mode === 'momentary' && !isValidTimerInterval(config.pulseMs)) {
                throwConfigurationError(config.name + ' needs a positive pulseMs timer interval');
            }
            if (config.manualInput !== undefined) {
                var input = config.manualInput;
                if (config.mode !== 'maintained' || !input || typeof input !== 'object') {
                    throwConfigurationError(config.name + ' manualInput is supported only on maintained relays');
                }
                reserveGpioPin(input.gpio,config.name + ' manualInput');
                if (typeof input.activeLow !== 'boolean' || typeof input.controlEnabled !== 'boolean' ||
                    !isValidTimerInterval(input.checkIntervalMs) || !isValidTimerInterval(input.checkCount)) {
                    throwConfigurationError(config.name + ' manualInput needs activeLow, controlEnabled, checkIntervalMs and checkCount');
                }
            }
        }
        else if (config.type === 'temperature') {
            if ((config.sensorType !== 11 && config.sensorType !== 22) || !isValidTimerInterval(config.pollIntervalMs)) {
                throwConfigurationError(config.name + ' needs sensorType 11 or 22 and a positive pollIntervalMs');
            }
            if (config.manualInput !== undefined) {
                throwConfigurationError(config.name + ' manualInput is supported only on maintained relays');
            }
        }
        else{
            throwConfigurationError('unsupported device type for ' + config.name + ': ' + config.type);
        }
        deviceRegistry.set(config.name, {
            config: config,
            relayGpio: null,
            confirmedRelayState: config.activeLow ? 1 : 0,
            observedRelayState: config.activeLow ? 1 : 0,
            pulseTimer: null,
            manualInputGpio: null,
            confirmedInputState: null,
            candidateInputState: null,
            inputCheckTimer: null
        });
    });
}

loadConfiguredDevices();

// Find a configured relay, rejecting missing devices and temperature sensors.
function getRelayDevice(deviceName) {
    var item = deviceRegistry.get(deviceName);
    if (!item || item.config.type !== 'switch') {
        throw new Error('Unknown relay: ' + deviceName);
    }
    return item;
}

// Convert logical ON/OFF to the output level required by this relay's polarity.
function getRelayOutputLevel(item,on) {
    var onLevel = item.config.activeLow ? 0 : 1;
    return on ? onLevel : 1 - onLevel;
}

// Convert a verified GPIO level to the ON/OFF label used by HTTP and Hubitat.
function getRelayStateLabel(item,state) {
    return state === getRelayOutputLevel(item,true) ? "ON" : "OFF";
}

// HTTP endpoints
var api = express.Router();
app.use('/api',api);

// Report HTTP availability without reading or operating any hardware.
app.get("/", function handleHealthRequest(req, res) {
    res.send("<html><body><h1>FirePlace ON</h1></body></html>");
});

// Read a configured relay or sensor and report its current state to Hubitat.
api.get('/:device', function handleDeviceStatusRequest(req, res) {
    let deviceName = req.params['device'];
    let ip = req.ip;
    logMessage("/api/"+deviceName,"Received request at: " + deviceName + " Source IP: "+ip);
    var item = deviceRegistry.get(deviceName);
    if (!item) {
        res.status(404).send("Device not found");
        return;
    }
    if (item.config.type === 'switch') {
        item.observedRelayState = readRelayOutput(deviceName,item.relayGpio,item.confirmedRelayState);
        var status = {};
        status[deviceName] = getRelayStateLabel(item,item.observedRelayState);
        status.physicalrelay = status[deviceName];
        queueDeviceStateNotification(deviceName,status[deviceName]);
        logMessage("HTTP","Request at /api/" + deviceName);
        res.send(status);
    }
    else{
        readTemperature(deviceName,function (err, temperature) {
            if (err) {
                res.status(500).send("Error: " + err);
                return;
            }
            res.send(temperature);
        });
    }
});

// Apply maintained commands or start/report a momentary pulse without extending it.
api.get('/:device/:command', function handleRelayCommandRequest(req, res) {
    let deviceName = req.params['device'];
    let command = req.params['command'];
    let ip = req.ip;
    logMessage("/api/"+deviceName+"/"+command,"Received request at: " + deviceName + " " + command + " Source IP: "+ip);
    var item = deviceRegistry.get(deviceName);
    if (!item || item.config.type !== 'switch') {
        res.status(404).send("Device not found");
        return;
    }
    switch (command) {
        case "on":
            if (item.config.mode === 'momentary') {
                pulseRelay(deviceName);
            }
            else{
                setRelayOutput(getRelayOutputLevel(item,true),deviceName);
            }
            break;
        case "off":
            if (item.config.mode === 'momentary') {
                verifyAndReportRelayOutput(getRelayOutputLevel(item,item.pulseTimer !== null),deviceName);
            }
            else{
                setRelayOutput(getRelayOutputLevel(item,false),deviceName);
            }
            break;
        default:
            res.status(404).send("Command not found");
            return;
    }
    logMessage("HTTP","Request at /api/" + deviceName + "/" + command);
    res.end();
});

// Return discovery JSON for bootstrap, or preserve the legacy notification-only response.
app.get("/discover", function handleDiscoveryRequest(req, res) {
    if (req.query.response === "json") {
        res.json(getDeviceDiscovery());
        return;
    }
    sendDeviceDiscovery();
    res.end();
});

// Save Hubitat's callback address, then report current outputs without operating them.
app.get('/subscribe/:host', function handleSubscriptionRequest(req, res, next) {
    var parts = req.params.host.split(":");
    nconf.set('notify:address', parts[0]);
    nconf.set('notify:port', parts[1]);
    nconf.save(function (err) {
      if (err) {
        logMessage("Subscribe",'Configuration error: '+err.message);
        res.status(500).json({ error: 'Configuration error: '+err.message });
        return;
      }
      try {
        reportRelayStates();
      } catch (err) {
        logMessage("Subscribe",'Relay state reporting error: '+err.message);
        next(err);
        return;
      }
      res.end();
      logMessage("Subscribe","Hubitat IP address: "+parts[0] +" Port: "+ parts[1]);
    });
});


logMessage("HTTP Endpoint","All HTTP endpoints loaded");

// GPIO initialization
// onoff expects global sysfs GPIO numbers, not BCM line offsets.
var gpioRoot = '/sys/class/gpio';
var relayDevices = Array.from(deviceRegistry.values()).filter(function (item) {
    return item.config.type === 'switch';
});
if (relayDevices.length > 0) {
    var gpioChips = fs.readdirSync(gpioRoot).filter(function (name) {
        return /^gpiochip\d+$/.test(name) &&
            fs.readFileSync(gpioRoot + '/' + name + '/label', 'utf8').trim() == 'pinctrl-bcm2835';
    });
    if (gpioChips.length != 1) {
        throw new Error('Expected one pinctrl-bcm2835 GPIO controller in ' + gpioRoot + ', found ' + gpioChips.length);
    }
    var gpioBaseValue = fs.readFileSync(gpioRoot + '/' + gpioChips[0] + '/base', 'utf8').trim();
    var gpioBase = Number(gpioBaseValue);
    if (!/^\d+$/.test(gpioBaseValue) || !Number.isSafeInteger(gpioBase)) {
        throw new Error('Invalid sysfs GPIO base: ' + gpioBaseValue);
    }
    logMessage("GPIO","Using " + gpioChips[0] + " with sysfs base " + gpioBase);
}

// Initialize outputs directly to their OFF level before starting the HTTP server.
relayDevices.forEach(function (item) {
    item.relayGpio = new Gpio(gpioBase + item.config.gpio, item.config.activeLow ? 'high' : 'low');
});
relayDevices.forEach(function (item) {
    item.confirmedRelayState = readRelayOutput(item.config.name,item.relayGpio,item.confirmedRelayState);
    item.observedRelayState = item.confirmedRelayState;
    if (item.confirmedRelayState !== getRelayOutputLevel(item,false)) {
        throw new Error('Relay initialization failed for ' + item.config.name + ': all relays must be OFF before starting the HTTP server');
    }
});
logMessage("GPIO","All relays initialized OFF");

// Record each manual input's baseline without applying it to the relay at startup.
relayDevices.forEach(function (item) {
    if (item.config.manualInput) {
        item.manualInputGpio = new Gpio(gpioBase + item.config.manualInput.gpio, 'in', 'both');
        item.confirmedInputState = readManualInput(item);
        item.candidateInputState = item.confirmedInputState;
    }
});

// HTTP server
var server = http.createServer(app);
server.listen(httpPort);
logMessage("HTTP Endpoint","HTTP Server Created at port: "+httpPort);

// Queue a relay state or sensor reading using Hubitat's existing message format.
function queueDeviceStateNotification(deviceName,command) {
    var message = JSON.stringify({device: deviceName,command: command});
    queueHubitatNotification(message);
    logMessage("Hubitat","Queued Hubitat state: " + message);
}

// Hubitat notification delivery
var notificationQueue = new Map();
var notificationInFlight = false;
var notificationTimeoutMs = 5000;
var notificationRetryDelays = [5000, 15000, 30000];

// Coalesce pending updates per device or message type, then start delivery.
var queueHubitatNotification = function(data) {
    var message = JSON.parse(data);
    var key = message.device ? 'device:' + message.device : 'type:' + message.type;
    var entry = notificationQueue.get(key);
    if (entry) {
        entry.data = data;
        entry.version++;
    } else {
        notificationQueue.set(key, {
            key: key,
            device: message.device,
            data: data,
            version: 0,
            retries: 0,
            retryTimer: null
        });
    }
    flushNotificationQueue();
}

// Send one ready notification at a time and schedule bounded retries on failure.
function flushNotificationQueue() {
    if (notificationInFlight) return;
    var entry = Array.from(notificationQueue.values()).find(function (item) {
        return item.retryTimer === null;
    });
    if (!entry) return;

    notificationInFlight = true;
    var version = entry.version;
    sendHubitatNotification(entry, function (err) {
        notificationInFlight = false;
        if (err) {
            logMessage("Notify","Notification error for " + entry.key + ": " + err.message);
            if (entry.retries < notificationRetryDelays.length) {
                var delay = notificationRetryDelays[entry.retries++];
                logMessage("Notify","Retrying " + entry.key + " in " + delay + "ms");
                entry.retryTimer = setTimeout(function () {
                    entry.retryTimer = null;
                    flushNotificationQueue();
                }, delay);
            } else {
                notificationQueue.delete(entry.key);
                logMessage("Notify","Retries exhausted for " + entry.key + "; a new update or periodic relay snapshot is required");
            }
        } else {
            logMessage("Notify","Hubitat accepted notification for " + entry.key);
            notificationQueue.delete(entry.key);
            if (entry.version !== version) {
                entry.retries = 0;
                notificationQueue.set(entry.key, entry);
            }
        }
        flushNotificationQueue();
    });
}

// Deliver one HTTP NOTIFY, refreshing relay readback before every send or retry.
function sendHubitatNotification(entry,callback) {
    var req;
    var timeout;
    var finished = false;
    // Finish once, cancel the deadline, and close failed requests before notifying the queue.
    function completeNotification(err) {
        if (finished) return;
        finished = true;
        if (timeout !== undefined) clearTimeout(timeout);
        if (err && req) req.destroy();
        callback(err);
    }

    try {
        if (!nconf.get('notify:address') || !nconf.get('notify:port')) {
            throw new Error('Notify server address and port not set');
        }
        var data = entry.data;
        // Queued or retried relay messages must describe the output now, not an old pulse.
        var item = deviceRegistry.get(entry.device);
        if (item && item.config.type === 'switch') {
            item.observedRelayState = readRelayOutput(entry.device,item.relayGpio,item.confirmedRelayState);
            data = JSON.stringify({device: entry.device, command: getRelayStateLabel(item,item.observedRelayState)});
        }
        var opts = {
            method: 'NOTIFY',
            host: nconf.get('notify:address'),
            port: nconf.get('notify:port'),
            path: '/notify',
            headers: {
                'CONTENT-TYPE': 'application/json',
                'CONTENT-LENGTH': Buffer.byteLength(data),
                'device': entry.device || 'discover'
            }
        };
        req = http.request(opts, function (res) {
            res.on('error', completeNotification);
            res.on('aborted', function () {
                completeNotification(new Error('Hubitat response was interrupted'));
            });
            res.on('end', function () {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    completeNotification();
                } else {
                    completeNotification(new Error('Hubitat returned HTTP ' + res.statusCode));
                }
            });
            res.resume();
        });
        req.on('error', completeNotification);
        timeout = setTimeout(function () {
            completeNotification(new Error('Hubitat notification timed out after ' + notificationTimeoutMs + 'ms'));
        }, notificationTimeoutMs);
        logMessage("Notify","Sending notification: " + data);
        req.write(data);
        req.end();
    } catch (err) {
        completeNotification(err);
    }
}

// Read a valid output level and log differences from the last confirmed command.
function readRelayOutput(deviceName,gpio,confirmedState) {
    if (!gpio || typeof gpio.readSync !== 'function') {
        throw new Error('Relay not initialized: ' + deviceName);
    }
    var state = gpio.readSync();
    if (state !== 0 && state !== 1) {
        throw new Error('Invalid relay readback for ' + deviceName + ': ' + state);
    }
    if (state !== confirmedState) {
        logMessage("GPIO","WARNING: Relay state mismatch for " + deviceName + ": tracked " + confirmedState + ", read " + state);
    }
    return state;
}

// Read all relay outputs before queuing their snapshot; never operate a relay here.
function reportRelayStates() {
    relayDevices.forEach(function (item) {
        item.observedRelayState = readRelayOutput(item.config.name,item.relayGpio,item.confirmedRelayState);
    });
    relayDevices.forEach(function (item) {
        queueDeviceStateNotification(item.config.name,getRelayStateLabel(item,item.observedRelayState));
    });
}

reportRelayStates();

// Reconcile relay notifications periodically, logging failures for the next attempt.
setInterval(function reconcileRelayStates() {
    try {
        reportRelayStates();
    } catch (err) {
        logMessage("GPIO","Relay state reconciliation error: " + err.message);
    }
}, relayReportIntervalMs);

// Describe configured device identities without exposing hardware settings.
function getDeviceDiscovery(){
    return {
        type: "discover",
        devices: Array.from(deviceRegistry.values()).map(function (item) {
            return {
                type: item.config.type,
                devicetypename: item.config.devicetypename,
                name: item.config.name,
                label: item.config.label
            };
        })
    };
}

// Advertise the same discovery descriptors through the legacy notification channel.
function sendDeviceDiscovery(){
    var discovery = getDeviceDiscovery();
    queueHubitatNotification(JSON.stringify(discovery));
    logMessage("Discovery","Sending devices back: " + JSON.stringify(discovery));
    return;
}

// Create a short identifier to correlate manual-input checks in the log.
function createLogCorrelationId() {
    return Math.random().toString(26).slice(2);
}

// Read a manual input and reject GPIO levels other than LOW or HIGH.
function readManualInput(item) {
    var state = item.manualInputGpio.readSync();
    if (state !== 0 && state !== 1) {
        throw new Error('Invalid manual input readback for ' + item.config.name + ': ' + state);
    }
    return state;
}

// Confirm a stable input change with one polling interval per device.
function checkManualInputChange(deviceName,callback){
    var item = getRelayDevice(deviceName);
    if (item.inputCheckTimer !== null) return;
    var stableCheckCount = 0;
    var requiredChecks = item.config.manualInput.checkCount;
    var checkIntervalMs = item.config.manualInput.checkIntervalMs;
    var checkId = createLogCorrelationId();
    item.candidateInputState = readManualInput(item);
    logMessage(checkId+"-ManualInput","Checking " + deviceName + " input state: " + item.candidateInputState);
    if (item.confirmedInputState != item.candidateInputState) {
        logMessage(checkId+"-ManualInput","Possible input change to: " + item.candidateInputState);
        // Reset the count on sampled changes; clear the timer before applying a result.
        item.inputCheckTimer = setInterval(function confirmManualInputChange(){
            try {
                var state = readManualInput(item);
                if (state !== item.candidateInputState) {
                    item.candidateInputState = state;
                    stableCheckCount = 0;
                }
                if (stableCheckCount >= requiredChecks) {
                    clearInterval(item.inputCheckTimer);
                    item.inputCheckTimer = null;
                    if (item.confirmedInputState != item.candidateInputState) {
                        logMessage(checkId+"-ManualInput","Confirmed input state after " + requiredChecks + " checks at " + checkIntervalMs + "ms: " + item.candidateInputState);
                        item.confirmedInputState = item.candidateInputState;
                        callback(true);
                    }
                    else{
                        logMessage(checkId+"-ManualInput","Input returned to its confirmed state; ignoring the change");
                        callback(false);
                    }
                }
                stableCheckCount++;
            } catch (err) {
                if (item.inputCheckTimer !== null) clearInterval(item.inputCheckTimer);
                item.inputCheckTimer = null;
                logMessage("ManualInput","Manual input error for " + deviceName + ": " + err.message);
            }
          }, checkIntervalMs);
    }
    else{
        logMessage(checkId+"-ManualInput","Input state unchanged; ignoring the edge");
        callback(false);
    }
}

// Manual-input monitoring
relayDevices.forEach(function (item) {
    if (!item.manualInputGpio) return;
    // Check input edges and follow confirmed changes only when control is enabled.
    item.manualInputGpio.watch(function handleManualInputEdge(err, value) {
        var deviceName = item.config.name;
        var eventId = createLogCorrelationId();
        logMessage(eventId+"-ManualInput","Input edge detected for " + deviceName);
        if (err) {
            console.error('There was an error', err);
            logMessage(eventId+"-ManualInput","Manual input watch error for " + deviceName + ": " + err);
            return;
        }
        try {
            // Apply only confirmed changes, allowing API commands to override unchanged inputs.
            checkManualInputChange(deviceName,function applyManualInputChange(changed) {
                if (changed) {
                    if (item.config.manualInput.controlEnabled) {
                        var on = item.candidateInputState === (item.config.manualInput.activeLow ? 0 : 1);
                        setRelayOutput(getRelayOutputLevel(item,on),deviceName);
                    }
                    else{
                        logMessage(eventId+"-ManualInput","Manual relay control disabled for " + deviceName);
                    }
                }
                else{
                    logMessage(eventId+"-ManualInput","No confirmed input change");
                }
            });
        } catch (err) {
            logMessage("ManualInput","Manual input error for " + deviceName + ": " + err.message);
        }
    });
});

// Write a requested GPIO level, then verify it before reporting successful control.
function setRelayOutput(requestedLevel,deviceName){
    var item = getRelayDevice(deviceName);
    if (requestedLevel !== 0 && requestedLevel !== 1) {
        throw new Error('Invalid relay state for ' + deviceName + ': ' + requestedLevel);
    }
    logMessage("Relay","Setting " + deviceName + " output level to: " + requestedLevel);
    item.relayGpio.writeSync(requestedLevel);
    verifyAndReportRelayOutput(requestedLevel,deviceName);
};

// Confirm the expected level, update command state, and queue the Hubitat event.
function verifyAndReportRelayOutput(expectedLevel,deviceName) {
    var item = getRelayDevice(deviceName);
    var state = item.relayGpio.readSync();
    item.observedRelayState = state;
    if (state !== expectedLevel) {
        throw new Error('Relay verification failed for ' + deviceName + ': expected ' + expectedLevel + ', read ' + state);
    }
    item.confirmedRelayState = state;
    queueDeviceStateNotification(deviceName,getRelayStateLabel(item,state));
}

// Start one momentary pulse, preserving its release timer across repeated requests.
function pulseRelay(deviceName) {
    var item = getRelayDevice(deviceName);
    if (item.config.mode !== 'momentary') {
        throw new Error('Relay is not momentary: ' + deviceName);
    }
    if (item.pulseTimer !== null) {
        verifyAndReportRelayOutput(getRelayOutputLevel(item,true),deviceName);
        logMessage("HTTP","Relay " + deviceName + " already ON");
        return;
    }
    var gpio = item.relayGpio;
    logMessage("Relay","Changing " + deviceName + " relay state to ON");
    // Keep release scheduled even if the ON write, readback, or notification fails.
    item.pulseTimer = setTimeout(function releaseRelayPulse() {
        logMessage("Relay","Changing " + deviceName + " relay state to OFF");
        gpio.writeSync(getRelayOutputLevel(item,false));
        verifyAndReportRelayOutput(getRelayOutputLevel(item,false),deviceName);
        item.pulseTimer = null;
     }, item.config.pulseMs);
    gpio.writeSync(getRelayOutputLevel(item,true));
    verifyAndReportRelayOutput(getRelayOutputLevel(item,true),deviceName);
}

// Read a configured DHT sensor, notify Hubitat, and optionally return HTTP values.
function readTemperature(deviceName,callback){
    var item = deviceRegistry.get(deviceName);
    if (!item || item.config.type !== 'temperature') {
        throw new Error('Unknown temperature sensor: ' + deviceName);
    }
    temperatureSensor.read(item.config.sensorType, item.config.gpio, function(err, temperature, humidity) {
        if (!err && (!Number.isFinite(temperature) || !Number.isFinite(humidity))) {
            err = new Error('Invalid temperature or humidity reading');
        }
        if (!err) {

            var temperatureCelsius = temperature.toFixed(1);
            var temperatureFahrenheit = temperatureCelsius * 9 / 5 + 32;
            var humidityPercent = humidity.toFixed(1);

            logMessage("Temperature",deviceName + " Temperature in Fahrenheit: " + temperatureFahrenheit + ' °F');
            logMessage("Temperature",deviceName + " Temperature in Celsius: " + temperatureCelsius + ' °C');
            logMessage("Temperature",deviceName + " Humidity: " + humidityPercent + ' %');
            var readingMessage = temperatureFahrenheit.toString() + "-" + humidityPercent;
            queueDeviceStateNotification(deviceName,readingMessage);
            if (callback) callback(null, {
                vartemperatureF: temperatureFahrenheit,
                vartemperatureC: temperatureCelsius,
                varhumidity: humidityPercent
            });
        }
        else{
            logMessage("Temperature",deviceName + " Error: " + err);
            if (callback) callback(err);
        }
    });
};

// Temperature polling
deviceRegistry.forEach(function (item, deviceName) {
    if (item.config.type === 'temperature') {
        // Read this sensor at its own configured interval and log polling failures.
        setInterval(function pollTemperature() {
            try {
                readTemperature(deviceName);
            } catch (err) {
                logMessage("Temperature",deviceName + " Error: " + err.message);
            }
        }, item.config.pollIntervalMs);
    }
});
