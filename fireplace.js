#!/usr/bin/env node
// Loading Dependencies
var http = require("http");
var https = require('https');
var express = require("express");
var app = express();
var nconf = require('nconf');
nconf.file({ file: './config.json' });
//var config = require('./config.js');
var fs = require('fs');
var Gpio = require('onoff').Gpio; //include onoff to interact with the GPIO
var sensor = require('node-dht-sensor');
var log4js = require("log4js");

log4js.configure({
    appenders: { fireplace: { type: "file", filename: "fireplace.log" } },
    categories: { default: { appenders: ["fireplace"], level: "debug" } }
  });

const wlogger = log4js.getLogger("fireplace");

////////////////////////////////////////
// Logger Function
////////////////////////////////////////
var logger = function(mod,str) {
    console.log("[%s] [%s] %s", new Date().toISOString(), mod, str);

    // log4js.configure({
    //   appenders: { fireplace: { type: "file", filename: "fireplace.log" } },
    //   categories: { default: { appenders: ["fireplace"], level: "debug" } }
    // });

    // const wlogger = log4js.getLogger("fireplace");
    wlogger.info("[%s] %s", mod, str);
}

logger("Modules","Modules loaded");

var httpport = nconf.get('httpport');
var relaystate = 1;
var oldswitchstate = 0;
var newswitchstate = 0;
var relaystategarage = 1;
var relaystategaragegate = 1;
var garagePulseTimers = { garagedoor: null, garagegate: null };
var physicalrelay = 1;
var physicalrelaygarage = 1;
var physicalrelaygaragegate = 1;
var miliolddate = new Date().getTime();
var milinewdate = new Date().getTime();
var firstexecution = true;


//////////////////////////////////////////////////////////////////
// Creating Endpoints
// Those Endpoints will receive a HTTP GET Request
// Execute the associated Method to make the following:
//  "/" - Used to check if the Fireplace is running
//  "/api/fireplace" - Used to turn on and off the fireplace
//////////////////////////////////////////////////////////////////

var api = express.Router();
app.use('/api',api);
// Used only to check if NodeJS is running
app.get("/", function (req, res) {
    res.send("<html><body><h1>FirePlace ON</h1></body></html>");
});

api.get('/:device', function (req, res) {
    let device = req.params['device']
    let ip = req.ip;
    logger("/api/"+device,"Received request at: " + device + " Source IP: "+ip);
    switch (device) {
        case "fireplace":
            var fireplacestatus = {
                fireplace: "",
                physicalrelay: ""
            }
            physicalrelay = readrelaystate("fireplace",relay,relaystate);
            if (physicalrelay == 1) {
                fireplacestatus.fireplace = "OFF"
            }
            else{
                fireplacestatus.fireplace = "ON"
            }
            fireplacestatus.physicalrelay = fireplacestatus.fireplace;

            sendSmartThingMsg("fireplace",fireplacestatus.fireplace);
            logger("HTTP","Request at /api/fireplace");
            res.send(fireplacestatus);
            break;
        case "garagedoor":
            var garagedoorstatus = {
                garagedoor: "",
                physicalrelaygarage: ""
            }
            physicalrelaygarage = readrelaystate("garagedoor",relaygarage,relaystategarage);
            if (physicalrelaygarage == 1) {
                garagedoorstatus.garagedoor = "OFF"
            }
            else{
                garagedoorstatus.garagedoor = "ON"
            }
            garagedoorstatus.physicalrelaygarage = garagedoorstatus.garagedoor;
            sendSmartThingMsg("garagedoor",garagedoorstatus.garagedoor);
            logger("HTTP","Request at /api/garagedoor");
            res.send(garagedoorstatus);
            break;

        case "garagegate":
            var garagegatestatus = {
                garagegate: "",
                physicalrelaygaragegate: ""
            }
            physicalrelaygaragegate = readrelaystate("garagegate",relaygaragegate,relaystategaragegate);
            if (physicalrelaygaragegate == 1) {
                garagegatestatus.garagegate = "OFF"
            }
            else{
                garagegatestatus.garagegate = "ON"
            }
            garagegatestatus.physicalrelaygaragegate = garagegatestatus.garagegate;
            sendSmartThingMsg("garagegate",garagegatestatus.garagegate);
            logger("HTTP","Request at /api/garagegate");
            res.send(garagegatestatus);
            break;

        case "fireplacetemperature":
            var fireplacetemperature = {
                vartemperatureF: "",
                vartemperatureC: "",
                varhumidity: ""
            }
            sensor.read(11, 21, function(err, temperature, humidity) {
                if (!err) {

                    fireplacetemperature.vartemperatureF = (temperature.toFixed(1) * 9 / 5 + 32 )
                    fireplacetemperature.vartemperatureC = (temperature.toFixed(1))
                    fireplacetemperature.varhumidity = humidity.toFixed(1)
                    logger("HTTP","Request at /api/fireplacetemperature");
                    logger("HTTP","Temperature in Fahrenheit: " + fireplacetemperature.vartemperatureF + ' °F');
                    logger("HTTP","Temperature in Celsius: " + fireplacetemperature.vartemperatureC + ' °C');
                    logger("HTTP","Humidity: " + fireplacetemperature.varhumidity + ' %');

                    var temphumi = (fireplacetemperature.vartemperatureF.toString() + "-" + fireplacetemperature.varhumidity.toString())
                    sendSmartThingMsg("fireplacetemperature",temphumi);
                    res.send(fireplacetemperature);
                }
                else{
                    logger("HTTP","Error: " + err);
                    res.send("Error: " + err);
                }
            });
            break;

        default:
            res.status(404).send("Device not found");
            break;
    }
});

api.get('/:device/:command', function (req, res) {
    let device = req.params['device']
    let command = req.params['command']
    let ip = req.ip;
    logger("/api/"+device+"/"+command,"Received request at: " + device + " " + command + "Source IP: "+ip);
    switch (device) {
        case "fireplace":
            switch (command) {
                case "on":
                    relaycontrol(0);
                    logger("HTTP","Request at /api/fireplace/on");
                    res.end();
                    break;

                case "off":
                    relaycontrol(1);
                    logger("HTTP","Request at /api/fireplace/off");
                    res.end();
                    break;
                default:
                    res.status(404).send("Command not found");
                    break;
            }
            break;
        case "garagedoor":
        case "garagegate":
            switch (command) {
                case "on":
                    if (garagePulseTimers[device] === null) {
                        relaycontrolgarage(device);
                        logger("HTTP","Request at /api/"+device+"/on");
                    }
                    else{
                        reportgaragestate(0,device);
                        logger("HTTP","Relay " + device + " already ON");
                    }
                    res.end();
                    break;

                case "off":
                    reportgaragestate(garagePulseTimers[device] === null ? 1 : 0,device);
                    if (garagePulseTimers[device] !== null) {
                        logger("HTTP","Request at /api/"+device+"/off");
                    }
                    else{
                        logger("HTTP","Relay " + device + " already OFF");
                    }
                    res.end();
                    break;
                default:
                    res.status(404).send("Command not found");
                    break;
            }
            break;

        default:
            res.status(404).send("Device not found");
            break;
    }
});

/**
 * discover
 */
// Used to send all devices back
app.get("/discover", function (req, res) {
    devicesDiscover();
    res.end();
});

// app.get("/api/fireplace", function (req, res) {
//     var fireplacestatus = {
//         fireplace: ""
//     }
//     if (relaystate == 1) {
//         fireplacestatus.fireplace = "OFF"
//     }
//     else{
//         fireplacestatus.fireplace = "ON"
//     }
//     sendSmartThingMsg("fireplace",fireplacestatus.fireplace);
//     logger("HTTP","Request at /api/fireplace");
//     res.send(fireplacestatus);
// });

// app.get("/api/fireplace/on", function (req, res) {
//     if (relaystate == 1) {
//         relaycontrol();
//         logger("HTTP","Request at /api/fireplace/on");
//     }
//     else{
//         logger("HTTP","Relay already ON");
//     }
//     res.end();
// });

// app.get("/api/fireplace/off", function (req, res) {
//     if (relaystate == 0) {
//         relaycontrol();
//         logger("HTTP","Request at /api/fireplace/off");
//     }
//     else{
//         logger("HTTP","Relay already OFF");
//     }
//     res.end();
// });

// app.get("/api/garagedoor", function (req, res) {
//     var garagedoorstatus = {
//         garagedoor: ""
//     }
//     if (relaystategarage == 1) {
//         garagedoorstatus.garagedoor = "OFF"
//     }
//     else{
//         garagedoorstatus.garagedoor = "ON"
//     }
//     sendSmartThingMsg("garagedoor",garagedoorstatus.garagedoor);
//     logger("HTTP","Request at /api/garagedoor");
//     res.send(garagedoorstatus);
// });

// app.get("/api/garagedoor/on", function (req, res) {
//     if (relaystategarage == 1) {
//         relaycontrolgarage();
//         logger("HTTP","Request at /api/fireplace/on");
//     }
//     else{
//         logger("HTTP","Relay GarageDoor already ON");
//     }
//     res.end();
// });

// app.get("/api/garagedoor/off", function (req, res) {
//     if (relaystategarage == 0) {
//         relaycontrolgarage();
//         logger("HTTP","Request at /api/fireplace/off");
//     }
//     else{
//         logger("HTTP","Relay GarageDoor already OFF");
//     }
//     res.end();
// });

/**
 * Subscribe route used by SmartThings Hub to register for callback/notifications and write to config.json
 * @param {String} host - The SmartThings Hub IP address and port number
 */
app.get('/subscribe/:host', function (req, res, next) {
    var parts = req.params.host.split(":");
    nconf.set('notify:address', parts[0]);
    nconf.set('notify:port', parts[1]);
    nconf.save(function (err) {
      if (err) {
        logger("Subscribe",'Configuration error: '+err.message);
        res.status(500).json({ error: 'Configuration error: '+err.message });
        return;
      }
      try {
        reportrelaystates();
      } catch (err) {
        logger("Subscribe",'Relay state reporting error: '+err.message);
        next(err);
        return;
      }
      res.end();
      logger("Subscribe","SmartThings HUB IpAddress: "+parts[0] +" Port: "+ parts[1]);
    });
});


logger("HTTP Endpoint","All HTTP endpoints loaded");

////////////////////////////////////////
// Preparing GPIO
////////////////////////////////////////
// onoff expects global sysfs GPIO numbers, not BCM line offsets.
var gpioRoot = '/sys/class/gpio';
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
logger("GPIO","Using " + gpioChips[0] + " with sysfs base " + gpioBase);

// 'high' initializes these active-low relays OFF without an initial LOW pulse.
var relay = new Gpio(gpioBase + 23, 'high');
var relaygarage = new Gpio(gpioBase + 24, 'high');
var relaygaragegate = new Gpio(gpioBase + 25, 'high');
relaystate = relay.readSync();
relaystategarage = relaygarage.readSync();
relaystategaragegate = relaygaragegate.readSync();
if (relaystate !== 1 || relaystategarage !== 1 || relaystategaragegate !== 1) {
    throw new Error('Relay initialization failed: all relays must be OFF before starting the HTTP server');
}
logger("GPIO","All relays initialized OFF");

var pushButton = new Gpio(gpioBase + 4, 'in', 'both'); //BCM GPIO4, monitoring both edges

////////////////////////////////////////
// Creating Server
////////////////////////////////////////
var server = http.createServer(app);
server.listen(httpport);
logger("HTTP Endpoint","HTTP Server Created at port: "+httpport);

///////////////////////////////////////////
// Function to send fireplace msgs to SmartThing
///////////////////////////////////////////
function sendSmartThingMsg(device,command) {
    var msg = JSON.stringify({device: device,command: command});
    notify(msg);
    logger("SendHubitatMsg","Queued Hubitat state: " + msg);
}

///////////////////////////////////////////
// Send HTTP callback to SmartThings HUB
///////////////////////////////////////////
/**
 * Callback to the SmartThings Hub via HTTP NOTIFY
 * @param {String} data - The HTTP message body
 */
var notificationQueue = new Map();
var notificationInFlight = false;
var notificationTimeout = 5000;
var notificationRetryDelays = [5000, 15000, 30000];

var notify = function(data) {
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
    flushnotifications();
}

function flushnotifications() {
    if (notificationInFlight) return;
    var entry = Array.from(notificationQueue.values()).find(function (item) {
        return item.retryTimer === null;
    });
    if (!entry) return;

    notificationInFlight = true;
    var version = entry.version;
    sendnotification(entry, function (err) {
        notificationInFlight = false;
        if (err) {
            logger("Notify","Notification error for " + entry.key + ": " + err.message);
            if (entry.retries < notificationRetryDelays.length) {
                var delay = notificationRetryDelays[entry.retries++];
                logger("Notify","Retrying " + entry.key + " in " + delay + "ms");
                entry.retryTimer = setTimeout(function () {
                    entry.retryTimer = null;
                    flushnotifications();
                }, delay);
            } else {
                notificationQueue.delete(entry.key);
                logger("Notify","Retries exhausted for " + entry.key + "; a new update or periodic relay snapshot is required");
            }
        } else {
            logger("Notify","Hubitat accepted notification for " + entry.key);
            notificationQueue.delete(entry.key);
            if (entry.version !== version) {
                entry.retries = 0;
                notificationQueue.set(entry.key, entry);
            }
        }
        flushnotifications();
    });
}

function sendnotification(entry,callback) {
    var req;
    var timeout;
    var finished = false;
    function finish(err) {
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
        if (entry.device === 'fireplace') {
            physicalrelay = readrelaystate("fireplace",relay,relaystate);
            data = JSON.stringify({device: entry.device, command: physicalrelay == 0 ? "ON" : "OFF"});
        } else if (entry.device === 'garagedoor') {
            physicalrelaygarage = readrelaystate("garagedoor",relaygarage,relaystategarage);
            data = JSON.stringify({device: entry.device, command: physicalrelaygarage == 0 ? "ON" : "OFF"});
        } else if (entry.device === 'garagegate') {
            physicalrelaygaragegate = readrelaystate("garagegate",relaygaragegate,relaystategaragegate);
            data = JSON.stringify({device: entry.device, command: physicalrelaygaragegate == 0 ? "ON" : "OFF"});
        }
        var opts = {
            method: 'NOTIFY',
            host: nconf.get('notify:address'),
            port: nconf.get('notify:port'),
            path: '/notify',
            headers: {
                'CONTENT-TYPE': 'application/json',
                'CONTENT-LENGTH': Buffer.byteLength(data),
                'device': 'fireplace'
            }
        };
        req = http.request(opts, function (res) {
            res.on('error', finish);
            res.on('aborted', function () {
                finish(new Error('Hubitat response was interrupted'));
            });
            res.on('end', function () {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    finish();
                } else {
                    finish(new Error('Hubitat returned HTTP ' + res.statusCode));
                }
            });
            res.resume();
        });
        req.on('error', finish);
        timeout = setTimeout(function () {
            finish(new Error('Hubitat notification timed out after ' + notificationTimeout + 'ms'));
        }, notificationTimeout);
        logger("Notify","Sending notification: " + data);
        req.write(data);
        req.end();
    } catch (err) {
        finish(err);
    }
}

function readrelaystate(device,gpio,trackedstate) {
    if (!gpio || typeof gpio.readSync !== 'function') {
        throw new Error('Relay not initialized: ' + device);
    }
    var state = gpio.readSync();
    if (state !== 0 && state !== 1) {
        throw new Error('Invalid relay readback for ' + device + ': ' + state);
    }
    if (state !== trackedstate) {
        logger("GPIO","WARNING: Relay state mismatch for " + device + ": tracked " + trackedstate + ", read " + state);
    }
    return state;
}

function reportrelaystates() {
    physicalrelay = readrelaystate("fireplace",relay,relaystate);
    physicalrelaygarage = readrelaystate("garagedoor",relaygarage,relaystategarage);
    physicalrelaygaragegate = readrelaystate("garagegate",relaygaragegate,relaystategaragegate);
    sendSmartThingMsg("fireplace",physicalrelay == 0 ? "ON" : "OFF");
    sendSmartThingMsg("garagedoor",physicalrelaygarage == 0 ? "ON" : "OFF");
    sendSmartThingMsg("garagegate",physicalrelaygaragegate == 0 ? "ON" : "OFF");
}

reportrelaystates();

setInterval(function () {
    try {
        reportrelaystates();
    } catch (err) {
        logger("GPIO","Relay state reconciliation error: " + err.message);
    }
}, 300000);

function devicesDiscover(){
    if (nconf.get('discover')) {
        notify(JSON.stringify(nconf.get('discover')));
        logger("devicesDiscover","Sending devices back: " + JSON.stringify(nconf.get('discover')));
    } else {
        logger("devicesDiscover","discover config json not set.");
    }
    return;
}

function createID() {
    return Math.random().toString(26).slice(2)
}

function switchchanged(callbackswitchsate){
    var icount = 0;
    var checkcount = 2;
    var waitcheck = 500;
    var swuID = createID();
    newswitchstate = pushButton.readSync();
    logger(swuID+"-"+"SWITCHCHANGED","Checking current switch state: " + newswitchstate);
    if (oldswitchstate != newswitchstate) {
        logger(swuID+"-"+"SWITCHCHANGED","Looks like switch was changed to: " + newswitchstate);
        var interval = setInterval(function(){
            newswitchstate = pushButton.readSync();
            if (icount >= checkcount) {
                if (oldswitchstate != newswitchstate) {
                    logger(swuID+"-"+"SWITCHCHANGED","Checking if the switch was changed for " + checkcount + " times, in " + waitcheck + "ms, the final state is " + newswitchstate + ". The SWITCH was really changed and keep in that state.");
                    oldswitchstate = newswitchstate;
                    callbackswitchsate(true);
                }
                else{
                    logger(swuID+"-"+"SWITCHCHANGED","Checking if the switch was changed for " + checkcount + " times, in " + waitcheck + "ms, the final state is " + newswitchstate + ". It was a falso positive and the switch goes back to the original state.");
                    callbackswitchsate(false);
                }
                clearInterval(interval);
            }
            icount++;
          }, waitcheck);
    }
    else{
        logger(swuID+"-"+"SWITCHCHANGED","Switch was not changed false positive!");
        callbackswitchsate(false);
    }
}

//switchchanged();

pushButton.watch(function (err, value) { //Watch for hardware interrupts on pushButton GPIO, specify callback function
    var puuID = createID();
    logger(puuID+"-"+"PUSHBUTTON","PUSHBUTTON event detected!");
    if (err) { //if an error
        console.error('There was an error', err); //output error message to console
        logger(puuID+"-"+"PUSHBUTTON","PUSHBUTTON Error" + err);
        return;
    }
    logger(puuID+"-"+"PUSHBUTTON","Checking if SWITCH was changed...");
    switchchanged(function (switchchanged) {
        if (switchchanged) {
            logger(puuID+"-"+"PUSHBUTTON","Switch changed!");
            // The pushbutton is currently disabled for test
            //relaycontrol()
        }
        else{
            logger(puuID+"-"+"PUSHBUTTON","Switch not changed!");
        }
        //return switchchanged;
    });
});

function relaycontrol(requestedstate){
    if (requestedstate !== 0 && requestedstate !== 1) {
        throw new Error('Invalid fireplace relay state: ' + requestedstate);
    }
    logger("RELALAYCONTROL","Setting Relay State to: " + requestedstate);
    relay.writeSync(requestedstate);
    physicalrelay = relay.readSync();
    if (physicalrelay !== requestedstate) {
        throw new Error('Fireplace relay verification failed: requested ' + requestedstate + ', read ' + physicalrelay);
    }
    relaystate = physicalrelay;
    sendSmartThingMsg("fireplace",relaystate == 0 ? "ON" : "OFF");
};

function getgaragerelay(device) {
    if (device === "garagedoor") return relaygarage;
    if (device === "garagegate") return relaygaragegate;
    throw new Error('Unknown garage relay: ' + device);
}

function reportgaragestate(expectedstate,device) {
    var state = getgaragerelay(device).readSync();
    if (device === "garagedoor") {
        physicalrelaygarage = state;
    } else {
        physicalrelaygaragegate = state;
    }
    if (state !== expectedstate) {
        throw new Error('Garage relay verification failed for ' + device + ': expected ' + expectedstate + ', read ' + state);
    }
    if (device === "garagedoor") {
        relaystategarage = state;
    } else {
        relaystategaragegate = state;
    }
    sendSmartThingMsg(device,state == 0 ? "ON" : "OFF");
}

function relaycontrolgarage(device) {
    var gpio = getgaragerelay(device);
    logger("RELALAYCONTROLGARAGE","Changing " + device + " Relay State to ON");
    // Keep release scheduled even if the ON write, readback, or notification fails.
    garagePulseTimers[device] = setTimeout(function() {
        logger("RELALAYCONTROLGARAGE","Changing " + device + " Relay State to OFF");
        gpio.writeSync(1);
        reportgaragestate(1,device);
        garagePulseTimers[device] = null;
     }, 4500);
    gpio.writeSync(0);
    reportgaragestate(0,device);
}

// ####################################
// ######## Temperature Code ##########
// ####################################
function collecttemperature(){

    sensor.read(11, 21, function(err, temperature, humidity) {
        if (!err) {

            var vartemperatureF = (temperature.toFixed(1) * 9 / 5 + 32 )
            var vartemperatureC = (temperature.toFixed(1))
            var varhumidity = humidity.toFixed(1)

            logger("collecttemperature","Temperature in Fahrenheit: " + vartemperatureF + ' °F');
            logger("collecttemperature","Temperature in Celsius: " + vartemperatureC + ' °C');
            logger("collecttemperature","Humidity: " + varhumidity + ' %');
            var temphumi = (vartemperatureF.toString() + "-" + varhumidity.toString())
            sendSmartThingMsg("fireplacetemperature",temphumi);
        }
        else{
            logger("collecttemperature","Error: " + err);
        }
    });


};


function celsiusToFahrenheit(celsius)
{
  var cTemp = celsius;
  var cToFahr = cTemp * 9 / 5 + 32;
  var message = cTemp+'\xB0C is ' + cToFahr + ' \xB0F.';
  return cToFahr;
  //  console.log(message);
}

function fahrenheitToCelsius(fahrenheit)
{
  var fTemp = fahrenheit;
  var fToCel = (fTemp - 32) * 5 / 9;
  var message = fTemp+'\xB0F is ' + fToCel + '\xB0C.';
  //  console.log(message);
}


interval = setInterval(function () { //#C
    collecttemperature()
}, 900000);

// 5 seconds is 5000
// 15 minutes is 900000