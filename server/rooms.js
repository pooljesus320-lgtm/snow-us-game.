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
const NUM_TRIANGULOS = 60;
const RESPAWN_TRIANGULO = 15;      // s
const TIEMPO_TAREA_MAX = 90;       // s máx. con el modal de pregunta / lección abierto
const TIEMPO_REINICIO_SALA = 15;   // s tras terminar la partida antes de volver al lobby

// ----- Power-ups (recompensas por responder, en 3 niveles de sensibilidad) -----
const POWERUP_TIPOS = ['boots', 'bubble', 'magnet', 'radar', 'camo', 'energy'];
const NUM_POWERUPS = 12;
const RADIO_POWERUP = 45;
const RESPAWN_POWERUP = 35;        // s tras recogerlo
const RESPAWN_POWERUP_CANCELADO = 5; // s si el jugador decide no responder
const POWERUP_DUR = [8, 12, 16];   // s por nivel
const BOOTS_BONUS = [0.15, 0.30, 0.50];
const MAGNET_RADIO = [150, 250, 400];
const NODRAIN_SEG = [0, 5, 10];    // súper energía: s sin gastar energía
const NIVELES_MAX = 3;
const NIVEL_TRAS_LECCION = 2;      // tras la lección, los power-ups ya no piden datos

// ----- Combate (bolas de nieve) -----
const CD_ATAQUE = 1500;            // ms
const VEL_PROYECTIL = 650;
const VIDA_PROYECTIL = 0.8;        // s  (~520 px de alcance)
const RADIO_IMPACTO = 30;
const ATURDIR_PORTADOR = 1500;     // ms: el portador suelta la bandera y queda aturdido
const RALENTIZAR = 1000;           // ms: a un jugador normal solo lo frena
const FACTOR_LENTO = 0.6;
const INMUNE_TRAS_GOLPE = 2000;    // ms sin poder ser golpeado de nuevo
const FACTOR_PORTADOR = 0.85;      // el portador de bandera va más lento
const BLOQUEO_RECOGER = 3000;      // ms que el portador golpeado no puede recoger de nuevo su bandera
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
            blue: { x: BASES.blue.x, y: BASES.blue.y, carrierId: null, droppedAt: 0, lockId: null, lockUntil: 0 },
            red: { x: BASES.red.x, y: BASES.red.y, carrierId: null, droppedAt: 0, lockId: null, lockUntil: 0 }
        };
    }

    // 12 power-ups en anillo alrededor del mapa (un tipo cada 30°, se repiten 2 veces)
    newPowerups() {
        return Array.from({ length: NUM_POWERUPS }, (_, i) => {
            const a = (i / NUM_POWERUPS) * Math.PI * 2 + Math.PI / 12;
            return {
                id: i,
                type: POWERUP_TIPOS[i % POWERUP_TIPOS.length],
                x: Math.round(MAP_SIZE / 2 + Math.cos(a) * 1400),
                y: Math.round(MAP_SIZE / 2 + Math.sin(a) * 1400),
                active: true,
                respawnAt: 0
            };
        });
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
            pending: null,          // power-up pendiente de responder { type, spotId }
            level: 0,               // preguntas respondidas (0..3)
            fx: {},                 // efectos activos { tipo: { until, tier } }
            nextAttackAt: 0,
            stunUntil: 0,
            slowUntil: 0,
            immuneUntil: 0,
            stats: { hits: 0, powerups: 0, captures: 0 }
        });
    }

    // ---------- Serialización (Map -> Array, sin token) ----------
    serializePlayer(p) {
        const now = Date.now();
        const fx = {};
        for (const k of Object.keys(p.fx)) {
            const left = (p.fx[k].until - now) / 1000;
            if (left > 0) fx[k] = { left: Math.round(left * 10) / 10, tier: p.fx[k].tier };
        }
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
            pendingType: p.pending ? p.pending.type : null,
            level: p.level,
            fx,
            stunned: now < p.stunUntil
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
            triangles: room.triangles.filter((t) => t.active).map((t) => ({ id: t.id, x: Math.round(t.x), y: Math.round(t.y) })),
            powerups: room.powerups.map((u) => ({ id: u.id, type: u.type, x: u.x, y: u.y, active: u.active }))
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
            triangles: this.newTriangles(),
            powerups: this.newPowerups(),
            projectiles: [],
            projSeq: 0
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
        room.powerups = this.newPowerups();
        room.projectiles = [];
        for (const p of room.players.values()) this.resetPlayer(p);
    }

    resetToLobby(room) {
        room.started = false;
        room.starting = false;
        room.finished = false;
        room.paused = false;
        room.flag = this.newFlags();
        room.triangles = this.newTriangles();
        room.powerups = this.newPowerups();
        room.projectiles = [];
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

    fxTier(p, type, now) {
        const f = p.fx[type];
        return f && f.until > now ? f.tier : 0;
    }

    applyPowerup(p, type, tier, now) {
        if (type === 'energy') {
            p.energy = ENERGIA_POR_TRIANGULO;
            const nd = NODRAIN_SEG[tier - 1];
            if (nd > 0) p.fx.nodrain = { until: now + nd * 1000, tier };
        } else {
            p.fx[type] = { until: now + POWERUP_DUR[tier - 1] * 1000, tier };
        }
    }

    // El jugador decidió no responder: sin power-up, el punto reaparece pronto
    cancelPending(room, p, now) {
        if (p.pending) {
            const spot = room.powerups[p.pending.spotId];
            if (spot) spot.respawnAt = now + RESPAWN_POWERUP_CANCELADO * 1000;
        }
        p.taskOpen = false;
        p.pending = null;
    }

    cancelTask(socketId) {
        const room = this.getRoomOf(socketId);
        const p = room && room.players.get(socketId);
        if (!p || !p.taskOpen || !p.pending) return false;
        this.cancelPending(room, p, Date.now());
        return true;
    }

    // Termina la tarea: la respuesta NUNCA llega al servidor, solo el aviso "terminé"
    completeTask(socketId) {
        const room = this.getRoomOf(socketId);
        const p = room && room.players.get(socketId);
        if (!p || !room.started || room.finished || !p.taskOpen || !p.pending || p.isFrozen) return null;
        const tier = Math.min(p.level + 1, NIVELES_MAX);
        const type = p.pending.type;
        this.applyPowerup(p, type, tier, Date.now());
        p.level = Math.min(p.level + 1, NIVELES_MAX);
        p.stats.powerups++;
        p.taskOpen = false;
        p.pending = null;
        return { type, tier, learned: p.level >= NIVELES_MAX };
    }

    // ---------- Combate ----------
    spawnProjectile(room, p, dx, dy) {
        const m = Math.hypot(dx, dy) || 1;
        const ux = dx / m, uy = dy / m;
        room.projectiles.push({
            id: ++room.projSeq,
            ownerId: p.id,
            team: p.team,
            x: p.x + ux * 30,
            y: p.y + uy * 30,
            vx: ux * VEL_PROYECTIL,
            vy: uy * VEL_PROYECTIL,
            life: VIDA_PROYECTIL
        });
    }

    fireAttack(socketId, dx, dy) {
        const room = this.getRoomOf(socketId);
        if (!room || !room.started || room.finished || room.paused) return false;
        const p = room.players.get(socketId);
        const now = Date.now();
        if (!p || p.isFrozen || p.disconnected || p.taskOpen || now < p.stunUntil || now < p.nextAttackAt) return false;
        dx = Number(dx); dy = Number(dy);
        if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 0.1) {
            dx = p.facingLeft ? -1 : 1; dy = 0;
        }
        p.nextAttackAt = now + CD_ATAQUE;
        this.spawnProjectile(room, p, dx, dy);
        return true;
    }

    applyHit(io, room, q, pr, now) {
        if (now < q.immuneUntil || this.fxTier(q, 'bubble', now)) return; // absorbido
        q.immuneUntil = now + INMUNE_TRAS_GOLPE;
        const owner = room.players.get(pr.ownerId);
        if (owner) owner.stats.hits++;
        let dropped = false;
        if (q.hasFlag) {
            this.dropFlag(room, q);
            q.stunUntil = now + ATURDIR_PORTADOR;
            dropped = true;
        } else {
            q.slowUntil = now + RALENTIZAR;
        }
        io.to(room.code).emit('hit', { id: q.id, dropped });
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
        const now = Date.now();
        for (const f of Object.values(room.flag)) {
            if (f.carrierId === p.id) {
                f.carrierId = null;
                f.droppedAt = now;
                f.x = p.x;
                f.y = p.y;
                f.lockId = p.id;                    // no puede recogerla de nuevo al instante
                f.lockUntil = now + BLOQUEO_RECOGER;
            }
        }
        p.hasFlag = false;
    }

    checkFlagPickup(room, p) {
        const now = Date.now();
        const enemy = otroEquipo(p.team);
        const ef = room.flag[enemy];
        const bloqueada = ef.lockId === p.id && now < ef.lockUntil;
        if (!p.hasFlag && !bloqueada && ef.carrierId === null && Math.hypot(p.x - ef.x, p.y - ef.y) < RADIO_RECOGER) {
            ef.carrierId = p.id;
            ef.droppedAt = 0;
            ef.lockId = null;
            p.hasFlag = true;
        }
        // Un compañero que toca la bandera propia caída la devuelve a la base
        const of = room.flag[p.team];
        if (of.carrierId === null && of.droppedAt && Math.hypot(p.x - of.x, p.y - of.y) < RADIO_RECOGER) {
            of.x = BASES[p.team].x; of.y = BASES[p.team].y; of.droppedAt = 0; of.lockId = null;
        }
    }

    // true si el jugador lleva la bandera enemiga a su base (usamos la posición base de la bandera propia)
    checkFlagCapture(room, p) {
        if (!p.hasFlag) return false;
        const h = BASES[p.team];
        return Math.hypot(p.x - h.x, p.y - h.y) < RADIO_CAPTURA;
    }

    declareWinner(io, room, team, reason, capturer) {
        if (!room.started || room.finished) return; // nunca en lobby / cuenta atrás / ya terminada
        room.finished = true;
        room.finishedAt = Date.now();
        room.paused = false;
        room.projectiles = [];
        if (team) room.score[team]++;
        if (capturer) capturer.stats.captures++;
        const stats = Array.from(room.players.values()).map((p) => ({
            id: p.id, nickname: p.nickname, team: p.team, isBot: p.isBot,
            captures: p.stats.captures, hits: p.stats.hits, powerups: p.stats.powerups
        }));
        for (const p of room.players.values()) { p.vx = 0; p.vy = 0; }
        io.to(room.code).emit('gameFinished', { winner: team, reason, lesson: LECCION, score: room.score, stats });
    }

    eliminate(io, room, p) {
        p.isFrozen = true;
        p.energy = Math.max(0, p.energy);
        p.vx = 0; p.vy = 0;
        if (p.pending) this.cancelPending(room, p, Date.now());
        p.taskOpen = false;
        this.dropFlag(room, p);
        if (!p.isBot) io.to(p.id).emit('eliminated', { reason: 'energy' });
    }

    // Los triángulos solo recargan energía (sin preguntas). El imán amplía el radio de recogida.
    checkTrianglePickup(io, room, p, now) {
        const mt = this.fxTier(p, 'magnet', now);
        const radio = RADIO_TRIANGULO + (mt ? MAGNET_RADIO[mt - 1] : 0);
        for (const t of room.triangles) {
            if (!t.active || Math.hypot(p.x - t.x, p.y - t.y) >= radio) continue;
            t.active = false;
            t.respawnAt = now + RESPAWN_TRIANGULO * 1000;
            p.energy = ENERGIA_POR_TRIANGULO;
            io.to(room.code).emit('triangleUpdate', { id: t.id, active: false });
            break;
        }
    }

    // Power-ups: piden una respuesta del nivel siguiente. Tras la lección ya no piden nada.
    checkPowerupPickup(io, room, p, now) {
        for (const u of room.powerups) {
            if (!u.active || Math.hypot(p.x - u.x, p.y - u.y) >= RADIO_POWERUP) continue;
            u.active = false;
            u.respawnAt = now + RESPAWN_POWERUP * 1000;
            io.to(room.code).emit('powerupUpdate', { id: u.id, active: false });
            if (p.level >= NIVELES_MAX) {
                this.applyPowerup(p, u.type, NIVEL_TRAS_LECCION, now);
                p.stats.powerups++;
                io.to(p.id).emit('powerupGranted', { type: u.type, tier: NIVEL_TRAS_LECCION, learned: true, free: true });
            } else {
                p.taskOpen = true;       // energía y movimiento en pausa mientras responde
                p.taskOpenAt = now;
                p.vx = 0; p.vy = 0;
                p.pending = { type: u.type, spotId: u.id };
                io.to(p.id).emit('powerupTask', { tier: p.level + 1, type: u.type });
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

    speedOf(p, now) {
        let v = VELOCIDAD_JUGADOR;
        if (p.hasFlag) v *= FACTOR_PORTADOR;
        const bt = this.fxTier(p, 'boots', now);
        if (bt) v *= 1 + BOOTS_BONUS[bt - 1];
        if (now < p.slowUntil) v *= FACTOR_LENTO;
        return v;
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
                        const atk = botController.getAttack(p, room, now, room.difficulty);
                        if (atk) this.spawnProjectile(room, p, atk.dx, atk.dy);
                    } else {
                        if (p.taskOpen) {
                            if (now - p.taskOpenAt > TIEMPO_TAREA_MAX * 1000) {
                                this.cancelPending(room, p, now);
                                io.to(p.id).emit('taskExpired');
                            } else continue; // pregunta abierta: sin energía, sin movimiento, sin golpes
                        }
                        if (!this.fxTier(p, 'nodrain', now)) p.energy -= dt;
                        if (p.energy <= 0) { this.eliminate(io, room, p); continue; }
                        if (now >= p.stunUntil) {
                            const v = this.speedOf(p, now);
                            p.x += p.vx * v * dt;
                            p.y += p.vy * v * dt;
                        }
                    }
                    p.x = Math.max(0, Math.min(MAP_SIZE, p.x));
                    p.y = Math.max(0, Math.min(MAP_SIZE, p.y));

                    this.checkTrianglePickup(io, room, p, now);
                    if (!p.isBot) this.checkPowerupPickup(io, room, p, now);
                    this.checkFlagPickup(room, p);
                    if (this.checkFlagCapture(room, p)) {
                        this.declareWinner(io, room, p.team, 'capture', p);
                        break;
                    }
                }
                if (room.finished) continue;

                // Proyectiles (bolas de nieve)
                for (let i = room.projectiles.length - 1; i >= 0; i--) {
                    const pr = room.projectiles[i];
                    pr.x += pr.vx * dt;
                    pr.y += pr.vy * dt;
                    pr.life -= dt;
                    let remove = pr.life <= 0 || pr.x < 0 || pr.y < 0 || pr.x > MAP_SIZE || pr.y > MAP_SIZE;
                    if (!remove) {
                        for (const q of room.players.values()) {
                            if (q.team === pr.team || q.isFrozen || q.disconnected || q.taskOpen) continue;
                            if (Math.hypot(q.x - pr.x, q.y - pr.y) < RADIO_IMPACTO) {
                                this.applyHit(io, room, q, pr, now);
                                remove = true;
                                break;
                            }
                        }
                    }
                    if (remove) room.projectiles.splice(i, 1);
                }

                // Banderas: seguir al portador / reset de la caída
                for (const team of ['blue', 'red']) {
                    const f = room.flag[team];
                    if (f.carrierId) {
                        const c = room.players.get(f.carrierId);
                        if (c && !c.isFrozen && !c.disconnected) { f.x = c.x; f.y = c.y; }
                        else { f.carrierId = null; f.droppedAt = now; if (c) c.hasFlag = false; }
                    } else if (f.droppedAt && now - f.droppedAt > RESET_BANDERA * 1000) {
                        f.x = BASES[team].x; f.y = BASES[team].y; f.droppedAt = 0; f.lockId = null;
                    }
                }

                // Reaparición de triángulos y power-ups
                for (const t of room.triangles) {
                    if (!t.active && t.respawnAt <= now) {
                        Object.assign(t, this.newTriangle(t.id));
                        io.to(code).emit('triangleUpdate', { id: t.id, active: true, x: Math.round(t.x), y: Math.round(t.y) });
                    }
                }
                for (const u of room.powerups) {
                    if (!u.active && u.respawnAt <= now) {
                        u.active = true;
                        io.to(code).emit('powerupUpdate', { id: u.id, active: true });
                    }
                }
            }

            // Se simula a 30 Hz pero se emite a 15 Hz para ahorrar ancho de banda
            if (this.tick % 2 === 0) {
                io.to(code).emit('gameStateUpdate', {
                    players: Array.from(room.players.values()).map((p) => this.serializePlayer(p)),
                    score: room.score,
                    flag: this.serializeFlags(room),
                    paused: room.paused,
                    proj: room.projectiles.map((pr) => ({ id: pr.id, x: Math.round(pr.x), y: Math.round(pr.y), team: pr.team }))
                });
            }
        }
    }
}

module.exports = RoomManager;
