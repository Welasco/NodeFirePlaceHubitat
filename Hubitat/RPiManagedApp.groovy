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
    singleInstance: false
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
      input "enableDiscovery", "bool", title: "Discover Devices (adds missing devices; keeps existing devices)", required: false, defaultValue: false
    }    
		section("Enable Debug Log at IDE"){
			input "idelog", "bool", title: "Select True or False:", defaultValue: false, required: false
		}     
  }
}

def installed() {
  writeLog("RPiManagedApp - Installed with settings: ${settings}")
  updated()
}

def updated() {

  writeLog("RPiManagedApp - Updated with settings: ${settings}")
	unsubscribe()
	initialize()
  sendCommand('/subscribe/'+getNotifyAddress())
  if (settings.enableDiscovery) {
    // Allow subscription to finish before discovering devices.
    runIn(10, "discoverChildDevices")
    app.updateSetting("enableDiscovery", [value: "false", type: "bool"])
  }    
}

def initialize() {
    subscribe(location, null, "lanResponseHandler", [filterEvents:false])
    writeLog("RPiManagedApp - Initialize")
}

def uninstalled() {
    removeChildDevices()
}

private removeChildDevices() {
    getChildDevices().collect { it.deviceNetworkId }.each { deleteChildDevice(it) }
    writeLog("RPiManagedApp - Removing all child devices")
}

def discoverChildDevices() {
  sendCommand('/discover')
  writeLog("RPiManagedApp - Sending discovery request")
}

def lanResponseHandler(evt) {
    try{
      def description = evt instanceof String ? evt : evt.description
      def map = parseLanMessage(description)
      if (map.networkAddress?.toUpperCase() != GetDeviceID()) {
        return
      }
      def headers = map.headers;
      def body = map.json ?: map.data
      if (body instanceof String) {
        body = new JsonSlurper().parseText(body)
      }
      else if (!(body instanceof Map) && map.body) {
        body = new JsonSlurper().parseText(map.body)
      }

      writeLog("RPiManagedApp - Received event headers:  ${headers}")
      writeLog("RPiManagedApp - Received event body: ${body}")
      if (body instanceof Map && (body.type == "discover" || (body.device && body.command))) {
        processEvent(body)
      }
    }
    catch(Exception err){
      log.error "RPiManagedApp - LAN event error: ${err.message}"
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

private addChildDevices(devices) {
  writeLog("RPiManagedApp - Start addChildDevices: ${devices}")
  if (!(devices instanceof List)) {
    log.error "RPiManagedApp - Discovery devices must be a list"
    return
  }
  devices.each {
    if (!(it instanceof Map) || !(it.name instanceof String) ||
        !(it.name ==~ /[A-Za-z0-9][A-Za-z0-9_-]*/) ||
        !(it.devicetypename instanceof String) || !it.devicetypename.trim() ||
        !(it.label instanceof String) || !it.label.trim() ||
        !(it.type in ["switch", "temperature"])) {
      log.error "RPiManagedApp - Invalid discovery descriptor: ${it}"
      return
    }
    def d = findRaspberryDevice(it.name)
    if (!d) {
      def deviceId = "${app.id}:${it.name}"
      d = addChildDevice("RPi Managed", it.devicetypename, deviceId, ["name": it.name, label: it.label, completedSetup: true])
      writeLog("RPiManagedApp - Added device: DisplayName: ${d.displayName} - deviceId: ${deviceId}")
    }
    d.updateDataValue("rpiDeviceName", it.name)
  }
}

private findRaspberryDevice(name) {
  def children = getChildDevices()
  def d = children.find { it.deviceNetworkId == "${app.id}:${name}" }
  if (!d) {
    // Match only this app's legacy children; keep their IDs and automation references.
    d = children.find { getRaspberryDeviceName(it) == name }
  }
  if (!d && name == "fireplace") {
    d = children.find { !it.getDataValue("rpiDeviceName") && it.deviceNetworkId == GetDeviceID() }
  }
  return d
}

def getRaspberryDeviceName(child) {
  return child.getDataValue("rpiDeviceName") ?: child.getName()
}

private parserDeviceCommand(evt) {
  def rpiDevice = findRaspberryDevice(evt.device)
  writeLog("RPiManagedApp - Method parserDeviceCommand rpiDevice: ${evt.device}")
  if(rpiDevice){
    rpiDevice.Rpiparse(evt.command)
    writeLog("RPiManagedApp - Updating rpiDevice Device ${evt.device} using Command: ${evt.command}")
  }
  else{
    log.warn "RPiManagedApp - Unknown device from configured Pi: ${evt.device}; run discovery"
  }
}

private getProxyAddress() {
  return settings.proxyAddress + ":" + settings.proxyPort
}

private getNotifyAddress() {
  def hub = location.hubs[0]
  return hub.getDataValue("localIP") + ":" + hub.getDataValue("localSrvPortTCP")
}

def sendCommand(path) {
  if (!settings.proxyAddress || !settings.proxyPort) {
    log.error "RPiManagedApp - Proxy configuration not set!"
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

def writeLog(message)
{
  if(settings.idelog){
    log.debug "${message}"
  }
}