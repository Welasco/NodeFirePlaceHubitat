import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import org.codehaus.groovy.control.CompilerConfiguration

class TestChild {
    String deviceNetworkId
    String name
    String label
    Map data = [:]
    List commands = []

    String getName() { return name }
    String getDisplayName() { return label }
    String getDataValue(String key) { return data[key] }
    void updateDataValue(String key, String value) { data[key] = value }
    void Rpiparse(String command) { commands << command }
}

class TestHub {
    String getDataValue(String key) {
        return key == "localIP" ? "127.0.0.1" : "39500"
    }
}

abstract class HubitatTestScript extends Script {
    Map settings = [proxyAddress: "192.168.2.10", proxyPort: "3001", enableDiscovery: true, idelog: false]
    Map definitionValues
    List children = []
    Map registry = [:]
    List sent = []
    List scheduled = []
    List subscriptions = []
    List errors = []
    List warnings = []
    def device
    def parent
    def location = [hubs: [new TestHub()]]
    def app = [
        id: 41,
        updateSetting: { String key, Map setting -> settings[key] = setting.value == "true" }
    ]
    def log = [debug: { message -> }, error: { message -> errors << message.toString() },
               warn: { message -> warnings << message.toString() }]

    void definition(Map values) { definitionValues = values }
    void preferences(Closure code) {}
    void metadata(Closure code) {}
    void unsubscribe() { subscriptions.clear() }
    void subscribe(Object target, Object event, Object handler, Map options) { subscriptions << handler }
    void runIn(int delay, Object handler) { scheduled << [delay: delay, handler: handler] }
    Map parseLanMessage(String description) { return new JsonSlurper().parseText(description) }
    List getChildDevices() { return children }
    void sendHubCommand(Object command) { sent << command.request }

    TestChild addChildDevice(String namespace, String type, Object id, Map attributes) {
        String deviceId = id.toString()
        assert !registry.containsKey(deviceId): "Duplicate child ID: ${deviceId}"
        def child = new TestChild(deviceNetworkId: deviceId, name: attributes.name, label: attributes.label)
        registry[deviceId] = child
        children << child
        return child
    }

    void deleteChildDevice(String id) {
        assert children.any { it.deviceNetworkId == id }
        children.removeAll { it.deviceNetworkId == id }
        registry.remove(id)
    }
}

def loader = new GroovyClassLoader(this.class.classLoader)
loader.parseClass('''
package hubitat.device
class HubAction {
    Map request
    HubAction(Map request) { this.request = request }
}
''')
def compiler = new CompilerConfiguration(scriptBaseClass: HubitatTestScript.name)
def root = new File(".")
def loadScript = { String filename ->
    def shell = new GroovyShell(loader, new Binding(), compiler)
    def script = shell.parse(new File(root, filename))
    script.run()
    return script
}
def event = { String address, Map payload ->
    JsonOutput.toJson([networkAddress: address, json: payload])
}
def descriptors = [
    [type: "temperature", devicetypename: "RPi Managed Temperature", name: "roomtemperature", label: "Room"],
    [type: "switch", devicetypename: "RPi Managed Switch", name: "fireplace", label: "Fireplace"],
    [type: "switch", devicetypename: "RPi Managed Switch", name: "garagedoor", label: "Garage Door"]
]

def first = loadScript("Hubitat/RPiManagedApp.groovy")
assert first.definitionValues.singleInstance == false
first.installed()
assert first.children.empty
assert first.subscriptions.size() == 1
assert first.settings.enableDiscovery == false
assert first.scheduled*.delay == [10]
assert first.sent[0].path == "/subscribe/127.0.0.1:39500"
first.updated()
assert first.subscriptions.size() == 1

def second = loadScript("Hubitat/RPiManagedApp.groovy")
second.app.id = 42
second.settings.proxyAddress = "192.168.2.11"
second.setRegistry(first.registry)
first.lanResponseHandler(event("C0A8020B", [type: "discover", devices: descriptors]))
assert first.children.empty
first.lanResponseHandler([description: event("C0A8020A", [type: "discover", devices: descriptors])])
second.lanResponseHandler(event("C0A8020B", [type: "discover", devices: descriptors]))
assert first.children*.deviceNetworkId == ["41:roomtemperature", "41:fireplace", "41:garagedoor"]
assert second.children*.deviceNetworkId == ["42:roomtemperature", "42:fireplace", "42:garagedoor"]
assert first.registry.size() == 6
first.lanResponseHandler(event("C0A8020A", [type: "discover", devices: descriptors.reverse()]))
assert first.children.size() == 3

first.lanResponseHandler(event("C0A8020B", [device: "fireplace", command: "ON"]))
assert first.children[1].commands.empty
first.lanResponseHandler(event("c0a8020a", [device: "fireplace", command: "ON"]))
assert first.children[1].commands == ["ON"]
assert second.children[1].commands.empty
second.lanResponseHandler(event("C0A8020B", [device: "fireplace", command: "OFF"]))
assert second.children[1].commands == ["OFF"]
first.lanResponseHandler(JsonOutput.toJson([networkAddress: "C0A8020A",
    data: [device: "garagedoor", command: "ON"]]))
first.lanResponseHandler(JsonOutput.toJson([networkAddress: "C0A8020A",
    body: JsonOutput.toJson([device: "garagedoor", command: "OFF"])]))
first.lanResponseHandler(JsonOutput.toJson([networkAddress: "C0A8020A",
    data: JsonOutput.toJson([device: "garagedoor", command: "ON"])]))
assert first.children[2].commands == ["ON", "OFF", "ON"]

def legacy = loadScript("Hubitat/RPiManagedApp.groovy")
legacy.app.id = 43
def oldFireplace = legacy.addChildDevice("RPi Managed", "RPi Managed Switch", "C0A8020A",
    [name: "Renamed Fireplace", label: "Existing Fireplace"])
def oldDoor = legacy.addChildDevice("RPi Managed", "RPi Managed Switch", "garagedoor",
    [name: "garagedoor", label: "Existing Door"])
legacy.lanResponseHandler(event("C0A8020A", [type: "discover", devices: descriptors]))
assert legacy.children.size() == 3
assert oldFireplace.deviceNetworkId == "C0A8020A"
assert oldDoor.deviceNetworkId == "garagedoor"
assert oldFireplace.label == "Existing Fireplace"
assert oldDoor.label == "Existing Door"
assert oldFireplace.getDataValue("rpiDeviceName") == "fireplace"
assert oldDoor.getDataValue("rpiDeviceName") == "garagedoor"
oldDoor.name = "Renamed Door"
legacy.lanResponseHandler(event("C0A8020A", [type: "discover", devices: descriptors]))
assert legacy.children.size() == 3
legacy.lanResponseHandler(event("C0A8020A", [device: "fireplace", command: "ON"]))
assert oldFireplace.commands == ["ON"]

def relayDriver = loadScript("Hubitat/RPiManagedSwitch.groovy")
relayDriver.setParent(legacy)
relayDriver.setDevice(oldFireplace)
legacy.sent.clear()
relayDriver.on()
relayDriver.off()
relayDriver.refresh()
assert legacy.sent*.path == ["/api/fireplace/on", "/api/fireplace/off", "/api/fireplace"]
assert legacy.sent.every { it.headers.HOST == "192.168.2.10:3001" }

def temperatureDriver = loadScript("Hubitat/RPiManagedTemperature.groovy")
temperatureDriver.setParent(first)
temperatureDriver.setDevice(first.children[0])
temperatureDriver.device.name = "Renamed Temperature"
first.sent.clear()
temperatureDriver.refresh()
assert first.sent[0].path == "/api/roomtemperature"

def unknownEvent = event("C0A8020A", [device: "missing", command: "ON"])
first.lanResponseHandler(unknownEvent)
assert first.warnings.last().contains("Unknown device")
first.lanResponseHandler(JsonOutput.toJson([networkAddress: "C0A8020A", body: "{invalid"]))
assert first.errors.last().contains("LAN event error")
first.lanResponseHandler(event("C0A8020A", [type: "discover", devices: [[name: "bad/name"]]]))
assert first.errors.last().contains("Invalid discovery descriptor")
assert first.children.size() == 3
first.uninstalled()
assert first.registry.size() == 3
assert second.children.size() == 3
assert first.errors.size() == 2
assert second.errors.empty
assert legacy.errors.empty

println "Hubitat managed app and driver checks passed"
