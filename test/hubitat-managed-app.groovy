import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import org.codehaus.groovy.control.CompilerConfiguration

class TestChild {
    String deviceNetworkId
    String name
    String label
    Map data = [:]
    List commands = []
    List events = []
    String driverType
    boolean component
    Map registry
    def driver

    String getName() { return name }
    String getDisplayName() { return label }
    String getDataValue(String key) { return data[key] }
    void updateDataValue(String key, String value) { data[key] = value }
    void Rpiparse(String command) {
        commands << command
        driver.Rpiparse(command)
    }
    void parse(String description) { driver.parse(description) }
    void setLabel(String value) { label = value }
    void setDeviceNetworkId(String value) {
        if (registry.containsKey(value) && registry[value] != this) {
            throw new IllegalArgumentException("Duplicate child ID: ${value}")
        }
        registry.remove(deviceNetworkId)
        deviceNetworkId = value
        registry[value] = this
    }
}

class TestHub {
    String getDataValue(String key) {
        return key == "localIP" ? "127.0.0.1" : "39500"
    }
}

class TestHttpResponse {
    String body
    int status = 200
    boolean failed = false
    int jsonReads = 0

    boolean hasError() { return failed }
    int getStatus() { return status }
    Object getJson() {
        jsonReads++
        return new JsonSlurper().parseText(body)
    }
}

abstract class HubitatTestScript extends Script {
    Map settings = [proxyAddress: "192.168.2.10", proxyPort: "3001", enableDiscovery: true, idelog: false]
    Map state = [:]
    Map definitionValues
    List children = []
    Map registry = [:]
    List sent = []
    List scheduled = []
    List subscriptions = []
    List errors = []
    List warnings = []
    Map inputs = [:]
    List httpRequests = []
    Set availableDrivers = ["RPi Managed Switch", "RPi Managed Temperature"] as Set
    Closure driverFactory
    Closure beforeSend
    def device
    def parent
    def location = [hubs: [new TestHub()]]
    def app = [
        id: 41,
        label: "RPi Managed App",
        updateSetting: { String key, Map setting -> settings[key] = setting.value == "true" },
        updateLabel: { String value -> app.label = value }
    ]
    def log = [debug: { message -> }, error: { message -> errors << message.toString() },
               warn: { message -> warnings << message.toString() }]

    void definition(Map values) { definitionValues = values }
    void preferences(Closure code) {}
    void metadata(Closure code) {}
    void dynamicPage(Map options, Closure code) { code.call() }
    void section(String title, Closure code) { code.call() }
    void input(Map options, String name, String type) { inputs[name] = options + [type: type] }
    void unsubscribe() { subscriptions.clear() }
    void subscribe(Object target, Object event, Object handler, Map options) { subscriptions << handler }
    void runIn(int delay, Object handler) { scheduled << [delay: delay, handler: handler] }
    void unschedule(String handler) { scheduled.removeAll { it.handler == handler } }
    void asynchttpGet(String callback, Map params, Map data) {
        httpRequests << [callback: callback, params: params, data: data]
    }
    Map parseLanMessage(String description) {
        if (description.startsWith("{")) return new JsonSlurper().parseText(description)
        def message = description.split(",").collectEntries {
            def field = it.split(":", 2)
            [(field[0].trim()): field[1].trim()]
        }
        if (message.headers) {
            def header = new String(message.headers.decodeBase64(), "UTF-8")
            message.header = header
            message.headers = header.split(/\r\n/).findAll { it }.collectEntries {
                def field = it.split(":", 2)
                [(field[0].trim()): field.size() == 2 ? field[1].trim() : null]
            }
        }
        if (message.body) {
            message.body = new String(message.body.decodeBase64(), "UTF-8")
            if (message.headers["Content-Type"] == "application/json") {
                message.json = new JsonSlurper().parseText(message.body)
                message.data = message.json
            }
        }
        return message
    }
    void sendEvent(Map event) { device.events << event }
    String getTemperatureScale() { return "F" }
    List getChildDevices() { return children }
    void sendHubCommand(Object command) {
        if (beforeSend) beforeSend.call(command)
        sent << command.request
    }

    TestChild addChildDevice(String namespace, String type, Object id, Map attributes) {
        String deviceId = id.toString()
        if (registry.containsKey(deviceId)) throw new IllegalArgumentException("Duplicate child ID: ${deviceId}")
        if (!availableDrivers.contains(type)) throw new IllegalStateException("Driver not installed: ${type}")
        def child = new TestChild(name: attributes.name, label: attributes.label,
            driverType: type, component: attributes.isComponent == true, registry: registry)
        child.@deviceNetworkId = deviceId
        child.driver = driverFactory.call(type, child)
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
def loadScript
loadScript = { String filename ->
    def shell = new GroovyShell(loader, new Binding(), compiler)
    def script = shell.parse(new File(root, filename))
    script.run()
    script.setDriverFactory { String type, TestChild child ->
        def filenameByType = [
            "RPi Managed Switch": "Hubitat/RPiManagedSwitch.groovy",
            "RPi Managed Temperature": "Hubitat/RPiManagedTemperature.groovy"
        ]
        def driver = loadScript(filenameByType[type])
        driver.setParent(script)
        driver.setDevice(child)
        return driver
    }
    return script
}
def event = { String address, Map payload, String contentType = "application/json" ->
    def headers = "NOTIFY /notify HTTP/1.1\r\nContent-Type: ${contentType}\r\n\r\n"
    def body = JsonOutput.toJson(payload)
    String description = "mac:B827EB000001, ip:${address}, port:CCA8, " +
        "headers:${headers.getBytes('UTF-8').encodeBase64()}, body:${body.getBytes('UTF-8').encodeBase64()}"
    return description
}
def descriptors = [
    [type: "temperature", devicetypename: "RPi Managed Temperature", name: "roomtemperature", label: "Room"],
    [type: "switch", devicetypename: "RPi Managed Switch", name: "fireplace", label: "Fireplace"],
    [type: "switch", devicetypename: "RPi Managed Switch", name: "garagedoor", label: "Garage Door"]
]

def deliverResponse = { instance, request, response ->
    instance."${request.callback}"(response, request.data)
}
def completeDiscovery = { instance, List devices = descriptors, Map options = [:] ->
    def response = new TestHttpResponse(
        body: options.containsKey("body") ? options.body : JsonOutput.toJson([type: "discover", devices: devices]),
        status: options.containsKey("status") ? options.status : 200,
        failed: options.failed == true)
    deliverResponse(instance, instance.httpRequests.last(), response)
    return response
}

def first = loadScript("Hubitat/RPiManagedApp.groovy")
assert first.definitionValues.singleInstance == false
first.settings.appName = "  Fireplace Pi  "
first.setBeforeSend { command ->
    assert first.registry["C0A8020A"]?.driverType == "RPi Managed Temperature"
    assert first.registry["C0A8020A"].getDataValue("rpiLanReceiver") == "true"
    assert first.children.size() == 3
}
first.installed()
assert first.children.empty
assert first.sent.empty
assert first.httpRequests[0].params.uri == "http://192.168.2.10:3001/discover"
assert first.httpRequests[0].params.query == [response: "json"]
assert first.httpRequests[0].params.contentType == "application/json"
assert first.settings.enableDiscovery
completeDiscovery(first)
assert first.children*.deviceNetworkId == ["C0A8020A", "41:fireplace", "41:garagedoor"]
assert first.children.every { !it.component }
assert first.children[0].getDataValue("rpiDeviceName") == "roomtemperature"
assert first.children[0].label == "Room"
assert first.app.label == "Fireplace Pi"
assert first.subscriptions.empty
assert first.settings.enableDiscovery == false
assert first.scheduled.empty
assert first.sent[0].path == "/subscribe/127.0.0.1:39500"
first.updated()
completeDiscovery(first, descriptors.reverse())
assert first.children.size() == 3
assert first.children[0].deviceNetworkId == "C0A8020A"
assert first.subscriptions.empty
first.page1()
assert first.inputs.appName.defaultValue == "Fireplace Pi"
assert first.inputs.appName.type == "text"

def second = loadScript("Hubitat/RPiManagedApp.groovy")
second.app.id = 42
second.settings.proxyAddress = "192.168.2.11"
second.setRegistry(first.registry)
second.settings.appName = "Workshop Pi"
second.installed()
completeDiscovery(second)
assert second.children[0].deviceNetworkId == "C0A8020B"
assert second.app.label == "Workshop Pi"

// Model Hubitat's LAN matching before invoking the actual matched driver's parse method.
def routeLan = { String address, Map payload ->
    def receiver = first.registry[address.toUpperCase()]
    if (!receiver) return false
    receiver.parse(event(address, payload))
    return true
}
assert !routeLan("C0A8020C", [type: "discover", devices: descriptors])
assert routeLan("C0A8020A", [type: "discover", devices: descriptors])
assert routeLan("C0A8020B", [type: "discover", devices: descriptors])
assert routeLan("C0A8020A", [device: "roomtemperature", command: "68-50.0"])
assert routeLan("C0A8020B", [device: "roomtemperature", command: "72-40.0"])
assert first.children[0].events == [
    [name: "temperature", value: "68", unit: "F"],
    [name: "humidity", value: "50.0", unit: "%"]
]
assert second.children[0].events == [
    [name: "temperature", value: "72", unit: "F"],
    [name: "humidity", value: "40.0", unit: "%"]
]
assert second.children*.deviceNetworkId == ["C0A8020B", "42:fireplace", "42:garagedoor"]
assert first.registry.size() == 6
assert routeLan("C0A8020A", [type: "discover", devices: descriptors.reverse()])
assert first.children.size() == 3
def firstFireplace = first.children.find { it.getDataValue("rpiDeviceName") == "fireplace" }
def secondFireplace = second.children.find { it.getDataValue("rpiDeviceName") == "fireplace" }
def firstDoor = first.children.find { it.getDataValue("rpiDeviceName") == "garagedoor" }

first.lanResponseHandler(event("C0A8020B", [device: "fireplace", command: "ON"]))
assert firstFireplace.commands.empty
assert routeLan("c0a8020a", [device: "fireplace", command: "ON"])
assert firstFireplace.commands == ["ON"]
assert firstFireplace.events == [[name: "switch", value: "on"]]
assert secondFireplace.commands.empty
assert routeLan("C0A8020B", [device: "fireplace", command: "OFF"])
assert secondFireplace.commands == ["OFF"]
first.lanResponseHandler(JsonOutput.toJson([networkAddress: "C0A8020A",
    data: [device: "garagedoor", command: "ON"]]))
first.lanResponseHandler(JsonOutput.toJson([networkAddress: "C0A8020A",
    body: JsonOutput.toJson([device: "garagedoor", command: "OFF"])]))
first.lanResponseHandler(JsonOutput.toJson([networkAddress: "C0A8020A",
    data: JsonOutput.toJson([device: "garagedoor", command: "ON"])]))
assert firstDoor.commands == ["ON", "OFF", "ON"]
first.lanResponseHandler(event("C0A8020A", [device: "garagedoor", command: "OFF"], "text/plain"))
assert first.errors.empty: first.errors
assert firstDoor.commands.last() == "OFF"

def legacy = loadScript("Hubitat/RPiManagedApp.groovy")
legacy.app.id = 43
def oldFireplace = legacy.addChildDevice("RPi Managed", "RPi Managed Switch", "C0A8020A",
    [name: "Renamed Fireplace", label: "Existing Fireplace"])
def oldDoor = legacy.addChildDevice("RPi Managed", "RPi Managed Switch", "garagedoor",
    [name: "garagedoor", label: "Existing Door"])
legacy.app.label = "Existing App Label"
legacy.settings.appName = "   "
legacy.installed()
completeDiscovery(legacy)
assert legacy.app.label == "Existing App Label"
assert legacy.children.size() == 3
oldFireplace.parse(event("C0A8020A", [type: "discover", devices: descriptors]))
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
oldFireplace.parse(event("C0A8020A", [device: "fireplace", command: "ON"]))
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

def receiver = first.children[0]
first.settings.appName = "Renamed Pi"
first.updated()
completeDiscovery(first)
assert first.app.label == "Renamed Pi"
assert receiver.label == "Room"
assert first.children.size() == 3
first.settings.proxyAddress = "192.168.2.12"
first.setBeforeSend(null)
first.updated()
completeDiscovery(first)
assert receiver.deviceNetworkId == "C0A8020C"
assert first.registry["C0A8020C"].is(receiver)
assert !first.registry.containsKey("C0A8020A")
assert firstFireplace.deviceNetworkId == "41:fireplace"
assert !routeLan("C0A8020A", [device: "fireplace", command: "OFF"])
assert routeLan("C0A8020C", [device: "fireplace", command: "OFF"])
assert firstFireplace.commands == ["ON", "OFF"]
first.settings.proxyAddress = "192.168.2.10"
first.updated()
completeDiscovery(first)
assert receiver.deviceNetworkId == "C0A8020A"

def duplicate = loadScript("Hubitat/RPiManagedApp.groovy")
duplicate.app.id = 44
duplicate.setRegistry(first.registry)
duplicate.installed()
completeDiscovery(duplicate)
assert duplicate.sent.empty
assert duplicate.errors.last().contains("LAN ID ownership")
assert duplicate.settings.enableDiscovery
assert first.registry["C0A8020A"].is(receiver)

def missingDriver = loadScript("Hubitat/RPiManagedApp.groovy")
missingDriver.availableDrivers.remove("RPi Managed Temperature")
missingDriver.installed()
completeDiscovery(missingDriver)
assert missingDriver.sent.empty
assert missingDriver.children.empty
assert missingDriver.errors.last().contains("installed managed drivers")

for (String invalidAddress in ["", "192.168.2.256", "192.168..2.10", "pi.local", "192.168.2"]) {
    def invalid = loadScript("Hubitat/RPiManagedApp.groovy")
    invalid.settings.proxyAddress = invalidAddress
    try {
        invalid.installed()
        assert false: "Invalid Pi IPv4 address must fail"
    } catch (IllegalArgumentException expected) {
        assert invalid.children.empty
        assert invalid.sent.empty
    }
}

// An already-discovered v3 child is reused, changing only its network ID to receive LAN traffic.
def migrated = loadScript("Hubitat/RPiManagedApp.groovy")
def existingSensor = migrated.addChildDevice("RPi Managed", "RPi Managed Temperature", "41:roomtemperature",
    [name: "roomtemperature", label: "Custom Sensor Label"])
existingSensor.updateDataValue("rpiDeviceName", "roomtemperature")
migrated.installed()
completeDiscovery(migrated)
assert migrated.children[0].is(existingSensor)
assert existingSensor.deviceNetworkId == "C0A8020A"
assert existingSensor.label == "Custom Sensor Label"
assert migrated.children.size() == 3

def sensorOnly = loadScript("Hubitat/RPiManagedApp.groovy")
sensorOnly.installed()
completeDiscovery(sensorOnly, descriptors.take(1))
assert sensorOnly.children.size() == 1
sensorOnly.children[0].parse(event("C0A8020A", [device: "roomtemperature", command: "68-50.0"]))
assert sensorOnly.children[0].commands == ["68-50.0"]
assert sensorOnly.children[0].events == [
    [name: "temperature", value: "68", unit: "F"],
    [name: "humidity", value: "50.0", unit: "%"]
]

def manualDiscovery = loadScript("Hubitat/RPiManagedApp.groovy")
manualDiscovery.settings.enableDiscovery = false
manualDiscovery.installed()
completeDiscovery(manualDiscovery)
assert manualDiscovery.children.size() == 1
manualDiscovery.discoverChildDevices()
completeDiscovery(manualDiscovery)
assert manualDiscovery.children.size() == 3

// Removing configuration remains additive; deleting the actual receiver and saving selects another.
def lifecycle = loadScript("Hubitat/RPiManagedApp.groovy")
lifecycle.installed()
completeDiscovery(lifecycle)
def originalReceiver = lifecycle.children[0]
lifecycle.settings.enableDiscovery = true
lifecycle.updated()
completeDiscovery(lifecycle, descriptors.drop(1))
assert lifecycle.children.size() == 3
assert lifecycle.children[0].is(originalReceiver)
assert lifecycle.warnings.last().contains("no longer configured")
lifecycle.deleteChildDevice(originalReceiver.deviceNetworkId)
def replacement = lifecycle.children.find { it.name == "fireplace" }
lifecycle.updated()
completeDiscovery(lifecycle, descriptors.drop(1))
assert replacement.deviceNetworkId == "C0A8020A"
assert lifecycle.children.size() == 2

def stale = loadScript("Hubitat/RPiManagedApp.groovy")
stale.installed()
def staleRequest = stale.httpRequests.last()
stale.settings.proxyAddress = "192.168.2.12"
stale.updated()
def ignored = new TestHttpResponse(body: "{invalid", status: 503)
deliverResponse(stale, staleRequest, ignored)
assert stale.children.empty
assert stale.sent.empty
assert stale.errors.empty
assert ignored.jsonReads == 0
completeDiscovery(stale)
assert stale.children[0].deviceNetworkId == "C0A8020C"

def repeatedSave = loadScript("Hubitat/RPiManagedApp.groovy")
repeatedSave.installed()
def earlierRequest = repeatedSave.httpRequests.last()
repeatedSave.updated()
deliverResponse(repeatedSave, earlierRequest, new TestHttpResponse(body: "{invalid", status: 503))
assert repeatedSave.children.empty
assert repeatedSave.sent.empty
assert repeatedSave.errors.empty
completeDiscovery(repeatedSave)
assert repeatedSave.children.size() == 3

for (Map failure in [[status: 503], [status: 0, failed: true], [body: ""],
    [body: "{invalid"], [body: '{"type":"discover","devices":null}'],
    [body: '{"type":"discover","devices":[{"name":"bad/name"}]}'],
    [body: JsonOutput.toJson([type: "discover", devices: [descriptors[0], descriptors[0]]])],
    [body: '{"type":"discover","devices":[]}']]) {
    def failed = loadScript("Hubitat/RPiManagedApp.groovy")
    failed.installed()
    completeDiscovery(failed, descriptors, failure)
    assert failed.children.empty
    assert failed.sent.empty
    assert failed.errors.size() == 1
    assert failed.settings.enableDiscovery
}

def removed = loadScript("Hubitat/RPiManagedApp.groovy")
removed.installed()
removed.uninstalled()
completeDiscovery(removed)
assert removed.children.empty
assert removed.sent.empty

def unknownEvent = event("C0A8020A", [device: "missing", command: "ON"])
first.lanResponseHandler(JsonOutput.toJson([json: [device: "fireplace", command: "ON"]]))
assert first.warnings.last().contains("no source IP")
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
