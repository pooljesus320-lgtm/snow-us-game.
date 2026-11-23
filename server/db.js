// Base de datos de partidas (SQLite integrado en Node 22.5+, sin dependencias extra).
//
// PRIVACIDAD: aquí solo se guardan estadísticas ANÓNIMAS del juego (equipo, capturas,
// golpes, power-ups, tiempos...). NO se guardan apodos, IPs, tokens, ids de socket ni,
// por supuesto, las respuestas de las preguntas (esas nunca salen del navegador).
const fs = require('fs');
const path = require('path');

class GameDB {
    constructor(file) {
        this.enabled = false;
        this.file = file;
        try {
            const { DatabaseSync } = require('node:sqlite');
            if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
            this.db = new DatabaseSync(file);
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS partidas (
                    id TEXT PRIMARY KEY,
                    modo TEXT, dificultad TEXT,
                    inicio TEXT, fin TEXT, duracion_s REAL,
                    ganador TEXT, motivo TEXT,
                    jugadores INTEGER, humanos INTEGER, bots INTEGER
                );
                CREATE TABLE IF NOT EXISTS jugadores_partida (
                    partida_id TEXT, etiqueta TEXT, equipo TEXT, es_bot INTEGER,
                    capturas INTEGER, golpes_dados INTEGER, golpes_recibidos INTEGER,
                    bolas_lanzadas INTEGER, triangulos INTEGER, powerups INTEGER,
                    preguntas_respondidas INTEGER, preguntas_rechazadas INTEGER,
                    banderas_recogidas INTEGER, eliminado_s REAL,
                    FOREIGN KEY (partida_id) REFERENCES partidas(id)
                );
                CREATE TABLE IF NOT EXISTS eventos (
                    partida_id TEXT, t_ms INTEGER, tipo TEXT,
                    equipo TEXT, jugador TEXT, detalle TEXT,
                    FOREIGN KEY (partida_id) REFERENCES partidas(id)
                );
                CREATE INDEX IF NOT EXISTS idx_jug_partida ON jugadores_partida(partida_id);
                CREATE INDEX IF NOT EXISTS idx_ev_partida ON eventos(partida_id);
            `);
            this.enabled = true;
            console.log(`[DB] Base de datos de partidas lista: ${file}`);
        } catch (e) {
            console.warn(`[DB] Base de datos DESACTIVADA (${e.message}). Requiere Node 22.5 o superior. El juego funciona igual.`);
        }
    }

    // Guarda una partida completa (resumen + jugadores + eventos) en una sola transacción
    saveMatch(m) {
        if (!this.enabled) return false;
        try {
            this.db.exec('BEGIN');
            this.db.prepare(
                `INSERT INTO partidas (id, modo, dificultad, inicio, fin, duracion_s, ganador, motivo, jugadores, humanos, bots)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?)`
            ).run(m.id, m.modo, m.dificultad, m.inicio, m.fin, m.duracion_s, m.ganador, m.motivo, m.jugadores.length,
                m.jugadores.filter((p) => !p.es_bot).length, m.jugadores.filter((p) => p.es_bot).length);

            const jp = this.db.prepare(
                `INSERT INTO jugadores_partida (partida_id, etiqueta, equipo, es_bot, capturas, golpes_dados, golpes_recibidos,
                    bolas_lanzadas, triangulos, powerups, preguntas_respondidas, preguntas_rechazadas, banderas_recogidas, eliminado_s)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
            );
            for (const p of m.jugadores) {
                jp.run(m.id, p.etiqueta, p.equipo, p.es_bot ? 1 : 0, p.capturas, p.golpes_dados, p.golpes_recibidos,
                    p.bolas_lanzadas, p.triangulos, p.powerups, p.preguntas_respondidas, p.preguntas_rechazadas,
                    p.banderas_recogidas, p.eliminado_s);
            }

            const ev = this.db.prepare(`INSERT INTO eventos (partida_id, t_ms, tipo, equipo, jugador, detalle) VALUES (?,?,?,?,?,?)`);
            for (const e of m.eventos) {
                ev.run(m.id, e.t, e.tipo, e.equipo, e.jugador, e.detalle ? JSON.stringify(e.detalle) : null);
            }
            this.db.exec('COMMIT');
            return true;
        } catch (e) {
            try { this.db.exec('ROLLBACK'); } catch (_) {}
            console.error('[DB] No se pudo guardar la partida:', e.message);
            return false;
        }
    }

    listMatches(limit = 100) {
        if (!this.enabled) return [];
        return this.db.prepare('SELECT * FROM partidas ORDER BY inicio DESC LIMIT ?').all(limit);
    }

    getMatch(id) {
        if (!this.enabled) return null;
        const partida = this.db.prepare('SELECT * FROM partidas WHERE id = ?').get(id);
        if (!partida) return null;
        return {
            partida,
            jugadores: this.db.prepare('SELECT * FROM jugadores_partida WHERE partida_id = ?').all(id),
            eventos: this.db.prepare('SELECT * FROM eventos WHERE partida_id = ? ORDER BY t_ms').all(id)
        };
    }

    table(name) {
        if (!this.enabled) return [];
        const ok = { partidas: 'partidas', jugadores: 'jugadores_partida', eventos: 'eventos' }[name];
        if (!ok) return [];
        return this.db.prepare(`SELECT * FROM ${ok}`).all();
    }

    // Resumen agregado de todas las partidas (incluye la métrica de privacidad: ¿cuántos responden?)
    summary() {
        if (!this.enabled) return null;
        const count = (sql) => this.db.prepare(sql).all();
        const total = this.db.prepare('SELECT COUNT(*) c, AVG(duracion_s) d FROM partidas').get();
        const porGanador = count('SELECT ganador, COUNT(*) c FROM partidas GROUP BY ganador');
        const porMotivo = count('SELECT motivo, COUNT(*) c FROM partidas GROUP BY motivo');
        const porModo = count('SELECT modo, COUNT(*) c FROM partidas GROUP BY modo');
        const tot = this.db.prepare(
            `SELECT SUM(capturas) capturas, SUM(golpes_dados) golpes, SUM(powerups) powerups, SUM(triangulos) triangulos
             FROM jugadores_partida WHERE es_bot = 0`
        ).get();

        // Por nivel de sensibilidad: cuántas veces se respondió y cuántas se rechazó
        const niveles = { 1: { respondidas: 0, rechazadas: 0 }, 2: { respondidas: 0, rechazadas: 0 }, 3: { respondidas: 0, rechazadas: 0 } };
        const rows = this.db.prepare(`SELECT tipo, detalle FROM eventos WHERE tipo IN ('powerup','powerup_cancelado')`).all();
        for (const r of rows) {
            let d = {};
            try { d = JSON.parse(r.detalle || '{}'); } catch (_) {}
            if (d.gratis || !niveles[d.nivel]) continue;
            niveles[d.nivel][r.tipo === 'powerup' ? 'respondidas' : 'rechazadas']++;
        }
        return {
            partidas: total.c,
            duracion_media_s: total.d ? Math.round(total.d) : 0,
            por_ganador: porGanador, por_motivo: porMotivo, por_modo: porModo,
            totales_humanos: tot,
            preguntas_por_nivel: niveles
        };
    }
}

module.exports = GameDB;
