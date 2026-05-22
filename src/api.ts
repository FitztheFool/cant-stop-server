import { saveAttempts, ScoreEntry } from '@kwizar/shared';
import { CantStopRoom } from './types';
import { isBot } from './game';

export function saveCantStopResults(
    room: CantStopRoom,
    winnerUserId: string | null,
    gameId: string,
): void {
    const vsBot = room.players.some(p => isBot(p.userId));

    const scores: ScoreEntry[] = room.players.map(p => {
        const isWinner = winnerUserId === p.userId;
        return {
            userId: p.userId,
            username: p.username,
            score: isWinner ? 1 : 0,
            placement: isWinner ? 1 : (p.abandon || p.afk ? null : (p.alive ? 2 : null)),
            abandon: p.abandon ?? false,
            afk: p.afk ?? false,
        };
    });

    saveAttempts('CANT_STOP', gameId, scores, vsBot);
}
