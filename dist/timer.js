"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.timerCallbacks = exports.timers = exports.TURN_DURATION = void 0;
exports.clearTimer = clearTimer;
exports.startTimer = startTimer;
const rooms_1 = require("./rooms");
exports.TURN_DURATION = 60;
exports.timers = {};
exports.timerCallbacks = {};
function clearTimer(code) {
    if (exports.timers[code]?.interval)
        clearInterval(exports.timers[code].interval);
    delete exports.timers[code];
}
function startTimer(io, code) {
    clearTimer(code);
    exports.timers[code] = { remaining: exports.TURN_DURATION };
    const room = rooms_1.rooms[code];
    if (room)
        room.turnStartedAt = Date.now();
    exports.timers[code].interval = setInterval(() => {
        const slot = exports.timers[code];
        if (!slot)
            return;
        slot.remaining--;
        io.to(code).emit('cant_stop:timer', { remaining: slot.remaining });
        const room = rooms_1.rooms[code];
        if (!room) {
            clearTimer(code);
            return;
        }
        const p = room.players[room.currentPlayerIndex];
        if (slot.remaining === 30 && p && !p.userId.startsWith('bot-')) {
            io.to(code).emit('cant_stop:afkWarning', {
                userId: p.userId,
                username: p.username,
                secondsLeft: 30,
            });
        }
        if (slot.remaining > 0)
            return;
        clearTimer(code);
        exports.timerCallbacks.onTimeout?.(code);
    }, 1000);
}
