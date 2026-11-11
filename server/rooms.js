const crypto = require('crypto');

// ===== Constantes del juego =====
const LIMITS_MODE = { bot: 2, pareja: 2, grupo: 59 };
const MIN_POR_EQUIPO = 1;
const PAUSA_DESCONEXION = 60;      // s de reserva de plaza
const RESET_BANDERA = 20;          // s hasta que una bandera caída vuelve a su base
const ENERGIA_POR_TRIANGULO = 21;
const MAP_SIZE = 4000;
const VELOCIDAD_JUGADOR = 220;
const RADIO_RECOGER = 40;          // recoger bandera enemiga / devolver la propia
const RADIO_CAPTURA = 60;          // llegar a la base propia con la bandera enemiga
const RADIO_TRIANGULO = 40;
const NUM_TRIANGULOS = 40;
const RESPAWN_TRIANGULO = 15;      // s
const TIEMPO_TAREA_MAX = 45;       // s máx. con el modal de pregunta abierto
const TIEMPO_REINICIO_SALA = 5;    // s tras terminar la partida antes de volver al lobby
const TRIANGULOS_TRAMPA = 3;
const LECCION = 'Nunca des datos personales a un juego o página desconocida.';

const BASES = {
    blue: { x: 400, y: 3600 },
    red: { x: 3600, y: 3600 }
};
const otroEquipo = (t) => (t === 'blue' ? 'red' : 'blue');

class RoomManager {
    constructor(maxPlayers = 59, reconnectTimeout = PAUSA_DESCONEXION) {
        this.rooms = new Map();
        this.playerToRoom = new Map();
        this.maxPlayers = maxPlayers;
        this.reconnectTimeout = reconnectTimeout;
        this.tick = 0;
    }

    static get LIMITS_MODE() { return LIMITS_MODE; }

    isValidMode(mode) {
        return Object.prototype.hasOwnProperty.call(LIMITS_MODE, mode);
    }

    limitFor(room) {
        return room.mode === 'grupo' ? this.maxPlayers : LIMITS_MODE[room.mode];
    }

    generateCleanCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin O, 0, 1, I
        let code = '';
        for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
        return code;
    }

    // ---------- Fábricas ----------
    newFlags() {
        return {
            blue: { x: BASES.blue.x, y: BASES.blue.y, carrierId: null, droppedAt: 0 },
            red: { x: BASES.red.x, y: BASES.red.y, carrierId: null, droppedAt: 0 }
        };
    }

    newTriangle(id) {
        return { id, x: 500 + Math.random() * 3000, y: 500 + Math.random() * 3000, active: true, respawnAt: 0 };
    }

    newTriangles() {
        return Array.from({ length: NUM_TRIANGULOS }, (_, i) => this.newTriangle(i));
    }

    sanitizeNick(nick) {
        return String(nick || '').replace(/[<>]/g, '').trim().slice(0, 12) || 'Viajero';
    }

    makePlayer(id, nickname, team, isBot = false) {
        const p = {
            id,
            token: isBot ? null : crypto.randomBytes(16).toString('hex'), // secreto: NUNCA se serializa
            nickname: this.sanitizeNick(nickname),
            team,
            isBot,
            facingLeft: false,
            disconnected: false,
            disconnectAt: 0
        };
        this.resetPlayer(p);
        return p;
    }

    resetPlayer(p) {
        const h = BASES[p.team];
        Object.assign(p, {
            x: h.x + (Math.random() - 0.5) * 120,
            y: h.y + (Math.random() - 0.5) * 120,
            vx: 0, vy: 0,
            energy: ENERGIA_POR_TRIANGULO,
            isFrozen: false,
            hasFlag: false,
            taskOpen: false,
            taskOpenAt: 0,
            trianglesEaten: 0
        });
    }

    // ---------- Serialización (Map -> Array, sin token) ----------
    serializePlayer(p) {
        return {
            id: p.id,
            nickname: p.nickname,
            team: p.team,
            x: Math.round(p.x),
            y: Math.round(p.y),
            energy: Math.round(p.energy * 10) / 10,
            isFrozen: p.isFrozen,
            facingLeft: p.facingLeft,
            hasFlag: p.hasFlag,
            isBot: p.isBot,
            disconnected: p.disconnected,
            taskOpen: p.taskOpen,
            trianglesEaten: p.trianglesEaten
        };
    }

    serializeFlags(room) {
        const f = (x) => ({ x: Math.round(x.x), y: Math.round(x.y), carrierId: x.carrierId });
        return { blue: f(room.flag.blue), red: f(room.flag.red) };
    }

    serializeRoom(room) {
        return {
            code: room.code,
            mode: room.mode,
            hostId: room.hostId,
            players: Array.from(room.players.values()).map((p) => this.serializePlayer(p)),
            started: room.started,
            starting: room.starting,
            finished: room.finished,
            score: room.score,
            flag: this.serializeFlags(room),
            paused: room.paused,
            triangles: room.triangles.filter((t) => t.active).map((t) => ({ id: t.id, x: Math.round(t.x), y: Math.round(t.y) }))
        };
    }

    // ---------- Salas ----------
    createRoom(mode, hostSocketId, hostNickname, difficulty = 'normal') {
        let code = this.generateCleanCode();
        while (this.rooms.has(code)) code = this.generateCleanCode();

        const room = {
            code,
            mode,
            difficulty,
            hostId: hostSocketId,
            players: new Map(),
            started: false,
            starting: false,
            finished: false,
            finishedAt: 0,
            paused: false,
            allowJoinMidGame: false,
            score: { blue: 0, red: 0 },
            flag: this.newFlags(),
            triangles: this.newTriangles()
        };

        this.rooms.set(code, room);
        this.joinRoom(code, hostSocketId, hostNickname);
        if (mode === 'bot') this.addBot(room);
        return room;
    }

    addBot(room) {
        const host = room.players.get(room.hostId);
        const bot = this.makePlayer('bot_' + room.code, 'Bot Yeti', otroEquipo(host.team), true);
        room.players.set(bot.id, bot);
    }

    getRoom(code) {
        return this.rooms.get(code);
    }

    getRoomOf(socketId) {
        return this.rooms.get(this.playerToRoom.get(socketId));
    }

    joinRoom(code, socketId, nickname) {
        code = String(code || '').trim().toUpperCase();
        const room = this.rooms.get(code);
        if (!room) return { error: 'La sala especificada no existe.' };
        if (room.players.has(socketId)) return { error: 'Ya estás en esta sala.' };
        if (this.playerToRoom.has(socketId)) return { error: 'Ya estás en otra sala.' };

        const limit = this.limitFor(room);
        if (room.players.size >= limit) return { error: `Sala llena (máximo ${limit} jugadores).` };
        if ((room.started || room.starting) && !room.allowJoinMidGame) return { error: 'La partida ya empezó.' };

        // Balance por conteo real de cada equipo (no por paridad)
        let blue = 0, red = 0;
        for (const p of room.players.values()) (p.team === 'blue' ? blue++ : red++);
        const team = blue < red ? 'blue' : red < blue ? 'red' : (Math.random() < 0.5 ? 'blue' : 'red');

        const player = this.makePlayer(socketId, nickname, team);
        room.players.set(socketId, player);
        this.playerToRoom.set(socketId, code);
        return { room, player };
    }

    canStart(room) {
        if (room.started || room.starting) return { ok: false, reason: 'La partida ya empezó' };
        if (room.mode === 'bot') return { ok: true };
        const real = Array.from(room.players.values()).filter((p) => !p.isBot && !p.disconnected);
        if (real.length < 2) return { ok: false, reason: 'Faltan al menos 2 jugadores' };
        const blue = real.filter((p) => p.team === 'blue').length;
        const red = real.length - blue;
        if (blue < MIN_POR_EQUIPO) return { ok: false, reason: 'Falta al menos 1 jugador en el equipo azul' };
        if (red < MIN_POR_EQUIPO) return { ok: false, reason: 'Falta al menos 1 jugador en el equipo rojo' };
        return { ok: true };
    }

    beginMatch(room) {
        room.starting = false;
        room.started = true;
        room.finished = false;
        room.paused = false;
        room.flag = this.newFlags();
        room.triangles = this.newTriangles();
        for (const p of room.players.values()) this.resetPlayer(p);
    }

    resetToLobby(room) {
        room.started = false;
        room.starting = false;
        room.finished = false;
        room.paused = false;
        room.flag = this.newFlags();
        room.triangles = this.newTriangles();
        for (const p of room.players.values()) this.resetPlayer(p);
    }

    // ---------- Entrada del jugador (solo afecta al socket que emite) ----------
    updatePlayerInput(socketId, inputState) {
        const room = this.getRoomOf(socketId);
        if (!room || !room.started || room.finished) return null;
        const p = room.players.get(socketId);
        if (!p || p.isFrozen || p.disconnected || p.taskOpen) return null;

        const i = inputState && typeof inputState === 'object' ? inputState : {};
        let vx = Number(i.vx), vy = Number(i.vy);
        if (!Number.isFinite(vx)) vx = 0;
        if (!Number.isFinite(vy)) vy = 0;
        vx = Math.max(-1, Math.min(1, vx));
        vy = Math.max(-1, Math.min(1, vy));
        const m = Math.hypot(vx, vy);
        if (m > 1) { vx /= m; vy /= m; }
        p.vx = vx;
        p.vy = vy;
        if (vx < 0) p.facingLeft = true; else if (vx > 0) p.facingLeft = false;
        return p;
    }

    // Termina la tarea: la respuesta NUNCA llega al servidor, solo el aviso "terminé"
    completeTask(socketId) {
        const room = this.getRoomOf(socketId);
        const p = room && room.players.get(socketId);
        if (!p || !room.started || room.finished || !p.taskOpen || p.isFrozen) return null;
        p.taskOpen = false;
        p.energy = ENERGIA_POR_TRIANGULO;
        p.trianglesEaten++;
        const deceived = p.trianglesEaten >= TRIANGULOS_TRAMPA;
        if (deceived) {
            p.isFrozen = true; // fuera de la ronda tras la lección
            p.vx = 0; p.vy = 0;
            this.dropFlag(room, p);
        }
        return { deceived };
    }

    // ---------- Conexión / reconexión ----------
    handleDisconnect(socketId) {
        const roomCode = this.playerToRoom.get(socketId);
        if (!roomCode) return null;
        const room = this.rooms.get(roomCode);
        const p = room && room.players.get(socketId);
        if (!p) return null;
        p.disconnected = true;
        p.disconnectAt = Date.now();
        p.vx = 0; p.vy = 0;
        this.dropFlag(room, p);
        return roomCode;
    }

    // Reasigna al jugador a un socket nuevo usando su token secreto
    rejoin(code, token, newSocketId) {
        code = String(code || '').trim().toUpperCase();
        const room = this.rooms.get(code);
        if (!room || typeof token !== 'string') return { error: 'Sesión caducada.' };
        const p = Array.from(room.players.values()).find((x) => !x.isBot && x.token === token);
        if (!p) return { error: 'Sesión caducada.' };
        if (newSocketId !== p.id && this.playerToRoom.has(newSocketId)) return { error: 'Ya estás en una sala.' };

        const oldId = p.id;
        if (oldId !== newSocketId) {
            room.players.delete(oldId);
            this.playerToRoom.delete(oldId);
            p.id = newSocketId;
            room.players.set(newSocketId, p);
            this.playerToRoom.set(newSocketId, code);
            if (room.hostId === oldId) room.hostId = newSocketId;
            for (const f of Object.values(room.flag)) if (f.carrierId === oldId) f.carrierId = newSocketId;
        }
        p.disconnected = false;
        p.disconnectAt = 0;
        return { room, player: p, oldId };
    }

    removePlayer(room, id) {
        const p = room.players.get(id);
        if (!p) return;
        this.dropFlag(room, p);
        room.players.delete(id);
        this.playerToRoom.delete(id);
        if (room.hostId === id) {
            const humans = Array.from(room.players.values()).filter((x) => !x.isBot);
            const next = humans.find((x) => !x.disconnected) || humans[0];
            if (next) room.hostId = next.id; // traspaso de anfitrión
        }
    }

    leaveRoom(socketId) {
        const room = this.getRoomOf(socketId);
        if (!room) return null;
        this.removePlayer(room, socketId);
        if (!this.hasHumans(room)) { this.deleteRoom(room); return { code: room.code, room: null }; }
        return { code: room.code, room };
    }

    hasHumans(room) {
        for (const p of room.players.values()) if (!p.isBot) return true;
        return false;
    }

    deleteRoom(room) {
        for (const id of room.players.keys()) this.playerToRoom.delete(id);
        this.rooms.delete(room.code);
    }

    // Se llama cada 5 s: expira reservas de plaza y limpia salas vacías
    tickReconnect(io) {
        const now = Date.now();
        const limit = this.reconnectTimeout * 1000;
        for (const room of Array.from(this.rooms.values())) {
            let changed = false;
            for (const p of Array.from(room.players.values())) {
                if (p.disconnected && now - p.disconnectAt > limit) {
                    this.removePlayer(room, p.id);
                    changed = true;
                }
            }
            if (!this.hasHumans(room)) { this.deleteRoom(room); continue; }
            if (changed && io) io.to(room.code).emit('roomUpdated', this.serializeRoom(room));
        }
    }

    // ---------- Reglas de juego ----------
    dropFlag(room, p) {
        for (const f of Object.values(room.flag)) {
            if (f.carrierId === p.id) {
                f.carrierId = null;
                f.droppedAt = Date.now();
                f.x = p.x;
                f.y = p.y;
            }
        }
        p.hasFlag = false;
    }

    checkFlagPickup(room, p) {
        const enemy = otroEquipo(p.team);
        const ef = room.flag[enemy];
        if (!p.hasFlag && ef.carrierId === null && Math.hypot(p.x - ef.x, p.y - ef.y) < RADIO_RECOGER) {
            ef.carrierId = p.id;
            ef.droppedAt = 0;
            p.hasFlag = true;
        }
        // Un compañero que toca la bandera propia caída la devuelve a la base
        const of = room.flag[p.team];
        if (of.carrierId === null && of.droppedAt && Math.hypot(p.x - of.x, p.y - of.y) < RADIO_RECOGER) {
            of.x = BASES[p.team].x; of.y = BASES[p.team].y; of.droppedAt = 0;
        }
    }

    // true si el jugador lleva la bandera enemiga a su base (usamos la posición base de la bandera propia)
    checkFlagCapture(room, p) {
        if (!p.hasFlag) return false;
        const h = BASES[p.team];
        return Math.hypot(p.x - h.x, p.y - h.y) < RADIO_CAPTURA;
    }

    declareWinner(io, room, team, reason) {
        if (!room.started || room.finished) return; // nunca en lobby / cuenta atrás / ya terminada
        room.finished = true;
        room.finishedAt = Date.now();
        room.paused = false;
        if (team) room.score[team]++;
        for (const p of room.players.values()) { p.vx = 0; p.vy = 0; }
        io.to(room.code).emit('gameFinished', { winner: team, reason, lesson: LECCION, score: room.score });
    }

    eliminate(io, room, p) {
        p.isFrozen = true;
        p.energy = Math.max(0, p.energy);
        p.vx = 0; p.vy = 0;
        p.taskOpen = false;
        this.dropFlag(room, p);
        if (!p.isBot) io.to(p.id).emit('eliminated', { reason: 'energy' });
    }

    checkTrianglePickup(io, room, p, now) {
        for (const t of room.triangles) {
            if (!t.active || Math.hypot(p.x - t.x, p.y - t.y) >= RADIO_TRIANGULO) continue;
            t.active = false;
            t.respawnAt = now + RESPAWN_TRIANGULO * 1000;
            io.to(room.code).emit('triangleUpdate', { id: t.id, active: false });
            if (p.isBot) {
                p.energy = ENERGIA_POR_TRIANGULO;
            } else {
                // Energía en pausa hasta que termine la tarea
                p.taskOpen = true;
                p.taskOpenAt = now;
                p.vx = 0; p.vy = 0;
                io.to(p.id).emit('triangleTask', { n: p.trianglesEaten + 1 });
            }
            break;
        }
    }

    teamStats(room) {
        const s = { blue: { active: 0, pending: 0, total: 0 }, red: { active: 0, pending: 0, total: 0 } };
        for (const p of room.players.values()) {
            const t = s[p.team];
            t.total++;
            if (!p.isFrozen) (p.disconnected ? t.pending++ : t.active++);
        }
        return s;
    }

    updateGameStates(io, botController) {
        const dt = 1 / 30;
        const now = Date.now();
        this.tick++;

        for (const [code, room] of this.rooms.entries()) {
            if (!room.started || room.starting) continue;

            if (room.finished) {
                if (now - room.finishedAt > TIEMPO_REINICIO_SALA * 1000) {
                    this.resetToLobby(room);
                    io.to(code).emit('roomUpdated', this.serializeRoom(room));
                }
                continue;
            }

            // 1) Fin por eliminación / cancelación
            const st = this.teamStats(room);
            const blueOut = st.blue.active === 0 && st.blue.pending === 0;
            const redOut = st.red.active === 0 && st.red.pending === 0;
            if (blueOut || redOut) {
                if (st.blue.total === 0 || st.red.total === 0) this.declareWinner(io, room, null, 'cancelled');
                else if (blueOut && redOut) this.declareWinner(io, room, null, 'draw');
                else this.declareWinner(io, room, blueOut ? 'red' : 'blue', 'elimination');
                continue;
            }

            // 2) Pausa si un equipo se quedó sin jugadores conectados vivos (reconexión)
            room.paused = st.blue.active === 0 || st.red.active === 0;

            if (!room.paused) {
                for (const p of room.players.values()) {
                    if (p.isFrozen || p.disconnected) continue;

                    if (p.isBot) {
                        botController.updateBotState(p, room, dt, room.difficulty);
                        if (p.isFrozen) { this.eliminate(io, room, p); continue; }
                    } else {
                        if (p.taskOpen) {
                            if (now - p.taskOpenAt > TIEMPO_TAREA_MAX * 1000) {
                                p.taskOpen = false;
                                io.to(p.id).emit('taskExpired');
                            } else continue; // pregunta abierta: sin energía ni movimiento
                        }
                        p.energy -= dt;
                        if (p.energy <= 0) { this.eliminate(io, room, p); continue; }
                        p.x += p.vx * VELOCIDAD_JUGADOR * dt;
                        p.y += p.vy * VELOCIDAD_JUGADOR * dt;
                    }
                    p.x = Math.max(0, Math.min(MAP_SIZE, p.x));
                    p.y = Math.max(0, Math.min(MAP_SIZE, p.y));

                    this.checkTrianglePickup(io, room, p, now);
                    this.checkFlagPickup(room, p);
                    if (this.checkFlagCapture(room, p)) {
                        this.declareWinner(io, room, p.team, 'capture');
                        break;
                    }
                }
                if (room.finished) continue;

                // Banderas: seguir al portador / reset de la caída
                for (const team of ['blue', 'red']) {
                    const f = room.flag[team];
                    if (f.carrierId) {
                        const c = room.players.get(f.carrierId);
                        if (c && !c.isFrozen && !c.disconnected) { f.x = c.x; f.y = c.y; }
                        else { f.carrierId = null; f.droppedAt = now; if (c) c.hasFlag = false; }
                    } else if (f.droppedAt && now - f.droppedAt > RESET_BANDERA * 1000) {
                        f.x = BASES[team].x; f.y = BASES[team].y; f.droppedAt = 0;
                    }
                }

                // Reaparición de triángulos
                for (const t of room.triangles) {
                    if (!t.active && t.respawnAt <= now) {
                        Object.assign(t, this.newTriangle(t.id));
                        io.to(code).emit('triangleUpdate', { id: t.id, active: true, x: Math.round(t.x), y: Math.round(t.y) });
                    }
                }
            }

            // Se simula a 30 Hz pero se emite a 15 Hz para ahorrar ancho de banda
            if (this.tick % 2 === 0) {
                io.to(code).emit('gameStateUpdate', {
                    players: Array.from(room.players.values()).map((p) => this.serializePlayer(p)),
                    score: room.score,
                    flag: this.serializeFlags(room),
                    paused: room.paused
                });
            }
        }
    }
}

module.exports = RoomManager;
