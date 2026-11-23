// Bot: 3 dificultades (facil / normal / dificil)
const DIFICULTADES = {
    facil:   { speed: 140, umbral: -1, cd: Infinity, jitter: 0 },   // no busca triángulos, no ataca
    normal:  { speed: 200, umbral: 8,  cd: 2500,     jitter: 0.15 }, // triángulos con energía < 8
    dificil: { speed: 240, umbral: 15, cd: 1700,     jitter: 0.06 }  // triángulos con energía < 15
};
const BASES = { blue: { x: 400, y: 3600 }, red: { x: 3600, y: 3600 } };
const ALCANCE_ATAQUE = 380;

class BotController {
    cfgDe(d, room) {
        const k = String(d || (room && room.difficulty) || 'normal').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        return DIFICULTADES[k] || DIFICULTADES.normal;
    }

    nearestTriangle(bot, room) {
        let best = null, bestD = Infinity;
        for (const t of room.triangles) {
            if (!t.active) continue;
            const d = Math.hypot(t.x - bot.x, t.y - bot.y);
            if (d < bestD) { bestD = d; best = t; }
        }
        return best;
    }

    updateBotState(bot, room, dt, dificultad) {
        if (bot.isFrozen) return;

        // Drenar energía (la elimina el RoomManager al detectar isFrozen)
        bot.energy -= dt;
        if (bot.energy <= 0) {
            bot.energy = 0;
            bot.isFrozen = true;
            return;
        }

        const now = Date.now();
        if (bot.stunUntil && now < bot.stunUntil) return; // aturdido por una bola de nieve

        const cfg = this.cfgDe(dificultad, room);
        const enemigo = bot.team === 'blue' ? 'red' : 'blue';

        let target = null;
        if (bot.hasFlag) {
            target = BASES[bot.team];
        } else {
            if (bot.energy < cfg.umbral) target = this.nearestTriangle(bot, room);
            if (!target) target = room.flag[enemigo];
        }

        const dx = target.x - bot.x;
        const dy = target.y - bot.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 5) return;

        const slow = bot.slowUntil && now < bot.slowUntil ? 0.6 : 1;
        const speed = cfg.speed * (bot.hasFlag ? 0.85 : 1) * slow;
        const step = Math.min(speed * dt, dist);
        bot.x += (dx / dist) * step;
        bot.y += (dy / dist) * step;
        bot.facingLeft = dx < 0;
    }

    // Devuelve {dx, dy} si el bot lanza una bola de nieve ahora, o null
    getAttack(bot, room, now, dificultad) {
        const cfg = this.cfgDe(dificultad, room);
        if (!isFinite(cfg.cd) || bot.isFrozen || now < (bot.botNextAttack || 0) || now < (bot.stunUntil || 0)) return null;

        let best = null, bd = ALCANCE_ATAQUE;
        for (const p of room.players.values()) {
            if (p.team === bot.team || p.isFrozen || p.disconnected || p.taskOpen) continue;
            const d = Math.hypot(p.x - bot.x, p.y - bot.y);
            if (d < bd) { bd = d; best = p; }
        }
        if (!best) return null;

        bot.botNextAttack = now + cfg.cd;
        const ang = Math.atan2(best.y - bot.y, best.x - bot.x) + (Math.random() * 2 - 1) * cfg.jitter;
        return { dx: Math.cos(ang), dy: Math.sin(ang) };
    }
}

module.exports = BotController;
