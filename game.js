// ===================== Constantes =====================
const ENERGIA_POR_TRIANGULO = 21;
const MAP_SIZE = 4000;
const MAX_JUGADORES = 59;
const MIN_JUGADORES_GRUPO = 2;
const TIEMPO_AUTO_LOBBY = 10;
const BASE_BLUE = { x: 400, y: 3600 };
const BASE_RED = { x: 3600, y: 3600 };
const SESSION_KEY = 'snowus_session'; // solo { code, token, nick }; NUNCA respuestas de preguntas

// ===================== Estado global =====================
let socket = null;
let mySocketId = null;
let myRoomCode = null;
let myNickname = 'Viajero';
let canvas, ctx;
let gameState = 'MENU'; // MENU | LOBBY | COUNTDOWN | PLAYING | LESSON | FINISHED
let players = {};       // id -> jugador (con rx, ry para suavizado)
let flag = { blue: { x: BASE_BLUE.x, y: BASE_BLUE.y, carrierId: null }, red: { x: BASE_RED.x, y: BASE_RED.y, carrierId: null } };
let triangles = [];
let scores = { blue: 0, red: 0 };
let lastRoom = null;
let camera = { x: 0, y: 0 };
let keys = {};
let joystick = { active: false, x: 0, y: 0 };
let taskModalOpen = false;
let isEliminated = false;
let paused = false;
let pauseBannerShown = false;
let inviteHandled = false;
let alarmTimer = null;
let audioCtx = null;
let cdTimer = null, elimTimer = null, bannerTimer = null;
let lastSent = { vx: NaN, vy: NaN }, lastSentAt = 0;
let qrShownFor = null;
let scenery = [];

// Respuestas de las preguntas: SOLO en RAM, nunca al servidor, nunca a storage.
const sessionDataTracker = { trianglesEaten: 0, tempResponses: {} };

const $ = (id) => document.getElementById(id);
const show = (id) => $(id) && $(id).classList.remove('hidden');
const hide = (id) => $(id) && $(id).classList.add('hidden');

// ===================== Arranque =====================
window.onload = () => {
    canvas = $('game-canvas');
    ctx = canvas.getContext('2d');
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    buildScenery();
    setupControls();
    setupJoystick();
    connectSocket();
    requestAnimationFrame(gameLoop);
};

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}

function setupControls() {
    window.addEventListener('keydown', (e) => {
        initAudio();
        if (e.target && e.target.tagName === 'INPUT') return; // no mover mientras se escribe
        keys[e.key.toLowerCase()] = true;
    });
    window.addEventListener('keyup', (e) => (keys[e.key.toLowerCase()] = false));
    window.addEventListener('pointerdown', initAudio);
}

function setupJoystick() {
    const zone = $('joystick-zone'), stick = $('joystick-stick');
    if (!zone || !stick) return;
    const R = 40;
    const move = (e) => {
        const t = e.touches[0];
        const r = zone.getBoundingClientRect();
        let dx = t.clientX - (r.left + r.width / 2), dy = t.clientY - (r.top + r.height / 2);
        const m = Math.hypot(dx, dy);
        if (m > R) { dx = (dx / m) * R; dy = (dy / m) * R; }
        stick.style.transform = `translate(${dx}px, ${dy}px)`;
        joystick = { active: true, x: dx / R, y: dy / R };
        e.preventDefault();
    };
    const end = () => { stick.style.transform = ''; joystick = { active: false, x: 0, y: 0 }; };
    zone.addEventListener('touchstart', move, { passive: false });
    zone.addEventListener('touchmove', move, { passive: false });
    zone.addEventListener('touchend', end);
    zone.addEventListener('touchcancel', end);
}

// ===================== Socket =====================
function connectSocket() {
    if (typeof io === 'undefined') {
        showBanner('No se pudo cargar Socket.IO. ¿Está corriendo el servidor (npm start)?', 8000);
        return;
    }
    socket = io();

    socket.on('connect', () => {
        mySocketId = socket.id;
        lastSent = { vx: NaN, vy: NaN };
        attemptRejoin();
    });

    socket.on('roomUpdated', (room) => {
        lastRoom = room;
        scores = room.score || scores;
        if (gameState === 'LOBBY') renderLobby(room);
    });

    socket.on('countdownStart', ({ seconds }) => showCountdown(seconds));

    socket.on('startAborted', ({ message }) => {
        clearInterval(cdTimer);
        hide('countdown-overlay');
        showBanner(message || 'No se pudo iniciar', 4000);
        if (lastRoom) openLobby(lastRoom);
    });

    socket.on('gameStarted', (room) => enterGame(room));

    socket.on('gameStateUpdate', (st) => {
        mergePlayers(st.players);
        flag = st.flag;
        scores = st.score;
        paused = !!st.paused;
        updateHUD();
        if (paused) {
            showBanner('Jugador reconectando… partida en pausa', 0);
            pauseBannerShown = true;
        } else if (pauseBannerShown) {
            hide('banner');
            pauseBannerShown = false;
        }
    });

    socket.on('triangleUpdate', (t) => {
        if (!t.active) triangles = triangles.filter((x) => x.id !== t.id);
        else { triangles = triangles.filter((x) => x.id !== t.id); triangles.push({ id: t.id, x: t.x, y: t.y }); }
    });

    socket.on('triangleTask', ({ n }) => triggerTriangleTask(n));
    socket.on('taskExpired', () => closeTaskModal());
    socket.on('eliminated', () => onLocalEliminated());
    socket.on('gameFinished', (res) => onGameFinished(res));
    socket.on('playerDisconnected', () => {
        if (gameState === 'PLAYING') showBanner('Jugador reconectando…', 3000);
    });
}

function attemptRejoin() {
    const s = loadSession();
    if (!s) return handleInviteLink();
    socket.emit('rejoin', { code: s.code, token: s.token }, (res) => {
        if (res && res.success) {
            myRoomCode = res.roomCode;
            myNickname = s.nick;
            inviteHandled = true;
            lastRoom = res.room;
            const me = res.room.players.find((p) => p.id === mySocketId);
            if (res.room.started && !res.room.finished && me && !me.isFrozen) enterGame(res.room);
            else openLobby(res.room);
        } else {
            clearSession();
            handleInviteLink();
        }
    });
}

// Enlace de invitación ?sala=CODIGO
function handleInviteLink() {
    if (inviteHandled) return;
    inviteHandled = true;
    const code = new URLSearchParams(location.search).get('sala');
    if (!code) return;
    history.replaceState(null, '', location.pathname);
    const nick = prompt('Elige tu apodo para entrar a la sala ' + code.toUpperCase() + ':', readNickname());
    if (nick === null) return;
    $('player-nickname').value = nick.trim().slice(0, 12) || 'Viajero';
    joinRoom(code, nick);
}

// ===================== Sesión (solo token de reconexión) =====================
function saveSession(code, token, nick) {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code, token, nick })); } catch (e) {}
}
function loadSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (e) { return null; }
}
function clearSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
}

// ===================== Menú / Lobby =====================
function readNickname() {
    return ($('player-nickname').value || '').trim().slice(0, 12) || 'Viajero';
}

function notConnected() {
    if (socket && socket.connected) return false;
    showBanner('Sin conexión con el servidor. Ejecuta npm start y recarga.', 5000);
    return true;
}

// "JUGAR VS BOT": sala de modo bot + inicio automático
function startSingleplayerMode() {
    createRoom('bot');
}

function createRoom(mode) {
    if (notConnected()) return;
    initAudio();
    myNickname = readNickname();
    socket.emit('createRoom', { mode, nickname: myNickname }, (res) => {
        if (!res || !res.success) return showBanner((res && res.message) || 'No se pudo crear la sala', 4000);
        myRoomCode = res.roomCode;
        saveSession(res.roomCode, res.token, myNickname);
        lastRoom = res.room;
        if (mode === 'bot') {
            socket.emit('startGame', { roomCode: res.roomCode }, (r) => {
                if (!r || !r.success) showBanner((r && r.message) || 'No se pudo iniciar', 4000);
            });
        } else {
            openLobby(res.room);
        }
    });
}

function joinRoom(code, nick) {
    if (notConnected()) return;
    code = String(code || '').trim().toUpperCase();
    if (code.length !== 6) return showBanner('Código inválido (6 caracteres)', 3000);
    initAudio();
    myNickname = (nick || '').trim().slice(0, 12) || 'Viajero';
    socket.emit('joinRoom', { code, nickname: myNickname }, (res) => {
        if (!res || !res.success) return showBanner((res && res.message) || 'No se pudo entrar', 4000);
        myRoomCode = res.roomCode;
        saveSession(res.roomCode, res.token, myNickname);
        lastRoom = res.room;
        openLobby(res.room);
    });
}

function joinRoomByInput() {
    joinRoom($('room-code-input').value, readNickname());
}

function openLobby(room) {
    hideAllModals();
    hide('main-menu');
    hide('hud-layer');
    hide('joystick-zone');
    show('lobby-modal');
    gameState = 'LOBBY';
    renderLobby(room);
}

function localCanStart(room) {
    if (room.started || room.starting) return { ok: false, reason: 'Partida en curso' };
    if (room.mode === 'bot') return { ok: true };
    const real = room.players.filter((p) => !p.isBot && !p.disconnected);
    const blue = real.filter((p) => p.team === 'blue').length;
    if (real.length < MIN_JUGADORES_GRUPO) return { ok: false, reason: 'Faltan al menos 2 jugadores' };
    if (blue < 1) return { ok: false, reason: 'Falta al menos 1 jugador en el equipo azul' };
    if (real.length - blue < 1) return { ok: false, reason: 'Falta al menos 1 jugador en el equipo rojo' };
    return { ok: true };
}

function renderLobby(room) {
    lastRoom = room;
    $('display-room-code').textContent = room.code;
    const max = room.mode === 'grupo' ? MAX_JUGADORES : 2;
    $('lobby-player-count').textContent = `Jugadores: ${room.players.length} / ${max}`;

    // QR (solo se regenera si cambia la sala)
    if (qrShownFor !== room.code && typeof QRCode !== 'undefined') {
        const box = $('qrcode');
        box.innerHTML = '';
        new QRCode(box, { text: inviteUrl(room.code), width: 110, height: 110 });
        qrShownFor = room.code;
    }

    // Lista de jugadores (textContent: sin riesgo de XSS con apodos)
    const list = $('lobby-players');
    list.innerHTML = '';
    room.players.forEach((p) => {
        const row = document.createElement('div');
        row.className = 'flex items-center gap-2 bg-slate-900/70 rounded-lg px-2 py-1 border border-slate-800';
        const dot = document.createElement('span');
        dot.className = 'w-2.5 h-2.5 rounded-full ' + (p.team === 'blue' ? 'bg-blue-500' : 'bg-red-500');
        const name = document.createElement('span');
        let t = p.nickname;
        if (p.id === room.hostId) t += ' ★';
        if (p.id === mySocketId) t += ' (tú)';
        if (p.disconnected) t += ' (reconectando…)';
        name.textContent = t;
        name.className = 'truncate text-slate-200';
        row.append(dot, name);
        list.appendChild(row);
    });

    // Botón de inicio
    const btn = $('btn-start-game');
    const check = localCanStart(room);
    let label = 'COMENZAR PARTIDA', enabled = true;
    if (room.started || room.starting) { label = 'PARTIDA EN CURSO'; enabled = false; }
    else if (room.hostId !== mySocketId) { label = 'ESPERANDO AL ANFITRIÓN'; enabled = false; }
    else if (!check.ok) { label = check.reason.toUpperCase(); enabled = false; }
    btn.disabled = !enabled;
    btn.textContent = label;
    btn.classList.toggle('opacity-50', !enabled);
    btn.classList.toggle('cursor-not-allowed', !enabled);
}

function inviteUrl(code) {
    return location.origin + '/?sala=' + code;
}

function launchLobbyGame() {
    if (!socket || !myRoomCode) return;
    socket.emit('startGame', { roomCode: myRoomCode }, (res) => {
        if (!res || !res.success) showBanner((res && res.message) || 'No se pudo iniciar', 4000);
    });
}

function leaveLobby() {
    returnToMainMenu();
}

function copyText(text, okMsg) {
    const done = () => showBanner(okMsg, 2000);
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
}
function fallbackCopy(text, cb) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); cb(); } catch (e) {}
    ta.remove();
}
function copyInviteLink() { if (myRoomCode) copyText(inviteUrl(myRoomCode), 'Enlace copiado'); }
function copyRoomCode() { if (myRoomCode) copyText(myRoomCode, 'Código copiado'); }

// ===================== Cuenta atrás / inicio de partida =====================
function showCountdown(n) {
    hide('main-menu');
    hide('lobby-modal');
    show('countdown-overlay');
    gameState = 'COUNTDOWN';
    const el = $('countdown-number');
    el.textContent = n;
    clearInterval(cdTimer);
    cdTimer = setInterval(() => {
        n--;
        if (n <= 0) { clearInterval(cdTimer); el.textContent = '¡YA!'; }
        else el.textContent = n;
    }, 1000);
}

function mergePlayers(arr) {
    const next = {};
    for (const p of arr) {
        const old = players[p.id];
        p.rx = old ? old.rx : p.x;
        p.ry = old ? old.ry : p.y;
        next[p.id] = p;
    }
    players = next;
}

function enterGame(room) {
    clearInterval(cdTimer);
    hideAllModals();
    hide('main-menu');
    hide('lobby-modal');
    show('hud-layer');
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) show('joystick-zone');

    players = {};
    mergePlayers(room.players);
    flag = room.flag;
    triangles = room.triangles || [];
    scores = room.score;
    paused = !!room.paused;
    isEliminated = false;
    taskModalOpen = false;
    sessionDataTracker.trianglesEaten = 0;
    sessionDataTracker.tempResponses = {};
    lastSent = { vx: NaN, vy: NaN };
    gameState = 'PLAYING';

    const me = players[mySocketId];
    if (me) {
        camera.x = me.x - canvas.width / 2;
        camera.y = me.y - canvas.height / 2;
        // Recarga con una pregunta abierta: se vuelve a mostrar
        if (me.taskOpen) triggerTriangleTask(me.trianglesEaten + 1);
    }
    updateHUD();
}

// ===================== Preguntas (triángulos) =====================
function triggerTriangleTask(n) {
    sessionDataTracker.trianglesEaten = n;
    const label = $('task-question-label');
    label.innerText =
        n === 1 ? 'Ingresa tu NOMBRE COMPLETO:' :
        n === 2 ? 'Ingresa el NOMBRE DE TUS PAPÁS:' :
                  'Ingresa tu EDAD:';
    keys = {};
    show('task-modal');
    taskModalOpen = true;
    hideAlarm();
    const input = $('task-input');
    input.value = '';
    setTimeout(() => input.focus(), 50);
}

function closeTaskModal() {
    hide('task-modal');
    taskModalOpen = false;
}

function submitTaskAnswer() {
    if (!taskModalOpen) return;
    const input = $('task-input');
    const n = sessionDataTracker.trianglesEaten;
    // ⚠ PRIVACIDAD: la respuesta vive solo en RAM. Al servidor solo viaja "terminé" (sin datos).
    sessionDataTracker.tempResponses['r' + n] = input.value.trim();
    input.value = '';
    closeTaskModal();
    hideAlarm();
    socket.emit('taskDone'); // el servidor recarga la energía a 21 s
    if (n >= 3) {
        sessionDataTracker.tempResponses = {}; // se descartan los datos
        showLesson();
    }
}

function showLesson() {
    hide('task-modal');
    hide('hud-layer');
    hide('joystick-zone');
    hideAlarm();
    show('lesson-modal');
    gameState = 'LESSON';
}

// ===================== Eliminación / fin de partida =====================
function onLocalEliminated() {
    if (isEliminated) return;
    isEliminated = true;
    hideAlarm();
    closeTaskModal();
    show('eliminated-modal');
    let s = TIEMPO_AUTO_LOBBY;
    $('elim-count').textContent = s;
    clearInterval(elimTimer);
    elimTimer = setInterval(() => {
        s--;
        $('elim-count').textContent = Math.max(s, 0);
        if (s <= 0) returnToLobby();
    }, 1000);
}

function onGameFinished({ winner, reason, lesson }) {
    hideAllModals();
    hideAlarm();
    hide('hud-layer');
    hide('joystick-zone');
    gameState = 'FINISHED';
    const me = players[mySocketId];
    const names = { blue: 'CONEJOS AZULES', red: 'VENADOS ROJOS' };
    let text;
    if (!winner) text = reason === 'cancelled' ? 'PARTIDA CANCELADA' : '¡EMPATE!';
    else {
        const mine = me && me.team === winner;
        text = (mine ? '¡VICTORIA! ' : 'DERROTA. ') + 'Ganan los ' + names[winner];
    }
    const motivo = {
        capture: 'Capturaron la bandera enemiga.',
        elimination: 'El otro equipo quedó sin energía.',
        draw: 'Ambos equipos quedaron sin energía.',
        cancelled: 'Un equipo se quedó sin jugadores.'
    }[reason] || '';
    $('winner-text').textContent = text;
    $('winner-lesson').textContent = motivo + ' Lección: ' + (lesson || '');
    show('winner-modal');
}

function hideAllModals() {
    ['task-modal', 'lesson-modal', 'eliminated-modal', 'winner-modal', 'countdown-overlay'].forEach(hide);
    clearInterval(elimTimer);
    taskModalOpen = false;
}

// "Volver al lobby": sin recargar, para conservar el socket y la plaza
function returnToLobby() {
    if (!lastRoom) return returnToMainMenu();
    hideAlarm();
    openLobby(lastRoom);
}

function restartMatch() { // botón de la pantalla de lección
    returnToLobby();
}

function returnToMainMenu() {
    if (socket && myRoomCode) socket.emit('leaveRoom', {}, () => {});
    clearSession();
    myRoomCode = null;
    lastRoom = null;
    qrShownFor = null;
    players = {};
    triangles = [];
    hideAllModals();
    hideAlarm();
    hide('lobby-modal');
    hide('hud-layer');
    hide('joystick-zone');
    show('main-menu');
    gameState = 'MENU';
    history.replaceState(null, '', location.pathname);
}

// ===================== HUD / alarma / avisos =====================
function updateHUD() {
    const me = players[mySocketId];
    if (me) {
        $('energy-timer').innerText = `${me.energy.toFixed(1)}s`;
        $('energy-bar-fill').style.width = `${Math.max(0, Math.min(100, (me.energy / ENERGIA_POR_TRIANGULO) * 100))}%`;
    }
    $('score-blue').innerText = scores.blue;
    $('score-red').innerText = scores.red;
}

function showAlarm() {
    show('energy-warning');
    if (!alarmTimer) {
        beep(880, 0.15);
        alarmTimer = setInterval(() => beep(880, 0.15), 1000);
    }
}

function hideAlarm() {
    hide('energy-warning');
    if (alarmTimer) { clearInterval(alarmTimer); alarmTimer = null; }
}

function showBanner(text, ms = 3000) {
    const b = $('banner');
    if (!b) return;
    b.textContent = text;
    b.classList.remove('hidden');
    clearTimeout(bannerTimer);
    if (ms > 0) bannerTimer = setTimeout(() => { if (!pauseBannerShown) b.classList.add('hidden'); }, ms);
}

function initAudio() {
    if (!audioCtx) {
        try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

function beep(freq, dur) {
    if (!audioCtx) return;
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.value = 0.04;
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + dur);
}

// ===================== Bucle =====================
let lastTime = performance.now();
function gameLoop(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;
    if (gameState === 'PLAYING') updateGame(dt);
    renderGame(now / 1000);
    requestAnimationFrame(gameLoop);
}

function updateGame(dt) {
    const me = players[mySocketId];
    if (!me) return;

    // Suavizado hacia la posición del servidor (autoridad)
    const k = Math.min(1, dt * 15);
    for (const p of Object.values(players)) {
        p.rx += (p.x - p.rx) * k;
        p.ry += (p.y - p.ry) * k;
    }

    // Alarma: solo de 10 s a 0 s y NUNCA con el modal de pregunta abierto
    if (taskModalOpen || me.isFrozen || paused || isEliminated) hideAlarm();
    else if (me.energy <= 10 && me.energy > 0) showAlarm();
    else hideAlarm();

    // Entrada (el servidor mueve; el cliente solo envía la intención)
    let vx = 0, vy = 0;
    if (!taskModalOpen && !isEliminated && !me.isFrozen) {
        if (keys['w'] || keys['arrowup']) vy -= 1;
        if (keys['s'] || keys['arrowdown']) vy += 1;
        if (keys['a'] || keys['arrowleft']) vx -= 1;
        if (keys['d'] || keys['arrowright']) vx += 1;
        if (joystick.active) { vx = joystick.x; vy = joystick.y; }
        const m = Math.hypot(vx, vy);
        if (m > 1) { vx /= m; vy /= m; }
    }
    const t = performance.now();
    if (vx !== lastSent.vx || vy !== lastSent.vy || t - lastSentAt > 250) {
        socket.emit('playerMove', { roomCode: myRoomCode, inputState: { vx, vy, facingLeft: vx < 0 } });
        lastSent = { vx, vy };
        lastSentAt = t;
    }

    camera.x += (me.rx - canvas.width / 2 - camera.x) * 0.1;
    camera.y += (me.ry - canvas.height / 2 - camera.y) * 0.1;
}

// ===================== Render =====================
function buildScenery() {
    // Pinos y rocas deterministas (mismo mapa para todos)
    let seed = 1234;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 160; i++) {
        const x = rnd() * MAP_SIZE, y = rnd() * MAP_SIZE;
        if (Math.hypot(x - BASE_BLUE.x, y - BASE_BLUE.y) < 260 || Math.hypot(x - BASE_RED.x, y - BASE_RED.y) < 260) continue;
        scenery.push({ x, y, type: rnd() < 0.75 ? 'pine' : 'rock', s: 0.8 + rnd() * 0.7 });
    }
}

function drawFlag(f, color, carrierPos) {
    const x = carrierPos ? carrierPos.x + 14 : f.x;
    const y = carrierPos ? carrierPos.y - 26 : f.y;
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y - 46);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y - 46);
    ctx.lineTo(x + 28, y - 38);
    ctx.lineTo(x, y - 28);
    ctx.closePath();
    ctx.fill();
}

function drawPlayer(p, isMe, t) {
    const moving = Math.hypot(p.x - p.rx, p.y - p.ry) > 1.5;
    const bob = moving ? Math.sin(t * 14) * 3 : 0;
    const color = p.team === 'blue' ? '#2563eb' : '#dc2626';
    ctx.save();
    ctx.translate(p.rx, p.ry);
    if (p.disconnected) ctx.globalAlpha = 0.4;

    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(0, 24, 20, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    if (isMe) {
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.ellipse(0, 24, 26, 9, 0, 0, Math.PI * 2);
        ctx.stroke();
    }

    ctx.save();
    ctx.scale(p.facingLeft ? -1 : 1, 1);
    ctx.translate(0, bob);
    const body = p.isFrozen ? '#94a3b8' : color;
    ctx.fillStyle = body;
    // orejas (conejo azul) o astas (venado rojo)
    if (p.team === 'blue') {
        ctx.beginPath(); ctx.ellipse(-8, -34, 5, 16, -0.15, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.ellipse(6, -34, 5, 16, 0.15, 0, Math.PI * 2); ctx.fill();
    } else {
        ctx.strokeStyle = '#78350f';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-8, -18); ctx.lineTo(-14, -34); ctx.moveTo(-12, -28); ctx.lineTo(-20, -30);
        ctx.moveTo(8, -18); ctx.lineTo(14, -34); ctx.moveTo(12, -28); ctx.lineTo(20, -30);
        ctx.stroke();
    }
    // mochila
    ctx.fillStyle = p.isFrozen ? '#64748b' : (p.team === 'blue' ? '#1d4ed8' : '#b91c1c');
    ctx.fillRect(-26, -4, 10, 24);
    // cuerpo cápsula
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.roundRect(-18, -22, 36, 46, 16);
    ctx.fill();
    // visor
    ctx.fillStyle = '#bae6fd';
    ctx.beginPath();
    ctx.ellipse(6, -8, 12, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    // patitas
    ctx.fillStyle = body;
    const step = moving ? Math.sin(t * 14) * 4 : 0;
    ctx.fillRect(-14, 20, 10, 8 + step);
    ctx.fillRect(4, 20, 10, 8 - step);
    if (p.isFrozen) {
        ctx.fillStyle = 'rgba(186,230,253,0.45)';
        ctx.beginPath();
        ctx.roundRect(-20, -24, 40, 54, 16);
        ctx.fill();
    }
    ctx.restore();

    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(15,23,42,0.8)';
    ctx.lineWidth = 3;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    const label = isMe ? 'TÚ · ' + p.nickname : p.nickname;
    ctx.strokeText(label, 0, -56);
    ctx.fillText(label, 0, -56);
    ctx.restore();
}

function renderGame(t) {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(-camera.x, -camera.y);

    // Suelo nevado
    const g = ctx.createLinearGradient(0, 0, 0, MAP_SIZE);
    g.addColorStop(0, '#e0f2fe');
    g.addColorStop(1, '#f1f5f9');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, MAP_SIZE, MAP_SIZE);
    ctx.strokeStyle = 'rgba(148,163,184,0.25)';
    ctx.lineWidth = 1;
    const x0 = Math.max(0, Math.floor(camera.x / 200) * 200), x1 = Math.min(MAP_SIZE, camera.x + canvas.width);
    const y0 = Math.max(0, Math.floor(camera.y / 200) * 200), y1 = Math.min(MAP_SIZE, camera.y + canvas.height);
    ctx.beginPath();
    for (let x = x0; x <= x1; x += 200) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    for (let y = y0; y <= y1; y += 200) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    ctx.stroke();
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 6;
    ctx.strokeRect(0, 0, MAP_SIZE, MAP_SIZE);

    // Pinos y rocas (solo los visibles)
    for (const s of scenery) {
        if (s.x < camera.x - 80 || s.x > camera.x + canvas.width + 80 || s.y < camera.y - 120 || s.y > camera.y + canvas.height + 80) continue;
        if (s.type === 'pine') {
            ctx.fillStyle = '#14532d';
            for (let i = 0; i < 3; i++) {
                ctx.beginPath();
                ctx.moveTo(s.x, s.y - 70 * s.s + i * 22 * s.s);
                ctx.lineTo(s.x + (22 + i * 8) * s.s, s.y - 30 * s.s + i * 22 * s.s);
                ctx.lineTo(s.x - (22 + i * 8) * s.s, s.y - 30 * s.s + i * 22 * s.s);
                ctx.closePath();
                ctx.fill();
            }
            ctx.fillStyle = '#f8fafc';
            ctx.beginPath();
            ctx.moveTo(s.x, s.y - 70 * s.s);
            ctx.lineTo(s.x + 10 * s.s, s.y - 52 * s.s);
            ctx.lineTo(s.x - 10 * s.s, s.y - 52 * s.s);
            ctx.closePath();
            ctx.fill();
        } else {
            ctx.fillStyle = '#94a3b8';
            ctx.beginPath();
            ctx.ellipse(s.x, s.y, 24 * s.s, 15 * s.s, 0, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // Cuevas / bases
    [['blue', BASE_BLUE, 'rgba(37,99,235,0.18)', '#2563eb'], ['red', BASE_RED, 'rgba(220,38,38,0.18)', '#dc2626']].forEach(([, b, fill, stroke]) => {
        ctx.fillStyle = fill;
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(b.x, b.y, 150, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    });

    // Banderas (si alguien la lleva, se dibuja sobre el portador)
    const carrierOf = (f) => (f.carrierId && players[f.carrierId] ? { x: players[f.carrierId].rx, y: players[f.carrierId].ry } : null);
    drawFlag(flag.blue, '#2563eb', carrierOf(flag.blue));
    drawFlag(flag.red, '#dc2626', carrierOf(flag.red));

    // Triángulos
    for (const tr of triangles) {
        ctx.fillStyle = '#06b6d4';
        ctx.shadowColor = '#22d3ee';
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.moveTo(tr.x, tr.y - 15);
        ctx.lineTo(tr.x + 12, tr.y + 10);
        ctx.lineTo(tr.x - 12, tr.y + 10);
        ctx.closePath();
        ctx.fill();
        ctx.shadowBlur = 0;
    }

    // Jugadores (el local al final para que quede encima)
    Object.values(players).filter((p) => p.id !== mySocketId).forEach((p) => drawPlayer(p, false, t));
    if (players[mySocketId]) drawPlayer(players[mySocketId], true, t);

    ctx.restore();
}
