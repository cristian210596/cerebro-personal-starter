# Patch supervivencia Supabase + backup automatico

COPIAR:
- src/maintenance.ts
- src/telegram.ts
- api/cron.ts
- vercel.json

EJECUTAR SQL:
- ninguno

NO HACER:
- no ejecutar setup:notion
- no ejecutar SQL
- no tocar .env

Despues:
- GitHub Desktop -> commit: supervivencia backup automatico
- Push origin
- esperar redeploy de Vercel

Pruebas Telegram:
- /backup estado
- /backup auto probar
- /supervivencia

Que hace:
- Registra automaticamente el ultimo chat de Telegram en app_config.
- Agrega endpoint /api/cron.
- Agrega Vercel Cron diario a las 12:00 UTC.
- Cada corrida hace ping a Supabase para evitar pausa por inactividad.
- Si pasaron 7 dias desde el ultimo backup automatico, genera backup ZIP y lo manda por Telegram.
- /backup manual sigue funcionando igual.
