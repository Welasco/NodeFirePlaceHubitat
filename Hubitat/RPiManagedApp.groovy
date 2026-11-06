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
    section("App Name") {
      input "appName", "text", title: "App Name", description: "(ie. Fireplace Pi or Workshop Pi)",
        required: false, defaultValue: app.label ?: "RPi Managed App"
    }
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
  if (settings.appName?.trim()) {
    app.updateLabel(settings.appName.trim())
  }
	unsubscribe()
  unschedule("discoverChildDevices")
	initialize()
}

def initialize() {
    requestDeviceDiscovery(settings.enableDiscovery == true)
    writeLog("RPiManagedApp - Initialize")
}

// Retrieve identities over the request's HTTP connection, without needing a LAN receiver.
private requestDeviceDiscovery(boolean discoverAll) {
  def deviceId = GetDeviceID()
  state.discoveryRequestId = (state.discoveryRequestId ?: 0) + 1
  asynchttpGet("deviceDiscoveryResponse", [
    uri: "http://${getProxyAddress()}/discover",
    query: [response: "json"],
    contentType: "application/json",
    timeout: 15
  ], [requestId: state.discoveryRequestId, deviceId: deviceId,
      host: getProxyAddress(), discoverAll: discoverAll])
}

// Ignore superseded responses; register children before enabling unsolicited notifications.
def deviceDiscoveryResponse(response, data) {
  if (data?.requestId != state.discoveryRequestId ||
      data?.deviceId != GetDeviceID() || data?.host != getProxyAddress()) {
    writeLog("RPiManagedApp - Ignoring superseded discovery response")
    return
  }
  try {
    if (response.hasError() || response.getStatus() != 200) {
      log.error "RPiManagedApp - Discovery HTTP request failed (status ${response.getStatus()}); check the Pi address and service"
      return
    }
    def discovery = response.getJson()
    if (!(discovery instanceof Map) || discovery.type != "discover" || !(discovery.devices instanceof List)) {
      throw new IllegalArgumentException("Expected discovery JSON; update the Pi service to support /discover?response=json")
    }
    def names = []
    discovery.devices.each {
      if (!isValidDiscoveryDescriptor(it) || it.name in names) {
        throw new IllegalArgumentException("Invalid or duplicate discovery descriptor: ${it}")
      }
      names << it.name
    }
    ensureFirstDevice(discovery.devices)
    if (data.discoverAll) {
      addChildDevices(discovery.devices)
      app.updateSetting("enableDiscovery", [value: "false", type: "bool"])
    }
    sendCommand('/subscribe/'+getNotifyAddress())
  }
  catch(Exception err) {
    log.error "RPiManagedApp - Discovery bootstrap failed; check the Pi JSON response, installed managed drivers, and LAN ID ownership: ${err.message}"
  }
}

// Keep an existing receiver, or use the first configured appliance's driver and hex-IP ID.
private ensureFirstDevice(devices) {
  def deviceId = GetDeviceID()
  def children = getChildDevices()
  def receiver = children.find { it.deviceNetworkId == deviceId } ?:
    children.find { it.getDataValue("rpiLanReceiver") == "true" }
  def descriptor = receiver ? devices.find {
    findRaspberryDevice(it.name)?.deviceNetworkId == receiver.deviceNetworkId
  } : null
  if (!receiver) {
    if (!devices) {
      throw new IllegalArgumentException("At least one configured device is required to create a LAN receiver")
    }
    descriptor = devices[0]
    receiver = findRaspberryDevice(descriptor.name)
    if (!receiver) {
      receiver = addChildDevice("RPi Managed", descriptor.devicetypename, deviceId,
        [name: descriptor.name, label: descriptor.label, completedSetup: true])
    }
  }
  if (receiver.deviceNetworkId != deviceId) {
    receiver.setDeviceNetworkId(deviceId)
  }
  if (descriptor) {
    receiver.updateDataValue("rpiDeviceName", descriptor.name)
  }
  else {
    log.warn "RPiManagedApp - LAN receiver is no longer configured; it remains a receiver until removed and the app is saved again"
  }
  receiver.updateDataValue("rpiLanReceiver", "true")
  writeLog("RPiManagedApp - LAN receiver: ${receiver.displayName} - deviceId: ${deviceId}")
  return receiver
}

def uninstalled() {
    state.discoveryRequestId = (state.discoveryRequestId ?: 0) + 1
    removeChildDevices()
}

private removeChildDevices() {
    getChildDevices().collect { it.deviceNetworkId }.each { deleteChildDevice(it) }
    writeLog("RPiManagedApp - Removing all child devices")
}

def discoverChildDevices() {
  requestDeviceDiscovery(true)
  writeLog("RPiManagedApp - Sending discovery request")
}

def lanResponseHandler(evt) {
    try{
      def description = evt instanceof String ? evt : evt.description
      def map = parseLanMessage(description)
      def sourceAddress = map.ip ?: map.networkAddress
      if (!sourceAddress) {
        log.warn "RPiManagedApp - LAN message has no source IP; cannot route it"
        return
      }
      if (sourceAddress.toUpperCase() != GetDeviceID()) {
        writeLog("RPiManagedApp - Ignoring LAN message from ${sourceAddress}; expected ${GetDeviceID()}")
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

private isValidDiscoveryDescriptor(descriptor) {
  return descriptor instanceof Map && descriptor.name instanceof String &&
    descriptor.name ==~ /[A-Za-z0-9][A-Za-z0-9_-]*/ &&
    descriptor.devicetypename instanceof String && descriptor.devicetypename.trim() &&
    descriptor.label instanceof String && descriptor.label.trim() &&
    descriptor.type in ["switch", "temperature"]
}

private addChildDevices(devices) {
  writeLog("RPiManagedApp - Start addChildDevices: ${devices}")
  if (!(devices instanceof List)) {
    log.error "RPiManagedApp - Discovery devices must be a list"
    return
  }
  devices.each {
    if (!isValidDiscoveryDescriptor(it)) {
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
    def octets = settings.proxyAddress?.split(/\./, -1)
    if (octets?.size() != 4 || octets.any { !(it ==~ /\d{1,3}/) || it.toInteger() > 255 }) {
      throw new IllegalArgumentException("RPi Endpoint must be a valid IPv4 address")
    }
    def deviceId = octets*.toInteger().asType( byte[] ).encodeHex().toString().toUpperCase()
    return deviceId
}

def writeLog(message)
{
  if(settings.idelog){
    log.debug "${message}"
  }
}