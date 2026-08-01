const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const autoEat = require('mineflayer-auto-eat');
const armorManager = require('mineflayer-armor-manager');

const collectBlockModule = require('mineflayer-collectblock');
const collectBlock = collectBlockModule.plugin || collectBlockModule;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const activeBots = {};
let activeSocket = null;

function safeLoad(bot, plugin, name, socket) {
    try {
        if (typeof plugin === 'function') bot.loadPlugin(plugin);
        else if (plugin && typeof plugin.plugin === 'function') bot.loadPlugin(plugin.plugin);
    } catch (err) {}
}

function startBotInstance(data, socket) {
    const { host, port, username, version } = data;

    if (activeBots[username]) {
        activeBots[username].isManualStop = true;
        activeBots[username].bot.quit();
        clearTimeout(activeBots[username].reconnectTimer);
    }

    socket.emit('log', `[${username}] Sunucuya bağlanılıyor: ${host}:${port}`);

    const bot = mineflayer.createBot({
        host: host,
        port: parseInt(port),
        username: username,
        version: version === "false" ? false : version
    });

    safeLoad(bot, pathfinder, 'pathfinder', socket);
    safeLoad(bot, autoEat, 'autoEat', socket);
    safeLoad(bot, armorManager, 'armorManager', socket);
    safeLoad(bot, collectBlock, 'collectBlock', socket);

    activeBots[username] = {
        bot: bot,
        config: data,
        isManualStop: false,
        reconnectTimer: null
    };

    bot.on('spawn', () => {
        socket.emit('log', `[${username}] Dünyaya giriş yapıldı.`);
        if (bot.autoEat) bot.autoEat.enable();
        activeBots[username].isManualStop = false;
        updateBotList(socket);
    });

    bot.on('kicked', (reason) => socket.emit('log', `[${username}] Atıldı: ${reason}`));
    bot.on('end', (reason) => {
        socket.emit('log', `[${username}] Bağlantı koptu: ${reason}`);
        const state = activeBots[username];
        if (state && !state.isManualStop && state.config) {
            state.reconnectTimer = setTimeout(() => startBotInstance(state.config, socket), 5000);
        } else {
            updateBotList(socket);
        }
    });
    bot.on('error', (err) => socket.emit('log', `[${username}] Hata: ${err.message}`));
    bot.on('inventoryUpdate', () => sendPlayerInventory(username, socket));
    bot.on('windowOpen', (window) => {
        let title = "Menü";
        try { title = JSON.parse(window.title).text || "Menü"; } catch(e) {}
        const items = window.slots.map(i => i ? { slot: i.slot, name: i.name, count: i.count } : null);
        socket.emit('mcGuiOpened', { username, title, items });
    });
    bot.on('message', (message) => socket.emit('chat', `[${username}] ${message.toAnsi()}`));
}

function updateBotList(socket) {
    const list = Object.keys(activeBots).map(name => ({
        username: name,
        host: activeBots[name].config.host
    }));
    socket.emit('botListUpdate', list);
}

function sendPlayerInventory(username, socket) {
    const state = activeBots[username];
    if (!state || !state.bot || !state.bot.inventory) return;
    const slots = state.bot.inventory.slots.map(item => item ? { slot: item.slot, name: item.name, count: item.count } : null);
    socket.emit('playerInventoryUpdate', { username, slots });
}

setInterval(() => {
    if (!activeSocket) return;
    for (const username in activeBots) {
        const state = activeBots[username];
        if (state && state.bot && state.bot.entity) {
            const bot = state.bot;
            const entitiesData = [];
            
            for (const id in bot.entities) {
                const entity = bot.entities[id];
                if (entity && entity !== bot.entity) {
                    const dx = entity.position.x - bot.entity.position.x;
                    const dz = entity.position.z - bot.entity.position.z;
                    if (Math.abs(dx) < 64 && Math.abs(dz) < 64) {
                        entitiesData.push({
                            id: id,
                            name: entity.username || entity.name || entity.type,
                            x: entity.position.x,
                            z: entity.position.z,
                            type: entity.type
                        });
                    }
                }
            }

            const players = bot.players ? Object.keys(bot.players).map(p => ({ username: p })) : [];

            activeSocket.emit('dataUpdate', {
                username: username,
                botPos: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
                health: bot.health,
                food: bot.food,
                entities: entitiesData,
                players: players
            });
        }
    }
}, 500);

io.on('connection', (socket) => {
    activeSocket = socket;
    updateBotList(socket);

    socket.on('startBot', (data) => { if (data.username) startBotInstance(data, socket); });
    socket.on('stopBot', (username) => {
        if (activeBots[username]) {
            activeBots[username].isManualStop = true;
            clearTimeout(activeBots[username].reconnectTimer);
            activeBots[username].bot.quit();
            delete activeBots[username];
            socket.emit('log', `[${username}] Durduruldu.`);
            updateBotList(socket);
        }
    });
    socket.on('sendChat', ({ username, message }) => {
        if (activeBots[username]) activeBots[username].bot.chat(message);
    });
    socket.on('clickMcItem', ({ username, slotId }) => {
        if (activeBots[username]?.bot?.currentWindow) activeBots[username].bot.clickWindow(slotId, 0, 0);
    });
    socket.on('quickMoveItem', ({ username, slotId }) => {
        if (activeBots[username]?.bot?.currentWindow) activeBots[username].bot.clickWindow(slotId, 0, 1);
    });
    socket.on('tossItem', ({ username, slotId }) => {
        const bot = activeBots[username]?.bot;
        if (bot?.inventory) {
            const item = bot.inventory.slots[slotId];
            if (item) bot.toss(item.type, null, item.count);
        }
    });
    socket.on('requestInventory', (username) => sendPlayerInventory(username, socket));
    socket.on('botControl', ({ username, action, state }) => {
        try { activeBots[username]?.bot?.setControlState(action, state); } catch (e) {}
    });
    socket.on('goToCoordinates', ({ username, x, y, z }) => {
        const bot = activeBots[username]?.bot;
        if (bot?.pathfinder) {
            bot.pathfinder.setMovements(new Movements(bot));
            bot.pathfinder.goto(new goals.GoalBlock(parseInt(x), parseInt(y), parseInt(z)));
            socket.emit('log', `[${username}] Yürünüyor: X:${x}, Y:${y}, Z:${z}`);
        }
    });
    socket.on('stopWalking', (username) => activeBots[username]?.bot?.pathfinder?.stop());
    socket.on('collectBlock', ({ username, blockName }) => {
        const bot = activeBots[username]?.bot;
        if (bot?.collectBlock) {
            const blockType = bot.registry.blocksByName[blockName];
            if (blockType) {
                const target = bot.findBlock({ matching: blockType.id, maxDistance: 32 });
                if (target) bot.collectBlock.collect(target);
            }
        }
    });
    socket.on('interactEntity', ({ username, entityId, action }) => {
        const bot = activeBots[username]?.bot;
        if (bot) {
            const ent = bot.entities[entityId];
            if (ent) {
                if (action === 'rightclick') bot.activateEntity(ent);
                else if (action === 'leftclick') bot.attack(ent);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Çalışıyor: ${PORT}`));
