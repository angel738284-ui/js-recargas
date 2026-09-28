const express = require("express");
const crypto = require("crypto");

const app = express();

const GOXTOP_BASE_URL = "https://goxtop.com/api/v.1";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_TELEGRAM_ID = "1051260349";

const sessions = new Map();

// Configuración del panel
const SALDO_ALERTA_USD = 10;
let saldoBajoAvisado = false;

// Resumen diario en memoria.
// Se conserva mientras el proceso de Render siga encendido.
const ventasDiarias = [];

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString("utf8");
  }
}));

// ======================================================
// SERVIDOR
// ======================================================

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "JS Recargas API funcionando"
  });
});

// ======================================================
// TELEGRAM
// ======================================================

async function telegram(method, body) {
  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();

  if (!data.ok) {
    console.error(`Telegram ${method}:`, data);
  }

  return data;
}

async function enviarMensaje(chatId, text, keyboard = null) {
  const body = {
    chat_id: chatId,
    text
  };

  if (keyboard) {
    body.reply_markup = keyboard;
  }

  return telegram("sendMessage", body);
}

async function editarMensaje(
  chatId,
  messageId,
  text,
  keyboard = null
) {
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text
  };

  if (keyboard) {
    body.reply_markup = keyboard;
  }

  return telegram("editMessageText", body);
}

async function borrarMensaje(chatId, messageId) {
  try {
    await telegram("deleteMessage", {
      chat_id: chatId,
      message_id: messageId
    });
  } catch (error) {
    console.error("No se pudo borrar mensaje:", error);
  }
}

async function responderBoton(callbackId, text = null) {
  const body = {
    callback_query_id: callbackId
  };

  if (text) {
    body.text = text;
  }

  return telegram("answerCallbackQuery", body);
}

function esAdmin(chatId) {
  return String(chatId) === ADMIN_TELEGRAM_ID;
}

// ======================================================
// GOXTOP
// ======================================================

async function obtenerSaldo() {
  const response = await fetch(
    `${GOXTOP_BASE_URL}/balance`,
    {
      headers: {
        "x-api-key": process.env.GOXTOP_API_KEY
      }
    }
  );

  let data;

  try {
    data = await response.json();
  } catch {
    data = {};
  }

  const result = {
    ok: response.ok,
    status: response.status,
    data
  };

  const saldo =
    extraerSaldo(data);

  if (
    response.ok &&
    saldo !== null
  ) {
    await revisarAlertaSaldo(
      saldo
    );
  }

  return result;
}

async function obtenerProductos() {
  const response = await fetch(
    `${GOXTOP_BASE_URL}/products/freefire_latam`,
    {
      headers: {
        "x-api-key": process.env.GOXTOP_API_KEY
      }
    }
  );

  let data;

  try {
    data = await response.json();
  } catch {
    data = {};
  }

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

function extraerProductos(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  return [];
}

function extraerSaldo(data) {
  const valor =
    data?.data?.wallet_balance ??
    data?.wallet_balance;

  const saldo = Number(valor);

  return Number.isFinite(saldo)
    ? saldo
    : null;
}

async function revisarAlertaSaldo(saldo) {
  if (!Number.isFinite(saldo)) {
    return;
  }

  if (saldo > SALDO_ALERTA_USD) {
    saldoBajoAvisado = false;
    return;
  }

  if (saldoBajoAvisado) {
    return;
  }

  saldoBajoAvisado = true;

  await enviarMensaje(
    ADMIN_TELEGRAM_ID,
    "⚠️ SALDO BAJO EN GOXTOP\n\n" +
    `💰 Saldo actual: ${saldo.toFixed(3)} USD\n` +
    `🔔 Límite de alerta: ${SALDO_ALERTA_USD.toFixed(2)} USD\n\n` +
    "Conviene recargar saldo antes de seguir vendiendo."
  );
}

// ======================================================
// VERIFICAR JUGADOR FREE FIRE
// ======================================================

async function verificarJugadorFreeFire(userid) {
  const uid = encodeURIComponent(userid);

  // 1) Verificador gratuito principal
  try {
    const response = await fetch(
      "https://freefireapis.lat/info-player?uid=" + uid + "&region=SAC",
      {
        method: "GET",
        headers: { "Accept": "application/json" }
      }
    );

    let data;
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    const basicInfo =
      data?.resultado?.basicInfo ??
      data?.result?.basicInfo ??
      data?.basicInfo ??
      null;

    const nickname =
      basicInfo?.nickname ??
      data?.resultado?.nickname ??
      data?.nickname ??
      null;

    const accountId =
      basicInfo?.accountId ??
      data?.resultado?.accountId ??
      data?.accountId ??
      null;

    const error =
      data?.error ??
      data?.message ??
      null;

    const noEncontrado =
      response.status === 404 &&
      (
        String(error || "").toUpperCase().includes("PLAYER_NOT_FOUND") ||
        String(error || "").toLowerCase().includes("not found")
      );

    if (noEncontrado) {
      return {
        ok: true,
        encontrado: false,
        status: 404,
        nickname: null,
        accountId: null,
        data
      };
    }

    if (
      response.ok &&
      data?.success !== false &&
      data?.exito !== false &&
      nickname
    ) {
      return {
        ok: true,
        encontrado: true,
        status: response.status,
        nickname,
        accountId,
        data
      };
    }
  } catch (error) {
    console.error("Verificador principal Free Fire:", error);
  }

  // 2) Respaldo Volsever
  if (!process.env.VOLSEVER_API_KEY) {
    throw new Error("No hay verificador de respaldo disponible");
  }

  const respaldo = await fetch(
    "https://gate.volsever.com/garena/api/v1/pagostore/free-fire/check-products" +
    "?id=" + uid +
    "&region=SAC",
    {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "X-API-Key": process.env.VOLSEVER_API_KEY
      }
    }
  );

  let dataRespaldo;
  try {
    dataRespaldo = await respaldo.json();
  } catch {
    dataRespaldo = {};
  }

  if (
    respaldo.status === 404 ||
    (
      dataRespaldo?.status === false &&
      Number(dataRespaldo?.code) === 404
    )
  ) {
    return {
      ok: true,
      encontrado: false,
      status: 404,
      nickname: null,
      accountId: null,
      data: dataRespaldo
    };
  }

  const nickname =
    dataRespaldo?.data?.username ??
    dataRespaldo?.username ??
    null;

  if (
    respaldo.ok &&
    dataRespaldo?.status !== false &&
    nickname
  ) {
    return {
      ok: true,
      encontrado: true,
      status: respaldo.status,
      nickname,
      accountId:
        dataRespaldo?.data?.user_id ??
        dataRespaldo?.user_id ??
        userid,
      data: dataRespaldo
    };
  }

  throw new Error(
    dataRespaldo?.message ||
    "Los verificadores de Free Fire no respondieron correctamente"
  );
}
// ======================================================
// PROMOS RD - VOLSEVER
// ======================================================

async function consultarPromosRD(userid) {
  if (!process.env.VOLSEVER_API_KEY) {
    throw new Error("VOLSEVER_API_KEY no configurada");
  }

  const url =
    "https://gate.volsever.com/garena/api/v1/pagostore/free-fire/check-discounts-paypal-dom" +
    "?id=" +
    encodeURIComponent(userid);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "X-API-Key": process.env.VOLSEVER_API_KEY
    }
  });

  let data;

  try {
    data = await response.json();
  } catch {
    data = {};
  }

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

function extraerPromosRD(data) {
  const items =
    data?.data?.discount_items ??
    data?.discount_items ??
    [];

  if (!Array.isArray(items)) {
    return [];
  }

  return items;
}

const PRECIOS_PROMO_RD = {
  110: 1300,
  341: 3600,
  572: 6200,
  1166: 12500,
  2398: 24000,
  5600: 53500
};

const PRECIOS_NORMAL_RD = {
  110: 1500,
  341: 4500,
  572: 8400,
  1166: 15000,
  2398: 25000,
  5600: 60000
};

const PAQUETES_PROMO_RD = [
  110,
  341,
  572,
  1166,
  2398,
  5600
];

function paquetePromoRD(item) {
  const diamantes = Number(item?.diamonds || 0);
  const bonus = Number(item?.bonus_diamonds || 0);
  const total = diamantes + bonus;

  if (diamantes === 5600 || total === 6160) {
    return 5600;
  }

  return total || diamantes;
}

function precioPesos(valor) {
  return "$" + Number(valor || 0).toLocaleString("es-AR");
}

function normalizarPaqueteVenta(producto) {
  const texto =
    String(
      producto?.Pack ??
      producto?.name ??
      producto ??
      ""
    );

  const conocidos = [
    6160,
    5600,
    2398,
    1166,
    572,
    341,
    110
  ];

  return (
    conocidos.find(
      numero =>
        texto.includes(
          String(numero)
        )
    ) ??
    null
  );
}

function precioVentaNormalArs(producto) {
  const paquete =
    normalizarPaqueteVenta(
      producto
    );

  if (paquete === 6160) {
    return PRECIOS_NORMAL_RD[5600] || 0;
  }

  return (
    PRECIOS_NORMAL_RD[
      paquete
    ] ||
    0
  );
}

function esRecargaCara(producto) {
  const paquete =
    normalizarPaqueteVenta(
      producto
    );

  return [
    2398,
    5600,
    6160
  ].includes(paquete);
}

function fechaArgentinaKey(
  fecha = new Date()
) {
  const partes =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          "America/Argentina/Cordoba",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }
    ).formatToParts(fecha);

  const get =
    tipo =>
      partes.find(
        p => p.type === tipo
      )?.value || "";

  return (
    get("year") +
    "-" +
    get("month") +
    "-" +
    get("day")
  );
}

function fechaArgentinaTexto(
  fecha = new Date()
) {
  return new Intl.DateTimeFormat(
    "es-AR",
    {
      timeZone:
        "America/Argentina/Cordoba",
      day: "2-digit",
      month: "2-digit",
      year: "numeric"
    }
  ).format(fecha);
}

function registrarVenta(venta) {
  ventasDiarias.push({
    fecha:
      new Date().toISOString(),
    dia:
      fechaArgentinaKey(),
    ...venta
  });

  if (
    ventasDiarias.length >
    500
  ) {
    ventasDiarias.splice(
      0,
      ventasDiarias.length - 500
    );
  }
}

function construirResumenDia() {
  const hoy =
    fechaArgentinaKey();

  const ventas =
    ventasDiarias.filter(
      venta =>
        venta.dia === hoy
    );

  const normales =
    ventas.filter(
      venta =>
        venta.tipo === "normal"
    );

  const promos =
    ventas.filter(
      venta =>
        venta.tipo === "promo"
    );

  const facturado =
    ventas.reduce(
      (total, venta) =>
        total +
        Number(
          venta.precioArs || 0
        ),
      0
    );

  const costoUsd =
    normales.reduce(
      (total, venta) =>
        total +
        Number(
          venta.costoUsd || 0
        ),
      0
    );

  let texto =
    "📊 RESUMEN DEL DÍA\n\n" +
    `📅 ${fechaArgentinaTexto()}\n\n` +
    `🧾 Ventas registradas: ${ventas.length}\n` +
    `💎 Recargas normales: ${normales.length}\n` +
    `🇩🇴 Promos registradas: ${promos.length}\n` +
    `💵 Facturado: ${precioPesos(facturado)} ARS\n` +
    `💳 Costo GoXTop: ${costoUsd.toFixed(3)} USD`;

  if (!ventas.length) {
    texto +=
      "\n\nTodavía no hay ventas registradas hoy.";
  } else {
    texto +=
      "\n\n🕘 ÚLTIMAS VENTAS\n";

    texto +=
      ventas
        .slice(-5)
        .reverse()
        .map(venta => {
          const tipo =
            venta.tipo === "promo"
              ? "🇩🇴"
              : "💎";

          const precio =
            venta.precioArs
              ? precioPesos(
                  venta.precioArs
                )
              : "sin precio ARS";

          return (
            `${tipo} ${venta.paquete} · ${precio} · ID ${venta.userid}`
          );
        })
        .join("\n");
  }

  texto +=
    "\n\nℹ️ Este resumen se reinicia si Render reinicia el servicio.";

  return texto;
}

// ======================================================
// RASTREAR ORDEN
// ======================================================

async function consultarOrden(partnerOrderId) {
  const response = await fetch(
    `${GOXTOP_BASE_URL}/${encodeURIComponent(partnerOrderId)}`,
    {
      method: "GET",
      headers: {
        "x-api-key": process.env.GOXTOP_API_KEY
      }
    }
  );

  let data;

  try {
    data = await response.json();
  } catch {
    data = {
      success: false,
      message: "Respuesta no válida de GoXTop"
    };
  }

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

function obtenerDatosOrden(respuesta, orderId) {
  const data =
    respuesta?.data?.data ??
    respuesta?.data ??
    {};

  const statusRaw =
    data.status ??
    data.order_status ??
    data.orderStatus ??
    data.state ??
    "UNKNOWN";

  const status =
    String(statusRaw).toUpperCase();

  let icono = "🔎";
  let titulo = "ESTADO DE LA ORDEN";
  let descripcion =
    `Estado: ${statusRaw}`;

  if (
    status === "SUCCESS" ||
    status === "COMPLETED" ||
    status === "COMPLETE" ||
    status === "SUCCESSFUL"
  ) {
    icono = "✅";
    titulo = "RECARGA COMPLETADA";
    descripcion =
      "GoXTop informa que la orden fue completada.";
  } else if (
    status === "FAILED" ||
    status === "FAIL" ||
    status === "CANCELLED" ||
    status === "CANCELED" ||
    status === "REJECTED"
  ) {
    icono = "❌";
    titulo = "RECARGA FALLIDA";
    descripcion =
      `GoXTop informa: ${statusRaw}`;
  } else if (
    status === "PENDING" ||
    status === "PROCESSING" ||
    status === "IN_PROGRESS" ||
    status === "QUEUED"
  ) {
    icono = "⏳";
    titulo = "RECARGA EN PROCESO";
    descripcion =
      `Estado actual: ${statusRaw}`;
  }

  const id =
    data.userid ??
    data.user_id ??
    data.player_id ??
    null;

  const producto =
    data.denom ??
    data.product ??
    data.product_name ??
    null;

  const precio =
    data.amount ??
    data.price ??
    data.cost ??
    null;

  let texto =
    `${icono} ${titulo}\n\n` +
    `📦 Orden:\n${orderId}\n\n`;

  if (id) {
    texto += `🆔 ID: ${id}\n`;
  }

  if (producto) {
    texto += `💎 Producto: ${producto}\n`;
  }

  if (precio !== null) {
    texto += `💵 Monto: $${precio}\n`;
  }

  texto += `\n${descripcion}`;

  return {
    texto,
    status
  };
}

// ======================================================
// CREAR RECARGA
// ======================================================

async function crearRecarga(order) {
  const partner_orderid =
    "JS-" +
    Date.now() +
    "-" +
    Math.random().toString(36).slice(2, 8);

  const response = await fetch(
    `${GOXTOP_BASE_URL}/create`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.GOXTOP_API_KEY
      },
      body: JSON.stringify({
        game: "freefire_latam",
        denom: order.denom,
        userid: order.userid,
        serverid: "",
        charname: "",
        partner_webhook_url:
          "https://js-recargas-2.onrender.com/webhook/order-status",
        partner_orderid
      })
    }
  );

  let data;

  try {
    data = await response.json();
  } catch {
    data = {
      success: false,
      message: "Respuesta no válida de GoXTop"
    };
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
    partner_orderid
  };
}// ======================================================
// TECLADOS
// ======================================================

function tecladoPrincipal() {
  return {
    inline_keyboard: [
      [
        {
          text: "💎 Nueva recarga",
          callback_data: "nueva"
        }
      ],
      [
        {
          text: "🇩🇴 Consultar promos",
          callback_data: "promos_rd"
        }
      ],
      [
        {
          text: "🔎 Rastrear orden",
          callback_data: "rastrear"
        }
      ],
      [
        {
          text: "💰 Saldo",
          callback_data: "saldo"
        },
        {
          text: "📦 Productos",
          callback_data: "productos"
        }
      ],
      [
        {
          text: "📊 Resumen del día",
          callback_data: "resumen_dia"
        }
      ]
    ]
  };
}

function tecladoVolver() {
  return {
    inline_keyboard: [
      [
        {
          text: "‹ Volver al menú",
          callback_data: "menu"
        }
      ]
    ]
  };
}

function tecladoOrden(orderId) {
  return {
    inline_keyboard: [
      [
        {
          text: "🔄 Actualizar estado",
          callback_data: `track:${orderId}`
        }
      ],
      [
        {
          text: "💎 Nueva recarga",
          callback_data: "nueva"
        }
      ],
      [
        {
          text: "🏠 Menú principal",
          callback_data: "menu"
        }
      ]
    ]
  };
}

// ======================================================
// MENÚ
// ======================================================

async function mostrarMenu(
  chatId,
  messageId = null
) {
  const texto =
    "🎮 JS RECARGAS\n\n" +
    "Panel de administración\n\n" +
    "Seleccioná una opción:";

  if (messageId) {
    await editarMensaje(
      chatId,
      messageId,
      texto,
      tecladoPrincipal()
    );

    return;
  }

  const result =
    await enviarMensaje(
      chatId,
      texto,
      tecladoPrincipal()
    );

  if (result.ok) {
    const session =
      sessions.get(
        String(chatId)
      ) || {};

    session.panelMessageId =
      result.result.message_id;

    session.estado = "menu";

    sessions.set(
      String(chatId),
      session
    );
  }
}

// ======================================================
// MOSTRAR ESTADO DE ORDEN
// ======================================================

async function mostrarEstadoOrden(
  chatId,
  messageId,
  orderId
) {
  await editarMensaje(
    chatId,
    messageId,
    "⏳ Consultando orden...\n\n" +
    `${orderId}`
  );

  try {
    const respuesta =
      await consultarOrden(orderId);

    if (!respuesta.ok) {
      const mensaje =
        respuesta.data?.message ||
        "No se pudo encontrar la orden.";

      await editarMensaje(
        chatId,
        messageId,
        "❌ NO SE PUDO CONSULTAR\n\n" +
        `📦 ${orderId}\n\n` +
        mensaje,
        {
          inline_keyboard: [
            [
              {
                text: "🔄 Intentar otra vez",
                callback_data:
                  `track:${orderId}`
              }
            ],
            [
              {
                text: "🔎 Otra orden",
                callback_data:
                  "rastrear"
              }
            ],
            [
              {
                text: "🏠 Menú",
                callback_data:
                  "menu"
              }
            ]
          ]
        }
      );

      return;
    }

    const resultado =
      obtenerDatosOrden(
        respuesta,
        orderId
      );

    await editarMensaje(
      chatId,
      messageId,
      resultado.texto,
      tecladoOrden(orderId)
    );

  } catch (error) {
    console.error(
      "Error rastreando orden:",
      error
    );

    await editarMensaje(
      chatId,
      messageId,
      "⚠️ ERROR DE CONEXIÓN\n\n" +
      `📦 ${orderId}\n\n` +
      "No se pudo consultar GoXTop.\n" +
      "Podés volver a intentarlo.",
      {
        inline_keyboard: [
          [
            {
              text: "🔄 Intentar otra vez",
              callback_data:
                `track:${orderId}`
            }
          ],
          [
            {
              text: "🏠 Menú",
              callback_data:
                "menu"
            }
          ]
        ]
      }
    );
  }
}

// ======================================================
// PRODUCTOS
// ======================================================

async function cargarProductos(
  chatId,
  messageId,
  paraRecarga = false
) {
  await editarMensaje(
    chatId,
    messageId,
    "⏳ Consultando catálogo..."
  );

  try {
    const result =
      await obtenerProductos();

    if (!result.ok) {
      await editarMensaje(
        chatId,
        messageId,
        "❌ No se pudo consultar el catálogo.",
        tecladoVolver()
      );

      return;
    }

    const productos =
      extraerProductos(result.data)
        .filter(
          p =>
            p.stockStatus ===
            "in_stock"
        );

    if (!productos.length) {
      await editarMensaje(
        chatId,
        messageId,
        "📦 No hay productos disponibles en este momento.",
        tecladoVolver()
      );

      return;
    }

    const session =
      sessions.get(
        String(chatId)
      ) || {};

    session.productos =
      productos;

    session.estado =
      paraRecarga
        ? "eligiendo_producto"
        : "viendo_productos";

    sessions.set(
      String(chatId),
      session
    );

    const filas = [];

    for (
      let i = 0;
      i < productos.length;
      i += 2
    ) {
      const fila = [];

      for (
        let j = i;
        j < i + 2 &&
        j < productos.length;
        j++
      ) {
        const p =
          productos[j];

        fila.push({
          text:
            `${p.name} · $${p.price}`,
          callback_data:
            `p:${j}`
        });
      }

      filas.push(fila);
    }

    filas.push([
      {
        text: "‹ Volver",
        callback_data:
          paraRecarga
            ? "cancelar"
            : "menu"
      }
    ]);

    const titulo =
      paraRecarga
        ? "💎 NUEVA RECARGA\n\n" +
          `🆔 ID: ${session.userid}\n` +
          (session.nickname
            ? `👤 Nombre: ${session.nickname}\n\n`
            : "\n") +
          "Elegí un producto:"
        : "📦 PRODUCTOS\n\n" +
          "Free Fire LATAM\n\n" +
          "Elegí un producto:";

    await editarMensaje(
      chatId,
      messageId,
      titulo,
      {
        inline_keyboard:
          filas
      }
    );

  } catch (error) {
    console.error(
      "Error catálogo:",
      error
    );

    await editarMensaje(
      chatId,
      messageId,
      "❌ No se pudo conectar con GoXTop.",
      tecladoVolver()
    );
  }
}

// ======================================================
// TELEGRAM WEBHOOK
// ======================================================

app.post(
  "/telegram/webhook",
  async (req, res) => {
    res.sendStatus(200);
    try {

      // ================================================
      // MENSAJES ESCRITOS
      // ================================================

      if (req.body.message) {
        const message =
          req.body.message;

        const chatId =
          message.chat.id;

        const text =
          (message.text || "")
            .trim();

        if (!esAdmin(chatId)) {
          await enviarMensaje(
            chatId,
            "⛔ Acceso no autorizado."
          );

          return;
        }

        // /start
        if (text === "/start") {
          const oldSession =
            sessions.get(
              String(chatId)
            );

          if (
            oldSession
              ?.panelMessageId
          ) {
            await borrarMensaje(
              chatId,
              oldSession
                .panelMessageId
            );
          }

          sessions.set(
            String(chatId),
            {
              estado: "menu"
            }
          );

          await mostrarMenu(
            chatId
          );

          return;
        }

        const session =
          sessions.get(
            String(chatId)
          );
// ESPERANDO ID PARA PROMOS RD
if (session?.estado === "esperando_id_promos") {
  await borrarMensaje(
    chatId,
    message.message_id
  );

  if (!/^\d+$/.test(text)) {
    await editarMensaje(
      chatId,
      session.panelMessageId,
      "❌ ID NO VÁLIDO\n\n" +
      "Escribí solamente números:",
      tecladoVolver()
    );

    return;
  }

  session.estado = "consultando_promos";

  sessions.set(
    String(chatId),
    session
  );

  await editarMensaje(
    chatId,
    session.panelMessageId,
    "🇩🇴 CONSULTANDO PROMOS\n\n" +
    `🆔 ID: ${text}\n\n` +
    "Consultando promociones disponibles..."
  );

  try {
    const resultado =
      await consultarPromosRD(text);

    if (
      resultado.status === 404 ||
      (
        resultado.data?.status === false &&
        resultado.data?.code === 404
      )
    ) {
      session.estado =
        "esperando_id_promos";

      sessions.set(
        String(chatId),
        session
      );

      await editarMensaje(
        chatId,
        session.panelMessageId,
        "❌ JUGADOR NO ENCONTRADO\n\n" +
        `🆔 ID: ${text}\n\n` +
        "Revisá el ID e intentá nuevamente.",
        tecladoVolver()
      );

      return;
    }

    if (
      !resultado.ok ||
      resultado.data?.status === false
    ) {
      throw new Error(
        "Volsever no disponible"
      );
    }

    const promos =
      extraerPromosRD(
        resultado.data
      );

    const promosActivas =
      new Set(
        promos
          .filter(
            item =>
              item?.is_discount === true
          )
          .map(paquetePromoRD)
      );

    const nombre =
      resultado.data?.data?.username ??
      resultado.data?.username ??
      null;

    let salida =
      "🇩🇴 ESTADO DE PROMOS\n\n" +
      (nombre
        ? `👤 ${nombre}\n`
        : "") +
      `🆔 ID: ${text}\n\n`;

    salida +=
      PAQUETES_PROMO_RD
        .map(paquete => {
          const activa =
            promosActivas.has(
              paquete
            );

          const precio =
            activa
              ? PRECIOS_PROMO_RD[
                  paquete
                ]
              : PRECIOS_NORMAL_RD[
                  paquete
                ];

          return (
            `💎 ${paquete} — ` +
            (
              activa
                ? "✅ Promo activa"
                : "❌ Sin promo"
            ) +
            ` — ${precioPesos(precio)}`
          );
        })
        .join("\n");

    session.estado =
      "promo_resultado";

    session.promoConsulta = {
      userid: text,
      nickname: nombre,
      promosActivas:
        Array.from(
          promosActivas
        )
    };

    sessions.set(
      String(chatId),
      session
    );

    const botonesPromo =
      Array.from(
        promosActivas
      )
        .sort(
          (a, b) => a - b
        )
        .map(paquete => [
          {
            text:
              `🛒 Preparar ${paquete} · ${precioPesos(PRECIOS_PROMO_RD[paquete])}`,
            callback_data:
              `promo_venta:${paquete}`
          }
        ]);

    botonesPromo.push(
      [
        {
          text: "🔎 Consultar otro ID",
          callback_data: "promos_rd"
        }
      ],
      [
        {
          text: "🏠 Menú principal",
          callback_data: "menu"
        }
      ]
    );

    await editarMensaje(
      chatId,
      session.panelMessageId,
      salida,
      {
        inline_keyboard:
          botonesPromo
      }
    );

  } catch (error) {
    console.error(
      "Error promos RD:",
      error
    );

    session.estado = "menu";

    sessions.set(
      String(chatId),
      session
    );

    await editarMensaje(
      chatId,
      session.panelMessageId,
      "⚠️ NO SE PUDIERON CONSULTAR LAS PROMOS\n\n" +
      "No se realizó ninguna recarga.",
      tecladoVolver()
    );
  }

  return;
        }
        // ESPERANDO ID
        if (
          session?.estado ===
          "esperando_id"
        ) {
          await borrarMensaje(
            chatId,
            message.message_id
          );

          if (
            !/^\d+$/.test(text)
          ) {
            await editarMensaje(
              chatId,
              session
                .panelMessageId,
              "❌ ID NO VÁLIDO\n\n" +
              "El ID debe contener solamente números.\n\n" +
              "Escribilo nuevamente:",
              {
                inline_keyboard: [
                  [
                    {
                      text:
                        "❌ Cancelar",
                      callback_data:
                        "cancelar"
                    }
                  ]
                ]
              }
            );

            return;
          }

          session.userid =
            text;

          session.estado =
            "verificando_jugador";

          sessions.set(
            String(chatId),
            session
          );

          await editarMensaje(
            chatId,
            session.panelMessageId,
            "🔎 VERIFICANDO JUGADOR\n\n" +
            `🆔 ID: ${session.userid}\n\n` +
            "Buscando la cuenta de Free Fire..."
          );

          try {
            const jugador =
              await verificarJugadorFreeFire(
                session.userid
              );

            if (!jugador.encontrado) {
              session.estado =
                "esperando_id";

              session.nickname =
                null;

              sessions.set(
                String(chatId),
                session
              );

              await editarMensaje(
                chatId,
                session.panelMessageId,
                "❌ JUGADOR NO ENCONTRADO\n\n" +
                `🆔 ID: ${session.userid}\n\n` +
                "No se encontró una cuenta de Free Fire con ese ID.\n\n" +
                "Revisalo y escribí el ID nuevamente:",
                {
                  inline_keyboard: [
                    [
                      {
                        text:
                          "❌ Cancelar",
                        callback_data:
                          "cancelar"
                      }
                    ]
                  ]
                }
              );

              return;
            }

            session.nickname =
              jugador.nickname;

            session.estado =
              "jugador_confirmado";

            sessions.set(
              String(chatId),
              session
            );

            await editarMensaje(
              chatId,
              session.panelMessageId,
              "✅ JUGADOR ENCONTRADO\n\n" +
              `🆔 ID: ${session.userid}\n` +
              `👤 Nombre: ${session.nickname}\n\n` +
              "¿Es la cuenta correcta?",
              {
                inline_keyboard: [
                  [
                    {
                      text:
                        "✅ Sí, continuar",
                      callback_data:
                        "jugador_ok"
                    }
                  ],
                  [
                    {
                      text:
                        "✏️ Cambiar ID",
                      callback_data:
                        "cambiar_id"
                    }
                  ],
                  [
                    {
                      text:
                        "❌ Cancelar",
                      callback_data:
                        "cancelar"
                    }
                  ]
                ]
              }
            );

          } catch (error) {
            console.error(
              "Error verificando jugador:",
              error
            );

            session.estado =
              "esperando_id";

            sessions.set(
              String(chatId),
              session
            );

            await editarMensaje(
              chatId,
              session.panelMessageId,
              "⚠️ NO SE PUDO VERIFICAR EL JUGADOR\n\n" +
              `🆔 ID: ${session.userid}\n\n` +
              "El servicio de verificación no respondió.\n" +
              "La recarga NO fue enviada.\n\n" +
              "Podés escribir el ID nuevamente o cancelar.",
              {
                inline_keyboard: [
                  [
                    {
                      text:
                        "❌ Cancelar",
                      callback_data:
                        "cancelar"
                    }
                  ]
                ]
              }
            );
          }

          return;
        }        // ESPERANDO ORDEN
        if (
          session?.estado ===
          "esperando_orden"
        ) {
          await borrarMensaje(
            chatId,
            message.message_id
          );

          const orderId =
            text.trim();

          if (
            !orderId ||
            orderId.length < 3
          ) {
            await editarMensaje(
              chatId,
              session
                .panelMessageId,
              "❌ ORDEN NO VÁLIDA\n\n" +
              "Escribí nuevamente el número de orden.",
              {
                inline_keyboard: [
                  [
                    {
                      text:
                        "❌ Cancelar",
                      callback_data:
                        "cancelar"
                    }
                  ]
                ]
              }
            );

            return;
          }

          session.ultimaOrden =
            orderId;

          session.estado =
            "consultando_orden";

          sessions.set(
            String(chatId),
            session
          );

          await mostrarEstadoOrden(
            chatId,
            session
              .panelMessageId,
            orderId
          );

          return;
        }

        // Mantener limpio el chat
        if (text !== "/start") {
          await borrarMensaje(
            chatId,
            message.message_id
          );
        }

        return;
      }

      // ================================================
      // BOTONES
      // ================================================

      if (
        req.body.callback_query
      ) {
        const callback =
          req.body
            .callback_query;

        const chatId =
          callback
            .message.chat.id;

        const messageId =
          callback
            .message.message_id;

        const data =
          callback.data;

        await responderBoton(
          callback.id
        );

        if (!esAdmin(chatId)) {
          return;
        }

        let session =
          sessions.get(
            String(chatId)
          ) || {};

        session.panelMessageId =
          messageId;

        sessions.set(
          String(chatId),
          session
        );

        // MENÚ
        if (data === "menu") {
          sessions.set(
            String(chatId),
            {
              panelMessageId:
                messageId,
              estado: "menu"
            }
          );

          await mostrarMenu(
            chatId,
            messageId
          );

          return;
        }
// CONSULTAR PROMOS RD
if (data === "promos_rd") {
  session = {
    panelMessageId: messageId,
    estado: "esperando_id_promos"
  };

  sessions.set(
    String(chatId),
    session
  );

  await editarMensaje(
    chatId,
    messageId,
    "🇩🇴 CONSULTAR PROMOS\n\n" +
    "Escribí el ID de Free Fire que querés consultar:",
    {
      inline_keyboard: [
        [
          {
            text: "❌ Cancelar",
            callback_data: "cancelar"
          }
        ]
      ]
    }
  );

  return;
}

// PREPARAR VENTA PROMO
if (
  data.startsWith(
    "promo_venta:"
  )
) {
  session =
    sessions.get(
      String(chatId)
    ) || {};

  const paquete =
    Number(
      data.substring(
        "promo_venta:".length
      )
    );

  const consulta =
    session.promoConsulta;

  if (
    !consulta ||
    !consulta.promosActivas
      ?.includes(paquete) ||
    !PRECIOS_PROMO_RD[paquete]
  ) {
    await mostrarMenu(
      chatId,
      messageId
    );
    return;
  }

  session.estado =
    "promo_preparada";

  session.promoSeleccionada =
    paquete;

  sessions.set(
    String(chatId),
    session
  );

  await editarMensaje(
    chatId,
    messageId,
    "🛒 VENTA PROMO PREPARADA\n\n" +
    `🆔 ID: ${consulta.userid}\n` +
    (
      consulta.nickname
        ? `👤 Nombre: ${consulta.nickname}\n`
        : ""
    ) +
    `💎 Promo: ${paquete}\n` +
    `💵 Precio: ${precioPesos(PRECIOS_PROMO_RD[paquete])}\n\n` +
    "⚠️ Esto NO compra la promo automáticamente.\n" +
    "Usá el botón de abajo solamente cuando quieras registrar la venta en el resumen.",
    {
      inline_keyboard: [
        [
          {
            text:
              "✅ Registrar venta",
            callback_data:
              `promo_registrar:${paquete}`
          }
        ],
        [
          {
            text:
              "🔎 Consultar otro ID",
            callback_data:
              "promos_rd"
          }
        ],
        [
          {
            text:
              "🏠 Menú",
            callback_data:
              "menu"
          }
        ]
      ]
    }
  );

  return;
}

// REGISTRAR VENTA PROMO
if (
  data.startsWith(
    "promo_registrar:"
  )
) {
  session =
    sessions.get(
      String(chatId)
    ) || {};

  const paquete =
    Number(
      data.substring(
        "promo_registrar:".length
      )
    );

  const consulta =
    session.promoConsulta;

  if (
    session.estado !==
      "promo_preparada" ||
    session.promoSeleccionada !==
      paquete ||
    !consulta ||
    !PRECIOS_PROMO_RD[paquete]
  ) {
    return;
  }

  registrarVenta({
    tipo: "promo",
    userid:
      consulta.userid,
    nickname:
      consulta.nickname,
    paquete,
    precioArs:
      PRECIOS_PROMO_RD[
        paquete
      ],
    costoUsd: 0
  });

  sessions.set(
    String(chatId),
    {
      panelMessageId:
        messageId,
      estado: "menu"
    }
  );

  await editarMensaje(
    chatId,
    messageId,
    "✅ VENTA PROMO REGISTRADA\n\n" +
    `🆔 ID: ${consulta.userid}\n` +
    (
      consulta.nickname
        ? `👤 Nombre: ${consulta.nickname}\n`
        : ""
    ) +
    `💎 Promo: ${paquete}\n` +
    `💵 Venta: ${precioPesos(PRECIOS_PROMO_RD[paquete])}\n\n` +
    "La venta fue sumada al resumen del día.\n" +
    "No se realizó ninguna recarga automática.",
    tecladoVolver()
  );

  return;
}

// RESUMEN DEL DÍA
if (
  data === "resumen_dia"
) {
  await editarMensaje(
    chatId,
    messageId,
    construirResumenDia(),
    tecladoVolver()
  );

  return;
}
        // NUEVA RECARGA
        if (data === "nueva") {
          session = {
            panelMessageId:
              messageId,
            estado:
              "esperando_id"
          };

          sessions.set(
            String(chatId),
            session
          );

          await editarMensaje(
            chatId,
            messageId,
            "💎 NUEVA RECARGA\n\n" +
            "Escribí el ID de Free Fire del jugador:",
            {
              inline_keyboard: [
                [
                  {
                    text:
                      "❌ Cancelar",
                    callback_data:
                      "cancelar"
                  }
                ]
              ]
            }
          );

          return;
        }

        // JUGADOR CONFIRMADO
        if (
          data === "jugador_ok"
        ) {
          session =
            sessions.get(
              String(chatId)
            );

          if (
            !session?.userid ||
            !session?.nickname ||
            session.estado !==
              "jugador_confirmado"
          ) {
            await mostrarMenu(
              chatId,
              messageId
            );

            return;
          }

          session.estado =
            "eligiendo_producto";

          sessions.set(
            String(chatId),
            session
          );

          await cargarProductos(
            chatId,
            messageId,
            true
          );

          return;
        }

        // CAMBIAR ID
        if (
          data === "cambiar_id"
        ) {
          session =
            sessions.get(
              String(chatId)
            ) || {};

          session.userid =
            null;

          session.nickname =
            null;

          session.estado =
            "esperando_id";

          session.panelMessageId =
            messageId;

          sessions.set(
            String(chatId),
            session
          );

          await editarMensaje(
            chatId,
            messageId,
            "💎 NUEVA RECARGA\n\n" +
            "Escribí el ID de Free Fire del jugador:",
            {
              inline_keyboard: [
                [
                  {
                    text:
                      "❌ Cancelar",
                    callback_data:
                      "cancelar"
                  }
                ]
              ]
            }
          );

          return;
        }

        // RASTREAR
        if (
          data === "rastrear"
        ) {
          session = {
            panelMessageId:
              messageId,
            estado:
              "esperando_orden"
          };

          sessions.set(
            String(chatId),
            session
          );

          await editarMensaje(
            chatId,
            messageId,
            "🔎 RASTREAR ORDEN\n\n" +
            "Escribí el número de la orden.\n\n" +
            "Ejemplo:\n" +
            "JS-1790580936155-6zzgln",
            {
              inline_keyboard: [
                [
                  {
                    text:
                      "❌ Cancelar",
                    callback_data:
                      "cancelar"
                  }
                ]
              ]
            }
          );

          return;
        }

        // ACTUALIZAR ESTADO
        if (
          data.startsWith(
            "track:"
          )
        ) {
          const orderId =
            data.substring(6);

          await mostrarEstadoOrden(
            chatId,
            messageId,
            orderId
          );

          return;
        }

        // CANCELAR
        if (data === "cancelar") {
          sessions.set(
            String(chatId),
            {
              panelMessageId:
                messageId,
              estado: "menu"
            }
          );

          await mostrarMenu(
            chatId,
            messageId
          );

          return;
        }

        // SALDO
        if (data === "saldo") {
          await editarMensaje(
            chatId,
            messageId,
            "⏳ Consultando saldo..."
          );

          try {
            const result =
              await obtenerSaldo();

            const saldo =
              extraerSaldo(
                result.data
              );

            if (
              !result.ok ||
              saldo === null
            ) {
              await editarMensaje(
                chatId,
                messageId,
                "❌ No se pudo consultar el saldo.",
                tecladoVolver()
              );

              return;
            }

            await editarMensaje(
              chatId,
              messageId,
              "💰 SALDO\n\n" +
              "Disponible en GoXTop:\n" +
              `$${saldo.toFixed(3)} USD` +
              (
                saldo <= SALDO_ALERTA_USD
                  ? "\n\n⚠️ SALDO BAJO: conviene cargar saldo."
                  : ""
              ),
              tecladoVolver()
            );

          } catch (error) {
            console.error(
              "Error saldo:",
              error
            );

            await editarMensaje(
              chatId,
              messageId,
              "❌ Error consultando el saldo.",
              tecladoVolver()
            );
          }

          return;
        }

        // PRODUCTOS
        if (
          data === "productos"
        ) {
          session.estado =
            "viendo_productos";

          sessions.set(
            String(chatId),
            session
          );

          await cargarProductos(
            chatId,
            messageId,
            false
          );

          return;
        }

        // ==============================================
        // PRODUCTO SELECCIONADO
        // ==============================================

        if (
          data.startsWith("p:")
        ) {
          session =
            sessions.get(
              String(chatId)
            );

          if (
            !session?.productos
          ) {
            await editarMensaje(
              chatId,
              messageId,
              "⌛ La sesión venció.",
              tecladoVolver()
            );

            return;
          }

          const index =
            Number(
              data.substring(2)
            );

          const producto =
            session
              .productos[index];

          if (!producto) {
            return;
          }

          // ============================================
          // SOLO VER PRODUCTO
          // ============================================

          if (
            session.estado ===
            "viendo_productos"
          ) {
            await editarMensaje(
              chatId,
              messageId,
              "📦 PRODUCTO\n\n" +
              `💎 ${producto.name}\n` +
              `💵 $${producto.price}\n` +
              "🟢 Disponible",
              {
                inline_keyboard: [
                  [
                    {
                      text:
                        "‹ Productos",
                      callback_data:
                        "productos"
                    }
                  ],
                  [
                    {
                      text:
                        "🏠 Menú",
                      callback_data:
                        "menu"
                    }
                  ]
                ]
              }
            );

            return;
          }

          // ============================================
          // PRODUCTO PARA RECARGA
          // ============================================

          if (
            session.estado ===
              "eligiendo_producto" &&
            session.userid
          ) {
            session.producto =
              producto;

            session.estado =
              "confirmando";

            sessions.set(
              String(chatId),
              session
            );

            await editarMensaje(
              chatId,
              messageId,
              "⏳ PREPARANDO RECARGA\n\n" +
              `🆔 ID: ${session.userid}\n` +
              (session.nickname
                ? `👤 Nombre: ${session.nickname}\n`
                : "") +
              `💎 Producto: ${producto.name}\n\n` +
              "Consultando saldo actual..."
            );

            try {
              const saldoResult =
                await obtenerSaldo();

              const saldo =
                extraerSaldo(
                  saldoResult.data
                );

              const costo =
                Number(
                  producto.price
                );

              if (
                !saldoResult.ok ||
                saldo === null ||
                !Number.isFinite(
                  costo
                )
              ) {
                session.estado =
                  "eligiendo_producto";

                sessions.set(
                  String(chatId),
                  session
                );

                await editarMensaje(
                  chatId,
                  messageId,
                  "⚠️ NO SE PUDO CONSULTAR EL SALDO\n\n" +
                  `🆔 ID: ${session.userid}\n` +
                  (session.nickname
                    ? `👤 Nombre: ${session.nickname}\n`
                    : "") +
                  `💎 Producto: ${producto.name}\n` +
                  `💵 Costo: $${producto.price}\n\n` +
                  "Por seguridad no se habilitó la confirmación.",
                  {
                    inline_keyboard: [
                      [
                        {
                          text:
                            "🔄 Intentar nuevamente",
                          callback_data:
                            `p:${index}`
                        }
                      ],
                      [
                        {
                          text:
                            "‹ Cambiar producto",
                          callback_data:
                            "volver_productos"
                        }
                      ],
                      [
                        {
                          text:
                            "❌ Cancelar",
                          callback_data:
                            "cancelar"
                        }
                      ]
                    ]
                  }
                );

                return;
              }

              const restante =
                saldo - costo;

              session.saldoAntes =
                saldo;

              session.saldoDespues =
                restante;

              sessions.set(
                String(chatId),
                session
              );

              // ========================================
              // SALDO INSUFICIENTE
              // ========================================

              if (restante < 0) {
                const faltante =
                  Math.abs(
                    restante
                  );

                session.estado =
                  "saldo_insuficiente";

                sessions.set(
                  String(chatId),
                  session
                );

                await editarMensaje(
                  chatId,
                  messageId,
                  "⚠️ SALDO INSUFICIENTE\n\n" +
                  "🎮 Free Fire LATAM\n" +
                  `🆔 ID: ${session.userid}\n` +
                  (session.nickname
                    ? `👤 Nombre: ${session.nickname}\n`
                    : "") +
                  `💎 Producto: ${producto.name}\n` +
                  `💵 Costo: $${costo.toFixed(3)}\n\n` +
                  `💰 Saldo actual: $${saldo.toFixed(3)}\n` +
                  `❌ Te faltan: $${faltante.toFixed(3)}\n\n` +
                  "No se puede confirmar esta recarga.",
                  {
                    inline_keyboard: [
                      [
                        {
                          text:
                            "‹ Cambiar producto",
                          callback_data:
                            "volver_productos"
                        }
                      ],
                      [
                        {
                          text:
                            "🏠 Menú",
                          callback_data:
                            "menu"
                        }
                      ]
                    ]
                  }
                );

                return;
              }              // ========================================
              // SALDO SUFICIENTE
              // ========================================

              await editarMensaje(
                chatId,
                messageId,
                "💎 CONFIRMAR RECARGA\n\n" +
                "🎮 Free Fire LATAM\n" +
                `🆔 ID: ${session.userid}\n` +
                (session.nickname
                  ? `👤 Nombre: ${session.nickname}\n`
                  : "") +
                `💎 Producto: ${producto.name}\n` +
                `💵 Costo: $${costo.toFixed(3)}\n\n` +
                `💰 Saldo actual: $${saldo.toFixed(3)}\n` +
                `💸 Después de recargar: $${restante.toFixed(3)}\n\n` +
                "Revisá los datos antes de continuar.",
                {
                  inline_keyboard: [
                    [
                      {
                        text:
                          "✅ Confirmar",
                        callback_data:
                          "confirmar"
                      }
                    ],
                    [
                      {
                        text:
                          "‹ Cambiar producto",
                        callback_data:
                          "volver_productos"
                      }
                    ],
                    [
                      {
                        text:
                          "❌ Cancelar",
                        callback_data:
                          "cancelar"
                      }
                    ]
                  ]
                }
              );

            } catch (error) {
              console.error(
                "Error consultando saldo:",
                error
              );

              session.estado =
                "eligiendo_producto";

              sessions.set(
                String(chatId),
                session
              );

              await editarMensaje(
                chatId,
                messageId,
                "⚠️ ERROR DE CONEXIÓN\n\n" +
                "No se pudo consultar el saldo de GoXTop.\n\n" +
                "Por seguridad no se habilitó la recarga.",
                {
                  inline_keyboard: [
                    [
                      {
                        text:
                          "‹ Volver",
                        callback_data:
                          "volver_productos"
                      }
                    ],
                    [
                      {
                        text:
                          "🏠 Menú",
                        callback_data:
                          "menu"
                      }
                    ]
                  ]
                }
              );
            }

            return;
          }
        }

        // ==============================================
        // VOLVER A PRODUCTOS
        // ==============================================

        if (
          data ===
          "volver_productos"
        ) {
          session =
            sessions.get(
              String(chatId)
            );

          if (
            !session?.userid
          ) {
            await mostrarMenu(
              chatId,
              messageId
            );

            return;
          }

          session.estado =
            "eligiendo_producto";

          session.producto =
            null;

          sessions.set(
            String(chatId),
            session
          );

          await cargarProductos(
            chatId,
            messageId,
            true
          );

          return;
        }

        // ==============================================
        // CONFIRMAR RECARGA
        // ==============================================

        if (
          data === "confirmar" ||
          data === "confirmar_cara"
        ) {
          session =
            sessions.get(
              String(chatId)
            );

          const confirmacionExtra =
            data ===
            "confirmar_cara";

          const estadoValido =
            confirmacionExtra
              ? session?.estado ===
                  "confirmacion_extra"
              : session?.estado ===
                  "confirmando";

          if (
            !session ||
            !estadoValido ||
            !session.producto ||
            !session.userid
          ) {
            return;
          }

          if (
            !confirmacionExtra &&
            esRecargaCara(
              session.producto
            )
          ) {
            session.estado =
              "confirmacion_extra";

            sessions.set(
              String(chatId),
              session
            );

            await editarMensaje(
              chatId,
              messageId,
              "🔐 CONFIRMACIÓN EXTRA\n\n" +
              "Esta es una recarga de importe alto.\n\n" +
              `🆔 ID: ${session.userid}\n` +
              (
                session.nickname
                  ? `👤 Nombre: ${session.nickname}\n`
                  : ""
              ) +
              `💎 Producto: ${session.producto.name}\n` +
              `💵 Costo GoXTop: ${Number(session.producto.price).toFixed(3)} USD\n\n` +
              "Confirmá una vez más antes de enviar la recarga.",
              {
                inline_keyboard: [
                  [
                    {
                      text:
                        "🔐 Sí, recargar ahora",
                      callback_data:
                        "confirmar_cara"
                    }
                  ],
                  [
                    {
                      text:
                        "‹ Cambiar producto",
                      callback_data:
                        "volver_productos"
                    }
                  ],
                  [
                    {
                      text:
                        "❌ Cancelar",
                      callback_data:
                        "cancelar"
                    }
                  ]
                ]
              }
            );

            return;
          }

          // Bloqueamos doble toque
          session.estado =
            "procesando";

          sessions.set(
            String(chatId),
            session
          );

          const order = {
            userid:
              session.userid,

            denom:
              session.producto.Pack ||
              session.producto.name,

            cantidad:
              session.producto.name,

            price:
              session.producto.price
          };

          // ============================================
          // REVISAR SALDO OTRA VEZ ANTES DE GASTAR
          // ============================================

          try {
            const saldoResult =
              await obtenerSaldo();

            const saldoActual =
              extraerSaldo(
                saldoResult.data
              );

            const costo =
              Number(
                order.price
              );

            if (
              !saldoResult.ok ||
              saldoActual === null ||
              !Number.isFinite(
                costo
              )
            ) {
              session.estado =
                "confirmando";

              sessions.set(
                String(chatId),
                session
              );

              await editarMensaje(
                chatId,
                messageId,
                "⚠️ NO SE PUDO VERIFICAR EL SALDO\n\n" +
                "La recarga NO fue enviada.\n\n" +
                "Intentá nuevamente.",
                {
                  inline_keyboard: [
                    [
                      {
                        text:
                          "‹ Volver",
                        callback_data:
                          "volver_productos"
                      }
                    ],
                    [
                      {
                        text:
                          "🏠 Menú",
                        callback_data:
                          "menu"
                      }
                    ]
                  ]
                }
              );

              return;
            }

            if (
              saldoActual < costo
            ) {
              const faltante =
                costo -
                saldoActual;

              session.estado =
                "saldo_insuficiente";

              sessions.set(
                String(chatId),
                session
              );

              await editarMensaje(
                chatId,
                messageId,
                "⚠️ SALDO INSUFICIENTE\n\n" +
                `💰 Saldo actual: $${saldoActual.toFixed(3)}\n` +
                `💵 Costo: $${costo.toFixed(3)}\n` +
                `❌ Te faltan: $${faltante.toFixed(3)}\n\n` +
                "La recarga NO fue enviada.",
                {
                  inline_keyboard: [
                    [
                      {
                        text:
                          "‹ Cambiar producto",
                        callback_data:
                          "volver_productos"
                      }
                    ],
                    [
                      {
                        text:
                          "🏠 Menú",
                        callback_data:
                          "menu"
                      }
                    ]
                  ]
                }
              );

              return;
            }

          } catch (error) {
            console.error(
              "Error verificando saldo:",
              error
            );

            session.estado =
              "confirmando";

            sessions.set(
              String(chatId),
              session
            );

            await editarMensaje(
              chatId,
              messageId,
              "⚠️ ERROR VERIFICANDO SALDO\n\n" +
              "La recarga NO fue enviada.",
              {
                inline_keyboard: [
                  [
                    {
                      text:
                        "🏠 Menú",
                      callback_data:
                        "menu"
                    }
                  ]
                ]
              }
            );

            return;
          }

          await editarMensaje(
            chatId,
            messageId,
            "⏳ PROCESANDO RECARGA\n\n" +
            `🆔 ${order.userid}\n` +
            (session.nickname
              ? `👤 ${session.nickname}\n`
              : "") +
            `💎 ${order.cantidad}\n\n` +
            "Enviando pedido a GoXTop...\n" +
            "No cierres ni repitas la operación."
          );

          try {
            const result =
              await crearRecarga(
                order
              );

            if (
              result.data
                ?.success === true
            ) {
              const orderId =
                result
                  .partner_orderid;

              const nickname =
                session.nickname;

              const paqueteVenta =
                normalizarPaqueteVenta(
                  session.producto
                ) ??
                order.cantidad;

              const precioVentaArs =
                precioVentaNormalArs(
                  session.producto
                );

              registrarVenta({
                tipo: "normal",
                userid:
                  order.userid,
                nickname,
                paquete:
                  paqueteVenta === 6160
                    ? 5600
                    : paqueteVenta,
                precioArs:
                  precioVentaArs,
                costoUsd:
                  Number(
                    order.price
                  ) || 0,
                orderId
              });

              sessions.set(
                String(chatId),
                {
                  panelMessageId:
                    messageId,
                  estado: "menu",
                  ultimaOrden:
                    orderId
                }
              );

              await editarMensaje(
                chatId,
                messageId,
                "✅ PEDIDO ACEPTADO\n\n" +
                `🆔 ID: ${order.userid}\n` +
                (nickname
                  ? `👤 Nombre: ${nickname}\n`
                  : "") +
                `💎 Producto: ${order.cantidad}\n` +
                `💵 Costo: $${order.price}\n\n` +
                "📦 Orden:\n" +
                `${orderId}\n\n` +
                "GoXTop aceptó el pedido.\n" +
                "Podés consultar su estado abajo.",
                tecladoOrden(
                  orderId
                )
              );

              return;
            }

            sessions.set(
              String(chatId),
              {
                panelMessageId:
                  messageId,
                estado: "menu"
              }
            );

            await editarMensaje(
              chatId,
              messageId,
              "❌ RECARGA NO COMPLETADA\n\n" +
              `🆔 ID: ${order.userid}\n` +
              `💎 Producto: ${order.cantidad}\n\n` +
              `${
                result.data
                  ?.message ||
                "GoXTop rechazó el pedido."
              }\n\n` +
              "No repitas la operación hasta revisar el estado.",
              {
                inline_keyboard: [
                  [
                    {
                      text:
                        "🏠 Menú",
                      callback_data:
                        "menu"
                    }
                  ]
                ]
              }
            );

          } catch (error) {
            console.error(
              "Error creando recarga:",
              error
            );

            sessions.set(
              String(chatId),
              {
                panelMessageId:
                  messageId,
                estado: "menu"
              }
            );

            await editarMensaje(
              chatId,
              messageId,
              "⚠️ ERROR DE COMUNICACIÓN\n\n" +
              "No se pudo confirmar el resultado del pedido.\n\n" +
              "No repitas la recarga hasta revisar GoXTop para evitar duplicados.",
              {
                inline_keyboard: [
                  [
                    {
                      text:
                        "🏠 Menú",
                      callback_data:
                        "menu"
                    }
                  ]
                ]
              }
            );
          }

          return;
        }
      }

    } catch (error) {
      console.error(
        "Error webhook Telegram:",
        error
      );
    }
  }
  );
  // ======================================================
// WEBHOOK GOXTOP
// ======================================================

app.post(
  "/webhook/order-status",
  (req, res) => {
    const timestamp =
      req.get(
        "X-Webhook-Timestamp"
      );

    const signature =
      req.get(
        "X-Webhook-Signature"
      );

    if (
      !timestamp ||
      !signature ||
      !process.env.SECRET_KEY
    ) {
      return res
        .status(401)
        .json({
          success: false
        });
    }

    const expected =
      crypto
        .createHmac(
          "sha256",
          process.env.SECRET_KEY
        )
        .update(
          timestamp +
          "." +
          req.rawBody
        )
        .digest("hex");

    try {
      const a =
        Buffer.from(signature);

      const b =
        Buffer.from(expected);

      if (
        a.length !== b.length ||
        !crypto.timingSafeEqual(
          a,
          b
        )
      ) {
        return res
          .status(401)
          .json({
            success: false
          });
      }

    } catch {
      return res
        .status(401)
        .json({
          success: false
        });
    }

    console.log(
      "Webhook GoXTop:",
      req.body
    );

    return res.json({
      success: true
    });
  }
);

// ======================================================
// PRODUCTOS API
// ======================================================

app.get(
  "/api/products/:gameCode",
  async (req, res) => {
    try {
      const response =
        await fetch(
          `${GOXTOP_BASE_URL}/products/${encodeURIComponent(req.params.gameCode)}`,
          {
            headers: {
              "x-api-key":
                process.env
                  .GOXTOP_API_KEY
            }
          }
        );

      const data =
        await response.json();

      return res
        .status(response.status)
        .json(data);

    } catch (error) {
      console.error(
        "Error productos API:",
        error
      );

      return res
        .status(500)
        .json({
          success: false
        });
    }
  }
);

// ======================================================
// INICIAR SERVIDOR
// ======================================================

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `JS Recargas ejecutándose en puerto ${PORT}`
  );
});