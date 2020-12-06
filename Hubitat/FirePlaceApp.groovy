/**
 *  FireplaceApp
 *
 *  Author: Victor Santana
 *  Date: 2017-12-21
 */

definition(
    name: "Fireplace SmartApp",
    namespace: "Fireplace",
    author: "Victor Santana",
    description: "Fireplace Switch",
    category: "My Apps",
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
    // section("SmartThings Hub") {
    //   input "hostHub", "hub", title: "Select Hub", multiple: false, required: true
    // }
    section("SmartThings Raspberry") {
      input "proxyAddress", "text", title: "Proxy Address", description: "(ie. 192.168.1.10)", required: true
      input "proxyPort", "text", title: "Proxy Port", description: "(ie. 3001)", required: true, defaultValue: "3001"
    }
		section("Enable Debug Log at SmartThing IDE"){
			input "idelog", "bool", title: "Select True or False:", defaultValue: false, required: false
		}     
  }
}

def installed() {
  writeLog("FireplaceSmartApp - Fireplace Installed with settings: ${settings}")
	initialize()
  updated()
  addFireplaceDeviceType()
}

def updated() {
  writeLog("FireplaceSmartApp - Updated with settings: ${settings}")
	//unsubscribe()
	//initialize()
  sendCommand('/subscribe/'+getNotifyAddress())
}

def initialize() {
    subscribe(location, null, lanResponseHandler, [filterEvents:false])
    writeLog("FireplaceSmartApp - Initialize")
}

def uninstalled() {
    removeChildDevices()
}

private removeChildDevices() {
    getAllChildDevices().each { deleteChildDevice(it.deviceNetworkId) }
    writeLog("FireplaceSmartApp - Removing all child devices")
}

def lanResponseHandler(evt) {
    try{
      def map = parseLanMessage(evt)
      def headers = map.headers;
      def body = map.data;

      if (headers.'device' != 'fireplace') {
        writeLog("FireplaceSmartApp - Received event ${evt} but it didn't came from Fireplace")
        writeLog("FireplaceSmartApp - Received event but it didn't came from Fireplace headers:  ${headers}")
        writeLog("FireplaceSmartApp - Received event but it didn't came from Fireplace body: ${body}")      
        return
      }

      writeLog("FireplaceSmartApp - Received event headers:  ${headers}")
      writeLog("FireplaceSmartApp - Received event body: ${body}")
      updateFireplaceDeviceType(body)
    }
    catch(MissingMethodException){
      pass
    }
}

private updateFireplaceDeviceType(cmd) {
	def FireplaceNetworkID = GetDeviceID()
  writeLog("FireplaceSmartApp - Method updateFireplaceDeviceType FireplaceNetworkID: ${FireplaceNetworkID}")
  def Fireplacedevice = getChildDevice(FireplaceNetworkID)
  if (Fireplacedevice) {
    Fireplacedevice.Fireplaceparse("${cmd.command}")
    writeLog("FireplaceSmartApp - Updating Fireplace Device ${FireplaceNetworkID} using Command: ${cmd}")
  }
}

private addFireplaceDeviceType() {
  def deviceId = GetDeviceID()
  if (!getChildDevice(deviceId)) {
    addChildDevice("Fireplace", "Fireplace Switch", deviceId, ["name": "Fireplace", label: "Fireplace", completedSetup: true])
    writeLog("FireplaceSmartApp - Added FireplaceDeviceType device: ${deviceId}")
  }
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
    log.error "SmartThings Node Proxy configuration not set!"
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