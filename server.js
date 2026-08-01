const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const autoEat = require('mineflayer-auto-eat');
const armorManager = require('mineflayer-armor-manager');
const collectBlock = require('mineflayer-collectblock').plugin; // <-- Düzeltilen kısım

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const activeBots = {};
let activeSocket = null;

function startBotInstance(data, socket) {
    const { host, port, username, version } = data;

    if (activeBots[username]) {
        activeBots[username].isManualStop = true;
        activeBots[username].bot.quit();
        clearTimeout(activeBots[username].reconnectTimer);
    }

    socket.emit('log', `[${username}] Sunucuya bağlanılıyor... (${host}:${port})`);

    const bot = mineflayer.createBot({
        host: host,
        port: parseInt(port),
        username: username,
        version: version
    });

    // Eklentiler güvenli bir şekilde yükleniyor
    bot.loadPlugin(pathfinder);
    bot.loadPlugin(autoEat);
    bot.loadPlugin(armorManager);
    bot.loadPlugin(collectBlock);

    activeBots[username] = {
        bot: bot,
        config: data,
        isManualStop: false,
        reconnectTimer: null
    };

    bot.on('spawn', () => {
        socket.emit('log', `[${username}] Dünyaya başarıyla giriş yaptı!`);
        bot.autoEat.enable();
        activeBots[username].isManualStop = false;
        updateBotList(socket);
    });

    bot.on('kicked', (reason) => {
        socket.emit('log', `[${username}] Sunucudan atıldı: ${reason}`);
    });

    bot.on('end', (reason) => {
        socket.emit('log', `[${username}] Bağlantı koptu: ${reason}`);
        const botState = activeBots[username];
        
        if (botState && !botState.isManualStop && botState.config) {
            socket.emit('log', `[${username}] 5 saniye içinde otomatik yeniden bağlanılıyor...`);
            botState.reconnectTimer = setTimeout(() => {
                startBotInstance(botState.config, socket);
            }, 5000);
        } else {
            updateBotList(socket);
        }
    });

    bot.on('error', (err) => {
        socket.emit('log', `[${username}] Hata: ${err.message}`);
    });

    bot.on('inventoryUpdate', () => {
        sendPlayerInventory(username, socket);
    });

    bot.on('windowOpen', (window) => {
        let title = "Menü";
        try { title = JSON.parse(window.title).text || "Menü"; } catch(e) {}
        const items = window.slots.map(i => i ? { slot: i.slot, name: i.name, count: i.count } : null);
        socket.emit('mcGuiOpened', { username, title, items });
    });

    bot.on('message', (message) => {
        socket.emit('chat', `[${username}] ${message.toAnsi()}`);
    });
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
    
    const slots = state.bot.inventory.slots.map(item => {
        if (!item) return null;
        return { slot: item.slot, name: item.name, count: item.count };
    });
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

            activeSocket.emit('mapUpdate', {
                username: username,
                botPos: { x: bot.entity.position.x, z: bot.entity.position.z },
                entities: entitiesData
            });
        }
    }
}, 1000);

io.on('connection', (socket) => {
    activeSocket = socket;
    updateBotList(socket);

    socket.on('startBot', (data) => {
        if (!data.username) return;
        startBotInstance(data, socket);
    });

    socket.on('stopBot', (username) => {
        if (activeBots[username]) {
            activeBots[username].isManualStop = true;
            clearTimeout(activeBots[username].reconnectTimer);
            activeBots[username].bot.quit();
            delete activeBots[username];
            socket.emit('log', `[${username}] Bot manuel olarak durduruldu.`);
            updateBotList(socket);
        }
    });

    socket.on('sendChat', ({ username, message }) => {
        const state = activeBots[username];
        if (state && state.bot) {
            state.bot.chat(message);
        }
    });

    socket.on('clickMcItem', ({ username, slotId }) => {
        const state = activeBots[username];
        if (state && state.bot && state.bot.currentWindow) {
            state.bot.clickWindow(slotId, 0, 0);
        }
    });

    socket.on('quickMoveItem', ({ username, slotId }) => {
        const state = activeBots[username];
        if (state && state.bot && state.bot.currentWindow) {
            state.bot.clickWindow(slotId, 0, 1);
        }
    });

    socket.on('tossItem', ({ username, slotId }) => {
        const state = activeBots[username];
        if (state && state.bot && state.bot.inventory) {
            const item = state.bot.inventory.slots[slotId];
            if (item) {
                state.bot.toss(item.type, null, item.count);
            }
        }
    });

    socket.on('requestInventory', (username) => {
        sendPlayerInventory(username, socket);
    });

    socket.on('botControl', ({ username, action, state: flag }) => {
        const state = activeBots[username];
        if (state && state.bot) {
            try {
                state.bot.setControlState(action, flag);
            } catch (err) {}
        }
    });

    socket.on('goToCoordinates', ({ username, x, y, z }) => {
        const state = activeBots[username];
        if (state && state.bot && state.bot.pathfinder) {
            const bot = state.bot;
            const defaultMove = new Movements(bot);
            bot.pathfinder.setMovements(defaultMove);
            const goal = new goals.GoalBlock(parseInt(x), parseInt(y), parseInt(z));
            socket.emit('log', `[${username}] Hedefe yürünüyor: X:${x}, Y:${y}, Z:${z}`);
            bot.pathfinder.goto(goal, (err) => {
                if (!err) socket.emit('log', `[${username}] Hedefe varıldı!`);
            });
        }
    });

    socket.on('followPlayer', ({ username, playerName }) => {
        const state = activeBots[username];
        if (state && state.bot && state.bot.pathfinder) {
            const bot = state.bot;
            const target = bot.players[playerName] ? bot.players[playerName].entity : null;
            if (!target) return socket.emit('log', `[${username}] Oyuncu bulunamadı: ${playerName}`);
            const movements = new Movements(bot);
            bot.pathfinder.setMovements(movements);
            const goal = new goals.GoalFollow(target, 1);
            bot.pathfinder.goto(goal);
            socket.emit('log', `[${username}] ${playerName} takip ediliyor.`);
        }
    });

    socket.on('stopWalking', (username) => {
        const state = activeBots[username];
        if (state && state.bot && state.bot.pathfinder) {
            state.bot.pathfinder.stop();
            socket.emit('log', `[${username}] Yürüyüş durduruldu.`);
        }
    });

    socket.on('collectBlock', ({ username, blockName }) => {
        const state = activeBots[username];
        if (state && state.bot && state.bot.collectBlock) {
            const bot = state.bot;
            const blockType = bot.registry.blocksByName[blockName];
            if (!blockType) return socket.emit('log', `[${username}] Blok bulunamadı: ${blockName}`);
            const targetBlock = bot.findBlock({ matching: blockType.id, maxDistance: 32 });
            if (!targetBlock) return socket.emit('log', `[${username}] Yakınlarda ${blockName} yok.`);
            bot.collectBlock.collect(targetBlock, (err) => {
                if (!err) socket.emit('log', `[${username}] ${blockName} kazılıp toplandı!`);
            });
        }
    });

    socket.on('interactEntity', ({ username, entityId, action }) => {
        const state = activeBots[username];
        if (state && state.bot) {
            const entity = state.bot.entities[entityId];
            if (entity) {
                if (action === 'rightclick') state.bot.activateEntity(entity);
                else if (action === 'leftclick') state.bot.attack(entity);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Sunucu aktif! Port: ${PORT}`);
});
