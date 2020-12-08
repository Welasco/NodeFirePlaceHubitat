/**
 *  FireplaceApp
 *
 *  Author: Victor Santana
 *  Date: 2017-12-21
 */

definition(
    name: "RPi Managed App",
    namespace: "RPi Managed",
    author: "Victor Santana",
    description: "RPi Managed App",
    category: "RPi Managed",
    iconUrl: "https://graph.api.smartthings.com/api/devices/icons/st.Home.home29-icn",
    iconX2Url: "https://graph.api.smartthings.com/api/devices/icons/st.Home.home29-icn?displaySize=2x",
    iconX3Url: "https://graph.api.smartthings.com/api/devices/icons/st.Home.home29-icn?displaySize=3x",
    singleInstance: true
)

import groovy.json.JsonBuilder
import groovy.json.JsonSlurper

preferences {
	page(name: "page1")
}

def page1() {
  dynamicPage(name: "page1", install: true, uninstall: true) {
    section("RPi Endpoint") {
      input "proxyAddress", "text", title: "Proxy Address", description: "(ie. 192.168.1.10)", required: true
      input "proxyPort", "text", title: "Proxy Port", description: "(ie. 3001)", required: true, defaultValue: "3001"
    }
    section("Discover Devices"){
      input "enableDiscovery", "bool", title: "Discover Devices (WARNING: all existing devices will be removed)", required: false, defaultValue: false      
    }    
		section("Enable Debug Log at IDE"){
			input "idelog", "bool", title: "Select True or False:", defaultValue: false, required: false
		}     
  }
}

def installed() {
  writeLog("RPiManagedApp - Installed with settings: ${settings}")
	initialize()
  updated()
  addFirstDeviceType()
}

def updated() {

  writeLog("RPiManagedApp - Updated with settings: ${settings}")
	//unsubscribe()
	//initialize()
  sendCommand('/subscribe/'+getNotifyAddress())
  if (settings.enableDiscovery) {
    //delay discovery for 5 seconds
    runIn(10, discoverChildDevices)
    settings.enableDiscovery = false
  }    
}

def initialize() {
    subscribe(location, null, lanResponseHandler, [filterEvents:false])
    writeLog("RPiManagedApp - Initialize")
}

def uninstalled() {
    removeChildDevices()
}

private removeChildDevices() {
    getAllChildDevices().each { deleteChildDevice(it.deviceNetworkId) }
    writeLog("RPiManagedApp - Removing all child devices")
}

def discoverChildDevices() {
  sendCommand('/discover')
  writeLog("RPiManagedApp - Sending discovery request")
}

def lanResponseHandler(evt) {
    try{
      def map = parseLanMessage(evt)
      def headers = map.headers;
      def body = map.data;

      writeLog("RPiManagedApp - Received event headers:  ${headers}")
      writeLog("RPiManagedApp - Received event body: ${body}")
      //updateFireplaceDeviceType(body)
      processEvent(body)
    }
    catch(MissingMethodException){
      pass
    }
}

// Check if the received event is for descover or update zone/alarm status
private processEvent(evt) {
  if (evt.type == "discover") {
    addChildDevices(evt.devices)
  }
  else{
    parserDeviceCommand(evt)
  }
}

private addFirstDeviceType(){
  def d = addChildDevice("RPi Managed", "RPi Managed Switch", GetDeviceID(), ["name": "fireplace", label: "Fireplace", completedSetup: true])
  writeLog("RPiManagedApp - Added first device: DisplayName: ${d.displayName} - deviceId: ${deviceId}")  
}

private addChildDevices(devices) {
  def firstdevice = 0
  def deviceId = ""
  devices.each {
    if(firstdevice != 0){
      deviceId = it.name
      if (!getChildDevice(deviceId)) {
        it.type = it.type.capitalize()
        def d = addChildDevice("RPi Managed", it.devicetypename, deviceId, ["name": it.name, label: it.label, completedSetup: true])
        writeLog("RPiManagedApp - Added device: DisplayName: ${d.displayName} - deviceId: ${deviceId}")
      }      
    }
    // if(firstdevice == 0){
    //   deviceId = GetDeviceID()
    //   firstdevice = 1
    // }
    // else{
    //   deviceId = it.name
    // }
    // if (!getChildDevice(deviceId)) {
    //   it.type = it.type.capitalize()
    //   def d = addChildDevice("RPi Managed", it.devicetypename, deviceId, ["name": it.name, label: it.label, completedSetup: true])
    //   writeLog("RPiManagedApp - Added device: DisplayName: ${d.displayName} - deviceId: ${deviceId}")
    // }
  }
}

private parserDeviceCommand(evt) {
	def deviceid = evt.device
  def rpiDevice = getChildDevice(deviceid)
  writeLog("RPiManagedApp - Method updateFireplaceDeviceType FireplaceNetworkID: ${FireplaceNetworkID}")
  if(rpiDevice){
    rpiDevice.Rpiparse(evt.command)
    writeLog("RPiManagedApp - Updating Fireplace Device ${FireplaceNetworkID} using Command: ${cmd}")
  }

  // def FireplaceNetworkID = GetDeviceID()
  // writeLog("RPiManagedApp - Method updateFireplaceDeviceType FireplaceNetworkID: ${FireplaceNetworkID}")
  // def Fireplacedevice = getChildDevice(FireplaceNetworkID)
  // if (Fireplacedevice) {
  //   Fireplacedevice.Fireplaceparse("${evt.command}")
  //   writeLog("RPiManagedApp - Updating Fireplace Device ${FireplaceNetworkID} using Command: ${cmd}")
  // }
}



private getProxyAddress() {
  return settings.proxyAddress + ":" + settings.proxyPort
}

private getNotifyAddress() {
  def hub = location.hubs[0]
  return hub.getDataValue("localIP") + ":" + hub.getDataValue("localSrvPortTCP")
}

private sendCommand(path) {
  if (settings.proxyAddress.length() == 0 ||
    settings.proxyPort.length() == 0) {
    writeLog("RPiManagedApp - ERROR: Proxy configuration not set!")
    return
  }

  def host = getProxyAddress()
  def headers = [:]
  headers.put("HOST", host)
  headers.put("Content-Type", "application/json")
  headers.put("stnp-auth", settings.authCode)

  def hubAction = new hubitat.device.HubAction(
      method: "GET",
      path: path,
      headers: headers
  )
  sendHubCommand(hubAction)
}

private String GetDeviceID(){
    def deviceIP = settings.proxyAddress
    def deviceId = deviceIP.tokenize( '.' )*.toInteger().asType( byte[] ).encodeHex().toString().toUpperCase()
    return deviceId
}

private writeLog(message)
{
  if(idelog){
    log.debug "${message}"
  }
}