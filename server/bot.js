// Bot: 3 dificultades (facil / normal / dificil)
const DIFICULTADES = {
    facil:   { speed: 140, umbral: -1 }, // nunca busca triángulos
    normal:  { speed: 200, umbral: 8 },  // busca triángulos con energía < 8
    dificil: { speed: 240, umbral: 15 }  // busca triángulos con energía < 15
};
const BASES = { blue: { x: 400, y: 3600 }, red: { x: 3600, y: 3600 } };

class BotController {
    normalizar(d) {
        return String(d || 'normal').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
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

        const cfg = DIFICULTADES[this.normalizar(dificultad || room.difficulty)] || DIFICULTADES.normal;
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

        const speed = cfg.speed * (bot.hasFlag ? 0.8 : 1);
        const step = Math.min(speed * dt, dist);
        bot.x += (dx / dist) * step;
        bot.y += (dy / dist) * step;
        bot.facingLeft = dx < 0;
    }
}

module.exports = BotController;
