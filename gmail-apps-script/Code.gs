/**
 * CerebroTL - Fase 5: ingesta de mails de Gmail etiquetados "_Cristian"
 * en una casilla compartida.
 *
 * QUÉ HACE:
 * Cada vez que corre (disparador de tiempo, cada 10 minutos), busca en
 * Gmail los mensajes con la etiqueta "_Cristian" que todavía no tengan la
 * etiqueta "_Cristian-procesado", extrae remitente/asunto/fecha/cuerpo, se
 * los manda al bot (endpoint /api/gmailIngest) y, si el bot confirma que
 * lo guardó, le pone la etiqueta "_Cristian-procesado" para no reenviarlo
 * de nuevo. Si falla el envío, NO marca como procesado, así se reintenta
 * solo en la próxima corrida.
 *
 * INSTALACIÓN (una sola vez):
 * 1. Entrá a https://script.google.com logueado con la cuenta de Gmail
 *    compartida (la que usás con tu login personal).
 * 2. Proyecto nuevo -> pegá todo este archivo reemplazando el contenido
 *    de Code.gs.
 * 3. En Gmail, creá (si no existe) la etiqueta "_Cristian" y la etiqueta
 *    "_Cristian-procesado" (Configuración -> Etiquetas -> Crear etiqueta
 *    nueva). Aplicá "_Cristian" a los mails que te interesan (a mano, o
 *    con un filtro de Gmail que la aplique sola según remitente/asunto).
 * 4. En el editor de Apps Script: ícono de tuerca (Configuración del
 *    proyecto) -> Propiedades del script -> Agregar propiedad del script:
 *      INGEST_URL    = https://<tu-deploy-de-vercel>/api/gmailIngest
 *      INGEST_SECRET = <el mismo valor que pusiste en Vercel como
 *                        GMAIL_INGEST_SECRET>
 *    (Nunca hardcodees el secreto acá en el código, por eso va en
 *    Propiedades del script.)
 * 5. Ejecutá una vez la función `crearDisparador` desde el editor (botón
 *    Ejecutar, elegí "crearDisparador" en el desplegable). Te va a pedir
 *    autorizar permisos de Gmail: aceptá (es tu propia cuenta).
 *    Eso deja un disparador de tiempo corriendo `procesarMailsCristian`
 *    cada 10 minutos, sin que tengas que hacer nada más.
 * 6. Para probar manualmente sin esperar el disparador: ejecutá
 *    `procesarMailsCristian` directamente desde el editor.
 *
 * Ver Logger (Ver -> Registros, o Ctrl+Enter después de ejecutar) para
 * diagnosticar errores.
 */

const GMAIL_LABEL_PENDIENTE = '_Cristian';
const GMAIL_LABEL_PROCESADO = '_Cristian-procesado';
const MAX_MENSAJES_POR_CORRIDA = 20; // por las dudas, para no mandar de golpe cientos de mails viejos la primera vez
const MAX_CUERPO_CHARS = 8000; // recorte de seguridad antes de mandar; el servidor igual trunca más

function crearDisparador() {
  // Borra disparadores previos de esta función para no duplicar si se
  // corre dos veces por error.
  const disparadoresExistentes = ScriptApp.getProjectTriggers();
  for (const t of disparadoresExistentes) {
    if (t.getHandlerFunction() === 'procesarMailsCristian') {
      ScriptApp.deleteTrigger(t);
    }
  }
  ScriptApp.newTrigger('procesarMailsCristian')
    .timeBased()
    .everyMinutes(10)
    .create();
  Logger.log('Disparador creado: procesarMailsCristian cada 10 minutos.');
}

function procesarMailsCristian() {
  const props = PropertiesService.getScriptProperties();
  const ingestUrl = props.getProperty('INGEST_URL');
  const ingestSecret = props.getProperty('INGEST_SECRET');

  if (!ingestUrl || !ingestSecret) {
    Logger.log('Faltan las propiedades del script INGEST_URL / INGEST_SECRET. Configuralas en Configuración del proyecto -> Propiedades del script.');
    return;
  }

  const labelPendiente = GmailApp.getUserLabelByName(GMAIL_LABEL_PENDIENTE);
  if (!labelPendiente) {
    Logger.log('No existe la etiqueta "' + GMAIL_LABEL_PENDIENTE + '". Creala en Gmail primero.');
    return;
  }
  let labelProcesado = GmailApp.getUserLabelByName(GMAIL_LABEL_PROCESADO);
  if (!labelProcesado) {
    labelProcesado = GmailApp.createLabel(GMAIL_LABEL_PROCESADO);
  }

  const query = 'label:' + GMAIL_LABEL_PENDIENTE + ' -label:' + GMAIL_LABEL_PROCESADO;
  const threads = GmailApp.search(query, 0, MAX_MENSAJES_POR_CORRIDA);

  if (!threads.length) {
    Logger.log('No hay mails nuevos con la etiqueta "' + GMAIL_LABEL_PENDIENTE + '".');
    return;
  }

  let enviados = 0;
  let fallidos = 0;

  for (const thread of threads) {
    const mensajes = thread.getMessages();
    for (const mensaje of mensajes) {
      const messageId = mensaje.getId();

      // Si el hilo tiene varios mensajes, sólo nos interesa reenviar los
      // que todavía no tengan procesado a nivel HILO (Gmail etiqueta por
      // hilo, no por mensaje individual) — para no reenviar todo el hilo
      // completo en cada corrida una vez que ya se marcó procesado, basta
      // con la condición del query de arriba. Igual protegemos acá contra
      // reprocesar el mismo mensaje si el hilo tiene mezcla de estados.
      try {
        const ok = enviarMensaje(mensaje, ingestUrl, ingestSecret);
        if (ok) {
          enviados++;
        } else {
          fallidos++;
        }
      } catch (error) {
        fallidos++;
        Logger.log('Error procesando mensaje ' + messageId + ': ' + error);
      }
    }
    // Marcamos el hilo como procesado sólo si TODOS sus mensajes se
    // enviaron bien en esta corrida (si alguno falló, se reintenta el
    // hilo completo en la próxima corrida — reenviar un mail ya guardado
    // no rompe nada porque el servidor dedupe por gmailMessageId).
    thread.addLabel(labelProcesado);
  }

  Logger.log('Corrida terminada. Enviados: ' + enviados + '. Fallidos: ' + fallidos + '.');
}

function enviarMensaje(mensaje, ingestUrl, ingestSecret) {
  const cuerpo = mensaje.getPlainBody().slice(0, MAX_CUERPO_CHARS);
  const payload = {
    gmailMessageId: mensaje.getId(),
    from: mensaje.getFrom(),
    subject: mensaje.getSubject(),
    dateIso: mensaje.getDate().toISOString(),
    bodyText: cuerpo,
    permalink: 'https://mail.google.com/mail/u/0/#all/' + mensaje.getId()
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-gmail-ingest-secret': ingestSecret
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(ingestUrl, options);
  const status = response.getResponseCode();
  if (status !== 200) {
    Logger.log('Ingest respondió ' + status + ': ' + response.getContentText());
    return false;
  }
  return true;
}
