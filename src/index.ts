import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { setupSocketAuth, corsConfig, connectToLobby } from '@kwizar/shared';

import {
    rollDice, computeSplits, applySplit, bankMarkers, hasLegalSplit,
    nextTurn, checkVictory, isBot, DEFAULT_COLUMNS_TO_WIN, MAX_ACTIVE_MARKERS,
} from './game';
import { rooms, createRoom } from './rooms';
import { startTimer, clearTimer, timerCallbacks } from './timer';
import { botPickSplit, botShouldStop } from './bot';
import { saveCantStopResults } from './api';
import { emitState } from './state';
import { CantStopRoom } from './types';
import { pushLog } from '@kwizar/shared';

dotenv.config();

const app = express();
app.get('/health', (_req, res) => { res.set('Access-Control-Allow-Origin', '*'); res.status(200).send('ok'); });

const server = http.createServer(app);
const io = new Server(server, { cors: corsConfig, maxHttpBufferSize: 1e5 });

setupSocketAuth(io, new TextEncoder().encode((process.env.SOCKET_USER_SECRET ?? process.env.INTERNAL_API_KEY)!));

const lobbySocket = connectToLobby('cant-stop-server', 'cant_stop');

// ── Configure from lobby ──────────────────────────────────────────────────────

lobbySocket.on('cant_stop:configure', ({ lobbyId: code, players, options, fresh, turnSeconds }: {
    lobbyId: string;
    players: any[];
    options?: { columnsToWin?: number };
    fresh?: boolean;
    turnSeconds?: number | null;
}, ack?: () => void) => {
    if (!code) { if (ack) ack(); return; }
    if (rooms[code] && !fresh && rooms[code].phase !== 'ended') {
        // In-progress room — keep state.
        if (ack) ack();
        return;
    }
    const columnsToWin = options?.columnsToWin ?? DEFAULT_COLUMNS_TO_WIN;
    const room = createRoom(code, players, columnsToWin);
    if (turnSeconds != null) room.turnDuration = turnSeconds;
    console.log(`[CANT_STOP] Room created: ${code} (${players.length} players, columnsToWin=${columnsToWin})`);
    rollAndStart(code);
    if (ack) ack();
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function rollAndStart(code: string): void {
    const room = rooms[code];
    if (!room) return;
    const player = room.players[room.currentPlayerIndex];
    if (!player) return;
    room.dice = rollDice();
    room.splits = computeSplits(room.dice, room, player);
    pushLog(room, 'move', `${player.username} lance les dés : ${room.dice.join(' ')}`);
    if (!hasLegalSplit(room, player)) {
        handleBust(code);
        return;
    }
    room.phase = 'rolling';
    emitState(io, room);
    startTimer(io, code);
    scheduleBotTurnIfNeeded(code);
}

function handleBust(code: string): void {
    const room = rooms[code];
    if (!room) return;
    const player = room.players[room.currentPlayerIndex];
    if (!player) return;
    room.activeMarkers = {};
    room.phase = 'busted';
    pushLog(room, 'attack', `${player.username} se plante (bust) — progression du tour perdue`);
    emitState(io, room);
    io.to(code).emit('cant_stop:busted', { userId: player.userId, username: player.username });
    setTimeout(() => {
        const r = rooms[code];
        if (!r || r.phase !== 'busted') return;
        nextTurn(r);
        rollAndStart(code);
    }, 1500);
}

function endGame(code: string, winnerUserId: string | null): void {
    const room = rooms[code];
    if (!room) return;
    room.phase = 'ended';
    room.winnerUserId = winnerUserId;
    const w = room.players.find(p => p.userId === winnerUserId);
    if (w) pushLog(room, 'coup', `${w.username} remporte la partie !`);
    clearTimer(code);
    emitState(io, room);
    try {
        saveCantStopResults(io, code, room, winnerUserId, room.currentGameId);
    } catch (e) {
        console.error('[CANT_STOP] saveResults failed', e);
    }
    io.to(code).emit('cant_stop:ended', { winnerUserId });
}

function aliveCount(room: CantStopRoom): number {
    return room.players.filter(p => p.alive).length;
}

function humansAliveCount(room: CantStopRoom): number {
    return room.players.filter(p => p.alive && !isBot(p.userId)).length;
}

/** End the game if the lineup no longer makes sense for a human:
 *  - no human is still in (would force them to watch a bot-only match)
 *  - one human left with zero bots (no opponent)
 *  In those cases, pick a winner from the alive players based on claimed
 *  columns (fallback: first alive). Returns true if the game was ended. */
function endIfNoMeaningfulMatch(code: string): boolean {
    const room = rooms[code];
    if (!room) return false;
    const alive = room.players.filter(p => p.alive);
    const humans = alive.filter(p => !isBot(p.userId));
    const bots = alive.filter(p => isBot(p.userId));
    const noContest = humans.length === 0 || (humans.length === 1 && bots.length === 0);
    if (!noContest) return false;
    const leader = [...alive].sort((a, b) => b.claimed.length - a.claimed.length)[0];
    pushLog(room, 'system', 'Fin de partie — plus assez de joueurs en lice');
    endGame(code, leader?.userId ?? null);
    return true;
}

// ── Bot turn ──────────────────────────────────────────────────────────────────

function scheduleBotTurnIfNeeded(code: string): void {
    const room = rooms[code];
    if (!room) return;
    if (room.phase !== 'rolling' && room.phase !== 'choosing') return;
    const p = room.players[room.currentPlayerIndex];
    if (!p?.alive || !isBot(p.userId)) return;
    clearTimer(code);
    setTimeout(() => doBotAction(code), 1000);
}

function doBotAction(code: string): void {
    const room = rooms[code];
    if (!room) return;
    const player = room.players[room.currentPlayerIndex];
    if (!player?.alive || !isBot(player.userId)) return;

    if (room.phase === 'rolling') {
        const idx = botPickSplit(room);
        applyPickSplit(code, idx);
        return;
    }
    if (room.phase === 'choosing') {
        if (botShouldStop(room, player)) {
            doStop(code);
        } else {
            doRoll(code);
        }
    }
}

// ── Actions ───────────────────────────────────────────────────────────────────

function applyPickSplit(code: string, splitIndex: number): void {
    const room = rooms[code];
    if (!room || room.phase !== 'rolling') return;
    const player = room.players[room.currentPlayerIndex];
    if (!player?.alive) return;
    const split = room.splits[splitIndex];
    if (!split || !split.legal) {
        // Should not happen, but bust if attempted.
        handleBust(code);
        return;
    }
    const { claimedNow } = applySplit(split, room, player);
    pushLog(room, 'move', `${player.username} avance ses pions`);
    if (claimedNow.length > 0) {
        for (const col of claimedNow) {
            pushLog(room, 'coup', `${player.username} verrouille la colonne ${col} !`);
            io.to(code).emit('cant_stop:columnClaimed', { userId: player.userId, username: player.username, column: col });
        }
        if (checkVictory(room, player)) {
            endGame(code, player.userId);
            return;
        }
    }
    room.phase = 'choosing';
    emitState(io, room);
    scheduleBotTurnIfNeeded(code);
}

function doRoll(code: string): void {
    const room = rooms[code];
    if (!room || room.phase !== 'choosing') return;
    const player = room.players[room.currentPlayerIndex];
    if (!player?.alive) return;
    room.dice = rollDice();
    room.splits = computeSplits(room.dice, room, player);
    pushLog(room, 'move', `${player.username} lance les dés : ${room.dice.join(' ')}`);
    if (!hasLegalSplit(room, player)) {
        handleBust(code);
        return;
    }
    room.phase = 'rolling';
    emitState(io, room);
    startTimer(io, code);
    scheduleBotTurnIfNeeded(code);
}

function doStop(code: string): void {
    const room = rooms[code];
    if (!room || room.phase !== 'choosing') return;
    const player = room.players[room.currentPlayerIndex];
    if (!player?.alive) return;
    bankMarkers(room, player);
    pushLog(room, 'defend', `${player.username} s'arrête et sécurise sa progression`);
    if (checkVictory(room, player)) {
        endGame(code, player.userId);
        return;
    }
    nextTurn(room);
    rollAndStart(code);
}

// ── Inactivity ────────────────────────────────────────────────────────────────

timerCallbacks.onTimeout = (code: string) => {
    const room = rooms[code];
    if (!room) return;
    const player = room.players[room.currentPlayerIndex];
    if (!player) return;
    if (!isBot(player.userId)) {
        // Mark player as AFK, eliminate.
        player.alive = false;
        player.afk = true;
        pushLog(room, 'system', `${player.username} exclu (inactivité)`);
        io.to(code).emit('cant_stop:playerKicked', { userId: player.userId, username: player.username, reason: 'inactivity' });
    }
    if (aliveCount(room) <= 1) {
        const winner = room.players.find(p => p.alive) ?? null;
        endGame(code, winner?.userId ?? null);
        return;
    }
    if (endIfNoMeaningfulMatch(code)) return;
    room.activeMarkers = {};
    nextTurn(room);
    rollAndStart(code);
};

// ── Socket events ─────────────────────────────────────────────────────────────

io.on('connection', socket => {
    socket.on('cant_stop:join', ({ lobbyId: code }: { lobbyId: string }) => {
        const userId = socket.data?.userId as string | undefined;
        const room = rooms[code];
        if (!room) { socket.emit('notFound'); return; }
        socket.data.lobbyId = code;
        socket.join(code);

        if (userId) {
            const player = room.players.find(p => p.userId === userId);
            if (player) {
                room.socketIds.set(userId, socket.id);
                const dt = room.disconnectTimers.get(userId);
                if (dt) { clearTimeout(dt); room.disconnectTimers.delete(userId); }
            }
        }
        emitState(io, room);
    });

    socket.on('cant_stop:pickSplit', ({ lobbyId: code, splitIndex }: { lobbyId: string; splitIndex: number }) => {
        const userId = socket.data?.userId as string | undefined;
        const room = rooms[code];
        if (!room) return;
        const player = room.players[room.currentPlayerIndex];
        if (!player || player.userId !== userId) return;
        applyPickSplit(code, splitIndex);
    });

    socket.on('cant_stop:roll', ({ lobbyId: code }: { lobbyId: string }) => {
        const userId = socket.data?.userId as string | undefined;
        const room = rooms[code];
        if (!room) return;
        const player = room.players[room.currentPlayerIndex];
        if (!player || player.userId !== userId) return;
        doRoll(code);
    });

    socket.on('cant_stop:stop', ({ lobbyId: code }: { lobbyId: string }) => {
        const userId = socket.data?.userId as string | undefined;
        const room = rooms[code];
        if (!room) return;
        const player = room.players[room.currentPlayerIndex];
        if (!player || player.userId !== userId) return;
        doStop(code);
    });

    socket.on('cant_stop:surrender', ({ lobbyId: code }: { lobbyId: string }) => {
        const userId = socket.data?.userId as string | undefined;
        if (!userId) return;
        const room = rooms[code];
        if (!room) return;
        const player = room.players.find(p => p.userId === userId);
        if (!player || !player.alive) return;
        player.alive = false;
        player.abandon = true;
        pushLog(room, 'system', `${player.username} abandonne la partie`);
        io.to(code).emit('cant_stop:playerKicked', { userId: player.userId, username: player.username, reason: 'surrender' });
        if (aliveCount(room) <= 1) {
            const winner = room.players.find(p => p.alive) ?? null;
            endGame(code, winner?.userId ?? null);
            return;
        }
        if (endIfNoMeaningfulMatch(code)) return;
        if (room.players[room.currentPlayerIndex]?.userId === userId) {
            room.activeMarkers = {};
            nextTurn(room);
            rollAndStart(code);
        } else {
            emitState(io, room);
        }
    });

    socket.on('disconnect', () => {
        const userId = socket.data?.userId as string | undefined;
        const code = socket.data?.lobbyId as string | undefined;
        if (!userId || !code) return;
        const room = rooms[code];
        if (!room) return;
        const player = room.players.find(p => p.userId === userId);
        if (!player) return;
        room.socketIds.delete(userId);
        // Grace period for reconnect — 30s, then mark AFK.
        const t = setTimeout(() => {
            const r = rooms[code];
            if (!r) return;
            const p2 = r.players.find(pp => pp.userId === userId);
            if (!p2 || !p2.alive) return;
            p2.alive = false;
            p2.afk = true;
            io.to(code).emit('cant_stop:playerKicked', { userId, username: p2.username, reason: 'disconnect' });
            if (aliveCount(r) <= 1) {
                const winner = r.players.find(pp => pp.alive) ?? null;
                endGame(code, winner?.userId ?? null);
                return;
            }
            if (endIfNoMeaningfulMatch(code)) return;
            if (r.players[r.currentPlayerIndex]?.userId === userId) {
                r.activeMarkers = {};
                nextTurn(r);
                rollAndStart(code);
            } else {
                emitState(io, r);
            }
        }, 30_000);
        room.disconnectTimers.set(userId, t);
    });
});

const PORT = process.env.PORT ?? 10013;
server.listen(PORT, () => {
    console.log(`[CANT_STOP] listening on port ${PORT}`);
});
