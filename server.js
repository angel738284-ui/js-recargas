const express = require("express");
const crypto = require("crypto");

const app = express();

const GOXTOP_BASE_URL = "https://goxtop.com/api/v.1";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_TELEGRAM_ID = "1051260349";

const sessions = new Map();

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

async function editarMensaje(chatId, messageId, text, keyboard = null) {
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
  const response = await fetch(`${GOXTOP_BASE_URL}/balance`, {
    headers: {
      "x-api-key": process.env.GOXTOP_API_KEY
    }
  });

  return {
    ok: response.ok,
    data: await response.json()
  };
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

  return {
    ok: response.ok,
    data: await response.json()
  };
}

function extraerProductos(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

async function crearRecarga(order) {
  const partner_orderid =
    "JS-" +
    Date.now() +
    "-" +
    Math.random().toString(36).slice(2, 8);

  const response = await fetch(`${GOXTOP_BASE_URL}/create`, {
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
  });

  return {
    ok: response.ok,
    data: await response.json(),
    partner_orderid
  };
}

// ======================================================
// INTERFAZ
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
          text: "💰 Saldo",
          callback_data: "saldo"
        },
        {
          text: "📦 Productos",
          callback_data: "productos"
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

async function mostrarMenu(chatId, messageId = null) {
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

  const result = await enviarMensaje(
    chatId,
    texto,
    tecladoPrincipal()
  );

  if (result.ok) {
    const session = sessions.get(String(chatId)) || {};
    session.panelMessageId = result.result.message_id;
    session.estado = "menu";
    sessions.set(String(chatId), session);
  }
}

// ======================================================
// PRODUCTOS
// ======================================================

async function cargarProductos(chatId, messageId, paraRecarga = false) {
  await editarMensaje(
    chatId,
    messageId,
    "⏳ Consultando catálogo..."
  );

  try {
    const result = await obtenerProductos();

    if (!result.ok) {
      await editarMensaje(
        chatId,
        messageId,
        "❌ No se pudo consultar el catálogo.",
        tecladoVolver()
      );
      return;
    }

    const productos = extraerProductos(result.data)
      .filter(p => p.stockStatus === "in_stock");

    if (!productos.length) {
      await editarMensaje(
        chatId,
        messageId,
        "📦 No hay productos disponibles en este momento.",
        tecladoVolver()
      );
      return;
    }

    const session = sessions.get(String(chatId)) || {};

    session.productos = productos;
    session.estado = paraRecarga
      ? "eligiendo_producto"
      : "viendo_productos";

    sessions.set(String(chatId), session);

    const filas = [];

    for (let i = 0; i < productos.length; i += 2) {
      const fila = [];

      for (
        let j = i;
        j < i + 2 && j < productos.length;
        j++
      ) {
        const p = productos[j];

        fila.push({
          text: `${p.name} · $${p.price}`,
          callback_data: `p:${j}`
        });
      }

      filas.push(fila);
    }

    filas.push([
      {
        text: "‹ Volver",
        callback_data: paraRecarga ? "cancelar" : "menu"
      }
    ]);

    const titulo = paraRecarga
      ? `💎 NUEVA RECARGA\n\n🆔 ID: ${session.userid}\n\nElegí un producto:`
      : "📦 PRODUCTOS\n\nFree Fire LATAM\n\nElegí un producto para ver su información:";

    await editarMensaje(
      chatId,
      messageId,
      titulo,
      {
        inline_keyboard: filas
      }
    );

  } catch (error) {
    console.error("Error catálogo:", error);

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

app.post("/telegram/webhook", async (req, res) => {
  res.sendStatus(200);

  try {

    // ==================================================
    // MENSAJES ESCRITOS
    // ==================================================

    if (req.body.message) {
      const message = req.body.message;
      const chatId = message.chat.id;
      const text = (message.text || "").trim();

      if (!esAdmin(chatId)) {
        await enviarMensaje(
          chatId,
          "⛔ Acceso no autorizado."
        );
        return;
      }

      // /start
      if (text === "/start") {
        const oldSession = sessions.get(String(chatId));

        // Intentamos borrar el panel anterior para no duplicarlo
        if (oldSession?.panelMessageId) {
          await borrarMensaje(
            chatId,
            oldSession.panelMessageId
          );
        }

        sessions.set(String(chatId), {
          estado: "menu"
        });

        await mostrarMenu(chatId);
        return;
      }

      const session = sessions.get(String(chatId));

      // Esperando ID
      if (session?.estado === "esperando_id") {

        // Borramos el mensaje escrito por vos para mantener limpio el chat
        await borrarMensaje(
          chatId,
          message.message_id
        );

        if (!/^\d+$/.test(text)) {
          await editarMensaje(
            chatId,
            session.panelMessageId,
            "❌ ID NO VÁLIDO\n\n" +
            "El ID debe contener solamente números.\n\n" +
            "Escribilo nuevamente:",
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

        session.userid = text;
        session.estado = "eligiendo_producto";

        sessions.set(String(chatId), session);

        await cargarProductos(
          chatId,
          session.panelMessageId,
          true
        );

        return;
      }

      // Si escribe algo fuera del flujo, borramos ese mensaje
      // y mantenemos el panel.
      if (text !== "/start") {
        await borrarMensaje(
          chatId,
          message.message_id
        );
      }

      return;
    }

    // ==================================================
    // BOTONES
    // ==================================================

    if (req.body.callback_query) {
      const callback = req.body.callback_query;

      const chatId = callback.message.chat.id;
      const messageId = callback.message.message_id;
      const data = callback.data;

      await responderBoton(callback.id);

      if (!esAdmin(chatId)) {
        return;
      }

      let session =
        sessions.get(String(chatId)) || {};

      session.panelMessageId = messageId;
      sessions.set(String(chatId), session);

      // MENU
      if (data === "menu") {
        sessions.set(String(chatId), {
          panelMessageId: messageId,
          estado: "menu"
        });

        await mostrarMenu(
          chatId,
          messageId
        );

        return;
      }

      // NUEVA RECARGA
      if (data === "nueva") {
        session = {
          panelMessageId: messageId,
          estado: "esperando_id"
        };

        sessions.set(String(chatId), session);

        await editarMensaje(
          chatId,
          messageId,
          "💎 NUEVA RECARGA\n\n" +
          "Escribí el ID de Free Fire del jugador:",
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

      // CANCELAR
      if (data === "cancelar") {
        sessions.set(String(chatId), {
          panelMessageId: messageId,
          estado: "menu"
        });

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
          const result = await obtenerSaldo();

          if (!result.ok) {
            await editarMensaje(
              chatId,
              messageId,
              "❌ No se pudo consultar el saldo.",
              tecladoVolver()
            );

            return;
          }

          const balance =
            result.data?.data?.wallet_balance ??
            result.data?.wallet_balance ??
            "No disponible";

          await editarMensaje(
            chatId,
            messageId,
            "💰 SALDO\n\n" +
            `Disponible en GoXTop:\n$${balance} USD`,
            tecladoVolver()
          );

        } catch {
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
      if (data === "productos") {
        session.estado = "viendo_productos";

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

      // PRODUCTO
      if (data.startsWith("p:")) {
        session =
          sessions.get(String(chatId));

        if (!session?.productos) {
          await editarMensaje(
            chatId,
            messageId,
            "⌛ La sesión venció.",
            tecladoVolver()
          );

          return;
        }

        const index = Number(
          data.substring(2)
        );

        const producto =
          session.productos[index];

        if (!producto) {
          await responderBoton(
            callback.id,
            "Producto no disponible"
          );

          return;
        }

        // Solo mirando catálogo
        if (session.estado === "viendo_productos") {
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
                    text: "‹ Productos",
                    callback_data: "productos"
                  }
                ],
                [
                  {
                    text: "🏠 Menú",
                    callback_data: "menu"
                  }
                ]
              ]
            }
          );

          return;
        }

        // Seleccionando para recarga
        if (
          session.estado === "eligiendo_producto" &&
          session.userid
        ) {
          session.producto = producto;
          session.estado = "confirmando";

          sessions.set(
            String(chatId),
            session
          );

          await editarMensaje(
            chatId,
            messageId,
            "💎 CONFIRMAR RECARGA\n\n" +
            "🎮 Free Fire LATAM\n" +
            `🆔 ID: ${session.userid}\n` +
            `💎 Producto: ${producto.name}\n` +
            `💵 Costo: $${producto.price}\n\n` +
            "Revisá los datos antes de continuar.",
            {
              inline_keyboard: [
                [
                  {
                    text: "✅ Confirmar",
                    callback_data: "confirmar"
                  }
                ],
                [
                  {
                    text: "‹ Cambiar producto",
                    callback_data: "volver_productos"
                  }
                ],
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
      }

      // VOLVER A PRODUCTOS
      if (data === "volver_productos") {
        session =
          sessions.get(String(chatId));

        if (!session?.userid) {
          await mostrarMenu(
            chatId,
            messageId
          );

          return;
        }

        session.estado =
          "eligiendo_producto";

        session.producto = null;

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

      // ==================================================
      // CONFIRMAR RECARGA
      // ==================================================

      if (data === "confirmar") {
        session =
          sessions.get(String(chatId));

        if (
          !session ||
          session.estado !== "confirmando" ||
          !session.producto ||
          !session.userid
        ) {
          await responderBoton(
            callback.id,
            "No hay una recarga pendiente."
          );

          return;
        }

        // Bloqueo inmediato contra doble toque
        session.estado = "procesando";

        sessions.set(
          String(chatId),
          session
        );

        const order = {
          userid: session.userid,
          denom:
            session.producto.Pack ||
            session.producto.name,
          cantidad:
            session.producto.name,
          price:
            session.producto.price
        };

        await editarMensaje(
          chatId,
          messageId,
          "⏳ PROCESANDO RECARGA\n\n" +
          `🆔 ${order.userid}\n` +
          `💎 ${order.cantidad}\n\n` +
          "Enviando pedido a GoXTop...\n" +
          "No cierres ni repitas la operación."
        );

        try {
          const result =
            await crearRecarga(order);

          // Si GoXTop aceptó
          if (result.data?.success === true) {

            sessions.set(
              String(chatId),
              {
                panelMessageId: messageId,
                estado: "menu"
              }
            );

            await editarMensaje(
              chatId,
              messageId,
              "✅ RECARGA ENVIADA\n\n" +
              `🆔 ID: ${order.userid}\n` +
              `💎 Producto: ${order.cantidad}\n` +
              `💵 Costo: $${order.price}\n\n` +
              `📦 ${result.partner_orderid}\n\n` +
              "GoXTop aceptó el pedido.",
              {
                inline_keyboard: [
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
              }
            );

            return;
          }

          // Pedido rechazado
          sessions.set(
            String(chatId),
            {
              panelMessageId: messageId,
              estado: "menu"
            }
          );

          await editarMensaje(
            chatId,
            messageId,
            "❌ RECARGA NO COMPLETADA\n\n" +
            `🆔 ID: ${order.userid}\n` +
            `💎 Producto: ${order.cantidad}\n\n` +
            `${result.data?.message || "GoXTop rechazó el pedido."}\n\n` +
            "No repitas la operación hasta revisar el estado.",
            {
              inline_keyboard: [
                [
                  {
                    text: "🏠 Volver al menú",
                    callback_data: "menu"
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
              panelMessageId: messageId,
              estado: "menu"
            }
          );

          await editarMensaje(
            chatId,
            messageId,
            "⚠️ ERROR DE COMUNICACIÓN\n\n" +
            "No se pudo confirmar el resultado del pedido.\n\n" +
            "No repitas la recarga hasta revisar GoXTop, para evitar duplicados.",
            {
              inline_keyboard: [
                [
                  {
                    text: "🏠 Menú",
                    callback_data: "menu"
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
});

// ======================================================
// WEBHOOK GOXTOP
// ======================================================

app.post("/webhook/order-status", (req, res) => {
  const timestamp =
    req.get("X-Webhook-Timestamp");

  const signature =
    req.get("X-Webhook-Signature");

  if (
    !timestamp ||
    !signature ||
    !process.env.SECRET_KEY
  ) {
    return res
      .status(401)
      .json({ success: false });
  }

  const expected =
    crypto
      .createHmac(
        "sha256",
        process.env.SECRET_KEY
      )
      .update(
        timestamp + "." + req.rawBody
      )
      .digest("hex");

  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);

    if (
      a.length !== b.length ||
      !crypto.timingSafeEqual(a, b)
    ) {
      return res
        .status(401)
        .json({ success: false });
    }

  } catch {
    return res
      .status(401)
      .json({ success: false });
  }

  console.log(
    "Webhook GoXTop:",
    req.body
  );

  return res.json({
    success: true
  });
});

// ======================================================
// PRODUCTOS API
// ======================================================

app.get(
  "/api/products/:gameCode",
  async (req, res) => {
    try {
      const response = await fetch(
        `${GOXTOP_BASE_URL}/products/${encodeURIComponent(req.params.gameCode)}`,
        {
          headers: {
            "x-api-key":
              process.env.GOXTOP_API_KEY
          }
        }
      );

      const data =
        await response.json();

      return res
        .status(response.status)
        .json(data);

    } catch {
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
