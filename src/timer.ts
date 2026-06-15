import type { Server } from 'socket.io';
import { rooms } from './rooms';

export const TURN_DURATION = 60;

export interface TimerSlot {
    remaining: number;
    interval?: ReturnType<typeof setInterval>;
}

export const timers: Record<string, TimerSlot> = {};

export const timerCallbacks: {
    onTimeout?: (code: string) => void;
} = {};

export function clearTimer(code: string): void {
    if (timers[code]?.interval) clearInterval(timers[code].interval);
    delete timers[code];
}

export function startTimer(io: Server, code: string): void {
    clearTimer(code);
    const room = rooms[code];
    if (room) room.turnStartedAt = Date.now();
    const dur = room?.turnDuration ?? TURN_DURATION;
    if (dur <= 0) return;                              // 0 = pas de limite (jamais AFK)
    timers[code] = { remaining: dur };

    timers[code].interval = setInterval(() => {
        const slot = timers[code];
        if (!slot) return;
        slot.remaining--;
        io.to(code).emit('cant_stop:timer', { remaining: slot.remaining });

        const room = rooms[code];
        if (!room) { clearTimer(code); return; }

        const p = room.players[room.currentPlayerIndex];
        if (slot.remaining === 30 && p && !p.userId.startsWith('bot-')) {
            io.to(code).emit('cant_stop:afkWarning', {
                userId: p.userId,
                username: p.username,
                secondsLeft: 30,
            });
        }

        if (slot.remaining > 0) return;

        clearTimer(code);
        timerCallbacks.onTimeout?.(code);
    }, 1000);
}
