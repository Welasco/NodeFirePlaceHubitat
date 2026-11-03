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
var garagePulseTimer = null;
var physicalrelay = 1;
var physicalrelaygarage = 1;
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
            if (Object.prototype.toString.call(relay) != "[object Object]") {
                fireplacestatus.fireplace = "OFF"
                fireplacestatus.physicalrelay = "NotExecuted";
            }
            else{
                physicalrelay = relay.readSync();
                if (relaystate == 1) {
                    fireplacestatus.fireplace = "OFF"
                }
                else{
                    fireplacestatus.fireplace = "ON"
                }
                if (physicalrelay == 1) {
                    fireplacestatus.physicalrelay = "OFF"
                }
                else{
                    fireplacestatus.physicalrelay = "ON"
                }
            }

            sendSmartThingMsg("fireplace",fireplacestatus.fireplace);
            logger("HTTP","Request at /api/fireplace");
            res.send(fireplacestatus);
            break;
        case "garagedoor":
            var garagedoorstatus = {
                garagedoor: "",
                physicalrelaygarage: ""
            }
            if (Object.prototype.toString.call(relay) != "[object Object]") {
                garagedoorstatus.garagedoor = "OFF"
                garagedoorstatus.physicalrelaygarage = "NotExecuted";
            }
            else{
                physicalrelaygarage = relaygarage.readSync();
                if (relaystategarage == 1) {
                    garagedoorstatus.garagedoor = "OFF"
                }
                else{
                    garagedoorstatus.garagedoor = "ON"
                }
                if (physicalrelaygarage == 1) {
                    garagedoorstatus.physicalrelaygarage = "OFF"
                }
                else{
                    garagedoorstatus.physicalrelaygarage = "ON"
                }
            }
            sendSmartThingMsg("garagedoor",garagedoorstatus.garagedoor);
            logger("HTTP","Request at /api/garagedoor");
            res.send(garagedoorstatus);
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
            switch (command) {
                case "on":
                    if (garagePulseTimer === null) {
                        relaycontrolgarage();
                        logger("HTTP","Request at /api/garagedoor/on");
                    }
                    else{
                        reportgaragestate(0);
                        logger("HTTP","Relay GarageDoor already ON");
                    }
                    res.end();
                    break;

                case "off":
                    reportgaragestate(garagePulseTimer === null ? 1 : 0);
                    if (relaystategarage == 0) {
                        logger("HTTP","Request at /api/garagedoor/off");
                    }
                    else{
                        logger("HTTP","Relay GarageDoor already OFF");
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
app.get('/subscribe/:host', function (req, res) {
    var parts = req.params.host.split(":");
    nconf.set('notify:address', parts[0]);
    nconf.set('notify:port', parts[1]);
    nconf.save(function (err) {
      if (err) {
        logger("Subscribe",'Configuration error: '+err.message);
        res.status(500).json({ error: 'Configuration error: '+err.message });
        return;
      }
    });
    res.end();
    logger("Subscribe","SmartThings HUB IpAddress: "+parts[0] +" Port: "+ parts[1]);
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
relaystate = relay.readSync();
relaystategarage = relaygarage.readSync();
if (relaystate !== 1 || relaystategarage !== 1) {
    throw new Error('Relay initialization failed: both relays must be OFF before starting the HTTP server');
}
logger("GPIO","Both relays initialized OFF");

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
    logger("SendHubitatMsg","Sending SmartThing comand: " + msg);
}

///////////////////////////////////////////
// Send HTTP callback to SmartThings HUB
///////////////////////////////////////////
/**
 * Callback to the SmartThings Hub via HTTP NOTIFY
 * @param {String} data - The HTTP message body
 */
var notify = function(data) {
    if (!nconf.get('notify:address') || nconf.get('notify:address').length == 0 ||
      !nconf.get('notify:port') || nconf.get('notify:port') == 0) {
      logger("Notify","Notify server address and port not set!");
      return;
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

    var req = http.request(opts);
    req.on('error', function(err, req, res) {
      logger("Notify","Notify error: "+err);
    });
    req.write(data);
    req.end();
}

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

function reportgaragestate(expectedstate) {
    physicalrelaygarage = relaygarage.readSync();
    if (physicalrelaygarage !== expectedstate) {
        throw new Error('Garage relay verification failed: expected ' + expectedstate + ', read ' + physicalrelaygarage);
    }
    relaystategarage = physicalrelaygarage;
    sendSmartThingMsg("garagedoor",relaystategarage == 0 ? "ON" : "OFF");
}

function relaycontrolgarage() {
    logger("RELALAYCONTROLGARAGE","Changing Relay State to ON: " + relaystategarage);
    // Keep release scheduled even if the ON write, readback, or notification fails.
    garagePulseTimer = setTimeout(function() {
        logger("RELALAYCONTROLGARAGE","Changing Relay State to OFF: " + relaystategarage);
        relaygarage.writeSync(1);
        reportgaragestate(1);
        garagePulseTimer = null;
     }, 1500);
    relaygarage.writeSync(0);
    reportgaragestate(0);
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