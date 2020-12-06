#!/usr/bin/env node
// Loading Dependencies
var http = require("http");
var https = require('https');
var express = require("express");
var app = express();
var nconf = require('nconf');
nconf.file({ file: './config.json' });
//var config = require('./config.js');
fs = require('fs');
var Gpio = require('onoff').Gpio; //include onoff to interact with the GPIO


////////////////////////////////////////
// Logger Function
////////////////////////////////////////
var logger = function(mod,str) {
    console.log("[%s] [%s] %s", new Date().toISOString(), mod, str);
}

logger("Modules","Modules loaded");

var httpport = nconf.get('httpport');
var relaystate = 1;
var oldswitchstate = 0;
var newswitchstate = 0;
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

// Used only to check if NodeJS is running
app.get("/", function (req, res) {
    res.send("<html><body><h1>FirePlace ON</h1></body></html>");
});

app.get("/api/fireplace", function (req, res) {
    var fireplacestatus = {
        fireplace: ""
    }
    if (relaystate == 1) {
        fireplacestatus.fireplace = "OFF"
    }
    else{
        fireplacestatus.fireplace = "ON"
    }
    sendSmartThingMsg(fireplacestatus.fireplace);
    logger("HTTP","Request at /api/fireplace");
    res.send(fireplacestatus);
});

app.get("/api/fireplace/on", function (req, res) {
    if (relaystate == 1) {
        relaycontrol();
        logger("HTTP","Request at /api/fireplace/on");
    }
    else{
        logger("HTTP","Relay already ON");
    }
    res.end();
});

app.get("/api/fireplace/off", function (req, res) {
    if (relaystate == 0) {
        relaycontrol();
        logger("HTTP","Request at /api/fireplace/off");
    }
    else{
        logger("HTTP","Relay already OFF");
    }    
    res.end();
});

app.get("/api/garagedoor", function (req, res) {
    relaycontrolgarage();
    logger("HTTP","Request at /api/garagedoor");
    //res.send("200 OK");
    res.end();
});

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
// Creating Server
////////////////////////////////////////
var server = http.createServer(app);
server.listen(httpport);
logger("HTTP Endpoint","HTTP Server Created at port: "+httpport);

////////////////////////////////////////
// Preparing GPIO
////////////////////////////////////////
//var LED = new Gpio(21, 'out'); //use GPIO pin 4 as output
var pushButton = new Gpio(4, 'in', 'both'); //use GPIO pin 17 as input, and 'both' button presses, and releases should be handled
//var relay = new Gpio(23, 'out')
var relay;
//var relaygarage = new Gpio(24, 'out') // When the object is instanciated the relay turns on. It cannot be done here.

///////////////////////////////////////////
// Function to send fireplace msgs to SmartThing
///////////////////////////////////////////
function sendSmartThingMsg(command) {
    var msg = JSON.stringify({command: command});
    notify(msg);
    logger("SendMartthingsMsg","Sending SmartThing comand: " + msg);
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

function relaycontrol(){
    //relaystate = relay.readSync();
    //relaystate = LED.readSync();
    logger("RELALAYCONTROL","Relay State value: " + relaystate);
    if (relaystate == 1) {
        relaystate = 0;
        // Checking if relay is a object or not. We need this to avoid change the relay at the initilization process
        if (Object.prototype.toString.call(relay) != "[object Object]") {
            relay = new Gpio(23, 'out');
        }
        logger("RELALAYCONTROL","Changing Relay State to ON: " + relaystate);
        relay.writeSync(relaystate);
        //LED.writeSync(relaystate);
        sendSmartThingMsg("ON");
        // Call to SmartThings to update the App
    }else{
        relaystate = 1;
        logger("RELALAYCONTROL","Changing Relay State to OFF: " + relaystate);
        relay.writeSync(relaystate);
        //LED.writeSync(relaystate);
        sendSmartThingMsg("OFF");
        // Call to SmartThings to update the App
    }
};

function relaycontrolgarage() {
    logger("RELALAYCONTROLGARAGE","Changing Relay State to ON: " + relaystate);
    var relaygarage = new Gpio(24, 'out')
    relaygarage.writeSync(0);
    setTimeout(function() {
        logger("RELALAYCONTROLGARAGE","Changing Relay State to OFF: " + relaystate);
        relaygarage.writeSync(1);
     }, 1500);
}