const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'fireplace.js'), 'utf8');

function loadApp() {
    const routes = new Map();
    const gpios = new Map();
    const events = [];
    const messages = [];
    const requests = [];
    const timers = [];
    const saves = [];
    const logs = [];
    const config = {
        httpport: 3001,
        'notify:address': '127.0.0.1',
        'notify:port': 39500
    };
    let notificationError;
    const app = {
        use() {},
        get(route, handler) { routes.set(route, handler); }
    };
    const express = Object.assign(() => app, { Router: () => app });
    class Gpio {
        constructor(pin, direction) {
            this.pin = pin;
            this.value = direction === 'high' ? 1 : 0;
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
        watch() {}
    }
    const modules = {
        fs: {
            readdirSync() { return ['gpiochip512']; },
            readFileSync(file) {
                if (file.endsWith('/label')) return 'pinctrl-bcm2835';
                if (file.endsWith('/base')) return '512';
                throw new Error('Unexpected file read: ' + file);
            }
        },
        http: {
            createServer() { return { listen() {} }; },
            request(options) {
                if (notificationError) throw notificationError;
                requests.push(options);
                let message;
                return {
                    on() {},
                    write(data) { message = JSON.parse(data); },
                    end() {
                        messages.push(message);
                        events.push(['notify', message.device, message.command]);
                    }
                };
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
        'node-dht-sensor': {},
        log4js: { configure() {}, getLogger() { return { info() {} }; } }
    };
    const context = vm.createContext({
        require(name) {
            assert.ok(Object.hasOwn(modules, name), 'Unexpected module: ' + name);
            return modules[name];
        },
        console: { log(...args) { logs.push(args); }, error() {} },
        Buffer,
        setInterval() {},
        setTimeout(callback, delay) {
            const timer = { callback, delay };
            timers.push(timer);
            return timer;
        }
    });
    vm.runInContext(source, context, { filename: 'fireplace.js' });
    const startupMessages = messages.slice();
    const startupEvents = events.slice();
    events.length = 0;
    messages.length = 0;
    requests.length = 0;
    logs.length = 0;
    return {
        context, events, messages, requests, timers, logs, startupMessages, startupEvents,
        fireplace: gpios.get(535),
        garage: gpios.get(536),
        setNotificationError(error) { notificationError = error; },
        status(device) {
            let body;
            routes.get('/:device')({
                params: { device },
                ip: '127.0.0.1'
            }, {
                send(value) { body = value; }
            });
            return body;
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
            let ended = false;
            routes.get('/:device/:command')({
                params: { device, command },
                ip: '127.0.0.1'
            }, {
                end() { ended = true; }
            });
            assert.equal(ended, true);
        }
    };
}

test('fireplace commands set their target despite stale cached state and confirm repeated requests', () => {
    const app = loadApp();
    app.context.relaystate = 0;
    app.command('fireplace', 'off');
    app.context.relaystate = 1;
    app.fireplace.value = 0;
    app.command('fireplace', 'on');
    app.command('fireplace', 'on');
    app.command('fireplace', 'off');
    app.command('fireplace', 'off');
    assert.deepEqual(app.events, [1, 0, 0, 1, 1].flatMap(value => [
        ['write', 535, value],
        ['read', 535, value],
        ['notify', 'fireplace', value === 0 ? 'ON' : 'OFF']
    ]));
    assert.equal(app.context.relaystate, 1);
});

test('fireplace failures do not update confirmed state or send success notifications', () => {
    for (const fault of ['writeError', 'readError', 'ignoreWrites']) {
        const app = loadApp();
        app.fireplace[fault] = fault === 'ignoreWrites' ? true : new Error(fault);
        assert.throws(() => app.command('fireplace', 'on'), /Error|verification failed/);
        assert.equal(app.context.relaystate, 1);
        assert.deepEqual(app.messages, []);
    }
    const app = loadApp();
    assert.throws(() => app.context.relaycontrol(), /Invalid fireplace relay state/);
    assert.deepEqual(app.events, []);
});

test('garage repeats report confirmed state without restarting or shortening the pulse', () => {
    const app = loadApp();
    app.command('garagedoor', 'on');
    app.command('garagedoor', 'on');
    app.command('garagedoor', 'off');
    assert.equal(app.timers.length, 1);
    assert.equal(app.timers[0].delay, 1500);
    assert.equal(app.garage.value, 0);
    app.timers[0].callback();
    app.command('garagedoor', 'off');
    assert.deepEqual(app.events, [
        ['write', 536, 0], ['read', 536, 0], ['notify', 'garagedoor', 'ON'],
        ['read', 536, 0], ['notify', 'garagedoor', 'ON'],
        ['read', 536, 0], ['notify', 'garagedoor', 'ON'],
        ['write', 536, 1], ['read', 536, 1], ['notify', 'garagedoor', 'OFF'],
        ['read', 536, 1], ['notify', 'garagedoor', 'OFF']
    ]);
    assert.equal(app.context.relaystategarage, 1);
    assert.equal(app.context.garagePulseTimer, null);
    app.command('garagedoor', 'on');
    assert.equal(app.timers.length, 2);
});

test('garage verification failures never announce an unconfirmed ON state', () => {
    for (const fault of ['writeError', 'readError', 'ignoreWrites']) {
        const app = loadApp();
        app.garage[fault] = fault === 'ignoreWrites' ? true : new Error(fault);
        assert.throws(() => app.command('garagedoor', 'on'), /Error|verification failed/);
        assert.equal(app.context.relaystategarage, 1);
        assert.deepEqual(app.messages, []);
        assert.equal(app.timers.length, 1);
        assert.throws(() => app.command('garagedoor', 'on'), /Error|verification failed/);
        assert.equal(app.timers.length, 1);
        app.garage[fault] = undefined;
        app.timers[0].callback();
        assert.equal(app.garage.value, 1);
        assert.deepEqual(app.messages, [{ device: 'garagedoor', command: 'OFF' }]);
    }
});

test('garage release remains scheduled when the ON notification throws', () => {
    const app = loadApp();
    app.setNotificationError(new Error('Notification failed'));
    assert.throws(() => app.command('garagedoor', 'on'), /Notification failed/);
    assert.equal(app.garage.value, 0);
    assert.equal(app.timers.length, 1);
    app.setNotificationError(undefined);
    app.timers[0].callback();
    assert.equal(app.garage.value, 1);
    assert.deepEqual(app.messages, [{ device: 'garagedoor', command: 'OFF' }]);
});

test('garage release failures never announce an unconfirmed OFF state', () => {
    for (const fault of ['writeError', 'readError', 'ignoreWrites']) {
        const app = loadApp();
        app.command('garagedoor', 'on');
        app.garage[fault] = fault === 'ignoreWrites' ? true : new Error(fault);
        assert.throws(() => app.timers[0].callback(), /Error|verification failed/);
        assert.equal(app.context.relaystategarage, 0);
        assert.deepEqual(app.messages, [{ device: 'garagedoor', command: 'ON' }]);
    }
});

test('startup publishes both confirmed OFF states after reading both outputs', () => {
    const app = loadApp();
    assert.deepEqual(app.startupMessages, [
        { device: 'fireplace', command: 'OFF' },
        { device: 'garagedoor', command: 'OFF' }
    ]);
    assert.deepEqual(app.startupEvents.slice(-4), [
        ['read', 535, 1], ['read', 536, 1],
        ['notify', 'fireplace', 'OFF'], ['notify', 'garagedoor', 'OFF']
    ]);
    assert.equal(app.startupEvents.some(event => event[0] === 'write'), false);
});

test('status refresh reports observed output, logs mismatches, and preserves tracked state', () => {
    for (const [device, gpio, tracked, physical, field] of [
        ['fireplace', 'fireplace', 'relaystate', 'physicalrelay', 'physicalrelay'],
        ['garagedoor', 'garage', 'relaystategarage', 'physicalrelaygarage', 'physicalrelaygarage']
    ]) {
        for (const value of [0, 1]) {
            const app = loadApp();
            app[gpio].value = value;
            app.context[tracked] = 1 - value;
            const body = app.status(device);
            const state = value === 0 ? 'ON' : 'OFF';
            assert.equal(body[device], state);
            assert.equal(body[field], state);
            assert.deepEqual(app.messages, [{ device, command: state }]);
            assert.equal(app.context[physical], value);
            assert.equal(app.context[tracked], 1 - value);
            assert.ok(app.logs.some(args => args.some(arg =>
                typeof arg === 'string' && arg.includes('Relay state mismatch for ' + device)
            )));
            assert.equal(app.events.some(event => event[0] === 'write'), false);
        }
    }
});

test('garage status does not depend on the fireplace relay object', () => {
    const app = loadApp();
    app.context.relay = undefined;
    app.garage.value = 0;
    const body = app.status('garagedoor');
    assert.equal(body.garagedoor, 'ON');
    assert.equal(body.physicalrelaygarage, 'ON');
    assert.deepEqual(app.messages, [{ device: 'garagedoor', command: 'ON' }]);
});

test('status refresh does not announce a state when GPIO is absent, invalid, or unreadable', () => {
    for (const device of ['fireplace', 'garagedoor']) {
        for (const fault of ['absent', 'invalid', 'unreadable']) {
            const app = loadApp();
            const gpio = device === 'fireplace' ? app.fireplace : app.garage;
            if (fault === 'absent') app.context[device === 'fireplace' ? 'relay' : 'relaygarage'] = undefined;
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
        { device: 'garagedoor', command: 'OFF' }
    ]);
    assert.ok(app.requests.every(request => request.host === '127.0.0.2' && request.port === '39501'));
    assert.equal(app.context.relaystate, 1);
    assert.equal(app.events.some(event => event[0] === 'write'), false);
});

test('subscription snapshots do not restart or shorten an active garage pulse', () => {
    const app = loadApp();
    app.command('garagedoor', 'on');
    const timer = app.context.garagePulseTimer;
    const response = app.subscribe('127.0.0.1:39500');
    app.completeSave();
    assert.equal(response.ended, true);
    assert.equal(app.context.garagePulseTimer, timer);
    assert.equal(app.timers.length, 1);
    assert.equal(app.garage.value, 0);
    assert.deepEqual(app.messages.slice(-2), [
        { device: 'fireplace', command: 'OFF' },
        { device: 'garagedoor', command: 'ON' }
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
