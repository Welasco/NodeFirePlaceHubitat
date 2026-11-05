const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const source = fs.readFileSync(path.join(__dirname, '..', 'fireplace.js'), 'utf8');

function loadApp(options = {}) {
    const routes = new Map();
    const gpios = options.gpios || new Map();
    const events = [];
    const messages = [];
    const requests = [];
    const outgoing = [];
    const timers = [];
    const intervals = [];
    const saves = [];
    const logs = [];
    const sensorReads = [];
    const config = {
        ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')),
        'notify:address': '127.0.0.1',
        'notify:port': 39500
    };
    if (options.configure) options.configure(config);
    let notificationError;
    let autoRespond = true;
    const app = {
        use() {},
        get(route, handler) { routes.set(route, handler); }
    };
    const express = Object.assign(() => app, { Router: () => app });
    class Gpio {
        constructor(pin, direction) {
            this.pin = pin;
            this.direction = direction;
            this.value = direction === 'high' ? 1 : 0;
            if (direction === 'in' && options.inputValues && Object.hasOwn(options.inputValues, pin)) {
                this.value = options.inputValues[pin];
            }
            if (pin === 537 && options.gateStartupReadback !== undefined) {
                this.value = options.gateStartupReadback;
            }
            gpios.set(pin, this);
        }
        readSync() {
            if (this.readError) throw this.readError;
            events.push(['read', this.pin, this.value]);
            return this.value;
        }
        writeSync(value) {
            if (this.writeError) throw this.writeError;
            events.push(['write', this.pin, value]);
            if (!this.ignoreWrites) this.value = value;
        }
        watch(callback) { this.watcher = callback; }
    }
    const modules = {
        fs: {
            readdirSync() {
                if (options.gpioUnavailable) throw new Error('No sysfs GPIO');
                return ['gpiochip512'];
            },
            readFileSync(file) {
                if (file.endsWith('/label')) return 'pinctrl-bcm2835';
                if (file.endsWith('/base')) return '512';
                throw new Error('Unexpected file read: ' + file);
            }
        },
        http: {
            createServer() { return { listen() {} }; },
            request(options, onResponse) {
                if (notificationError) throw notificationError;
                requests.push(options);
                let message;
                const request = new EventEmitter();
                request.write = data => { message = JSON.parse(data); };
                request.end = () => {
                    messages.push(message);
                    events.push(['notify', message.device, message.command]);
                    if (autoRespond) request.respond(200);
                };
                request.destroy = () => { request.destroyed = true; };
                request.fail = error => request.emit('error', error);
                request.respond = (statusCode, end = true) => {
                    const response = new EventEmitter();
                    response.statusCode = statusCode;
                    response.resume = () => {
                        response.resumed = true;
                        if (end) response.emit('end');
                    };
                    onResponse(response);
                    return response;
                };
                outgoing.push(request);
                return request;
            }
        },
        https: {},
        express,
        nconf: {
            file() {},
            get(key) { return config[key]; },
            set(key, value) { config[key] = value; },
            save(callback) { saves.push(callback); }
        },
        onoff: { Gpio },
        'node-dht-sensor': {
            read(type, pin, callback) {
                sensorReads.push([type, pin]);
                callback(options.sensorError, 20, 50);
            }
        },
        log4js: { configure() {}, getLogger() { return { info() {} }; } }
    };
    const context = vm.createContext({
        require(name) {
            assert.ok(Object.hasOwn(modules, name), 'Unexpected module: ' + name);
            return modules[name];
        },
        console: { log(...args) { logs.push(args); }, error() {} },
        Buffer,
        setInterval(callback, delay) {
            const timer = { delay, active: true, callback() { if (this.active) callback(); } };
            intervals.push(timer);
            return timer;
        },
        setTimeout(callback, delay) {
            const timer = {
                delay,
                active: true,
                callback() {
                    if (!this.active) return;
                    this.active = false;
                    callback();
                }
            };
            timers.push(timer);
            return timer;
        },
        clearTimeout(timer) { timer.active = false; },
        clearInterval(timer) { timer.active = false; }
    });
    vm.runInContext(source, context, { filename: 'fireplace.js' });
    const startupMessages = messages.slice();
    const startupEvents = events.slice();
    events.length = 0;
    messages.length = 0;
    requests.length = 0;
    outgoing.length = 0;
    logs.length = 0;
    return {
        context, config, gpios, events, messages, requests, outgoing, intervals, logs, startupMessages, startupEvents, sensorReads,
        allTimers: timers,
        get timers() { return timers.filter(timer => timer.delay === 4500); },
        fireplace: gpios.get(535),
        garage: gpios.get(536),
        gate: gpios.get(537),
        state(device) { return context.deviceRegistry.get(device); },
        setNotificationError(error) { notificationError = error; },
        setAutoRespond(value) { autoRespond = value; },
        retry(device) {
            const entry = context.notificationQueue.get('device:' + device);
            assert.ok(entry && entry.retryTimer, 'Expected a pending retry for ' + device);
            return entry.retryTimer;
        },
        status(device) {
            const response = this.statusResponse(device);
            return response.body;
        },
        statusResponse(device) {
            const response = {
                statusCode: 200,
                status(code) { this.statusCode = code; return this; },
                send(value) { this.body = value; }
            };
            routes.get('/:device')({
                params: { device },
                ip: '127.0.0.1'
            }, response);
            return response;
        },
        subscribe(host) {
            const response = {
                statusCode: 200,
                ended: false,
                status(code) { this.statusCode = code; return this; },
                json(body) { this.body = body; this.ended = true; },
                end() { this.ended = true; }
            };
            routes.get('/subscribe/:host')({ params: { host } }, response, error => {
                response.error = error;
            });
            return response;
        },
        completeSave(error) {
            const callback = saves.shift();
            assert.ok(callback, 'Expected a pending configuration save');
            callback(error);
        },
        command(device, command) {
            const response = {
                statusCode: 200,
                ended: false,
                status(code) { this.statusCode = code; return this; },
                send(body) { this.body = body; this.ended = true; },
                end() { this.ended = true; }
            };
            routes.get('/:device/:command')({
                params: { device, command },
                ip: '127.0.0.1'
            }, response);
            assert.equal(response.ended, true);
            return response;
        }
    };
}

test('fireplace commands set their target despite stale cached state and confirm repeated requests', () => {
    const app = loadApp();
    app.state('fireplace').confirmedRelayState = 0;
    app.command('fireplace', 'off');
    app.state('fireplace').confirmedRelayState = 1;
    app.fireplace.value = 0;
    app.command('fireplace', 'on');
    app.command('fireplace', 'on');
    app.command('fireplace', 'off');
    app.command('fireplace', 'off');
    assert.deepEqual(app.events, [1, 0, 0, 1, 1].flatMap(value => [
        ['write', 535, value],
        ['read', 535, value],
        ['read', 535, value],
        ['notify', 'fireplace', value === 0 ? 'ON' : 'OFF']
    ]));
    assert.equal(app.state('fireplace').confirmedRelayState, 1);
});

test('fireplace failures do not update confirmed state or send success notifications', () => {
    for (const fault of ['writeError', 'readError', 'ignoreWrites']) {
        const app = loadApp();
        app.fireplace[fault] = fault === 'ignoreWrites' ? true : new Error(fault);
        assert.throws(() => app.command('fireplace', 'on'), /Error|verification failed/);
        assert.equal(app.state('fireplace').confirmedRelayState, 1);
        assert.deepEqual(app.messages, []);
    }
    const app = loadApp();
    assert.throws(() => app.context.setRelayOutput(undefined,'fireplace'), /Invalid relay state/);
    assert.deepEqual(app.events, []);
});

test('garage repeats report confirmed state without restarting or shortening either relay pulse', () => {
    for (const [device, gpio, pin] of [
        ['garagedoor', 'garage', 536],
        ['garagegate', 'gate', 537]
    ]) {
        const app = loadApp();
        app.command(device, 'on');
        app.command(device, 'on');
        app.command(device, 'off');
        assert.equal(app.timers.length, 1);
        assert.equal(app.timers[0].delay, 4500);
        assert.equal(app[gpio].value, 0);
        app.timers[0].callback();
        app.command(device, 'off');
        assert.deepEqual(app.events, [
            ['write', pin, 0], ['read', pin, 0], ['read', pin, 0], ['notify', device, 'ON'],
            ['read', pin, 0], ['read', pin, 0], ['notify', device, 'ON'],
            ['read', pin, 0], ['read', pin, 0], ['notify', device, 'ON'],
            ['write', pin, 1], ['read', pin, 1], ['read', pin, 1], ['notify', device, 'OFF'],
            ['read', pin, 1], ['read', pin, 1], ['notify', device, 'OFF']
        ]);
        assert.equal(app.state(device).confirmedRelayState, 1);
        assert.equal(app.state(device).pulseTimer, null);
        app.command(device, 'on');
        assert.equal(app.timers.length, 2);
    }
});

test('garage verification failures never announce an unconfirmed ON state', () => {
    for (const [device, gpio] of [
        ['garagedoor', 'garage'],
        ['garagegate', 'gate']
    ]) {
        for (const fault of ['writeError', 'readError', 'ignoreWrites']) {
            const app = loadApp();
            app[gpio][fault] = fault === 'ignoreWrites' ? true : new Error(fault);
            assert.throws(() => app.command(device, 'on'), /Error|verification failed/);
            assert.equal(app.state(device).confirmedRelayState, 1);
            assert.deepEqual(app.messages, []);
            assert.equal(app.timers.length, 1);
            assert.throws(() => app.command(device, 'on'), /Error|verification failed/);
            assert.equal(app.timers.length, 1);
            app[gpio][fault] = undefined;
            app.timers[0].callback();
            assert.equal(app[gpio].value, 1);
            assert.deepEqual(app.messages, [{ device, command: 'OFF' }]);
        }
    }
});

test('notification setup failures do not fail garage commands or delay their release', () => {
    const app = loadApp();
    app.setNotificationError(new Error('Notification failed'));
    app.command('garagedoor', 'on');
    assert.equal(app.garage.value, 0);
    assert.equal(app.timers.length, 1);
    app.setNotificationError(undefined);
    app.timers[0].callback();
    assert.equal(app.garage.value, 1);
    assert.deepEqual(app.messages, []);
    app.retry('garagedoor').callback();
    assert.deepEqual(app.messages, [{ device: 'garagedoor', command: 'OFF' }]);
});

test('garage release failures never announce an unconfirmed OFF state', () => {
    for (const [device, gpio] of [
        ['garagedoor', 'garage'],
        ['garagegate', 'gate']
    ]) {
        for (const fault of ['writeError', 'readError', 'ignoreWrites']) {
            const app = loadApp();
            app.command(device, 'on');
            app[gpio][fault] = fault === 'ignoreWrites' ? true : new Error(fault);
            assert.throws(() => app.timers[0].callback(), /Error|verification failed/);
            assert.equal(app.state(device).confirmedRelayState, 0);
            assert.deepEqual(app.messages, [{ device, command: 'ON' }]);
        }
    }
});

test('startup publishes all confirmed OFF states after reading all outputs', () => {
    const app = loadApp();
    assert.deepEqual(app.startupMessages, [
        { device: 'fireplace', command: 'OFF' },
        { device: 'garagedoor', command: 'OFF' },
        { device: 'garagegate', command: 'OFF' }
    ]);
    assert.deepEqual(app.startupEvents.slice(-6), [
        ['read', 535, 1], ['notify', 'fireplace', 'OFF'],
        ['read', 536, 1], ['notify', 'garagedoor', 'OFF'],
        ['read', 537, 1], ['notify', 'garagegate', 'OFF']
    ]);
    assert.equal(app.startupEvents.some(event => event[0] === 'write'), false);
});

test('status refresh reports observed output, logs mismatches, and preserves tracked state', () => {
    for (const [device, gpio] of [
        ['fireplace', 'fireplace'],
        ['garagedoor', 'garage'],
        ['garagegate', 'gate']
    ]) {
        for (const value of [0, 1]) {
            const app = loadApp();
            app[gpio].value = value;
            app.state(device).confirmedRelayState = 1 - value;
            const body = app.status(device);
            const state = value === 0 ? 'ON' : 'OFF';
            assert.equal(body[device], state);
            assert.equal(body.physicalrelay, state);
            assert.deepEqual(Object.keys(body), [device, 'physicalrelay']);
            assert.deepEqual(app.messages, [{ device, command: state }]);
            assert.equal(app.state(device).observedRelayState, value);
            assert.equal(app.state(device).confirmedRelayState, 1 - value);
            assert.ok(app.logs.some(args => args.some(arg =>
                typeof arg === 'string' && arg.includes('Relay state mismatch for ' + device)
            )));
            assert.equal(app.events.some(event => event[0] === 'write'), false);
        }
    }
});

test('garage status does not depend on the fireplace relay object', () => {
    const app = loadApp();
    app.state('fireplace').relayGpio = undefined;
    app.garage.value = 0;
    const body = app.status('garagedoor');
    assert.equal(body.garagedoor, 'ON');
    assert.equal(body.physicalrelay, 'ON');
    assert.deepEqual(app.messages, [{ device: 'garagedoor', command: 'ON' }]);
});

test('status refresh does not announce a state when GPIO is absent, invalid, or unreadable', () => {
    for (const [device, property] of [
        ['fireplace', 'fireplace'],
        ['garagedoor', 'garage'],
        ['garagegate', 'gate']
    ]) {
        for (const fault of ['absent', 'invalid', 'unreadable']) {
            const app = loadApp();
            const gpio = app[property];
            if (fault === 'absent') app.state(device).relayGpio = undefined;
            if (fault === 'invalid') gpio.value = 2;
            if (fault === 'unreadable') gpio.readError = new Error('Read failed');
            assert.throws(() => app.status(device), /Relay not initialized|Invalid relay readback|Read failed/);
            assert.deepEqual(app.messages, []);
        }
    }
});

test('subscription waits for saving and then snapshots current outputs to the new address', () => {
    const app = loadApp();
    const response = app.subscribe('127.0.0.2:39501');
    assert.equal(response.ended, false);
    assert.deepEqual(app.events, []);
    app.fireplace.value = 0;
    app.completeSave();
    assert.equal(response.ended, true);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(app.messages, [
        { device: 'fireplace', command: 'ON' },
        { device: 'garagedoor', command: 'OFF' },
        { device: 'garagegate', command: 'OFF' }
    ]);
    assert.ok(app.requests.every(request => request.host === '127.0.0.2' && request.port === '39501'));
    assert.equal(app.state('fireplace').confirmedRelayState, 1);
    assert.equal(app.events.some(event => event[0] === 'write'), false);
});

test('subscription snapshots do not restart or shorten an active garage pulse', () => {
    const app = loadApp();
    app.command('garagedoor', 'on');
    const timer = app.state('garagedoor').pulseTimer;
    const response = app.subscribe('127.0.0.1:39500');
    app.completeSave();
    assert.equal(response.ended, true);
    assert.equal(app.state('garagedoor').pulseTimer, timer);
    assert.equal(app.timers.length, 1);
    assert.equal(app.garage.value, 0);
    assert.deepEqual(app.messages.slice(-3), [
        { device: 'fireplace', command: 'OFF' },
        { device: 'garagedoor', command: 'ON' },
        { device: 'garagegate', command: 'OFF' }
    ]);
    timer.callback();
    assert.equal(app.garage.value, 1);
    assert.deepEqual(app.messages.at(-1), { device: 'garagedoor', command: 'OFF' });
});

test('failed subscription save returns an error without publishing a snapshot', () => {
    const app = loadApp();
    const response = app.subscribe('127.0.0.1:39500');
    app.completeSave(new Error('Disk full'));
    assert.equal(response.statusCode, 500);
    assert.equal(response.ended, true);
    assert.equal(response.body.error, 'Configuration error: Disk full');
    assert.deepEqual(app.messages, []);
});

test('subscription snapshot errors reach Express error handling without a success response', () => {
    const app = loadApp();
    const response = app.subscribe('127.0.0.1:39500');
    const error = new Error('Garage read failed');
    app.garage.readError = error;
    app.completeSave();
    assert.equal(response.error, error);
    assert.equal(response.ended, false);
    assert.deepEqual(app.messages, []);
});

test('notification requests are serialized and pending updates coalesce to the latest state', () => {
    const app = loadApp();
    app.setAutoRespond(false);
    app.command('fireplace', 'on');
    app.command('fireplace', 'off');
    app.command('fireplace', 'on');
    app.command('fireplace', 'off');
    assert.equal(app.outgoing.length, 1);
    assert.equal(app.context.notificationQueue.size, 1);
    app.outgoing[0].respond(200);
    assert.equal(app.outgoing.length, 2);
    assert.deepEqual(app.messages, [
        { device: 'fireplace', command: 'ON' },
        { device: 'fireplace', command: 'OFF' }
    ]);
    app.outgoing[1].respond(204);
    assert.equal(app.context.notificationQueue.size, 0);
    assert.equal(app.context.notificationInFlight, false);
    assert.equal(app.allTimers.some(timer => timer.active), false);
});

test('garage pulses finish while another notification is waiting for its response', () => {
    const app = loadApp();
    app.setAutoRespond(false);
    app.command('fireplace', 'on');
    app.command('garagedoor', 'on');
    assert.equal(app.outgoing.length, 1);
    app.timers[0].callback();
    assert.equal(app.garage.value, 1);
    assert.equal(app.state('garagedoor').pulseTimer, null);
    app.outgoing[0].respond(200);
    assert.deepEqual(app.messages, [
        { device: 'fireplace', command: 'ON' },
        { device: 'garagedoor', command: 'OFF' }
    ]);
    assert.deepEqual(app.events.filter(event => event[0] === 'write'), [
        ['write', 535, 0], ['write', 536, 0], ['write', 536, 1]
    ]);
});

test('notification retries re-read GPIO instead of replaying an obsolete ON payload', () => {
    for (const [device, gpio, pin] of [
        ['garagedoor', 'garage', 536],
        ['garagegate', 'gate', 537]
    ]) {
        const app = loadApp();
        app.setAutoRespond(false);
        app.command(device, 'on');
        app.outgoing[0].fail(new Error('Connection refused'));
        assert.equal(app.retry(device).delay, 5000);
        app[gpio].value = 1;
        app.retry(device).callback();
        assert.deepEqual(app.messages, [
            { device, command: 'ON' },
            { device, command: 'OFF' }
        ]);
        assert.equal(app.state(device).confirmedRelayState, 0);
        assert.deepEqual(app.events.filter(event => event[0] === 'write'), [['write', pin, 0]]);
    }
});

test('unreadable GPIO blocks retry payloads without replaying the previous state', () => {
    const app = loadApp();
    app.setAutoRespond(false);
    app.command('fireplace', 'on');
    app.outgoing[0].fail(new Error('Connection lost'));
    app.fireplace.readError = new Error('GPIO read failed');
    app.retry('fireplace').callback();
    assert.equal(app.outgoing.length, 1);
    assert.equal(app.retry('fireplace').delay, 15000);
    assert.deepEqual(app.messages, [{ device: 'fireplace', command: 'ON' }]);
});

test('notification deadlines destroy stalled requests and late events cannot schedule duplicate retries', () => {
    const app = loadApp();
    app.setAutoRespond(false);
    app.command('garagedoor', 'on');
    const request = app.outgoing[0];
    const deadline = app.allTimers.find(timer => timer.active && timer.delay === 5000);
    assert.ok(deadline);
    app.timers[0].callback();
    assert.equal(app.garage.value, 1);
    deadline.callback();
    assert.equal(request.destroyed, true);
    const retry = app.retry('garagedoor');
    assert.equal(retry.delay, 5000);
    request.fail(new Error('Late socket error'));
    request.respond(200);
    assert.equal(app.retry('garagedoor'), retry);
    assert.equal(app.context.notificationQueue.get('device:garagedoor').retries, 1);
    app.setAutoRespond(true);
    retry.callback();
    assert.deepEqual(app.messages.at(-1), { device: 'garagedoor', command: 'OFF' });
    assert.equal(app.context.notificationQueue.size, 0);
});

test('non-success HTTP responses and interrupted bodies retry, while successful responses clear deadlines', () => {
    const app = loadApp();
    app.setAutoRespond(false);
    app.command('fireplace', 'on');
    const response = app.outgoing[0].respond(503);
    assert.equal(response.resumed, true);
    app.retry('fireplace').callback();
    const interrupted = app.outgoing[1].respond(200, false);
    interrupted.emit('aborted');
    assert.equal(app.retry('fireplace').delay, 15000);
    app.retry('fireplace').callback();
    app.outgoing[2].respond(204);
    assert.equal(app.context.notificationQueue.size, 0);
    assert.equal(app.allTimers.some(timer => timer.active), false);
});

test('retries stop after the approved delays and periodic reconciliation recovers current states', () => {
    const app = loadApp();
    app.setAutoRespond(false);
    app.command('fireplace', 'on');
    app.outgoing[0].fail(new Error('Hub offline'));
    for (const delay of [5000, 15000, 30000]) {
        const retry = app.retry('fireplace');
        assert.equal(retry.delay, delay);
        retry.callback();
        app.outgoing.at(-1).fail(new Error('Hub offline'));
    }
    assert.equal(app.outgoing.length, 4);
    assert.equal(app.context.notificationQueue.size, 0);
    assert.equal(app.allTimers.some(timer => timer.active), false);
    assert.ok(app.logs.some(args => args.some(arg =>
        typeof arg === 'string' && arg.includes('Retries exhausted')
    )));
    app.garage.value = 0;
    app.setAutoRespond(true);
    const periodic = app.intervals.find(timer => timer.delay === 300000);
    assert.ok(periodic);
    periodic.callback();
    assert.deepEqual(app.messages.slice(-3), [
        { device: 'fireplace', command: 'ON' },
        { device: 'garagedoor', command: 'ON' },
        { device: 'garagegate', command: 'OFF' }
    ]);
    assert.deepEqual(app.events.filter(event => event[0] === 'write'), [['write', 535, 0]]);
});

test('a failed notification does not block delivery to a different device', () => {
    const app = loadApp();
    app.setAutoRespond(false);
    app.command('fireplace', 'on');
    app.command('garagedoor', 'on');
    app.outgoing[0].fail(new Error('Hub busy'));
    assert.equal(app.retry('fireplace').delay, 5000);
    assert.equal(app.outgoing.length, 2);
    assert.deepEqual(app.messages.at(-1), { device: 'garagedoor', command: 'ON' });
});

test('retry attempts use the current subscription address', () => {
    const app = loadApp();
    app.setAutoRespond(false);
    app.command('fireplace', 'on');
    app.outgoing[0].fail(new Error('Old hub unavailable'));
    app.setAutoRespond(true);
    const response = app.subscribe('127.0.0.2:39501');
    app.completeSave();
    assert.equal(response.ended, true);
    app.retry('fireplace').callback();
    assert.equal(app.requests.at(-1).host, '127.0.0.2');
    assert.equal(app.requests.at(-1).port, '39501');
    assert.equal(app.context.notificationQueue.size, 0);
});

test('periodic snapshot errors are logged and do not prevent a later reconciliation', () => {
    const app = loadApp();
    const periodic = app.intervals.find(timer => timer.delay === 300000);
    app.garage.readError = new Error('Temporary GPIO failure');
    periodic.callback();
    assert.deepEqual(app.messages, []);
    assert.ok(app.logs.some(args => args.some(arg =>
        typeof arg === 'string' && arg.includes('Relay state reconciliation error')
    )));
    app.garage.readError = undefined;
    periodic.callback();
    assert.deepEqual(app.messages, [
        { device: 'fireplace', command: 'OFF' },
        { device: 'garagedoor', command: 'OFF' },
        { device: 'garagegate', command: 'OFF' }
    ]);
});

test('temperature and discovery notifications retain their existing payloads and NOTIFY headers', () => {
    const app = loadApp();
    const temperature = { device: 'fireplacetemperature', command: '72.0-50.0' };
    const discovery = { type: 'discover', devices: [{ name: 'fireplace' }] };
    app.context.queueHubitatNotification(JSON.stringify(temperature));
    app.context.queueHubitatNotification(JSON.stringify(discovery));
    assert.deepEqual(app.messages, [temperature, discovery]);
    assert.ok(app.requests.every(request => request.method === 'NOTIFY' && request.path === '/notify'));
    assert.deepEqual(app.requests.map(request => request.headers.device), ['fireplacetemperature', 'discover']);
});

test('garagegate must initialize OFF and rejects unknown commands without operating a relay', () => {
    assert.throws(() => loadApp({ gateStartupReadback: 0 }), /all relays must be OFF/);
    const app = loadApp();
    assert.equal(app.gate.value, 1);
    const response = app.command('garagegate', 'invalid');
    assert.equal(response.statusCode, 404);
    assert.equal(response.body, 'Command not found');
    assert.deepEqual(app.events, []);
});

test('garagegate and garagedoor maintain independent pulse timers and state snapshots', () => {
    const app = loadApp();
    app.command('garagegate', 'on');
    const gateTimer = app.state('garagegate').pulseTimer;
    app.command('garagedoor', 'on');
    const doorTimer = app.state('garagedoor').pulseTimer;
    app.command('garagegate', 'on');
    app.command('garagedoor', 'on');
    assert.equal(app.timers.length, 2);
    assert.notEqual(gateTimer, doorTimer);
    const response = app.subscribe('127.0.0.1:39500');
    app.completeSave();
    assert.equal(response.ended, true);
    assert.deepEqual(app.messages.slice(-3), [
        { device: 'fireplace', command: 'OFF' },
        { device: 'garagedoor', command: 'ON' },
        { device: 'garagegate', command: 'ON' }
    ]);
    assert.equal(app.state('garagegate').pulseTimer, gateTimer);
    assert.equal(app.state('garagedoor').pulseTimer, doorTimer);
    gateTimer.callback();
    assert.equal(app.gate.value, 1);
    assert.equal(app.garage.value, 0);
    assert.equal(app.state('garagegate').confirmedRelayState, 1);
    assert.equal(app.state('garagedoor').confirmedRelayState, 0);
    app.command('garagegate', 'on');
    const nextGateTimer = app.state('garagegate').pulseTimer;
    doorTimer.callback();
    assert.equal(app.garage.value, 1);
    assert.equal(app.gate.value, 0);
    assert.equal(app.state('garagedoor').pulseTimer, null);
    assert.equal(app.state('garagegate').pulseTimer, nextGateTimer);
    nextGateTimer.callback();
    assert.equal(app.gate.value, 1);
    assert.ok(app.timers.every(timer => timer.delay === 4500));
    assert.deepEqual(app.events.filter(event => event[0] === 'write'), [
        ['write', 537, 0], ['write', 536, 0], ['write', 537, 1],
        ['write', 537, 0], ['write', 536, 1], ['write', 537, 1]
    ]);
});

test('both garage relays release on time even while Hubitat notification delivery is stalled', () => {
    const app = loadApp();
    app.setAutoRespond(false);
    app.command('garagegate', 'on');
    app.command('garagedoor', 'on');
    assert.equal(app.outgoing.length, 1);
    app.state('garagegate').pulseTimer.callback();
    app.state('garagedoor').pulseTimer.callback();
    assert.equal(app.gate.value, 1);
    assert.equal(app.garage.value, 1);
    assert.equal(app.state('garagegate').pulseTimer, null);
    assert.equal(app.state('garagedoor').pulseTimer, null);
    app.outgoing[0].respond(200);
    app.outgoing[1].respond(200);
    app.outgoing[2].respond(200);
    assert.deepEqual(app.messages, [
        { device: 'garagegate', command: 'ON' },
        { device: 'garagedoor', command: 'OFF' },
        { device: 'garagegate', command: 'OFF' }
    ]);
    assert.equal(app.context.notificationQueue.size, 0);
});

test('periodic reconciliation includes garagegate readback without changing its tracked state', () => {
    const app = loadApp();
    app.gate.value = 0;
    app.intervals.find(timer => timer.delay === 300000).callback();
    assert.deepEqual(app.messages, [
        { device: 'fireplace', command: 'OFF' },
        { device: 'garagedoor', command: 'OFF' },
        { device: 'garagegate', command: 'ON' }
    ]);
    assert.equal(app.state('garagegate').confirmedRelayState, 1);
    assert.equal(app.events.some(event => event[0] === 'write'), false);
});

test('discovery advertises garagegate with the same switch driver as garagedoor', () => {
    const app = loadApp();
    app.context.sendDeviceDiscovery();
    const discovery = app.messages[0];
    assert.equal(discovery.type, 'discover');
    const door = discovery.devices.find(device => device.name === 'garagedoor');
    const gates = discovery.devices.filter(device => device.name === 'garagegate');
    assert.equal(gates.length, 1);
    assert.equal(gates[0].type, door.type);
    assert.equal(gates[0].devicetypename, door.devicetypename);
});

test('configured names, GPIOs and relay polarity drive routes, snapshots and notification retries', () => {
    const app = loadApp({
        configure(config) {
            const relay = config.discover.devices[0];
            delete relay.manualInput;
            Object.assign(relay, { name: 'workshoplight', gpio: 17, activeLow: false });
            config.discover.devices = [relay];
            config.relayReportIntervalMs = 60000;
        }
    });
    assert.deepEqual([...app.gpios.keys()], [529]);
    assert.equal(app.gpios.get(529).direction, 'low');
    assert.deepEqual(app.startupMessages, [{ device: 'workshoplight', command: 'OFF' }]);
    assert.equal(app.statusResponse('fireplace').statusCode, 404);
    assert.equal(app.command('fireplace', 'on').statusCode, 404);
    app.setAutoRespond(false);
    app.command('workshoplight', 'on');
    assert.equal(app.gpios.get(529).value, 1);
    app.outgoing[0].fail(new Error('Hub offline'));
    app.gpios.get(529).value = 0;
    app.setAutoRespond(true);
    app.retry('workshoplight').callback();
    assert.deepEqual(app.messages, [
        { device: 'workshoplight', command: 'ON' },
        { device: 'workshoplight', command: 'OFF' }
    ]);
    assert.equal(app.requests[0].headers.device, 'workshoplight');
    app.intervals.find(timer => timer.delay === 60000).callback();
    assert.equal(app.status('workshoplight').physicalrelay, 'OFF');
    app.command('workshoplight', 'on');
    app.command('workshoplight', 'off');
    assert.equal(app.gpios.get(529).value, 0);
});

test('momentary durations and polarity are independent of names and discovery ordering', () => {
    const app = loadApp({
        configure(config) {
            const door = config.discover.devices[1];
            const gate = config.discover.devices[2];
            Object.assign(door, { name: 'door2', pulseMs: 1200 });
            Object.assign(gate, { name: 'gate2', activeLow: false, pulseMs: 2000 });
            config.discover.devices = [gate, door];
        }
    });
    app.command('door2', 'on');
    app.command('gate2', 'on');
    const doorTimer = app.state('door2').pulseTimer;
    const gateTimer = app.state('gate2').pulseTimer;
    assert.equal(doorTimer.delay, 1200);
    assert.equal(gateTimer.delay, 2000);
    app.command('gate2', 'on');
    app.command('gate2', 'off');
    assert.equal(app.state('gate2').pulseTimer, gateTimer);
    assert.equal(app.gate.value, 1);
    doorTimer.callback();
    assert.equal(app.garage.value, 1);
    assert.equal(app.gate.value, 1);
    gateTimer.callback();
    assert.equal(app.gate.value, 0);
    assert.deepEqual(app.messages.slice(-2), [
        { device: 'door2', command: 'OFF' },
        { device: 'gate2', command: 'OFF' }
    ]);
});

test('invalid configuration fails before creating any GPIOs', () => {
    for (const configure of [
        config => { config.httpport = '3001'; },
        config => { config.relayReportIntervalMs = 2147483648; },
        config => { config.discover.type = 'other'; },
        config => { config.discover.devices = {}; },
        config => { config.discover.devices[1].name = 'fireplace'; },
        config => { config.discover.devices[0].name = 'invalid/name'; },
        config => { config.discover.devices[0].gpio = 28; },
        config => { config.discover.devices[1].gpio = 23; },
        config => { config.discover.devices[3].gpio = 4; },
        config => { config.discover.devices[0].activeLow = 'true'; },
        config => { config.discover.devices[0].mode = 'toggle'; },
        config => { config.discover.devices[1].pulseMs = 0; },
        config => { config.discover.devices[3].sensorType = 12; },
        config => { delete config.discover.devices[3].pollIntervalMs; },
        config => { config.discover.devices[0].manualInput.controlEnabled = 'false'; },
        config => { config.discover.devices[0].manualInput.checkCount = 0; },
        config => { config.discover.devices[0].manualInput.checkIntervalMs = -1; },
        config => { config.discover.devices[0].manualInput.gpio = 24; },
        config => { config.discover.devices[0].manualInput = null; },
        config => { config.discover.devices[1].manualInput = config.discover.devices[0].manualInput; },
        config => { config.discover.devices[3].manualInput = config.discover.devices[0].manualInput; },
        config => { config.discover.devices[0].type = 'unknown'; }
    ]) {
        const gpios = new Map();
        assert.throws(() => loadApp({ configure, gpios }), /Configuration error/);
        assert.equal(gpios.size, 0);
    }
});

test('temperature-only configurations use configured readings and polling without sysfs GPIO', () => {
    const options = {
        gpioUnavailable: true,
        configure(config) {
            const temperature = config.discover.devices[3];
            Object.assign(temperature, { name: 'roomtemperature', gpio: 18, sensorType: 22, pollIntervalMs: 120000 });
            config.discover.devices = [temperature];
        }
    };
    const app = loadApp(options);
    assert.equal(app.gpios.size, 0);
    assert.deepEqual(app.startupMessages, []);
    const response = app.statusResponse('roomtemperature');
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.vartemperatureF, 68);
    assert.equal(response.body.vartemperatureC, '20.0');
    assert.equal(response.body.varhumidity, '50.0');
    app.intervals.find(timer => timer.delay === 120000).callback();
    assert.deepEqual(app.sensorReads, [[22, 18], [22, 18]]);
    assert.deepEqual(app.messages, [
        { device: 'roomtemperature', command: '68-50.0' },
        { device: 'roomtemperature', command: '68-50.0' }
    ]);
    assert.equal(app.command('roomtemperature', 'on').statusCode, 404);
    const failed = loadApp({ ...options, sensorError: new Error('DHT failed') });
    assert.equal(failed.statusResponse('roomtemperature').statusCode, 500);
    assert.deepEqual(failed.messages, []);
    assert.ok(failed.logs.some(args => args.some(arg => typeof arg === 'string' && arg.includes('DHT failed'))));
});

test('discovery includes only configured descriptors, without GPIO and manual-input settings', () => {
    const app = loadApp();
    app.context.sendDeviceDiscovery();
    assert.deepEqual(app.messages[0].devices, app.config.discover.devices.map(device => ({
        type: device.type, devicetypename: device.devicetypename, name: device.name, label: device.label
    })));
    assert.equal(app.messages[0].devices[0].name, 'fireplace');
});

function confirmInput(app, device, value) {
    const item = app.state(device);
    item.manualInputGpio.value = value;
    item.manualInputGpio.watcher(null, value);
    const timer = item.inputCheckTimer;
    if (timer) {
        for (let i = 0; i <= item.config.manualInput.checkCount; i++) timer.callback();
    }
}

test('disabled manual control preserves monitoring and filtering without changing the relay', () => {
    const app = loadApp();
    confirmInput(app, 'fireplace', 1);
    assert.equal(app.state('fireplace').confirmedInputState, 1);
    assert.equal(app.state('fireplace').inputCheckTimer, null);
    assert.equal(app.fireplace.value, 1);
    assert.equal(app.events.some(event => event[0] === 'write'), false);
    assert.deepEqual(app.messages, []);
    assert.ok(app.logs.some(args => args.some(arg =>
        typeof arg === 'string' && arg.includes('Manual relay control disabled for fireplace')
    )));
});

test('manual inputs are per relay and honor polarity, confirmed changes and API overrides', () => {
    const app = loadApp({
        inputValues: { 517: 1 },
        configure(config) {
            const fireplace = config.discover.devices[0];
            fireplace.manualInput.controlEnabled = true;
            const other = JSON.parse(JSON.stringify(fireplace));
            Object.assign(other, { name: 'otherrelay', gpio: 17, activeLow: false });
            Object.assign(other.manualInput, { gpio: 5, activeLow: true });
            config.discover.devices = [fireplace, other];
        }
    });
    confirmInput(app, 'fireplace', 1);
    assert.equal(app.fireplace.value, 0);
    assert.equal(app.state('otherrelay').relayGpio.value, 0);
    app.command('fireplace', 'off');
    confirmInput(app, 'fireplace', 1);
    assert.equal(app.fireplace.value, 1);
    assert.equal(app.state('fireplace').inputCheckTimer, null);
    confirmInput(app, 'otherrelay', 0);
    assert.equal(app.state('otherrelay').relayGpio.value, 1);
    confirmInput(app, 'fireplace', 0);
    app.command('fireplace', 'on');
    confirmInput(app, 'fireplace', 0);
    assert.equal(app.fireplace.value, 0);
    confirmInput(app, 'fireplace', 1);
    confirmInput(app, 'fireplace', 0);
    assert.equal(app.fireplace.value, 1);
    confirmInput(app, 'otherrelay', 1);
    assert.equal(app.state('otherrelay').relayGpio.value, 0);
    assert.deepEqual(app.messages.slice(-2), [
        { device: 'fireplace', command: 'OFF' },
        { device: 'otherrelay', command: 'OFF' }
    ]);
});

test('manual filtering rejects bounced inputs and uses only one checking interval per device', () => {
    const app = loadApp({
        configure(config) { config.discover.devices[0].manualInput.controlEnabled = true; }
    });
    const item = app.state('fireplace');
    item.manualInputGpio.value = 1;
    item.manualInputGpio.watcher(null, 1);
    const timer = item.inputCheckTimer;
    timer.callback();
    item.manualInputGpio.watcher(null, 1);
    assert.equal(item.inputCheckTimer, timer);
    item.manualInputGpio.value = 0;
    timer.callback();
    timer.callback();
    timer.callback();
    assert.equal(item.inputCheckTimer, null);
    assert.equal(item.confirmedInputState, 0);
    assert.deepEqual(app.messages, []);
    timer.callback();
    confirmInput(app, 'fireplace', 1);
    assert.deepEqual(app.messages, [{ device: 'fireplace', command: 'ON' }]);
});

test('simultaneous manual inputs keep separate configurable checking intervals', () => {
    const app = loadApp({
        configure(config) {
            const fireplace = config.discover.devices[0];
            fireplace.manualInput.controlEnabled = true;
            const other = JSON.parse(JSON.stringify(fireplace));
            Object.assign(other, { name: 'otherrelay', gpio: 17 });
            Object.assign(other.manualInput, { gpio: 5, checkIntervalMs: 100, checkCount: 1 });
            config.discover.devices = [fireplace, other];
        }
    });
    const fireplace = app.state('fireplace');
    const other = app.state('otherrelay');
    for (const item of [fireplace, other]) {
        item.manualInputGpio.value = 1;
        item.manualInputGpio.watcher(null, 1);
    }
    const fireplaceTimer = fireplace.inputCheckTimer;
    const otherTimer = other.inputCheckTimer;
    assert.notEqual(fireplaceTimer, otherTimer);
    assert.equal(fireplaceTimer.delay, 500);
    assert.equal(otherTimer.delay, 100);
    otherTimer.callback();
    otherTimer.callback();
    assert.equal(other.relayGpio.value, 0);
    assert.equal(fireplace.relayGpio.value, 1);
    assert.equal(fireplace.inputCheckTimer, fireplaceTimer);
    fireplaceTimer.callback();
    fireplaceTimer.callback();
    fireplaceTimer.callback();
    assert.equal(fireplace.relayGpio.value, 0);
    assert.equal(fireplace.inputCheckTimer, null);
});

test('manual input and relay failures are logged without announcing successful control', () => {
    for (const fault of ['inputRead', 'relayWrite', 'relayRead', 'watchError']) {
        const app = loadApp({
            configure(config) { config.discover.devices[0].manualInput.controlEnabled = true; }
        });
        const item = app.state('fireplace');
        item.manualInputGpio.value = 1;
        if (fault === 'watchError') {
            item.manualInputGpio.watcher(new Error('Input watch failed'), 1);
        } else {
            item.manualInputGpio.watcher(null, 1);
            if (fault === 'inputRead') item.manualInputGpio.readError = new Error('Input read failed');
            if (fault === 'relayWrite') app.fireplace.writeError = new Error('Relay write failed');
            if (fault === 'relayRead') app.fireplace.readError = new Error('Relay read failed');
            const timer = item.inputCheckTimer;
            for (let i = 0; i <= item.config.manualInput.checkCount; i++) timer.callback();
        }
        assert.equal(item.inputCheckTimer, null);
        assert.equal(item.confirmedRelayState, 1);
        assert.deepEqual(app.messages, []);
        assert.ok(app.logs.some(args => args.some(arg =>
            typeof arg === 'string' && /Manual input error|Manual input watch error/.test(arg)
        )));
    }
});

test('an initially active manual input never turns a relay ON at startup', () => {
    const app = loadApp({
        inputValues: { 516: 1 },
        configure(config) { config.discover.devices[0].manualInput.controlEnabled = true; }
    });
    assert.equal(app.state('fireplace').confirmedInputState, 1);
    assert.equal(app.fireplace.value, 1);
    confirmInput(app, 'fireplace', 1);
    assert.deepEqual(app.messages, []);
    confirmInput(app, 'fireplace', 0);
    confirmInput(app, 'fireplace', 1);
    assert.equal(app.fireplace.value, 0);
});
