# Cerebro Personal Starter

MVP inicial:

- Telegram como entrada rápida.
- Gemini como clasificador JSON.
- Supabase como base real.
- Notion como espejo opcional, con bases y columnas creadas automáticamente.

## 0) Requisitos

Instalar Node.js 20 o superior.

Después, abrir una terminal dentro de esta carpeta y ejecutar:

```bash
npm install
```

## 1) Crear bot de Telegram

1. Abrir Telegram.
2. Buscar `@BotFather`.
3. Enviar `/newbot`.
4. Elegir nombre y username.
5. Copiar el token.

Ese token va en `.env` como:

```env
TELEGRAM_BOT_TOKEN=...
```

## 2) Crear proyecto Supabase

1. Crear un proyecto en Supabase.
2. Ir a Project Settings > API.
3. Copiar:
   - Project URL
   - service_role key

Ponerlos en `.env`:

```env
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

## 3) Crear las tablas en Supabase

Opción más simple:

1. Abrir Supabase.
2. Ir a SQL Editor.
3. Copiar todo el contenido de `supabase/schema.sql`.
4. Ejecutar.

Opción automática:

1. En Supabase, ir a Project Settings > Database > Connection string.
2. Copiar la connection string.
3. Pegarla en `.env`:

```env
SUPABASE_DB_URL=...
```

4. Ejecutar:

```bash
npm run setup:supabase
```

## 4) Crear clave Gemini

Crear una API key de Gemini y pegarla en `.env`:

```env
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
```

## 5) Notion opcional

Podés saltear este paso al principio. Si lo salteás, el bot igual guarda todo en Supabase.

Para activarlo:

1. Crear una integración interna de Notion.
2. Copiar el token.
3. Crear una página vacía en Notion llamada `Cerebro Personal`.
4. Compartir esa página con la integración.
5. Copiar el ID de la página.
6. Completar `.env`:

```env
NOTION_TOKEN=...
NOTION_PARENT_PAGE_ID=...
```

7. Ejecutar:

```bash
npm run setup:notion
```

Ese comando crea automáticamente estas bases:

- 🧠 Cerebro - Items
- 🧩 Cerebro - Entidades
- 🧠 Cerebro - Memorias
- 📎 Cerebro - Archivos
- ⚙️ Cerebro - Taxonomía

También crea `notion-databases.json`, que el bot usa para saber dónde guardar.

## 6) Probar clasificador

```bash
npm run test:classify -- "Compré café Martínez Colombia. Me gustó bastante, volvería a comprar."
```

Debe devolver JSON con categoría, tags, entidades y posibles memorias.

## 7) Ejecutar bot

```bash
npm run dev
```

Ahora mandale un mensaje al bot por Telegram.

Ejemplo:

```text
Hoy hice calibración de longitud de onda del HPLC Shimadzu LC-40. Dio pass, pero me quedó duda con el nivel de energía de la lámpara D2.
```

El bot debería responder algo como:

```text
Guardado.
Categoría: Trabajo
Subcategorías: Control de Calidad, Calibraciones
Tipo: Duda técnica
Estado: Pendiente
Tags: hplc, shimadzu, lc40, pda40, lampara-d2, calibracion
```

## Comandos disponibles

```text
/start
/buscar hplc lampara d2
/ultimos
/pendientes
/memorias
```

## Estado del MVP

Incluido:

- Texto desde Telegram.
- Clasificación IA.
- Guardado en Supabase.
- Entidades normalizadas básicas.
- Memorias sugeridas.
- Sincronización automática a Notion si está configurado.
- Búsqueda simple.

No incluido todavía:

- Audios.
- Fotos.
- Documentos.
- Embeddings / búsqueda semántica avanzada.
- Deploy permanente.
- Corrección conversacional tipo `corregir: ...`.
