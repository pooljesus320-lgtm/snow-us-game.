// ===================== Constantes =====================
const ENERGIA_POR_TRIANGULO = 21;
const MAP_SIZE = 4000;
const MAX_JUGADORES = 59;
const MIN_JUGADORES_GRUPO = 2;
const TIEMPO_AUTO_LOBBY = 10;
const TIEMPO_LOBBY_TRAS_PARTIDA = 15;
const TIEMPO_LECCION_MIN = 5;       // s antes de poder cerrar la lección
const CD_ATAQUE_CLIENTE = 1500;     // ms (el servidor es quien valida de verdad)
const BASE_BLUE = { x: 400, y: 3600 };
const BASE_RED = { x: 3600, y: 3600 };
const SESSION_KEY = 'snowus_session'; // solo { code, token, nick }; NUNCA respuestas de preguntas

const NIVELES = { 1: 'Datos básicos', 2: 'Datos personales', 3: 'DATOS SENSIBLES' };
// Preguntas por nivel: primero inocentes, luego cada vez más sensibles
const PREGUNTAS = {
    1: [
        { q: 'Ingresa tu APODO favorito:', short: 'tu apodo favorito' },
        { q: 'Ingresa tu COLOR favorito:', short: 'tu color favorito' },
        { q: 'Ingresa tu ANIMAL favorito:', short: 'tu animal favorito' }
    ],
    2: [
        { q: 'Ingresa el nombre de tu COLEGIO:', short: 'el nombre de tu colegio' },
        { q: 'Ingresa tu CIUDAD:', short: 'tu ciudad' },
        { q: 'Ingresa el NOMBRE DE TUS PAPÁS:', short: 'el nombre de tus papás' }
    ],
    3: [
        { q: 'Ingresa tu EDAD:', short: 'tu edad' },
        { q: 'Ingresa tu DIRECCIÓN:', short: 'tu dirección' },
        { q: 'Ingresa tu NÚMERO DE TELÉFONO:', short: 'tu teléfono' }
    ]
};

const POWERUPS = {
    boots:   { name: 'Botas de hielo',     icon: '⚡', color: '#38bdf8', desc: ['+15% de velocidad', '+30% de velocidad', '+50% de velocidad'] },
    bubble:  { name: 'Burbuja de nieve',   icon: '🛡️', color: '#a78bfa', desc: ['inmune a bolas de nieve 8 s', 'inmune a bolas de nieve 12 s', 'inmune a bolas de nieve 16 s'] },
    magnet:  { name: 'Imán de triángulos', icon: '🧲', color: '#f472b6', desc: ['recoge triángulos a 150 px', 'recoge triángulos a 250 px', 'recoge triángulos a 400 px'] },
    radar:   { name: 'Radar',              icon: '📡', color: '#4ade80', desc: ['flecha hacia la bandera 8 s', 'flecha hacia la bandera 12 s', 'flecha hacia la bandera 16 s'] },
    camo:    { name: 'Camuflaje',          icon: '👻', color: '#cbd5e1', desc: ['casi invisible a distancia 8 s', 'casi invisible a distancia 12 s', 'casi invisible a distancia 16 s'] },
    energy:  { name: 'Súper energía',      icon: '🔋', color: '#facc15', desc: ['energía al máximo', 'energía al máximo + 5 s sin gasto', 'energía al máximo + 10 s sin gasto'] },
    nodrain: { name: 'Sin gasto de energía', icon: '🔋', color: '#facc15', desc: ['', '', ''] }
};

const TIPS = [
    'Nadie serio te pide tu dirección en un juego.',
    'Si un juego te pide más datos cada vez, desconfía.',
    'Siempre puedes elegir «Prefiero no responder»: es lo más seguro.',
    'Lanza bolas de nieve (Espacio o clic) para detener al que lleva la bandera.',
    'Los power-ups brillan alrededor del mapa… pero fíjate en lo que piden.',
    'Los triángulos recargan tu energía al instante.',
    'El que lleva la bandera va más lento: ¡protégelo o atrápalo!',
    'Tu equipo gana si lleva la bandera enemiga a su cueva.'
];

// ===================== Estado global =====================
let socket = null;
let mySocketId = null;
let myRoomCode = null;
let myNickname = 'Viajero';
let canvas, ctx, mmCanvas, mmCtx;
let gameState = 'MENU'; // MENU | LOBBY | COUNTDOWN | PLAYING | FINISHED
let players = {};       // id -> jugador (con rx, ry para suavizado)
let flag = { blue: { x: BASE_BLUE.x, y: BASE_BLUE.y, carrierId: null }, red: { x: BASE_RED.x, y: BASE_RED.y, carrierId: null } };
let triangles = [];
let powerups = [];
let projectiles = [];
let scores = { blue: 0, red: 0 };
let lastRoom = null;
let camera = { x: 0, y: 0 };
let keys = {};
let joystick = { active: false, x: 0, y: 0 };
let lastDir = { x: 1, y: 0 };
let taskModalOpen = false;   // true con la pregunta o la lección abiertas (energía en pausa)
let lessonOpen = false;
let pendingTask = null;
let isEliminated = false;
let spectating = false, specTargetId = null;
let paused = false;
let pauseBannerShown = false;
let inviteHandled = false;
let alarmTimer = null;
let audioCtx = null;
let cdTimer = null, elimTimer = null, bannerTimer = null, winTimer = null, lessonTimer = null;
let lastSent = { vx: NaN, vy: NaN }, lastSentAt = 0;
let lastAttackAt = 0;
let lastEnergy = null;
let hitFx = {};
let qrShownFor = null;
let scenery = [];

// Respuestas de las preguntas: SOLO en RAM, nunca al servidor, nunca a storage.
const sessionDataTracker = { tempResponses: {}, asked: [] };

const $ = (id) => document.getElementById(id);
const show = (id) => $(id) && $(id).classList.remove('hidden');
const hide = (id) => $(id) && $(id).classList.add('hidden');
const isTouch = () => 'ontouchstart' in window || navigator.maxTouchPoints > 0;

// ===================== Arranque =====================
window.onload = () => {
    canvas = $('game-canvas');
    ctx = canvas.getContext('2d');
    mmCanvas = $('minimap');
    mmCtx = mmCanvas.getContext('2d');
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
        const k = e.key.toLowerCase();
        if (k === ' ') {
            e.preventDefault();
            if (!e.repeat) doAttack();
            return;
        }
        if (k === 'e' && spectating) spectateNext();
        keys[k] = true;
    });
    window.addEventListener('keyup', (e) => (keys[e.key.toLowerCase()] = false));
    window.addEventListener('pointerdown', initAudio);
    // Clic / toque en el mapa = lanzar bola de nieve hacia ese punto
    canvas.addEventListener('pointerdown', (e) => {
        const me = players[mySocketId];
        if (!canAct() || !me) return;
        doAttack(e.clientX + camera.x - me.rx, e.clientY + camera.y - me.ry);
    });
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
        projectiles = st.proj || [];
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
        triangles = triangles.filter((x) => x.id !== t.id);
        if (t.active) triangles.push({ id: t.id, x: t.x, y: t.y });
    });

    socket.on('powerupUpdate', ({ id, active }) => {
        const u = powerups.find((x) => x.id === id);
        if (u) u.active = active;
    });

    socket.on('powerupTask', ({ tier, type }) => openPowerupTask(tier, type));
    socket.on('powerupGranted', ({ type, tier, free }) => {
        sfx.power();
        const d = POWERUPS[type];
        showBanner(`${d.icon} ¡${d.name} nivel ${tier}! ${d.desc[tier - 1]}` + (free ? ' (sin dar datos 👍)' : ''), 3500);
    });
    socket.on('taskExpired', () => { closeTaskModal(); closeLessonUI(); });

    socket.on('hit', ({ id, dropped }) => {
        hitFx[id] = performance.now();
        if (id === mySocketId) {
            sfx.hit();
            showBanner(dropped ? '¡Te golpearon! Soltaste la bandera 🚩' : '¡Te golpearon! ❄️', 2000);
        } else if (dropped) {
            showBanner('¡Bandera suelta! 🚩', 2000);
        }
    });

    socket.on('eliminated', () => onLocalEliminated());
    socket.on('gameFinished', (res) => onGameFinished(res));
    socket.on('playerDisconnected', () => {
        if (gameState === 'PLAYING') showBanner('Jugador reconectando…', 5000);
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
    resetSpectate();
    hide('main-menu');
    hideGameUI();
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

// ===================== Cuenta atrás (pantalla de carga con consejos) =====================
function showCountdown(n) {
    hide('main-menu');
    hide('lobby-modal');
    show('countdown-overlay');
    gameState = 'COUNTDOWN';
    const total = n, t0 = performance.now();
    const num = $('countdown-number'), bar = $('countdown-bar'), tip = $('countdown-tip');
    let tipIdx = Math.floor(Math.random() * TIPS.length), lastTip = -1;
    clearInterval(cdTimer);
    const tick = () => {
        const el = (performance.now() - t0) / 1000;
        const left = Math.ceil(total - el);
        num.textContent = left > 0 ? left : '¡YA!';
        bar.style.width = Math.min(100, (el / total) * 100) + '%';
        const ti = Math.floor(el / 2.5);
        if (ti !== lastTip) { lastTip = ti; tip.textContent = '💡 ' + TIPS[(tipIdx + ti) % TIPS.length]; }
        if (el >= total) clearInterval(cdTimer);
    };
    tick();
    cdTimer = setInterval(tick, 100);
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
    resetSpectate();
    hide('main-menu');
    hide('lobby-modal');
    show('hud-layer');
    show('minimap');
    if (isTouch()) { show('joystick-zone'); show('attack-btn'); }

    players = {};
    mergePlayers(room.players);
    flag = room.flag;
    triangles = room.triangles || [];
    powerups = room.powerups || [];
    projectiles = [];
    scores = room.score;
    paused = !!room.paused;
    isEliminated = false;
    taskModalOpen = false;
    pendingTask = null;
    lastEnergy = null;
    sessionDataTracker.tempResponses = {};
    sessionDataTracker.asked = [];
    lastSent = { vx: NaN, vy: NaN };
    gameState = 'PLAYING';

    const me = players[mySocketId];
    if (me) {
        camera.x = me.x - canvas.width / 2;
        camera.y = me.y - canvas.height / 2;
        // Recarga con una pregunta abierta: se vuelve a mostrar
        if (me.taskOpen && me.pendingType) openPowerupTask(me.level + 1, me.pendingType);
    }
    updateHUD();
}

function hideGameUI() {
    hide('hud-layer');
    hide('minimap');
    hide('joystick-zone');
    hide('attack-btn');
    hide('spectate-bar');
    $('fx-bar').innerHTML = '';
}

// ===================== Power-ups: preguntas escalonadas =====================
function openPowerupTask(tier, type) {
    tier = Math.max(1, Math.min(3, tier));
    const bank = PREGUNTAS[tier];
    const q = bank[Math.floor(Math.random() * bank.length)];
    const d = POWERUPS[type];
    pendingTask = { tier, type, q };
    $('task-title').textContent = `${d.icon} POWER-UP: ${d.name.toUpperCase()}`;
    $('task-desc').textContent = `Nivel ${tier} · ${NIVELES[tier]} — ${d.desc[tier - 1]}. Responde para activarlo.`;
    $('task-question-label').innerText = q.q;
    keys = {};
    show('task-modal');
    taskModalOpen = true;
    hideAlarm();
    const input = $('task-input');
    input.setAttribute('autocomplete', 'off');
    input.value = '';
    setTimeout(() => input.focus(), 50);
}

function closeTaskModal() {
    hide('task-modal');
    taskModalOpen = false;
}

function submitTaskAnswer() {
    if (!taskModalOpen || !pendingTask) return;
    const input = $('task-input');
    const { tier, q } = pendingTask;
    // ⚠ PRIVACIDAD: la respuesta vive solo en RAM. Al servidor solo viaja "terminé" (sin datos).
    sessionDataTracker.tempResponses['r' + tier] = input.value.trim();
    sessionDataTracker.asked.push({ tier, short: q.short });
    input.value = '';
    hide('task-modal');
    if (tier >= 3) {
        sessionDataTracker.tempResponses = {}; // se descartan los datos antes de mostrar la lección
        showLesson();                          // el servidor mantiene la energía en pausa hasta cerrarla
    } else {
        taskModalOpen = false;
        pendingTask = null;
        socket.emit('taskDone');
    }
}

// El jugador prefirió no dar sus datos: no hay power-up
function cancelTask() {
    if (!taskModalOpen) return;
    $('task-input').value = '';
    closeTaskModal();
    pendingTask = null;
    socket.emit('taskCancel');
    showBanner('Buena decisión: no compartir datos es lo más seguro 👍', 3500);
}

function showLesson() {
    hideAlarm();
    lessonOpen = true;
    taskModalOpen = true;
    const tl = $('lesson-timeline');
    tl.innerHTML = '';
    const colors = { 1: 'bg-emerald-900/60 border-emerald-600 text-emerald-200', 2: 'bg-yellow-900/60 border-yellow-600 text-yellow-200', 3: 'bg-red-900/60 border-red-600 text-red-200' };
    sessionDataTracker.asked.forEach((a, i) => {
        const row = document.createElement('div');
        row.className = 'rounded-lg border px-3 py-1 text-left ' + colors[a.tier];
        row.textContent = `${i + 1}. ${NIVELES[a.tier]}: te pedí ${a.short}`;
        tl.appendChild(row);
    });
    show('lesson-modal');
    const btn = $('lesson-continue');
    let s = TIEMPO_LECCION_MIN;
    btn.disabled = true;
    btn.classList.add('opacity-50', 'cursor-not-allowed');
    btn.textContent = `LEE LA LECCIÓN… (${s})`;
    clearInterval(lessonTimer);
    lessonTimer = setInterval(() => {
        s--;
        if (s <= 0) {
            clearInterval(lessonTimer);
            btn.disabled = false;
            btn.classList.remove('opacity-50', 'cursor-not-allowed');
            btn.textContent = '🏅 SEGUIR JUGANDO';
        } else btn.textContent = `LEE LA LECCIÓN… (${s})`;
    }, 1000);
}

function continueAfterLesson() {
    if ($('lesson-continue').disabled) return;
    closeLessonUI();
    pendingTask = null;
    socket.emit('taskDone'); // ahora sí se entrega el power-up nivel 3
    showBanner('🏅 Insignia: Detective de privacidad. ¡Ya no necesitas dar datos para los power-ups!', 4500);
}

function closeLessonUI() {
    clearInterval(lessonTimer);
    hide('lesson-modal');
    lessonOpen = false;
    taskModalOpen = false;
}

// ===================== Eliminación / espectador / fin de partida =====================
function onLocalEliminated() {
    if (isEliminated) return;
    isEliminated = true;
    hideAlarm();
    closeTaskModal();
    sfx.lose();
    show('eliminated-modal');
    let s = TIEMPO_AUTO_LOBBY;
    $('elim-count').textContent = s;
    $('elim-bar').style.width = '100%';
    clearInterval(elimTimer);
    elimTimer = setInterval(() => {
        s--;
        $('elim-count').textContent = Math.max(s, 0);
        $('elim-bar').style.width = Math.max(0, (s / TIEMPO_AUTO_LOBBY) * 100) + '%';
        if (s <= 0) returnToLobby();
    }, 1000);
}

function aliveOthers() {
    return Object.values(players).filter((p) => p.id !== mySocketId && !p.isFrozen && !p.disconnected);
}

function spectateNext() {
    const list = aliveOthers();
    if (!list.length) { specTargetId = null; return; }
    const i = list.findIndex((p) => p.id === specTargetId);
    specTargetId = list[(i + 1) % list.length].id;
    showBanner('👁 Espectando a ' + players[specTargetId].nickname, 2000);
}

function startSpectating() {
    clearInterval(elimTimer);
    hide('eliminated-modal');
    spectating = true;
    show('spectate-bar');
    specTargetId = null;
    spectateNext();
}

function resetSpectate() {
    spectating = false;
    specTargetId = null;
    hide('spectate-bar');
}

function onGameFinished({ winner, reason, lesson, stats }) {
    hideAllModals();
    resetSpectate();
    hideAlarm();
    hideGameUI();
    gameState = 'FINISHED';
    const me = players[mySocketId];
    const names = { blue: 'CONEJOS AZULES', red: 'VENADOS ROJOS' };
    let text;
    if (!winner) text = reason === 'cancelled' ? 'PARTIDA CANCELADA' : '¡EMPATE!';
    else {
        const mine = me && me.team === winner;
        text = (mine ? '¡VICTORIA! ' : 'DERROTA. ') + 'Ganan los ' + names[winner];
        mine ? sfx.win() : sfx.lose();
    }
    const motivo = {
        capture: 'Capturaron la bandera enemiga.',
        elimination: 'El otro equipo quedó sin energía.',
        draw: 'Ambos equipos quedaron sin energía.',
        cancelled: 'Un equipo se quedó sin jugadores.'
    }[reason] || '';
    $('winner-text').textContent = text;
    $('winner-lesson').textContent = motivo + ' Lección: ' + (lesson || '');
    renderStats(stats || []);
    show('winner-modal');

    let s = TIEMPO_LOBBY_TRAS_PARTIDA;
    $('winner-count').textContent = s;
    $('winner-bar').style.width = '100%';
    clearInterval(winTimer);
    winTimer = setInterval(() => {
        s--;
        $('winner-count').textContent = Math.max(s, 0);
        $('winner-bar').style.width = Math.max(0, (s / TIEMPO_LOBBY_TRAS_PARTIDA) * 100) + '%';
        if (s <= 0) returnToLobby();
    }, 1000);
}

// Resumen: capturas, golpes y power-ups por jugador (textContent: sin XSS)
function renderStats(stats) {
    const box = $('winner-stats');
    box.innerHTML = '';
    const rows = stats.slice().sort((a, b) => (b.captures - a.captures) || (b.hits - a.hits) || (b.powerups - a.powerups)).slice(0, 10);
    const head = document.createElement('div');
    head.className = 'grid grid-cols-[1fr_auto_auto_auto] gap-x-3 text-slate-400 mb-1';
    ['Jugador', '🚩', '❄️', '⚡'].forEach((t) => { const c = document.createElement('span'); c.textContent = t; head.appendChild(c); });
    box.appendChild(head);
    rows.forEach((r) => {
        const row = document.createElement('div');
        row.className = 'grid grid-cols-[1fr_auto_auto_auto] gap-x-3 py-0.5 ' + (r.id === mySocketId ? 'text-yellow-300 font-bold' : '');
        const n = document.createElement('span');
        n.textContent = (r.team === 'blue' ? '🔵 ' : '🔴 ') + r.nickname + (r.isBot ? ' 🤖' : '');
        n.className = 'truncate';
        const a = document.createElement('span'); a.textContent = r.captures;
        const b = document.createElement('span'); b.textContent = r.hits;
        const c = document.createElement('span'); c.textContent = r.powerups;
        row.append(n, a, b, c);
        box.appendChild(row);
    });
}

function hideAllModals() {
    ['task-modal', 'lesson-modal', 'eliminated-modal', 'winner-modal', 'countdown-overlay'].forEach(hide);
    clearInterval(elimTimer);
    clearInterval(winTimer);
    clearInterval(lessonTimer);
    lessonOpen = false;
    taskModalOpen = false;
}

// "Volver al lobby": sin recargar, para conservar el socket y la plaza
function returnToLobby() {
    if (!lastRoom) return returnToMainMenu();
    hideAlarm();
    openLobby(lastRoom);
}

function returnToMainMenu() {
    if (socket && myRoomCode) socket.emit('leaveRoom', {}, () => {});
    clearSession();
    myRoomCode = null;
    lastRoom = null;
    qrShownFor = null;
    players = {};
    triangles = [];
    powerups = [];
    projectiles = [];
    hideAllModals();
    resetSpectate();
    hideAlarm();
    hide('lobby-modal');
    hideGameUI();
    show('main-menu');
    gameState = 'MENU';
    history.replaceState(null, '', location.pathname);
}

// ===================== HUD / alarma / avisos / sonido =====================
function updateHUD() {
    const me = players[mySocketId];
    if (me) {
        $('energy-timer').innerText = `${me.energy.toFixed(1)}s`;
        $('energy-bar-fill').style.width = `${Math.max(0, Math.min(100, (me.energy / ENERGIA_POR_TRIANGULO) * 100))}%`;
        if (lastEnergy !== null && me.energy > lastEnergy + 5) sfx.pickup(); // recogió un triángulo
        lastEnergy = me.energy;
        renderFxBar(me);
    }
    $('score-blue').innerText = scores.blue;
    $('score-red').innerText = scores.red;
}

function renderFxBar(me) {
    const bar = $('fx-bar');
    bar.innerHTML = '';
    for (const [k, v] of Object.entries(me.fx || {})) {
        const d = POWERUPS[k];
        if (!d) continue;
        const el = document.createElement('div');
        el.className = 'px-2 py-1 rounded-lg text-xs font-bold border border-white/40';
        el.style.background = d.color;
        el.style.color = '#0f172a';
        el.textContent = `${d.icon} ${d.name} ${'★'.repeat(v.tier)} ${Math.ceil(v.left)}s`;
        bar.appendChild(el);
    }
}

function showAlarm() {
    show('energy-warning');
    if (!alarmTimer) {
        sfx.alarm();
        alarmTimer = setInterval(() => sfx.alarm(), 1000);
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

function tone(freq, dur, type = 'square', delay = 0, vol = 0.05) {
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime + delay;
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
}

const sfx = {
    alarm: () => tone(880, 0.15, 'square'),
    pickup: () => { tone(1000, 0.07, 'sine'); tone(1400, 0.09, 'sine', 0.07); },
    power: () => [660, 880, 1100, 1320].forEach((f, i) => tone(f, 0.12, 'triangle', i * 0.08)),
    throw: () => tone(520, 0.08, 'sawtooth'),
    hit: () => tone(180, 0.25, 'sawtooth', 0, 0.07),
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 'triangle', i * 0.12)),
    lose: () => [330, 262, 196].forEach((f, i) => tone(f, 0.22, 'triangle', i * 0.15))
};

// ===================== Combate =====================
function canAct() {
    const me = players[mySocketId];
    return gameState === 'PLAYING' && me && !me.isFrozen && !isEliminated && !taskModalOpen && !paused && !spectating;
}

// aim opcional (clic); sin aim usa la última dirección de movimiento
function doAttack(ax, ay) {
    if (!canAct()) return;
    const t = performance.now();
    if (t - lastAttackAt < CD_ATAQUE_CLIENTE) return;
    lastAttackAt = t;
    if (ax === undefined || (Math.abs(ax) < 1 && Math.abs(ay) < 1)) { ax = lastDir.x; ay = lastDir.y; }
    socket.emit('attack', { dx: ax, dy: ay });
    sfx.throw();
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

    // Espectador: la cámara sigue a otro jugador
    if (spectating) {
        hideAlarm();
        let tg = players[specTargetId];
        if (!tg || tg.isFrozen || tg.disconnected) { spectateNext(); tg = players[specTargetId]; }
        if (tg) {
            camera.x += (tg.rx - canvas.width / 2 - camera.x) * 0.1;
            camera.y += (tg.ry - canvas.height / 2 - camera.y) * 0.1;
        }
        return;
    }

    // Alarma: solo de 10 s a 0 s y NUNCA con la pregunta/lección abierta
    const nodrain = me.fx && me.fx.nodrain;
    if (taskModalOpen || me.isFrozen || paused || isEliminated || nodrain) hideAlarm();
    else if (me.energy <= 10 && me.energy > 0) showAlarm();
    else hideAlarm();

    // Entrada (el servidor mueve; el cliente solo envía la intención)
    let vx = 0, vy = 0;
    if (canAct()) {
        if (keys['w'] || keys['arrowup']) vy -= 1;
        if (keys['s'] || keys['arrowdown']) vy += 1;
        if (keys['a'] || keys['arrowleft']) vx -= 1;
        if (keys['d'] || keys['arrowright']) vx += 1;
        if (joystick.active) { vx = joystick.x; vy = joystick.y; }
        const m = Math.hypot(vx, vy);
        if (m > 1) { vx /= m; vy /= m; }
        if (m > 0.2) lastDir = { x: vx / Math.max(m, 1), y: vy / Math.max(m, 1) };
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

// Power-ups: haz de luz vertical + aro pulsante + icono flotando (visibles de lejos)
function drawPowerups(t) {
    for (const u of powerups) {
        if (!u.active) continue;
        if (u.x < camera.x - 100 || u.x > camera.x + canvas.width + 100 || u.y < camera.y - 260 || u.y > camera.y + canvas.height + 100) continue;
        const d = POWERUPS[u.type];
        const pulse = 1 + Math.sin(t * 4 + u.id) * 0.12;
        const g = ctx.createLinearGradient(0, u.y - 220, 0, u.y);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(1, d.color + '99');
        ctx.fillStyle = g;
        ctx.fillRect(u.x - 14, u.y - 220, 28, 220);
        ctx.shadowColor = d.color;
        ctx.shadowBlur = 28;
        ctx.fillStyle = d.color + '55';
        ctx.strokeStyle = d.color;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(u.x, u.y, 44 * pulse, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.font = '34px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#fff';
        ctx.fillText(d.icon, u.x, u.y + 12 + Math.sin(t * 3 + u.id) * 4);
    }
}

function drawPlayer(p, isMe, t) {
    const meP = players[mySocketId];
    const moving = Math.hypot(p.x - p.rx, p.y - p.ry) > 1.5;
    const bob = moving ? Math.sin(t * 14) * 3 : 0;
    const color = p.team === 'blue' ? '#2563eb' : '#dc2626';
    const fx = p.fx || {};

    ctx.save();
    ctx.translate(p.rx, p.ry);

    // Camuflaje: los enemigos lo ven casi invisible a distancia
    let alpha = 1;
    if (p.disconnected) alpha = 0.4;
    if (fx.camo) {
        const far = meP ? Math.hypot(meP.rx - p.rx, meP.ry - p.ry) > 350 : true;
        alpha = isMe || (meP && meP.team === p.team) ? 0.55 : (far ? 0.1 : 0.55);
    }
    ctx.globalAlpha = alpha;

    // Portador de bandera: halo pulsante dorado (todos lo ven)
    if (p.hasFlag) {
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 4;
        ctx.globalAlpha = alpha * (0.5 + 0.4 * Math.sin(t * 8));
        ctx.beginPath();
        ctx.arc(0, 0, 48, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = alpha;
    }
    // Imán: aro tenue con su radio
    if (isMe && fx.magnet) {
        const r = [150, 250, 400][fx.magnet.tier - 1] || 150;
        ctx.strokeStyle = 'rgba(244,114,182,0.45)';
        ctx.setLineDash([10, 10]);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
    }

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
    ctx.fillStyle = p.isFrozen ? '#64748b' : (p.team === 'blue' ? '#1d4ed8' : '#b91c1c');
    ctx.fillRect(-26, -4, 10, 24);
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.roundRect(-18, -22, 36, 46, 16);
    ctx.fill();
    ctx.fillStyle = '#bae6fd';
    ctx.beginPath();
    ctx.ellipse(6, -8, 12, 8, 0, 0, Math.PI * 2);
    ctx.fill();
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

    // Burbuja de nieve (inmunidad)
    if (fx.bubble) {
        ctx.fillStyle = 'rgba(167,139,250,0.18)';
        ctx.strokeStyle = 'rgba(167,139,250,0.9)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, -2, 40, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    }
    // Aturdido
    if (p.stunned) {
        ctx.font = '18px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#fff';
        ctx.fillText('✨', Math.cos(t * 8) * 18, -46 + Math.sin(t * 8) * 4);
    }
    // Impacto reciente
    const h = hitFx[p.id];
    if (h && performance.now() - h < 400) {
        const k = (performance.now() - h) / 400;
        ctx.strokeStyle = `rgba(255,255,255,${1 - k})`;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(0, 0, 20 + k * 40, 0, Math.PI * 2);
        ctx.stroke();
    }

    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(15,23,42,0.8)';
    ctx.lineWidth = 3;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    const label = (isMe ? 'TÚ · ' : '') + p.nickname + (p.isBot ? ' 🤖' : '') + (p.hasFlag ? ' 🚩' : '');
    ctx.strokeText(label, 0, -56);
    ctx.fillText(label, 0, -56);
    ctx.restore();
}

// Flecha en el borde de la pantalla hacia un objetivo fuera de vista
function drawEdgeArrow(wx, wy, color, label) {
    const sx = wx - camera.x, sy = wy - camera.y;
    const W = canvas.width, H = canvas.height, m = 50;
    if (sx > m && sx < W - m && sy > m && sy < H - m) return; // ya se ve
    const cx = W / 2, cy = H / 2;
    const dx = sx - cx, dy = sy - cy;
    const k = Math.min((cx - m) / Math.max(Math.abs(dx), 1), (cy - m - 20) / Math.max(Math.abs(dy), 1));
    const ax = cx + dx * k, ay = cy + dy * k;
    const ang = Math.atan2(dy, dx);
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(ang);
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(15,23,42,0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(22, 0); ctx.lineTo(-12, -14); ctx.lineTo(-12, 14);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.restore();
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.strokeStyle = 'rgba(15,23,42,0.9)';
    ctx.lineWidth = 3;
    ctx.fillStyle = color;
    ctx.strokeText(label, ax, ay + 30);
    ctx.fillText(label, ax, ay + 30);
}

function drawArrows(me) {
    const myT = me.team, enT = myT === 'blue' ? 'red' : 'blue';
    const home = myT === 'blue' ? BASE_BLUE : BASE_RED;
    // Radar: apunta a la bandera enemiga
    if (me.fx && me.fx.radar && !me.hasFlag) drawEdgeArrow(flag[enT].x, flag[enT].y, '#4ade80', '📡 BANDERA');
    // Si llevo la bandera: apunta a mi base
    if (me.hasFlag) drawEdgeArrow(home.x, home.y, '#facc15', '🏠 LLÉVALA A TU BASE');
    // Si el enemigo lleva MI bandera: apunta al ladrón
    const mine = flag[myT];
    if (mine.carrierId && players[mine.carrierId]) {
        const c = players[mine.carrierId];
        drawEdgeArrow(c.rx, c.ry, '#f87171', '¡DETÉN AL LADRÓN!');
    } else if (!mine.carrierId && Math.hypot(mine.x - home.x, mine.y - home.y) > 5) {
        drawEdgeArrow(mine.x, mine.y, '#fb923c', 'TU BANDERA CAÍDA');
    }
}

function drawMinimap(me) {
    const S = mmCanvas.width, k = S / MAP_SIZE;
    mmCtx.clearRect(0, 0, S, S);
    mmCtx.fillStyle = 'rgba(224,242,254,0.85)';
    mmCtx.fillRect(0, 0, S, S);
    // bases
    [[BASE_BLUE, '#2563eb'], [BASE_RED, '#dc2626']].forEach(([b, c]) => {
        mmCtx.fillStyle = c + '66';
        mmCtx.beginPath(); mmCtx.arc(b.x * k, b.y * k, 150 * k + 3, 0, Math.PI * 2); mmCtx.fill();
    });
    // power-ups
    powerups.forEach((u) => {
        if (!u.active) return;
        mmCtx.fillStyle = POWERUPS[u.type].color;
        mmCtx.beginPath(); mmCtx.arc(u.x * k, u.y * k, 4, 0, Math.PI * 2); mmCtx.fill();
    });
    // banderas
    [['blue', '#2563eb'], ['red', '#dc2626']].forEach(([t, c]) => {
        const f = flag[t];
        mmCtx.fillStyle = c;
        mmCtx.fillRect(f.x * k - 4, f.y * k - 4, 8, 8);
        mmCtx.strokeStyle = '#facc15';
        mmCtx.lineWidth = 2;
        mmCtx.strokeRect(f.x * k - 4, f.y * k - 4, 8, 8);
    });
    // jugadores (los camuflados enemigos no aparecen)
    Object.values(players).forEach((p) => {
        if (p.isFrozen || p.disconnected) return;
        if (p.fx && p.fx.camo && me && p.team !== me.team) return;
        mmCtx.fillStyle = p.team === 'blue' ? '#1d4ed8' : '#b91c1c';
        mmCtx.beginPath(); mmCtx.arc(p.rx * k, p.ry * k, p.id === mySocketId ? 5 : 3, 0, Math.PI * 2); mmCtx.fill();
        if (p.id === mySocketId) { mmCtx.strokeStyle = '#fff'; mmCtx.lineWidth = 2; mmCtx.stroke(); }
    });
    // vista de la cámara
    mmCtx.strokeStyle = 'rgba(15,23,42,0.6)';
    mmCtx.lineWidth = 1;
    mmCtx.strokeRect(camera.x * k, camera.y * k, canvas.width * k, canvas.height * k);
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
    [[BASE_BLUE, 'rgba(37,99,235,0.18)', '#2563eb'], [BASE_RED, 'rgba(220,38,38,0.18)', '#dc2626']].forEach(([b, fill, stroke]) => {
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

    // Triángulos (solo recargan energía)
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

    drawPowerups(t);

    // Jugadores (el local al final para que quede encima)
    Object.values(players).filter((p) => p.id !== mySocketId).forEach((p) => drawPlayer(p, false, t));
    if (players[mySocketId]) drawPlayer(players[mySocketId], true, t);

    // Bolas de nieve
    for (const pr of projectiles) {
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = pr.team === 'blue' ? '#2563eb' : '#dc2626';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(pr.x, pr.y, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    }

    ctx.restore();

    if (gameState === 'PLAYING' && players[mySocketId]) {
        drawArrows(players[mySocketId]);
        drawMinimap(players[mySocketId]);
    }
}
