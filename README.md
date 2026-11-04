# Raspberry Pi Relay and Temperature Integration for Hubitat

A Node.js HTTP service that connects Raspberry Pi GPIO devices to Hubitat:

- A fireplace relay with explicit ON/OFF commands.
- A garage-door relay and garage-gate relay with independent momentary pulses.
- A DHT11 temperature and humidity sensor.
- A monitored manual-switch input. Its fireplace-control action is currently disabled.

The current implementation is on the **`v2` branch**. The entry point is
[`fireplace.js`](fireplace.js).

## Hardware and wiring

The current setup uses an original Raspberry Pi Zero W and active-low relay
boards: GPIO LOW (`0`) energizes a relay; GPIO HIGH (`1`) turns it OFF.

Parenthesized numbers below are **physical header pins**. GPIO labels use
**BCM numbering**. Check the board's pin-1 marking before wiring; this is a
numbered layout, not an orientation guide.

```text
                           Raspberry Pi header
                           Odd pins  Even pins

 MANUAL SWITCH VCC ----------> 3V3 ( 1) ( 2) 5V  ---> Garage-gate board VCC
                             GPIO2 ( 3) ( 4) 5V  ---> Fireplace/garage-door board VCC
                             GPIO3 ( 5) ( 6) GND ---> Fireplace/garage-door board GND
 MANUAL SWITCH ------------> GPIO4 ( 7) ( 8) GPIO14
                               GND ( 9) (10) GPIO15
                            GPIO17 (11) (12) GPIO18
                            GPIO27 (13) (14) GND
                            GPIO22 (15) (16) GPIO23 <--- FIREPLACE relay
 DHT11 VCC ------------------> 3V3 (17) (18) GPIO24 <--- GARAGE DOOR relay
                            GPIO10 (19) (20) GND ---> Garage-gate board GND
                             GPIO9 (21) (22) GPIO25 <--- GARAGE GATE relay
                            GPIO11 (23) (24) GPIO8
                               GND (25) (26) GPIO7
                             GPIO0 (27) (28) GPIO1
                             GPIO5 (29) (30) GND
                             GPIO6 (31) (32) GPIO12
                            GPIO13 (33) (34) GND
                            GPIO19 (35) (36) GPIO16
                            GPIO26 (37) (38) GPIO20
 DHT11 GND ------------------> GND (39) (40) GPIO21 <--- DHT11 DATA
```

Both relay boards receive 5V. The DHT11 and manual switch receive 3.3V.
The second channel on the garage-gate relay board has no control pin assigned
in this app. Do not apply 5V to Raspberry Pi GPIO signal pins.

### GPIO numbering

`onoff` uses global Linux sysfs GPIO numbers. The app finds the unique
`pinctrl-bcm2835` controller under `/sys/class/gpio`, reads its base, and adds
the BCM offset automatically.

| Signal | BCM GPIO | Physical pin | Sysfs number when base is 512 |
|---|---:|---:|---:|
| Manual-switch input | 4 | 7 | 516 |
| Fireplace relay | 23 | 16 | 535 |
| Garage-door relay | 24 | 18 | 536 |
| Garage-gate relay | 25 | 22 | 537 |
| DHT11 data | 21 | 40 | Not used by the default DHT backend |

Keep the DHT11 sensor calls at BCM21; do not add the sysfs base to them.
This app requires the legacy sysfs GPIO interface and the controller above.
It is not a general-purpose implementation for every Raspberry Pi model,
including Pi 5.

## Installation

Use a Linux Raspberry Pi installation with Node.js 22 and npm. An original
Pi Zero W requires an ARMv6-compatible Node build; do not use an ARMv7 or ARM64
binary. The running setup has been exercised with Node.js 22.23.4.

Install native-build prerequisites if they are not already available:

```bash
sudo apt update
sudo apt install build-essential python3 pkg-config
```

Clone and install directly on the Pi:

```bash
git clone --branch v2 https://github.com/Welasco/NodeFirePlaceHubitat.git
cd NodeFirePlaceHubitat
npm ci
```

`onoff` and `node-dht-sensor` include native dependencies. Do not copy
`node_modules` from a different machine or architecture. The default DHT
backend uses the bundled BCM2835 library.

## Configuration and starting

Edit [`config.json`](config.json):

| Setting | Purpose |
|---|---|
| `httpport` | Node.js HTTP listening port; currently `3001`. |
| `notify.address` | Hubitat IP address for callbacks. |
| `notify.port` | Hubitat LAN callback port. |
| `discover.devices` | Device descriptors returned through discovery notifications. |

Hubitat registers its callback address through `/subscribe/:host`, and the
app saves it to `config.json`. Preserve the discovery descriptors and keep
`fireplace` first; the current Hubitat app assumes that ordering.

Run from the repository directory because config and log paths are relative:

```bash
npm start
```

Running without root requires access to sysfs GPIO files, `/dev/gpiomem` for
the default non-root DHT backend, and write permission for `config.json` and
`fireplace.log`. Raspberry Pi OS GPIO permissions and group membership depend
on the installed image. Previous `sudo` runs may also leave files owned by root.

If these permissions are not configured, the existing setup can be started
with `sudo npm start`. Successful startup does not prove DHT11 access works:
the sensor is initialized when a reading is requested.

Do not run a manual instance while the systemd service is already running.
The HTTP port does not require root at its default value of 3001.

## HTTP API

All routes below use HTTP GET. Replace the host and port as appropriate.

| Route | Behavior |
|---|---|
| `/` | Basic HTTP availability response; not a sensor or relay health check. |
| `/api/fireplace` | Read and report the fireplace relay state. |
| `/api/fireplace/on` | Set and verify fireplace ON. |
| `/api/fireplace/off` | Set and verify fireplace OFF. |
| `/api/garagedoor` | Read and report the garage-door relay state. |
| `/api/garagedoor/on` | Start a garage-door relay pulse. |
| `/api/garagedoor/off` | Confirm/report its state; does not cancel an active pulse. |
| `/api/garagegate` | Read and report the garage-gate relay state. |
| `/api/garagegate/on` | Start a garage-gate relay pulse. |
| `/api/garagegate/off` | Confirm/report its state; does not cancel an active pulse. |
| `/api/fireplacetemperature` | Read temperature in Fahrenheit/Celsius and humidity, and notify Hubitat. |
| `/discover` | Send configured device descriptors to Hubitat, not in the HTTP response body. |
| `/subscribe/:host` | Save a callback destination such as `HUB_IP:39500`, then report relay states. |

For example, this reads the garage-gate relay without operating it:

```bash
curl http://127.0.0.1:3001/api/garagegate
```

An OFF response is:

```json
{"garagegate":"OFF","physicalrelaygaragegate":"OFF"}
```

Relay state is not door/gate position. There are no position sensors in this
implementation. The HTTP endpoints are unauthenticated: keep this service
on a trusted LAN and do not expose it to the Internet.

### Garage pulse duration

Both garage relays share `relaycontrolgarage(device)` in `fireplace.js`.
Its `setTimeout` delay is **4500 milliseconds (4.5 seconds)**. Changing that
value changes the duration for both relays. Update the corresponding pulse
expectations in `test/relay-control.test.js` when changing it.

Each relay has its own timer. Repeated ON requests do not restart or extend
an active pulse, and OFF requests do not shorten it. OFF is scheduled before
the ON write so notification failures do not prevent scheduling release.
Node.js timers are not real-time guarantees or hardware safety cutoffs.

## Restart behavior and Hubitat synchronization

At process startup, all three outputs are initialized HIGH/OFF and read back
before the HTTP server starts. Startup then reports their current states.
A process restart interrupts any active garage pulse and initializes it OFF.

This does not guarantee OFF while the process is stopped, during a crash
before restart, during Pi boot, or after a hardware/power failure. GPIO
readback confirms an output level, not relay-contact or appliance operation.
The manual-switch filter remains active, but its relay-control call is disabled.

Hubitat notifications use HTTP `NOTIFY` to `/notify`. Relay bodies have the form:

```json
{"device":"garagegate","command":"OFF"}
```

State is reported after verified commands, status requests, startup, and
subscription, and reconciled every five minutes. Notifications are serialized
and pending updates coalesce per device. Before sending or retrying a relay
notification, the app reads its current output rather than replaying an old
ON payload.

Requests have a five-second total deadline and up to three retries after
5, 15, and 30 seconds. Exhaustion is logged; new updates or periodic snapshots
can restore synchronization. Delivery retries never operate the relays.
HTTP 2xx acceptance does not prove Hubitat applied a device event.

With three relays, periodic reconciliation alone sends 36 notifications per
hour. Temperature/humidity are collected every 15 minutes, as well as on demand.
Temperature notifications retain the legacy Fahrenheit-humidity string format.

## Hubitat setup and discovering new devices

Install these files in Hubitat:

| File | Hubitat location |
|---|---|
| [`Hubitat/RPiManagedApp.groovy`](Hubitat/RPiManagedApp.groovy) | Apps Code |
| [`Hubitat/RPiManagedSwitch.groovy`](Hubitat/RPiManagedSwitch.groovy) | Drivers Code |
| [`Hubitat/RPiManagedTemperature.groovy`](Hubitat/RPiManagedTemperature.groovy) | Drivers Code |

Add the RPi Managed App, configure the Pi address/port, and enable discovery.
The app registers its callback address and schedules discovery after 10 seconds.
Device Names must match the Node.js names (`fireplace`, `garagedoor`,
`garagegate`, and `fireplacetemperature`). Use Labels for friendly names.

To discover `garagegate` without recreating existing devices:

1. Create/download a Hubitat backup under Settings > Backup and Restore.
2. Use the existing installed RPi Managed App; do not uninstall/reinstall it.
3. Keep the current Pi address and discovery ordering unchanged, enable
   Discover Devices, and save/Done.
4. Wait for Garage Gate to appear, then turn discovery off and save again.
5. Refresh the new device to populate its relay state.

The current app's warning that discovery removes existing devices is outdated:
discovery calls `getChildDevice` and adds only missing devices. The removal
function is called by `uninstalled()`. Existing device records, settings, and
automation references are retained when their IDs remain unchanged.

Current Hubitat-code limitations:

- Discovery skips the first descriptor, assuming it is the existing fireplace.
  Its device network ID is derived from the Pi IP address.
- The discovery flag is reset by direct assignment rather than the documented
  `app.updateSetting` method; manually turn it off after discovery.
- The temperature driver splits values on `-`, which cannot correctly handle
  negative temperatures, and labels Fahrenheit readings using the hub's
  configured temperature scale. Use a Fahrenheit-configured hub until that
  conversion is addressed.

Official documentation:
[child-device methods](https://docs2.hubitat.com/en/developer/app/app-object),
[preference updates](https://docs2.hubitat.com/en/developer/app/installedapp-object),
and [backup/restore](https://docs2.hubitat.com/en/user-interface/settings/backup-and-restore).

## Running as a systemd service

[`fireplace.service`](fireplace.service) runs as user/group `pi`, uses
`/home/pi/NodeFirePlaceHubitat`, and restarts the process automatically.
Before installing it, check its paths, user/group, and Node.js availability
within its configured PATH (`/usr/bin:/usr/local/bin`). The entry point is
tracked as executable and uses `#!/usr/bin/env node`.

After adapting the service if necessary:

```bash
sudo cp fireplace.service /etc/systemd/system/fireplace.service
sudo systemctl daemon-reload
sudo systemctl enable --now fireplace.service
```

Useful commands:

```bash
sudo systemctl status fireplace.service
sudo journalctl -u fireplace.service -n 50 --no-pager
sudo systemctl restart fireplace.service
sudo systemctl stop fireplace.service
```

The service user needs the GPIO, sensor, config, and log permissions described
above. Application logs are also written to `fireplace.log`.

## Updating and troubleshooting

From the repository directory:

```bash
git status
git diff --summary
git diff -- fireplace.js config.json
git pull --ff-only origin v2
```

Subscription changes can modify the tracked `config.json`. Preserve local
callback settings when resolving pull conflicts; do not blindly overwrite it.
The executable bit for `fireplace.js` is tracked in Git.

Run `npm ci` again when dependency manifests change, then restart the app or
service. Restart initializes all relays OFF.

- **`EINVAL` exporting GPIO:** inspect `/sys/class/gpio/gpiochip*/label` and
  `base`; ensure the current automatic mapping code and supported controller
  are present. Do not replace BCM offsets with hard-coded global numbers.
- **Permission denied:** check sysfs GPIO access, `/dev/gpiomem`, and ownership
  of config/log files for the actual process user.
- **Temperature initialization/read errors:** check sensor permissions and
  wiring separately from relay operation.
- **Address already in use:** check whether the systemd service or another app
  instance already owns port 3001.
- **Hubitat state not updating:** check the callback destination, LAN reachability,
  and queued/sending/accepted/retry messages in the logs.

## Tests

```bash
npm test
node --check fireplace.js
```

The regression suite uses Node's built-in test runner with mocked GPIO,
HTTP, and timers. It covers relay commands, verification failures, independent
garage pulses, startup/discovery, and notification recovery. It does not
validate physical wiring, relay contacts, or the installed Hubitat runtime.
Test hardware behavior separately before connecting controlled loads.
