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

dotenv.config();

const app = express();
app.get('/health', (_req, res) => { res.set('Access-Control-Allow-Origin', '*'); res.status(200).send('ok'); });

const server = http.createServer(app);
const io = new Server(server, { cors: corsConfig, maxHttpBufferSize: 1e5 });

setupSocketAuth(io, new TextEncoder().encode((process.env.SOCKET_USER_SECRET ?? process.env.INTERNAL_API_KEY)!));

const lobbySocket = connectToLobby('cant-stop-server', 'cant_stop');

// ── Configure from lobby ──────────────────────────────────────────────────────

lobbySocket.on('cant_stop:configure', ({ lobbyId: code, players, options, fresh }: {
    lobbyId: string;
    players: any[];
    options?: { columnsToWin?: number };
    fresh?: boolean;
}, ack?: () => void) => {
    if (!code) { if (ack) ack(); return; }
    if (rooms[code] && !fresh && rooms[code].phase !== 'ended') {
        // In-progress room — keep state.
        if (ack) ack();
        return;
    }
    const columnsToWin = options?.columnsToWin ?? DEFAULT_COLUMNS_TO_WIN;
    const room = createRoom(code, players, columnsToWin);
    console.log(`[CantStop] Room created: ${code} (${players.length} players, columnsToWin=${columnsToWin})`);
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
    clearTimer(code);
    emitState(io, room);
    try {
        saveCantStopResults(room, winnerUserId, room.currentGameId);
    } catch (e) {
        console.error('[CantStop] saveResults failed', e);
    }
    io.to(code).emit('cant_stop:ended', { winnerUserId });
}

function aliveCount(room: CantStopRoom): number {
    return room.players.filter(p => p.alive).length;
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
    if (claimedNow.length > 0) {
        for (const col of claimedNow) {
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
        io.to(code).emit('cant_stop:playerKicked', { userId: player.userId, username: player.username, reason: 'inactivity' });
    }
    if (aliveCount(room) <= 1) {
        const winner = room.players.find(p => p.alive) ?? null;
        endGame(code, winner?.userId ?? null);
        return;
    }
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
        io.to(code).emit('cant_stop:playerKicked', { userId: player.userId, username: player.username, reason: 'surrender' });
        if (aliveCount(room) <= 1) {
            const winner = room.players.find(p => p.alive) ?? null;
            endGame(code, winner?.userId ?? null);
            return;
        }
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
    console.log(`[CantStop] listening on :${PORT}`);
});
