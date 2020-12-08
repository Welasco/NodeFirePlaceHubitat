metadata {
    // Automatically generated. Make future change here.
    definition (name: "RPi Managed Switch", namespace: "RPi Managed", author: "victor@hepoca.com") {
        capability "Switch"
        capability "Refresh"
    }
}


def Rpiparse(String description) {
    def msg = description
    parent.writeLog("${device.getName()} - Rpiparse Device Type - Processing command: $msg")
    
    if(msg == "ON"){
        sendEvent(name: "switch", value: "on")
    } else if(msg == "OFF"){
        sendEvent(name: "switch", value: "off")
    }
}

// Implement "switch"
def on() {
    parent.writeLog("${device.getName()} - RPi Managed Switch Device Type - Sending command ON")
    sendRaspberryCommand("${device.getName()}/on")    
}

def off() {
    parent.writeLog("${device.getName()} - RPi Managed Switch Device Type - Sending command OFF")
    sendRaspberryCommand("${device.getName()}/off")  
}

def refresh() {
    parent.writeLog("${device.getName()} - RPi Managed Switch Device Type - Sending command Refresh")
    sendRaspberryCommand("${device.getName()}")
}

def sendRaspberryCommand(String command) {
	def path = "/api/$command"
    parent.sendCommand(path);
}

// This method must exist
// it's used by hubitat to process the device message
def parse(description) {
	parent.lanResponseHandler(description)
}