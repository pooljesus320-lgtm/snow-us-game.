// Panel de consulta de la base de datos. Protegido con la variable de entorno ADMIN_KEY.
// Sin ADMIN_KEY el panel queda desactivado (nadie puede ver los datos).
const crypto = require('crypto');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();

function csv(rows) {
    if (!rows.length) return '';
    const cols = Object.keys(rows[0]);
    const cell = (v) => {
        let t = v === null || v === undefined ? '' : String(v);
        if (/^[=+\-@]/.test(t)) t = "'" + t; // evita inyección de fórmulas en Excel
        return '"' + t.replace(/"/g, '""') + '"';
    };
    return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
}

module.exports = function registerAdmin(app, db) {
    const auth = (req, res, next) => {
        const key = process.env.ADMIN_KEY;
        if (!key) return res.status(403).send('Panel desactivado: define la variable de entorno ADMIN_KEY.');
        const given = req.query.clave || req.get('x-admin-key') || '';
        if (!crypto.timingSafeEqual(hash(given), hash(key))) return res.status(401).send('Clave incorrecta.');
        if (!db.enabled) return res.status(503).send('La base de datos no está disponible (requiere Node 22.5+).');
        res.set('Cache-Control', 'no-store');
        res.set('X-Robots-Tag', 'noindex');
        next();
    };

    app.get('/admin', auth, (req, res) => {
        const k = encodeURIComponent(req.query.clave || '');
        const s = db.summary();
        const list = db.listMatches(50);
        const niv = Object.entries(s.preguntas_por_nivel).map(([n, v]) => {
            const t = v.respondidas + v.rechazadas;
            return `<tr><td>Nivel ${esc(n)}</td><td>${v.respondidas}</td><td>${v.rechazadas}</td><td>${t ? Math.round((v.rechazadas / t) * 100) + '%' : '-'}</td></tr>`;
        }).join('');
        const filas = list.map((p) => `<tr><td><a href="/admin/api/partida/${esc(p.id)}?clave=${k}">${esc(p.id.slice(0, 8))}</a></td><td>${esc(p.modo)}</td><td>${esc(p.inicio)}</td><td>${esc(p.duracion_s)}s</td><td>${esc(p.ganador)}</td><td>${esc(p.motivo)}</td><td>${esc(p.humanos)}+${esc(p.bots)}🤖</td></tr>`).join('');
        res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Snow Us · Datos</title>
<style>body{font-family:system-ui;background:#0f172a;color:#e2e8f0;max-width:980px;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%;margin:.5rem 0 1.5rem}td,th{border:1px solid #334155;padding:.35rem .6rem;text-align:left;font-size:.9rem}th{background:#1e293b}a{color:#67e8f9}h1,h2{color:#67e8f9}.card{background:#1e293b;border-radius:12px;padding:1rem;margin-bottom:1rem}</style></head><body>
<h1>❄ Snow Us · Datos de partidas</h1>
<div class="card"><b>${s.partidas}</b> partidas · duración media <b>${s.duracion_media_s}s</b> · ganadores: ${s.por_ganador.map((g) => esc(g.ganador) + ': ' + g.c).join(', ') || '-'} · motivos: ${s.por_motivo.map((g) => esc(g.motivo) + ': ' + g.c).join(', ') || '-'}</div>
<h2>Privacidad: ¿cuántos jugadores responden?</h2>
<table><tr><th>Nivel</th><th>Respondieron</th><th>Prefirieron no responder</th><th>% que rechazó</th></tr>${niv}</table>
<h2>Descargas</h2>
<p><a href="/admin/api/export.csv?tabla=partidas&clave=${k}">partidas.csv</a> · <a href="/admin/api/export.csv?tabla=jugadores&clave=${k}">jugadores.csv</a> · <a href="/admin/api/export.csv?tabla=eventos&clave=${k}">eventos.csv</a> · <a href="/admin/api/partidas.json?clave=${k}">partidas.json</a> · <a href="/admin/api/resumen.json?clave=${k}">resumen.json</a></p>
<h2>Últimas 50 partidas</h2>
<table><tr><th>ID</th><th>Modo</th><th>Inicio</th><th>Duración</th><th>Ganador</th><th>Motivo</th><th>Jugadores</th></tr>${filas || '<tr><td colspan="7">Todavía no hay partidas.</td></tr>'}</table>
<p style="color:#94a3b8;font-size:.8rem">Solo estadísticas anónimas: sin apodos, sin IP y sin respuestas de las preguntas.</p></body></html>`);
    });

    app.get('/admin/api/resumen.json', auth, (req, res) => res.json(db.summary()));
    app.get('/admin/api/partidas.json', auth, (req, res) => res.json(db.listMatches(1000)));
    app.get('/admin/api/partida/:id', auth, (req, res) => {
        const m = db.getMatch(String(req.params.id));
        if (!m) return res.status(404).send('Partida no encontrada.');
        res.json(m);
    });
    app.get('/admin/api/export.csv', auth, (req, res) => {
        const tabla = String(req.query.tabla || 'partidas');
        const rows = db.table(tabla);
        res.set('Content-Type', 'text/csv; charset=utf-8');
        res.set('Content-Disposition', `attachment; filename="snowus_${tabla.replace(/[^a-z]/g, '')}.csv"`);
        res.send('\ufeff' + csv(rows)); // BOM para que Excel respete las tildes
    });
};
