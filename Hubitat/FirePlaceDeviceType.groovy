/**
 *  FireplaceDeviceType
 *
 *  Author: Victor Santana
 *   based on work by XXX
 *  
 *  Date: 2017-03-26
 */


metadata {
    // Automatically generated. Make future change here.
    definition (name: "Fireplace Switch", namespace: "Fireplace", author: "victor@hepoca.com") {
        capability "Switch"
        capability "Refresh"
    }
}


def Fireplaceparse(String description) {
    def msg = description
    parent.writeLog("FireplaceSmartApp Device Type - Processing command: $msg")
    
    if(msg == "ON"){
        sendEvent(name: "switch", value: "on")
    } else if(msg == "OFF"){
        sendEvent(name: "switch", value: "off")
    }
}

// Implement "switch"
def on() {
    parent.writeLog("FireplaceSmartApp Device Type - Sending command ON")
    sendRaspberryCommand("fireplace/on")    
}

def off() {
    parent.writeLog("FireplaceSmartApp Device Type - Sending command OFF")
    sendRaspberryCommand("fireplace/off")  
}

def refresh() {
    parent.writeLog("FireplaceSmartApp Device Type - Sending command Refresh")
    sendRaspberryCommand("fireplace")
}

def sendRaspberryCommand(String command) {
	def path = "/api/$command"
    parent.sendCommand(path);
}

// This method must exist
// it's used by hubitat to process the device message
def parse(description) {
    //parent.writeLog("DSCAlarmSmartAppV2 AlarmPanel Device Type - Receive Lan Command ${description}")
	parent.lanResponseHandler(description)
}