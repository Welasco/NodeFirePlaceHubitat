var log4js = require("log4js");

////////////////////////////////////////
// Logger Function
////////////////////////////////////////
var logger = function(mod,str) {
    console.log("[%s] [%s] %s", new Date().toISOString(), mod, str);

    log4js.configure({
      appenders: { fireplace: { type: "file", filename: "fireplace.log" } },
      categories: { default: { appenders: ["fireplace"], level: "debug" } }
    });
    
    const wlogger = log4js.getLogger("fireplace");
    // wlogger.trace("Entering fireplace testing");
    // wlogger.debug("Got fireplace.");
    // wlogger.info("fireplace is Comté.");
    // wlogger.warn("fireplace is quite smelly.");
    // wlogger.error("fireplace is too ripe!");
    // wlogger.fatal("fireplace was breeding ground for listeria.");    
    wlogger.info("[%s] %s", mod, str);
}

logger("Modules","Modules loaded");
//wlogger("Modules","Modules loaded2");