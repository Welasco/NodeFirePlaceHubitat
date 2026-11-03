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
    const timers = [];
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
            request() {
                if (notificationError) throw notificationError;
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
            get(key) {
                return {
                    httpport: 3001,
                    'notify:address': '127.0.0.1',
                    'notify:port': 39500
                }[key];
            }
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
        console: { log() {}, error() {} },
        Buffer,
        setInterval() {},
        setTimeout(callback, delay) {
            const timer = { callback, delay };
            timers.push(timer);
            return timer;
        }
    });
    vm.runInContext(source, context, { filename: 'fireplace.js' });
    events.length = 0;
    return {
        context, events, messages, timers,
        fireplace: gpios.get(535),
        garage: gpios.get(536),
        setNotificationError(error) { notificationError = error; },
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
