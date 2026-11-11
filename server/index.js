const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const RoomManager = require('./rooms');
const BotController = require('./bot');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const MAX_JUGADORES = 59;
const TIEMPO_RECONEXION = 60; // Segundos
const TIEMPO_AUTO_START = 3;  // Segundos de cuenta atrás

app.use(express.static(path.join(__dirname, '../public')));

const roomManager = new RoomManager(MAX_JUGADORES, TIEMPO_RECONEXION);
const botController = new BotController();

// ---- Rate-limit simple por IP para joinRoom (10 intentos / minuto) ----
const joinAttempts = new Map();
function rateLimited(ip) {
    const now = Date.now();
    const e = joinAttempts.get(ip);
    if (!e || now > e.resetAt) {
        joinAttempts.set(ip, { count: 1, resetAt: now + 60000 });
        return false;
    }
    e.count++;
    return e.count > 10;
}
setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of joinAttempts) if (now > e.resetAt) joinAttempts.delete(ip);
}, 60000);

const noop = () => {};
const asObj = (d) => (d && typeof d === 'object' ? d : {});

io.on('connection', (socket) => {
    console.log(`Jugador conectado: ${socket.id}`);

    // Crear sala
    socket.on('createRoom', (data, cb) => {
        cb = typeof cb === 'function' ? cb : noop;
        const { mode, nickname, difficulty } = asObj(data);
        if (!roomManager.isValidMode(mode)) return cb({ success: false, message: 'Modo no válido.' });
        if (roomManager.playerToRoom.has(socket.id)) return cb({ success: false, message: 'Ya estás en una sala.' });

        const room = roomManager.createRoom(mode, socket.id, nickname, difficulty);
        socket.join(room.code);
        const me = room.players.get(socket.id);
        cb({ success: true, roomCode: room.code, playerId: socket.id, token: me.token, room: roomManager.serializeRoom(room) });
        io.to(room.code).emit('roomUpdated', roomManager.serializeRoom(room));
    });

    // Unirse a una sala
    socket.on('joinRoom', (data, cb) => {
        cb = typeof cb === 'function' ? cb : noop;
        if (rateLimited(socket.handshake.address)) {
            return cb({ success: false, message: 'Demasiados intentos. Espera un minuto.' });
        }
        const { code, nickname } = asObj(data);
        const result = roomManager.joinRoom(code, socket.id, nickname);
        if (result.error) return cb({ success: false, message: result.error });

        const roomCode = result.room.code;
        socket.join(roomCode);
        cb({ success: true, roomCode, playerId: socket.id, token: result.player.token, room: roomManager.serializeRoom(result.room) });
        io.to(roomCode).emit('roomUpdated', roomManager.serializeRoom(result.room));
    });

    // Reconexión con token (recarga de pestaña / caída de red)
    socket.on('rejoin', (data, cb) => {
        cb = typeof cb === 'function' ? cb : noop;
        const { code, token } = asObj(data);
        const result = roomManager.rejoin(code, token, socket.id);
        if (result.error) return cb({ success: false, message: result.error });

        if (result.oldId !== socket.id) {
            const old = io.sockets.sockets.get(result.oldId);
            if (old) old.disconnect(true); // cierra la pestaña duplicada
        }
        socket.join(result.room.code);
        cb({ success: true, roomCode: result.room.code, playerId: socket.id, room: roomManager.serializeRoom(result.room) });
        io.to(result.room.code).emit('roomUpdated', roomManager.serializeRoom(result.room));
    });

    // Movimiento: solo afecta al socket que emite (la sala se deduce del socket, no del cliente)
    socket.on('playerMove', (data) => {
        roomManager.updatePlayerInput(socket.id, asObj(data).inputState);
    });

    // Tarea terminada: no lleva datos (las respuestas nunca salen del navegador)
    socket.on('taskDone', () => {
        roomManager.completeTask(socket.id);
    });

    // Iniciar partida
    socket.on('startGame', (_data, cb) => {
        cb = typeof cb === 'function' ? cb : noop;
        const room = roomManager.getRoomOf(socket.id);
        if (!room || room.hostId !== socket.id) return cb({ success: false, message: 'Solo el anfitrión puede iniciar.' });
        const check = roomManager.canStart(room);
        if (!check.ok) return cb({ success: false, message: check.reason });

        room.starting = true;
        io.to(room.code).emit('countdownStart', { seconds: TIEMPO_AUTO_START });
        cb({ success: true });

        setTimeout(() => {
            if (roomManager.rooms.get(room.code) !== room || !room.starting) return;
            // Revalidar: alguien pudo desconectarse durante la cuenta atrás
            room.starting = false;
            const again = roomManager.canStart(room);
            if (!again.ok) {
                io.to(room.code).emit('startAborted', { message: again.reason });
                io.to(room.code).emit('roomUpdated', roomManager.serializeRoom(room));
                return;
            }
            roomManager.beginMatch(room);
            io.to(room.code).emit('gameStarted', roomManager.serializeRoom(room));
        }, TIEMPO_AUTO_START * 1000);
    });

    // Salir voluntariamente de la sala
    socket.on('leaveRoom', (_data, cb) => {
        cb = typeof cb === 'function' ? cb : noop;
        const res = roomManager.leaveRoom(socket.id);
        if (res) {
            socket.leave(res.code);
            if (res.room) {
                io.to(res.code).emit('playerDisconnected', { socketId: socket.id });
                io.to(res.code).emit('roomUpdated', roomManager.serializeRoom(res.room));
            }
        }
        cb({ success: true });
    });

    // Desconexión: se reserva la plaza TIEMPO_RECONEXION segundos
    socket.on('disconnect', () => {
        console.log(`Jugador desconectado: ${socket.id}`);
        const code = roomManager.handleDisconnect(socket.id);
        if (code) {
            io.to(code).emit('playerDisconnected', { socketId: socket.id });
            const room = roomManager.getRoom(code);
            if (room) io.to(code).emit('roomUpdated', roomManager.serializeRoom(room));
        }
    });
});

// Bucle principal (30 Hz) y limpieza de reservas (cada 5 s)
setInterval(() => roomManager.updateGameStates(io, botController), 1000 / 30);
setInterval(() => roomManager.tickReconnect(io), 5000);

server.listen(PORT, () => {
    console.log(`Servidor de Snow Us escuchando en el puerto ${PORT}`);
});
