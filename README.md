# Raspberry Pi Relay and Temperature Integration for Hubitat

A configuration-driven Node.js HTTP service that connects Raspberry Pi GPIO
devices to Hubitat. Run the same code on multiple supported Pis, with one
`config.json` and one Hubitat app instance per Pi.

The included configuration preserves the current hardware:

- A fireplace relay with maintained ON/OFF commands.
- A garage-door relay and garage-gate relay with independent 4.5-second pulses.
- A DHT11 temperature and humidity sensor on BCM21.
- A monitored manual-switch input on BCM4. Its fireplace-control action remains disabled.

This README describes the **v3 configuration-driven implementation**. Use
`master` for production; the `v3` branch is also retained. The entry point is
[`fireplace.js`](fireplace.js).

## What changed in v3

| Area | Behavior |
|---|---|
| Devices and routes | Device names, GPIOs, polarity, relay modes, pulse durations, and sensor polling come from `config.json`, not device-specific branches in the Node code. |
| Multiple Pis | Each Pi runs the same code with its own configuration and one Hubitat app instance. Notifications and new child IDs are isolated per instance. |
| First device and app name | The app retrieves discovery JSON first, then uses a configured appliance as its IP-based LAN receiver. No additional driver or receiver device is needed. App Name can be set during installation or later. |
| Manual input | Each maintained relay can optionally monitor an input and independently enable manual control. The included fireplace input remains monitoring-only. |
| Discovery | Every configured device is advertised, regardless of ordering. Only identity fields are sent to Hubitat, not GPIO or manual-input settings. |
| Existing Hubitat children | Discovery reuses matching children and preserves their labels. Legacy IP-based receivers retain their IDs; a namespaced child selected as receiver changes only its network ID. Removing configuration does not automatically delete children. |
| HTTP status | All relays use the same `physicalrelay` field; device-specific garage aliases were removed. |
| Readability | The single-file Node structure remains, with documented functions, meaningful runtime names, and obsolete code/comments removed. |

The GPIO libraries and hardware backend have not changed. This is not a
Python rewrite or a Pi 5 compatibility migration. No dependencies were added
by v3; an existing installation with the same dependency manifests does not
need `npm ci` solely for this upgrade.

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

Use BCM numbers in configuration for both relay and sensor pins; the app adds
the sysfs base only for relays and manual inputs, never for DHT sensor calls.
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
git clone --branch master https://github.com/Welasco/NodeFirePlaceHubitat.git
cd NodeFirePlaceHubitat
npm ci
```

`onoff` and `node-dht-sensor` include native dependencies. Do not copy
`node_modules` from a different machine or architecture. The default DHT
backend uses the bundled BCM2835 library.

## Configuration and starting

Edit [`config.json`](config.json):

Use the checked-in `config.json` as the template. `config.ORG.json` is a
historical file and is not read by the service.

| Setting | Purpose |
|---|---|
| `httpport` | Node.js HTTP listening port; currently `3001`. |
| `notify.address` | Hubitat IP address for callbacks. |
| `notify.port` | Hubitat LAN callback port. |
| `relayReportIntervalMs` | Relay reconciliation interval; currently `300000` (five minutes). |
| `discover.devices` | The devices to create, control, poll, and advertise to Hubitat. |

Hubitat registers its callback address through `/subscribe/:host`, and the
app saves it to `config.json`, preserving the hardware settings. Discovery
ordering no longer matters; the first device is discovered just like the others.

Each device needs `type`, `devicetypename`, `name`, `label`, and `gpio`:

| Device setting | Purpose |
|---|---|
| `name` | Stable API identifier, such as `fireplace`. Use letters, numbers, `_` and `-`, starting with a letter or number. |
| `label` | Initial friendly Hubitat label. Existing child labels are preserved during discovery. |
| `type` | `switch` or `temperature`. |
| `devicetypename` | Installed Hubitat driver, currently `RPi Managed Switch` or `RPi Managed Temperature`. |
| `gpio` | BCM GPIO number, from 0 to 27 for the supported boards. |
| `activeLow` | Required for switches; `true` means LOW energizes the relay. |
| `mode` | Required for switches; `maintained` or `momentary`. |
| `pulseMs` | Required for momentary relays; each relay has its own duration and timer. |
| `sensorType` | Required for temperature devices; `11` for DHT11 or `22` for DHT22. |
| `pollIntervalMs` | Required for temperature devices; currently `900000` (15 minutes). |
| `manualInput` | Optional input belonging to a maintained relay; see below. |

The included per-device values are:

| Name | Driver | BCM GPIO | Mode / sensor | Timing |
|---|---|---:|---|---|
| `fireplace` | RPi Managed Switch | 23 | Maintained, active-low | No automatic OFF timer |
| `garagedoor` | RPi Managed Switch | 24 | Momentary, active-low | `pulseMs: 4500` |
| `garagegate` | RPi Managed Switch | 25 | Momentary, active-low | `pulseMs: 4500` |
| `fireplacetemperature` | RPi Managed Temperature | 21 | DHT11 (`sensorType: 11`) | `pollIntervalMs: 900000` |

Only listed devices are initialized and advertised. A Pi can have a different
number of devices, different names, and different GPIO assignments. Removing
a device from configuration does not automatically delete its Hubitat child.
Names may repeat across Pis because their Hubitat app instances are isolated.
Keep names stable within a Pi to preserve device associations; changing a name
is treated as adding a different device, not renaming the existing one.

Configuration is loaded at startup. Restart after editing it; there is no live
reload. Invalid names, duplicate names/pins (including sensor and input pins),
unsupported types/modes, missing hardware fields, and invalid timers stop
startup before GPIO initialization. Older discovery-only configurations must
be updated with the new hardware fields. Timer intervals must be positive
integers no larger than `2147483647` milliseconds.

### Adding, changing, or removing devices

To add a device, add its complete descriptor to `discover.devices`, restart
the Pi service, and run discovery on that Pi's Hubitat app instance. No Express
route or GPIO source-code edit is needed. Changing an existing device's GPIO
or timing also requires a restart, but not rediscovery if its identity stays
the same.

Use Hubitat Labels for friendly naming. Editing a child device's Name after
discovery does not change its API identity because the driver uses the stored
`rpiDeviceName`. To deliberately change the configured `name`, plan for a new
child and update any automations that should use it.

Removing a descriptor and restarting stops initializing, advertising, polling,
and serving that device; requests to its former API path return HTTP 404.
The Hubitat child remains, can retain its last reported state, and is not
removed by subsequent discovery. Check its automation references and remove
that child manually in Hubitat if it is no longer needed. Do not uninstall
the app to remove one device: uninstalling deletes all of that app's children.

Removing a relay from configuration does not drive its old GPIO OFF. Likewise,
stopping the process is not an OFF command. Verify a safe hardware state before
removing a relay or changing its pin assignment.

### Optional manual input

The included fireplace entry contains:

```json
{
  "manualInput": {
    "gpio": 4,
    "activeLow": false,
    "controlEnabled": false,
    "checkIntervalMs": 500,
    "checkCount": 2
  }
}
```

These fields belong inside the maintained relay's descriptor; this fragment
is not a complete `config.json`.

Keep `controlEnabled: false` to monitor/filter input changes without controlling
the relay. To test manual control later, set it to `true` **for that device**
and restart. Omit `manualInput` entirely when a relay has no wired input.
Momentary garage operators and temperature devices cannot have manual inputs.

With input `activeLow: false`, a confirmed HIGH input requests ON and LOW
requests OFF; `true` reverses this mapping. Input polarity is independent of
relay polarity and must match the wiring.

The existing switch-checking approach is retained, with state and a checking
interval per input. The default checks finish after three 500ms intervals
(`checkCount` intermediate checks plus the final check); sampled changes reset
the counter. Repeated edge events do not create overlapping checking intervals.
Input and relay errors are logged without announcing successful control.

All relays still start OFF, even when a manual input is initially active.
The initial input is recorded as a baseline, not applied to the relay. After
startup, a confirmed input change follows the input state, while an API command
can override it. An unchanged input does not undo an API command; another
confirmed input change is needed.

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
Device routes use the configured `name`: `/api/:name`, `/api/:name/on`,
and `/api/:name/off`. The table shows the included configuration.

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
| `/discover?response=json` | Return the same descriptors as HTTP JSON without sending a discovery notification or operating GPIOs. |
| `/subscribe/:host` | Save a callback destination such as `HUB_IP:39500`, then report relay states. |

For example, this reads the garage-gate relay without operating it:

```bash
curl http://127.0.0.1:3001/api/garagegate
```

An OFF response is:

```json
{"garagegate":"OFF","physicalrelay":"OFF"}
```

Relay state is not door/gate position. There are no position sensors in this
implementation. The HTTP endpoints are unauthenticated: keep this service
on a trusted LAN and do not expose it to the Internet.
Temperature read failures return HTTP 500 and are logged.
All relay names return `{ "<name>": "OFF", "physicalrelay": "OFF" }` for an OFF
reading. Relay status responses use the same fields regardless of the device name.

The old `physicalrelaygarage` and `physicalrelaygaragegate` response aliases
are no longer returned. Update external clients that read those keys to use
`physicalrelay`. The configured-name key (such as `garagegate`) and Hubitat's
`device`/`command` notification format are unchanged; the managed Hubitat
drivers do not consume those removed aliases.

Unknown devices and unsupported commands return HTTP 404. Successful relay
commands return an empty response body; state is delivered through Hubitat
notifications. Temperature status returns the existing fields:

```json
{"vartemperatureF":68,"vartemperatureC":"20.0","varhumidity":"50.0"}
```

The temperature HTTP response uses a numeric Fahrenheit value and string
Celsius/humidity values. This format is retained for compatibility.

### Garage pulse duration

Momentary relays share `pulseRelay(deviceName)` in `fireplace.js`.
Their `pulseMs` settings are **4500 milliseconds (4.5 seconds)** in the included
configuration. Change each device's `pulseMs` independently in `config.json`
and restart; no source-code change is needed.

Each relay has its own timer. Repeated ON requests do not restart or extend
an active pulse, and OFF requests do not shorten it. OFF is scheduled before
the ON write so notification failures do not prevent scheduling release.
Node.js timers are not real-time guarantees or hardware safety cutoffs.

## Restart behavior and Hubitat synchronization

At process startup, all configured relay outputs are initialized OFF and read back
before the HTTP server starts. Startup then reports their current states.
A process restart interrupts any active garage pulse and initializes it OFF.
Active-low outputs initialize HIGH and active-high outputs initialize LOW.

This does not guarantee OFF while the process is stopped, during a crash
before restart, during Pi boot, or after a hardware/power failure. GPIO
readback confirms an output level, not relay-contact or appliance operation.
The manual-switch filter remains active when configured, but relay control is
disabled unless that device's `manualInput.controlEnabled` is `true`.

Hubitat notifications use HTTP `NOTIFY` to `/notify`. Relay bodies have the form:

```json
{"device":"garagegate","command":"OFF"}
```

State is reported after verified API/manual commands, status requests, startup,
and subscription, and reconciled at `relayReportIntervalMs`. Notifications are serialized
and pending updates coalesce per device. Before sending or retrying a relay
notification, the app reads its current output rather than replaying an old
ON payload.

Requests have a five-second total deadline and up to three retries after
5, 15, and 30 seconds. Exhaustion is logged; new updates or periodic snapshots
can restore synchronization. Delivery retries never operate the relays.
HTTP 2xx acceptance does not prove Hubitat applied a device event.

With the default three relays and five-minute reconciliation, periodic
reconciliation alone sends 36 notifications per hour. Temperature/humidity
are collected at each sensor's `pollIntervalMs`, as well as on demand.
Temperature notifications retain the legacy Fahrenheit-humidity string format.

## Hubitat setup and discovering new devices

Install these files in Hubitat:

| File | Hubitat location |
|---|---|
| [`Hubitat/RPiManagedApp.groovy`](Hubitat/RPiManagedApp.groovy) | Apps Code |
| [`Hubitat/RPiManagedSwitch.groovy`](Hubitat/RPiManagedSwitch.groovy) | Drivers Code |
| [`Hubitat/RPiManagedTemperature.groovy`](Hubitat/RPiManagedTemperature.groovy) | Drivers Code |

Update the Pi service first: the app requires `/discover?response=json`.
Add one RPi Managed App instance **per Pi**, enter an **App Name** such as
`Fireplace Pi` or `Workshop Pi`, configure its Pi IPv4 address/port, and enable
discovery. App Name is optional and can be changed by reopening the instance;
blank names preserve its current label. Renaming the app does not relabel its
relay or sensor children.

On installation or save, the app retrieves `/discover?response=json` using
Hubitat's asynchronous HTTP client. This response is delivered to the app's
callback on the requested HTTP connection, so it does not require a LAN receiver
to exist already. The callback validates the descriptors, then restores the
original first-device approach without hardcoding a fireplace:

- Reuse an existing IP-based receiver, or one previously marked as the receiver.
- Otherwise use the first device in `discover.devices`, with its configured
  name, label, and managed driver. Reuse a matching existing child when possible.
- Assign that child's network ID to the Pi's uppercase hexadecimal IP address,
  store `rpiDeviceName` and `rpiLanReceiver`, then add remaining children if
  Discover Devices is enabled.
- Only after registration succeeds, send the callback subscription to the Pi.

Hubitat matches incoming LAN traffic to an uppercase hexadecimal IP- or MAC-based
device network ID; namespaced appliance IDs alone cannot receive these messages.
Both managed drivers forward their `parse()` messages to the parent app, so a
relay or a sensor can be the receiver. It remains a normal configured appliance,
not a separate virtual endpoint. With the included configuration, `fireplace`
is the first device. Sensor-only Pis work too.

There is no fixed 10-second discovery delay. The callback creates children
before subscribing, and clears Discover Devices after successful discovery.
With discovery disabled, a fresh app still creates the receiver but does not
add the other children. HTTP failures, invalid JSON/descriptors, missing drivers,
or another app/device owning the Pi's LAN ID are logged and prevent subscription;
fix the reported problem and save/Done again. Superseded HTTP responses are ignored.
Use only one managed app instance for a given Pi on the same hub.

Each app accepts LAN notifications only from its configured Pi IP address.
Callback source ports are not filtered: Node's outgoing callback connections
do not originate from its HTTP listening port. Use a stable address/DHCP
reservation per Pi; IP filtering is routing isolation, not authentication.

All descriptors are discovered, including the first; no fireplace is created
unless it is configured. The receiver uses the Pi's hex-IP ID; other new child
network IDs use `<app-id>:<configured-name>`, so two Pis may both have a device
called `fireplace` without collisions.
Discovery stores `rpiDeviceName` on each child. Drivers use this stable name
for requests, rather than a friendly/edited Hubitat device name.
Changing a Pi address and saving updates the existing receiver's network ID
without recreating it or the other children. Reordering configuration alone
does not replace a receiver already registered.

Discovery remains additive. Removing the receiver from configuration leaves its
Hubitat child in place, still forwarding notifications, with a warning on save.
If you remove that child manually, save/Done the app afterward so it can select
a replacement from the current configuration. A fresh app needs at least one
configured device to create a receiver.

### Repairing a new instance that reports "no matching device found"

Early v3 app code created namespaced appliance children but omitted the IP-based
LAN receiver. Existing installations could still work because their legacy
fireplace child supplied it, while fresh instances could not receive discovery
or state updates. The Hubitat system warning means traffic arrived at the hub
but had no matching device network ID; changing the source port is not the fix.

1. Update the Pi service, preserving `config.json`, and restart it when safe;
   restart initializes configured outputs OFF. Confirm
   `curl --fail 'http://PI_IP:3001/discover?response=json'` returns discovery JSON.
2. Update the existing managed app and both managed drivers in Hubitat and save
   their code. No additional driver is needed.
3. Reopen the failing installed app, set its App Name and correct Pi address
   (for example `192.168.2.243`), enable Discover Devices, and save/Done.
4. Allow the HTTP callback to complete and check discovery/state updates.
   A fresh instance for `192.168.2.243` should assign receiver ID `C0A802F3`
   to its first configured appliance.

Do not uninstall the working app or recreate its appliance children. This
repair requires the updated Node discovery route and existing Hubitat code
entries, but no new configuration fields or changes to your GPIO values.

### Upgrading an existing Pi and Hubitat installation

1. Create/download a Hubitat backup under Settings > Backup and Restore.
2. Update the first Pi using the Git/config procedure below. Preserve its
   actual hardware settings and leave `manualInput.controlEnabled: false`
   until ready to test. Restart initializes all configured relays OFF.
   Verify `/discover?response=json` returns JSON before saving the new app.
3. Update the managed app and both managed drivers above, retaining the existing
   installed app instance and its Pi address. Replace source in existing code
   entries and save; do not duplicate those entries or uninstall/reinstall the app.
4. Enable Discover Devices on the existing app and save/Done. Discovery matches
   its legacy children, keeps their network IDs and labels, and records their
   configured names. Allow the HTTP callback to complete, refresh devices, and check
   the Pi/Hubitat logs. Verify relay commands only when it is safe to operate
   the connected equipment.
5. Deploy the same code with the second Pi's configuration, add a second managed
   app instance with that Pi's address, and enable discovery on that instance.

Legacy matching searches only the installed app's own children, by stored
name/device name, with the original IP-derived fireplace ID as a fallback.
If you previously renamed a legacy child before it had `rpiDeviceName`, restore
its original Device Name before discovery (the IP-derived fireplace can also
be matched by its ID). Existing automation references remain intact when the
same child is retained. Uninstalling an app deletes its children.

The existing temperature driver still splits values on `-`, which cannot
correctly handle negative temperatures, and labels Fahrenheit readings using
the hub's configured temperature scale. Use a Fahrenheit-configured hub until
that separate conversion issue is addressed.

Official documentation:
[LAN device routing](https://docs2.hubitat.com/en/developer/driver/building-a-lan-driver),
[asynchronous HTTP methods](https://docs2.hubitat.com/en/developer/common-methods-object#asynchttpget),
[child-device methods](https://docs2.hubitat.com/en/developer/app/app-object),
[preference updates](https://docs2.hubitat.com/en/developer/app/installedapp-object),
and [backup/restore](https://docs2.hubitat.com/en/user-interface/settings/backup-and-restore).

### Configuring a second Pi

Install the same Node code and dependencies on the second Pi. Its local
`config.json` defines only the devices physically connected to that board.
For example, a second Pi with a maintained relay on BCM17 and a DHT11 on BCM21
could use:

```json
{
  "httpport": 3001,
  "notify": {
    "address": "192.168.2.201",
    "port": "39500"
  },
  "relayReportIntervalMs": 300000,
  "discover": {
    "type": "discover",
    "devices": [
      {
        "type": "switch",
        "devicetypename": "RPi Managed Switch",
        "name": "workshoplight",
        "label": "Workshop Light",
        "gpio": 17,
        "activeLow": true,
        "mode": "maintained"
      },
      {
        "type": "temperature",
        "devicetypename": "RPi Managed Temperature",
        "name": "roomtemperature",
        "label": "Room Temperature",
        "gpio": 21,
        "sensorType": 11,
        "pollIntervalMs": 900000
      }
    ]
  }
}
```

Adapt this example to the actual wiring and Hubitat address. It intentionally
has no `manualInput`, so no input GPIO is created. The example creates
`/api/workshoplight`, `/api/workshoplight/on`, `/api/workshoplight/off`, and
`/api/roomtemperature` without any code changes.

`notify.address` is the **Hubitat address**, not the Pi's own address. Configure
the second Pi's distinct IPv4 address in its own Hubitat app instance. Both
Pis may use port 3001 because they have different addresses, and both can
notify the same hub. The managed app and driver code entries are shared;
install a second app instance, not a second copy of the code.

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

### Updating code and preserving each Pi's configuration

Run updates from the repository directory on the Pi, not from the development
machine. Schedule downtime while relay interruption is acceptable. Stop any
manually started process instead if this Pi is not running the systemd service.
Stopping alone does not guarantee outputs are OFF.

```bash
sudo systemctl stop fireplace.service
cp config.json ../fireplace-config.before-v3.json
git status
git diff -- config.json
```

Choose a fresh backup filename if that backup already exists. Subscription
changes can modify the tracked `config.json`, even if you have not edited it
manually. Preserve any other local changes as well; do not force a checkout
or reset the repository to bypass conflicts.

If `config.json` has local edits, stash only that file before switching/pulling:

```bash
git stash push -m "Pi config before v3 upgrade" -- config.json
```

Then update the production branch:

```bash
git fetch origin
git switch master
git pull --ff-only origin master
```

If intentionally staying on `v3`, use `git switch v3` and
`git pull --ff-only origin v3` instead. A pull updates files; it does not restart
the Node process or update code installed in Hubitat.

Review the new `config.json` and copy the correct per-Pi settings from the
backup, retaining the new fields such as `mode`, `gpio`, `activeLow`,
`relayReportIntervalMs`, and sensor/manual-input settings. Do not replace the
new file wholesale with a discovery-only configuration from an older version.
If a stash was created, inspect it with:

```bash
git stash list
git stash show -p 'stash@{0}'
```

Select the correct entry if other stashes exist. Do not blindly run
`git stash pop`: an old schema can remove required settings or cause conflicts.
Alternatively, to intentionally discard both staged and unstaged config edits
after backing them up:

```bash
git restore --source=HEAD --staged --worktree -- config.json
```

That restore command discards local settings and uses the committed file from
the **current** branch. Check the resulting Hubitat address and wiring before
starting the service. It does not merge an old configuration into the new one.

Run `npm ci` if dependency manifests changed or dependencies need restoring;
build native dependencies on the Pi itself. There are no dependency changes
introduced by v3 relative to the preceding implementation. The executable bit
for `fireplace.js` is tracked in Git.

After configuration is ready:

```bash
sudo systemctl start fireplace.service
sudo systemctl status fireplace.service --no-pager
sudo journalctl -u fireplace.service -n 50 --no-pager
curl --fail http://127.0.0.1:3001/
curl --fail http://127.0.0.1:3001/api/fireplace
```

Use the configured port and a device name present on this Pi. These GET status
requests do not operate the relay. The root response only confirms HTTP
availability; sensor access and Hubitat delivery must be checked separately.
Finish the Hubitat upgrade/discovery steps above. Reinstalling the systemd unit
is not needed when its existing paths, user/group, and Node environment are
already correct.

### Troubleshooting

- **Configuration error at startup:** use the v3 schema and inspect the logged
  field/device name. `node --check fireplace.js` checks code syntax, not the
  configuration schema or hardware. Check JSON syntax separately, for example
  with `node -e 'JSON.parse(require("fs").readFileSync("config.json", "utf8"))'`.
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
  configured Pi IPv4 address, and queued/sending/accepted/retry messages in the
  logs. Run discovery in the correct app instance if it logs an unknown device.
- **Hubitat "no matching device found" warning:** update Node and the existing
  app/drivers, then save the app instance as described above. Confirm its receiver's
  ID matches its configured Pi IP in uppercase hex, and that another app/device
  does not own that address. If you delete the child serving as LAN receiver,
  save/Done the app afterward to register a replacement.
- **Discovery HTTP/bootstrap failure:** check the Pi URL, service, and installed
  managed drivers. `/discover?response=json` must return `type: "discover"` and
  valid device descriptors; an empty response means the Node service needs updating.
  Fix the logged error and save/Done again.
- **Device endpoint returns 404:** check the configured name, device type,
  command, and whether the service was restarted after editing configuration.
- **Manual input logs changes but does not control the relay:** this is expected
  with `controlEnabled: false`. Check wiring/polarity before enabling it, and
  remember that an unchanged input does not override an API command.
- **Removed device still appears in Hubitat:** discovery is additive; remove
  the old child manually after checking its automation references.

## Code layout

The runtime remains in `fireplace.js`, using the existing libraries and a
function-based structure. Configuration and runtime state are separate:
`deviceRegistry` holds each device's GPIO objects, confirmed/observed states,
pulse timer, and optional manual-input state.

| Functions | Responsibility |
|---|---|
| `loadConfiguredDevices`, `getRelayDevice` | Validate configuration and look up a configured relay. |
| `getRelayOutputLevel`, `getRelayStateLabel` | Translate between logical ON/OFF and polarity-dependent GPIO levels. |
| `setRelayOutput`, `verifyAndReportRelayOutput`, `pulseRelay` | Operate, verify, and report maintained or momentary relay commands. |
| `readRelayOutput`, `reportRelayStates` | Read outputs and reconcile Hubitat without operating relays. |
| `readManualInput`, `checkManualInputChange` | Monitor and filter per-device manual input changes. |
| `readTemperature` | Share one configured DHT reading path between HTTP and polling. |
| `getDeviceDiscovery`, `sendDeviceDiscovery` | Share configured identity descriptors between HTTP JSON and legacy notifications. |
| `queueDeviceStateNotification`, `queueHubitatNotification`, `flushNotificationQueue`, `sendHubitatNotification` | Coalesce and deliver Hubitat updates with deadlines and retries. |

The managed Hubitat app handles instance naming, asynchronous discovery,
first-device LAN registration, and legacy child matching. Both managed drivers
forward raw LAN messages to their parent app, send commands using
`rpiDeviceName` and apply notifications from their parent app. The older
`FirePlaceApp.groovy`, `FirePlaceDeviceType.groovy`, and
`GaragePushableButton.groovy` files are not required for this managed setup.

## Tests

```bash
npm test
node --check fireplace.js
```

The regression suite uses Node's built-in test runner with mocked GPIO,
HTTP, sensors, and timers. It covers configured names/pins/polarity, configuration
validation, relay commands, independent pulses, manual-input filtering and API
overrides, startup/discovery, and notification recovery.

With Java and Groovy installed, run the Hubitat mock checks from this directory:

```bash
groovy test/hubitat-managed-app.groovy
```

They parse HTTP discovery JSON in an app callback and model IP-based LAN matching
through the actual switch/temperature driver's `parse` method. They cover
registration before subscription, multiple instances, app naming, sensor-only
Pis, receiver replacement/IP updates, legacy child preservation, stable driver
routes, malformed/failed HTTP responses, and superseded callbacks.
Neither suite validates physical wiring, relay contacts, or the installed
Hubitat runtime. Test hardware behavior separately before connecting controlled
loads, especially before enabling manual control.
