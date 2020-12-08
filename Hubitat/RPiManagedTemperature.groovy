preferences {
    //input("hostaddress", "text", title: "IP Address for Server:", description: "Ex: 10.0.0.12 or 192.168.0.4 (no http://)")
    //input("hostport", "number", title: "Port of Server", description: "port")
}

metadata {
	definition (name: "RPi Managed Temperature", namespace: "RPi Managed", author: "victor@hepoca.com") {
		capability "Temperature Measurement"
		capability "Relative Humidity Measurement"
		capability "Sensor"
		capability "Refresh"
	}
}

def Rpiparse(String description){
    def msg = description
    parent.writeLog("${device.getName()} - Rpiparse Device Type - Processing command: $msg")
   
	def temphumid = description.split("-")
	def temperature = temphumid[0]
	def humidity = temphumid[1]
	//log.debug "TemperatureSensor DeviceType - temperature: ${temperature} humidity: ${humidity}"
    sendEvent(name: "temperature", value: temperature, unit: getTemperatureScale())
    sendEvent(name: "humidity", value: humidity, unit: "%")
}

def refresh(){
    parent.writeLog("Rpiparse Device Type - Sending command")
    sendRaspberryCommand("${device.getName()}")
}

def sendRaspberryCommand(String command) {
	def path = "/api/$command"
    parent.sendCommand(path);
}