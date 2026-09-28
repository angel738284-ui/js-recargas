const express = require("express");
const crypto = require("crypto");

const app = express();

const GOXTOP_BASE_URL = "https://goxtop.com/api/v.1";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Única cuenta autorizada
const ADMIN_TELEGRAM_ID = "1051260349";

// Sesiones temporales
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

  return response.json();
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

async function responderBoton(callbackId) {
  return telegram("answerCallbackQuery", {
    callback_query_id: callbackId
  });
}

function esAdmin(id) {
  return String(id) === ADMIN_TELEGRAM_ID;
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
// MENÚ
// ======================================================

async function mostrarMenu(chatId) {
  await enviarMensaje(
    chatId,
    "🎮 JS RECARGAS\n\n¿Qué querés hacer?",
    {
      inline_keyboard: [
        [
          {
            text: "💎 Nueva recarga",
            callback_data: "nueva_recarga"
          }
        ],
        [
          {
            text: "💰 Ver saldo",
            callback_data: "saldo"
          },
          {
            text: "📦 Productos",
            callback_data: "productos"
          }
        ]
      ]
    }
  );
}

// ======================================================
// MOSTRAR PRODUCTOS COMO BOTONES
// ======================================================

async function mostrarProductos(chatId) {
  const result = await obtenerProductos();

  if (!result.ok) {
    await enviarMensaje(
      chatId,
      "❌ No pude consultar los productos de GoXTop."
    );
    return;
  }

  const productos = extraerProductos(result.data)
    .filter(p => p.stockStatus === "in_stock");

  if (!productos.length) {
    await enviarMensaje(
      chatId,
      "❌ No hay productos disponibles."
    );
    return;
  }

  const session = sessions.get(String(chatId));

  if (session) {
    session.productos = productos;
  }

  const botones = [];

  for (let i = 0; i < productos.length; i += 2) {
    const fila = [];

    for (let j = i; j < i + 2 && j < productos.length; j++) {
      const p = productos[j];

      fila.push({
        text: `${p.name} • $${p.price}`,
        callback_data: `producto_${j}`
      });
    }

    botones.push(fila);
  }

  botones.push([
    {
      text: "❌ Cancelar",
      callback_data: "cancelar"
    }
  ]);

  await enviarMensaje(
    chatId,
    "💎 Elegí el producto:",
    {
      inline_keyboard: botones
    }
  );
}

// ======================================================
// WEBHOOK TELEGRAM
// ======================================================

app.post("/telegram/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    // --------------------------------------------------
    // MENSAJES NORMALES
    // --------------------------------------------------

    if (req.body.message) {
      const message = req.body.message;

      const chatId = message.chat.id;
      const text = (message.text || "").trim();

      if (!esAdmin(chatId)) {
        await enviarMensaje(
          chatId,
          "⛔ No estás autorizado para utilizar JS Recargas."
        );
        return;
      }

      if (text === "/start") {
        sessions.delete(String(chatId));
        await mostrarMenu(chatId);
        return;
      }

      if (text === "/saldo") {
        const result = await obtenerSaldo();

        if (!result.ok) {
          await enviarMensaje(
            chatId,
            "❌ No pude consultar el saldo."
          );
          return;
        }

        const balance =
          result.data?.data?.wallet_balance ??
          result.data?.wallet_balance ??
          "No disponible";

        await enviarMensaje(
          chatId,
          `💰 Saldo GoXTop:\n\n$${balance} USD`
        );

        return;
      }

      // Esperando ID del jugador
      const session = sessions.get(String(chatId));

      if (session?.estado === "esperando_id") {
        if (!/^\d+$/.test(text)) {
          await enviarMensaje(
            chatId,
            "❌ El ID debe contener solamente números.\n\nIntentá nuevamente:"
          );
          return;
        }

        session.userid = text;
        session.estado = "eligiendo_producto";

        await enviarMensaje(
          chatId,
          `🆔 ID recibido:\n${text}\n\nAhora elegí el paquete.`
        );

        await mostrarProductos(chatId);
        return;
      }

      await mostrarMenu(chatId);
      return;
    }

    // --------------------------------------------------
    // BOTONES
    // --------------------------------------------------

    if (req.body.callback_query) {
      const callback = req.body.callback_query;

      const chatId = callback.message.chat.id;
      const data = callback.data;

      await responderBoton(callback.id);

      if (!esAdmin(chatId)) {
        await enviarMensaje(
          chatId,
          "⛔ No estás autorizado."
        );
        return;
      }

      // NUEVA RECARGA
      if (data === "nueva_recarga") {
        sessions.set(String(chatId), {
          estado: "esperando_id"
        });

        await enviarMensaje(
          chatId,
          "💎 NUEVA RECARGA\n\nEscribí el ID de Free Fire del jugador:"
        );

        return;
      }

      // SALDO
      if (data === "saldo") {
        const result = await obtenerSaldo();

        if (!result.ok) {
          await enviarMensaje(
            chatId,
            "❌ No pude consultar el saldo."
          );
          return;
        }

        const balance =
          result.data?.data?.wallet_balance ??
          result.data?.wallet_balance ??
          "No disponible";

        await enviarMensaje(
          chatId,
          `💰 Saldo GoXTop:\n\n$${balance} USD`
        );

        return;
      }

      // PRODUCTOS
      if (data === "productos") {
        sessions.set(String(chatId), {
          estado: "solo_productos"
        });

        await mostrarProductos(chatId);
        return;
      }

      // CANCELAR
      if (data === "cancelar") {
        sessions.delete(String(chatId));

        await enviarMensaje(
          chatId,
          "🚫 Operación cancelada.",
          {
            inline_keyboard: [
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

      // MENÚ
      if (data === "menu") {
        sessions.delete(String(chatId));
        await mostrarMenu(chatId);
        return;
      }

      // PRODUCTO ELEGIDO
      if (data.startsWith("producto_")) {
        const session = sessions.get(String(chatId));

        if (!session) {
          await enviarMensaje(
            chatId,
            "⌛ La sesión venció. Volvé al menú."
          );
          return;
        }

        const index = Number(data.replace("producto_", ""));
        const producto = session.productos?.[index];

        if (!producto) {
          await enviarMensaje(
            chatId,
            "❌ Producto no válido."
          );
          return;
        }

        // Si solamente estaba mirando productos
        if (!session.userid) {
          await enviarMensaje(
            chatId,
            `${producto.name}\n💵 $${producto.price}\n📦 ${producto.stockStatus}`
          );
          return;
        }

        session.producto = producto;
        session.estado = "confirmando";

        await enviarMensaje(
          chatId,
          "⚠️ CONFIRMAR RECARGA\n\n" +
          "🎮 Free Fire LATAM\n" +
          `🆔 ID: ${session.userid}\n` +
          `💎 Producto: ${producto.name}\n` +
          `💵 Costo GoXTop: $${producto.price}\n\n` +
          "Todavía NO se realizó la compra.",
          {
            inline_keyboard: [
              [
                {
                  text: "✅ CONFIRMAR",
                  callback_data: "confirmar"
                }
              ],
              [
                {
                  text: "❌ CANCELAR",
                  callback_data: "cancelar"
                }
              ]
            ]
          }
        );

        return;
      }

      // CONFIRMAR COMPRA
      if (data === "confirmar") {
        const session = sessions.get(String(chatId));

        if (
          !session ||
          session.estado !== "confirmando" ||
          !session.producto ||
          !session.userid
        ) {
          await enviarMensaje(
            chatId,
            "⌛ No hay ninguna recarga pendiente."
          );
          return;
        }

        // Cambiamos el estado ANTES de llamar a GoXTop
        // para evitar doble toque.
        session.estado = "procesando";

        const order = {
          userid: session.userid,
          denom:
            session.producto.Pack ||
            session.producto.name,
          cantidad: session.producto.name,
          price: session.producto.price
        };

        await enviarMensaje(
          chatId,
          "⏳ Enviando recarga a GoXTop...\n\nNo vuelvas a tocar Confirmar."
        );

        try {
          const result = await crearRecarga(order);

          // Eliminamos la sesión una vez enviado
          sessions.delete(String(chatId));

          if (result.data?.success === true) {
            await enviarMensaje(
              chatId,
              "✅ PEDIDO ACEPTADO\n\n" +
              `🆔 ID: ${order.userid}\n` +
              `💎 Producto: ${order.cantidad}\n` +
              `💵 Costo: $${order.price}\n` +
              `📦 Pedido: ${result.partner_orderid}\n\n` +
              "GoXTop aceptó la recarga.",
              {
                inline_keyboard: [
                  [
                    {
                      text: "💎 Otra recarga",
                      callback_data: "nueva_recarga"
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

          await enviarMensaje(
            chatId,
            "❌ RECARGA NO COMPLETADA\n\n" +
            `Mensaje: ${result.data?.message || "Order failed"}\n` +
            `Pedido: ${result.partner_orderid}\n\n` +
            "No vuelvas a enviarla hasta revisar GoXTop.",
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

        } catch (error) {
          console.error("Error recarga:", error);

          sessions.delete(String(chatId));

          await enviarMensaje(
            chatId,
            "⚠️ ERROR DE COMUNICACIÓN\n\n" +
            "No repitas la recarga todavía. Revisá primero GoXTop para evitar una compra duplicada."
          );
        }

        return;
      }
    }

  } catch (error) {
    console.error("Error Telegram:", error);
  }
});

// ======================================================
// WEBHOOK GOXTOP
// ======================================================

app.post("/webhook/order-status", (req, res) => {
  const timestamp = req.get("X-Webhook-Timestamp");
  const signature = req.get("X-Webhook-Signature");

  if (!timestamp || !signature || !process.env.SECRET_KEY) {
    return res.status(401).json({
      success: false
    });
  }

  const expected = crypto
    .createHmac("sha256", process.env.SECRET_KEY)
    .update(timestamp + "." + req.rawBody)
    .digest("hex");

  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);

    if (
      a.length !== b.length ||
      !crypto.timingSafeEqual(a, b)
    ) {
      return res.status(401).json({
        success: false
      });
    }
  } catch {
    return res.status(401).json({
      success: false
    });
  }

  console.log("Webhook GoXTop:", req.body);

  return res.status(200).json({
    success: true
  });
});

// ======================================================
// CONSULTAR PRODUCTOS DESDE NAVEGADOR
// ======================================================

app.get("/api/products/:gameCode", async (req, res) => {
  try {
    const response = await fetch(
      `${GOXTOP_BASE_URL}/products/${encodeURIComponent(req.params.gameCode)}`,
      {
        headers: {
          "x-api-key": process.env.GOXTOP_API_KEY
        }
      }
    );

    const data = await response.json();

    return res.status(response.status).json(data);

  } catch {
    return res.status(500).json({
      success: false
    });
  }
});

// ======================================================
// INICIAR SERVIDOR
// ======================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `JS Recargas ejecutándose en puerto ${PORT}`
  );
});
