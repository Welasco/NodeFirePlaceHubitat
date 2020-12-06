preferences {
    input("hostaddress", "text", title: "IP Address for Server:", description: "Ex: 10.0.0.12 or 192.168.0.4 (no http://)")
    input("hostport", "number", title: "Port of Server", description: "port")
}

metadata {
	definition (name: "GarageDoorButton", namespace: "GarageDoor", author: "Victor Santana") {
		//capability "Actuator"
		//capability "Switch"
		capability "Momentary"
	}
}

def hubitat.device.HubAction push() {
	//sendEvent(name: "switch", value: "on", isStateChange: true, displayed: false)
    //sendEvent(name: "switch", value: "off", isStateChange: true, displayed: false)
    return sendRaspberryCommand("garagedoor")

	sendEvent(name: "momentary", value: "pushed", isStateChange: true)
}


def on() {
	push()
}

def off() {
	push()

}

def hubitat.device.HubAction sendRaspberryCommand(String command) {

    log.debug "GarageDoor - command: $command"
    if(settings.hostaddress && settings.hostport){
		
        def host = settings.hostaddress
		def port = settings.hostport

		def path = "/api/$command"

		def headers = [:] 
		headers.put("HOST", "$host:$port")
		headers.put("Content-Type", "application/json")

		log.debug "GarageDoor - The Header is $headers"

		def method = "GET"

		try {
			def hubAction = new hubitat.device.HubAction(
				method: method,
				path: path,
				//body: json,
				headers: headers,
			)

			log.debug hubAction
			hubAction
            return hubAction
		}
		catch (Exception e) {
			log.debug "GarageDoor - Hit Exception $e on $hubAction"
		}
	}
	else{
		
		log.debug "GarageDoor - RespberryPI IP address and port not set!"
	}
}