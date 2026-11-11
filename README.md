# Snow Us - Captura la Bandera en la Nieve

Juego multijugador estilo Among Us con temática de nieve (Conejos Azules vs Venados Rojos).

## Estructura del Proyecto

```text
/mi-juego-snow-us
  ├── /public
  │     ├── index.html
  │     ├── game.js
  │     └── style.css
  ├── /server
  │     ├── index.js
  │     ├── rooms.js
  │     └── bot.js
  ├── package.json
  └── README.md
```

## Instrucciones para Ejecutar Localmente

1. Abre tu terminal en la carpeta del proyecto.
2. Instala las dependencias:
   ```bash
   npm install
   ```
3. Inicia el servidor Node.js:
   ```bash
   npm start
   ```
4. Abre tu navegador e ingresa a `http://localhost:3000`.

## Publicar Gratis en Render / Railway

1. Sube tu código a un repositorio en **GitHub**.
2. Entra a [Render.com](https://render.com) y crea un nuevo **Web Service**.
3. Conecta tu repositorio de GitHub.
4. Establece el **Build Command**: `npm install`
5. Establece el **Start Command**: `npm start`
6. Haz clic en **Create Web Service** y ¡listo!
