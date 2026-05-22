"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
const dotenv_1 = __importDefault(require("dotenv"));
const shared_1 = require("@kwizar/shared");
const game_1 = require("./game");
const rooms_1 = require("./rooms");
const timer_1 = require("./timer");
const bot_1 = require("./bot");
const api_1 = require("./api");
const state_1 = require("./state");
dotenv_1.default.config();
const app = (0, express_1.default)();
app.get('/health', (_req, res) => { res.set('Access-Control-Allow-Origin', '*'); res.status(200).send('ok'); });
const server = http_1.default.createServer(app);
const io = new socket_io_1.Server(server, { cors: shared_1.corsConfig, maxHttpBufferSize: 1e5 });
(0, shared_1.setupSocketAuth)(io, new TextEncoder().encode((process.env.SOCKET_USER_SECRET ?? process.env.INTERNAL_API_KEY)));
const lobbySocket = (0, shared_1.connectToLobby)('cant-stop-server', 'cant_stop');
// ── Configure from lobby ──────────────────────────────────────────────────────
lobbySocket.on('cant_stop:configure', ({ lobbyId: code, players, options, fresh }, ack) => {
    if (!code) {
        if (ack)
            ack();
        return;
    }
    if (rooms_1.rooms[code] && !fresh && rooms_1.rooms[code].phase !== 'ended') {
        // In-progress room — keep state.
        if (ack)
            ack();
        return;
    }
    const columnsToWin = options?.columnsToWin ?? game_1.DEFAULT_COLUMNS_TO_WIN;
    const room = (0, rooms_1.createRoom)(code, players, columnsToWin);
    console.log(`[CantStop] Room created: ${code} (${players.length} players, columnsToWin=${columnsToWin})`);
    rollAndStart(code);
    if (ack)
        ack();
});
// ── Helpers ────────────────────────────────────────────────────────────────────
function rollAndStart(code) {
    const room = rooms_1.rooms[code];
    if (!room)
        return;
    const player = room.players[room.currentPlayerIndex];
    if (!player)
        return;
    room.dice = (0, game_1.rollDice)();
    room.splits = (0, game_1.computeSplits)(room.dice, room, player);
    if (!(0, game_1.hasLegalSplit)(room, player)) {
        handleBust(code);
        return;
    }
    room.phase = 'rolling';
    (0, state_1.emitState)(io, room);
    (0, timer_1.startTimer)(io, code);
    scheduleBotTurnIfNeeded(code);
}
function handleBust(code) {
    const room = rooms_1.rooms[code];
    if (!room)
        return;
    const player = room.players[room.currentPlayerIndex];
    if (!player)
        return;
    room.activeMarkers = {};
    room.phase = 'busted';
    (0, state_1.emitState)(io, room);
    io.to(code).emit('cant_stop:busted', { userId: player.userId, username: player.username });
    setTimeout(() => {
        const r = rooms_1.rooms[code];
        if (!r || r.phase !== 'busted')
            return;
        (0, game_1.nextTurn)(r);
        rollAndStart(code);
    }, 1500);
}
function endGame(code, winnerUserId) {
    const room = rooms_1.rooms[code];
    if (!room)
        return;
    room.phase = 'ended';
    room.winnerUserId = winnerUserId;
    (0, timer_1.clearTimer)(code);
    (0, state_1.emitState)(io, room);
    try {
        (0, api_1.saveCantStopResults)(room, winnerUserId, room.currentGameId);
    }
    catch (e) {
        console.error('[CantStop] saveResults failed', e);
    }
    io.to(code).emit('cant_stop:ended', { winnerUserId });
}
function aliveCount(room) {
    return room.players.filter(p => p.alive).length;
}
// ── Bot turn ──────────────────────────────────────────────────────────────────
function scheduleBotTurnIfNeeded(code) {
    const room = rooms_1.rooms[code];
    if (!room)
        return;
    if (room.phase !== 'rolling' && room.phase !== 'choosing')
        return;
    const p = room.players[room.currentPlayerIndex];
    if (!p?.alive || !(0, game_1.isBot)(p.userId))
        return;
    (0, timer_1.clearTimer)(code);
    setTimeout(() => doBotAction(code), 1000);
}
function doBotAction(code) {
    const room = rooms_1.rooms[code];
    if (!room)
        return;
    const player = room.players[room.currentPlayerIndex];
    if (!player?.alive || !(0, game_1.isBot)(player.userId))
        return;
    if (room.phase === 'rolling') {
        const idx = (0, bot_1.botPickSplit)(room);
        applyPickSplit(code, idx);
        return;
    }
    if (room.phase === 'choosing') {
        if ((0, bot_1.botShouldStop)(room, player)) {
            doStop(code);
        }
        else {
            doRoll(code);
        }
    }
}
// ── Actions ───────────────────────────────────────────────────────────────────
function applyPickSplit(code, splitIndex) {
    const room = rooms_1.rooms[code];
    if (!room || room.phase !== 'rolling')
        return;
    const player = room.players[room.currentPlayerIndex];
    if (!player?.alive)
        return;
    const split = room.splits[splitIndex];
    if (!split || !split.legal) {
        // Should not happen, but bust if attempted.
        handleBust(code);
        return;
    }
    const { claimedNow } = (0, game_1.applySplit)(split, room, player);
    if (claimedNow.length > 0) {
        for (const col of claimedNow) {
            io.to(code).emit('cant_stop:columnClaimed', { userId: player.userId, username: player.username, column: col });
        }
        if ((0, game_1.checkVictory)(room, player)) {
            endGame(code, player.userId);
            return;
        }
    }
    room.phase = 'choosing';
    (0, state_1.emitState)(io, room);
    scheduleBotTurnIfNeeded(code);
}
function doRoll(code) {
    const room = rooms_1.rooms[code];
    if (!room || room.phase !== 'choosing')
        return;
    const player = room.players[room.currentPlayerIndex];
    if (!player?.alive)
        return;
    room.dice = (0, game_1.rollDice)();
    room.splits = (0, game_1.computeSplits)(room.dice, room, player);
    if (!(0, game_1.hasLegalSplit)(room, player)) {
        handleBust(code);
        return;
    }
    room.phase = 'rolling';
    (0, state_1.emitState)(io, room);
    (0, timer_1.startTimer)(io, code);
    scheduleBotTurnIfNeeded(code);
}
function doStop(code) {
    const room = rooms_1.rooms[code];
    if (!room || room.phase !== 'choosing')
        return;
    const player = room.players[room.currentPlayerIndex];
    if (!player?.alive)
        return;
    (0, game_1.bankMarkers)(room, player);
    if ((0, game_1.checkVictory)(room, player)) {
        endGame(code, player.userId);
        return;
    }
    (0, game_1.nextTurn)(room);
    rollAndStart(code);
}
// ── Inactivity ────────────────────────────────────────────────────────────────
timer_1.timerCallbacks.onTimeout = (code) => {
    const room = rooms_1.rooms[code];
    if (!room)
        return;
    const player = room.players[room.currentPlayerIndex];
    if (!player)
        return;
    if (!(0, game_1.isBot)(player.userId)) {
        // Mark player as AFK, eliminate.
        player.alive = false;
        player.afk = true;
        io.to(code).emit('cant_stop:playerKicked', { userId: player.userId, username: player.username, reason: 'inactivity' });
    }
    if (aliveCount(room) <= 1) {
        const winner = room.players.find(p => p.alive) ?? null;
        endGame(code, winner?.userId ?? null);
        return;
    }
    room.activeMarkers = {};
    (0, game_1.nextTurn)(room);
    rollAndStart(code);
};
// ── Socket events ─────────────────────────────────────────────────────────────
io.on('connection', socket => {
    socket.on('cant_stop:join', ({ lobbyId: code }) => {
        const userId = socket.data?.userId;
        const room = rooms_1.rooms[code];
        if (!room) {
            socket.emit('notFound');
            return;
        }
        socket.data.lobbyId = code;
        socket.join(code);
        if (userId) {
            const player = room.players.find(p => p.userId === userId);
            if (player) {
                room.socketIds.set(userId, socket.id);
                const dt = room.disconnectTimers.get(userId);
                if (dt) {
                    clearTimeout(dt);
                    room.disconnectTimers.delete(userId);
                }
            }
        }
        (0, state_1.emitState)(io, room);
    });
    socket.on('cant_stop:pickSplit', ({ lobbyId: code, splitIndex }) => {
        const userId = socket.data?.userId;
        const room = rooms_1.rooms[code];
        if (!room)
            return;
        const player = room.players[room.currentPlayerIndex];
        if (!player || player.userId !== userId)
            return;
        applyPickSplit(code, splitIndex);
    });
    socket.on('cant_stop:roll', ({ lobbyId: code }) => {
        const userId = socket.data?.userId;
        const room = rooms_1.rooms[code];
        if (!room)
            return;
        const player = room.players[room.currentPlayerIndex];
        if (!player || player.userId !== userId)
            return;
        doRoll(code);
    });
    socket.on('cant_stop:stop', ({ lobbyId: code }) => {
        const userId = socket.data?.userId;
        const room = rooms_1.rooms[code];
        if (!room)
            return;
        const player = room.players[room.currentPlayerIndex];
        if (!player || player.userId !== userId)
            return;
        doStop(code);
    });
    socket.on('cant_stop:surrender', ({ lobbyId: code }) => {
        const userId = socket.data?.userId;
        if (!userId)
            return;
        const room = rooms_1.rooms[code];
        if (!room)
            return;
        const player = room.players.find(p => p.userId === userId);
        if (!player || !player.alive)
            return;
        player.alive = false;
        player.abandon = true;
        io.to(code).emit('cant_stop:playerKicked', { userId: player.userId, username: player.username, reason: 'surrender' });
        if (aliveCount(room) <= 1) {
            const winner = room.players.find(p => p.alive) ?? null;
            endGame(code, winner?.userId ?? null);
            return;
        }
        if (room.players[room.currentPlayerIndex]?.userId === userId) {
            room.activeMarkers = {};
            (0, game_1.nextTurn)(room);
            rollAndStart(code);
        }
        else {
            (0, state_1.emitState)(io, room);
        }
    });
    socket.on('disconnect', () => {
        const userId = socket.data?.userId;
        const code = socket.data?.lobbyId;
        if (!userId || !code)
            return;
        const room = rooms_1.rooms[code];
        if (!room)
            return;
        const player = room.players.find(p => p.userId === userId);
        if (!player)
            return;
        room.socketIds.delete(userId);
        // Grace period for reconnect — 30s, then mark AFK.
        const t = setTimeout(() => {
            const r = rooms_1.rooms[code];
            if (!r)
                return;
            const p2 = r.players.find(pp => pp.userId === userId);
            if (!p2 || !p2.alive)
                return;
            p2.alive = false;
            p2.afk = true;
            io.to(code).emit('cant_stop:playerKicked', { userId, username: p2.username, reason: 'disconnect' });
            if (aliveCount(r) <= 1) {
                const winner = r.players.find(pp => pp.alive) ?? null;
                endGame(code, winner?.userId ?? null);
                return;
            }
            if (r.players[r.currentPlayerIndex]?.userId === userId) {
                r.activeMarkers = {};
                (0, game_1.nextTurn)(r);
                rollAndStart(code);
            }
            else {
                (0, state_1.emitState)(io, r);
            }
        }, 30000);
        room.disconnectTimers.set(userId, t);
    });
});
const PORT = process.env.PORT ?? 10013;
server.listen(PORT, () => {
    console.log(`[CantStop] listening on :${PORT}`);
});
