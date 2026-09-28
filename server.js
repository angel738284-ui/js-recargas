const express = require("express");
const crypto = require("crypto");

const app = express();

const GOXTOP_BASE_URL = "https://goxtop.com/api/v.1";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Solo esta cuenta de Telegram puede administrar el bot
const ADMIN_TELEGRAM_ID = "1051260349";

// Confirmaciones pendientes
const pendingOrders = new Map();

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString("utf8");
  }
}));

// ========================================
// SERVIDOR
// ========================================

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "JS Recargas API funcionando"
  });
});

// ========================================
// TELEGRAM
// ========================================

async function enviarTelegram(chatId, texto) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error("Falta TELEGRAM_BOT_TOKEN");
    return;
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: texto
        })
      }
    );

    if (!response.ok) {
      console.error("Telegram respondió:", await response.text());
    }
  } catch (error) {
    console.error("Error enviando Telegram:", error);
  }
}

function esAdmin(chatId) {
  return String(chatId) === ADMIN_TELEGRAM_ID;
}

// ========================================
// GOXTOP
// ========================================

async function obtenerSaldo() {
  const response = await fetch(`${GOXTOP_BASE_URL}/balance`, {
    headers: {
      "x-api-key": process.env.GOXTOP_API_KEY
    }
  });

  const data = await response.json();

  return {
    ok: response.ok,
    data
  };
}

async function obtenerProductos(gameCode) {
  const response = await fetch(
    `${GOXTOP_BASE_URL}/products/${encodeURIComponent(gameCode)}`,
    {
      headers: {
        "x-api-key": process.env.GOXTOP_API_KEY
      }
    }
  );

  const data = await response.json();

  return {
    ok: response.ok,
    data
  };
}

async function crearRecarga({ game, denom, userid }) {
  const partner_orderid =
    "JS-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

  const response = await fetch(`${GOXTOP_BASE_URL}/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.GOXTOP_API_KEY
    },
    body: JSON.stringify({
      game,
      denom,
      userid,
      serverid: "",
      charname: "",
      partner_webhook_url:
        "https://js-recargas-2.onrender.com/webhook/order-status",
      partner_orderid
    })
  });

  const data = await response.json();

  return {
    ok: response.ok,
    data,
    partner_orderid
  };
}

// ========================================
// ENDPOINTS DE CONSULTA
// ========================================

app.get("/api/games", async (req, res) => {
  try {
    const response = await fetch(`${GOXTOP_BASE_URL}/games`, {
      headers: {
        "x-api-key": process.env.GOXTOP_API_KEY
      }
    });

    const data = await response.json();

    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "No se pudo conectar con el proveedor"
    });
  }
});

app.get("/api/products/:gameCode", async (req, res) => {
  try {
    const result = await obtenerProductos(req.params.gameCode);

    return res
      .status(result.ok ? 200 : 502)
      .json(result.data);

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "No se pudieron obtener los productos"
    });
  }
});

// IMPORTANTE:
// Ya no dejamos una ruta pública para crear recargas.
// Las recargas se realizan únicamente desde el bot autorizado.

// ========================================
// WEBHOOK DE GOXTOP
// ========================================

app.post("/webhook/order-status", (req, res) => {
  const timestamp = req.get("X-Webhook-Timestamp");
  const signature = req.get("X-Webhook-Signature");

  if (!timestamp || !signature || !process.env.SECRET_KEY) {
    return res.status(401).json({ success: false });
  }

  const expectedSignature = crypto
    .createHmac("sha256", process.env.SECRET_KEY)
    .update(timestamp + "." + req.rawBody)
    .digest("hex");

  try {
    const signatureBuffer = Buffer.from(signature, "utf8");
    const expectedBuffer = Buffer.from(expectedSignature, "utf8");

    if (
      signatureBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
      return res.status(401).json({ success: false });
    }
  } catch {
    return res.status(401).json({ success: false });
  }

  console.log("Webhook GoXTop:", req.body);

  return res.status(200).json({ success: true });
});

// ========================================
// WEBHOOK DE TELEGRAM
// ========================================

app.post("/telegram/webhook", async (req, res) => {
  // Respondemos inmediatamente a Telegram
  res.sendStatus(200);

  try {
    const message = req.body.message;

    if (!message || !message.chat) {
      return;
    }

    const chatId = message.chat.id;
    const text = (message.text || "").trim();

    // Bloquear cualquier cuenta que no sea el administrador
    if (!esAdmin(chatId)) {
      await enviarTelegram(
        chatId,
        "⛔ No estás autorizado para utilizar JS Recargas."
      );
      return;
    }

    // START
    if (text === "/start") {
      await enviarTelegram(
        chatId,
        "✅ JS Recargas\n\n" +
        "Comandos:\n\n" +
        "/saldo\n" +
        "/productos\n" +
        "/recargar ID CANTIDAD\n" +
        "/confirmar\n" +
        "/cancelar\n\n" +
        "Ejemplo:\n" +
        "/recargar 9271306994 110"
      );
      return;
    }

    // ID
    if (text === "/id") {
      await enviarTelegram(
        chatId,
        `🆔 Tu Telegram ID:\n${chatId}\n\n✅ Administrador autorizado.`
      );
      return;
    }

    // SALDO
    if (text === "/saldo") {
      await enviarTelegram(chatId, "⏳ Consultando saldo...");

      try {
        const result = await obtenerSaldo();

        if (!result.ok) {
          await enviarTelegram(
            chatId,
            "❌ GoXTop no permitió consultar el saldo."
          );
          return;
        }

        await enviarTelegram(
          chatId,
          "💰 Saldo GoXTop:\n\n" +
          JSON.stringify(result.data, null, 2)
        );
      } catch (error) {
        await enviarTelegram(
          chatId,
          "❌ No pude consultar el saldo."
        );
      }

      return;
    }

    // PRODUCTOS FREE FIRE LATAM
    if (text === "/productos") {
      await enviarTelegram(
        chatId,
        "⏳ Consultando productos de Free Fire LATAM..."
      );

      try {
        const result = await obtenerProductos("freefire_latam");

        if (!result.ok) {
          await enviarTelegram(
            chatId,
            "❌ No pude consultar los productos."
          );
          return;
        }

        const rawProducts =
          Array.isArray(result.data)
            ? result.data
            : Array.isArray(result.data?.data)
              ? result.data.data
              : [];

        if (!rawProducts.length) {
          await enviarTelegram(
            chatId,
            "No encontré productos disponibles."
          );
          return;
        }

        const resumen = rawProducts
          .slice(0, 30)
          .map((p) => {
            const nombre = p.name || p.Pack || "Producto";
            const precio =
              p.price !== undefined ? ` - $${p.price}` : "";
            const stock =
              p.stockStatus ? ` - ${p.stockStatus}` : "";

            return `${nombre}${precio}${stock}`;
          })
          .join("\n");

        await enviarTelegram(
          chatId,
          "🎮 Free Fire LATAM\n\n" + resumen
        );

      } catch (error) {
        await enviarTelegram(
          chatId,
          "❌ Error consultando productos."
        );
      }

      return;
    }

    // PREPARAR RECARGA
    if (text.startsWith("/recargar")) {
      const partes = text.split(/\s+/);

      if (partes.length !== 3) {
        await enviarTelegram(
          chatId,
          "Formato incorrecto.\n\n" +
          "Usá:\n" +
          "/recargar ID CANTIDAD\n\n" +
          "Ejemplo:\n" +
          "/recargar 9271306994 110"
        );
        return;
      }

      const userid = partes[1];
      const cantidad = partes[2];

      if (!/^\d+$/.test(userid)) {
        await enviarTelegram(
          chatId,
          "❌ El ID del jugador debe contener solamente números."
        );
        return;
      }

      if (!/^\d+$/.test(cantidad)) {
        await enviarTelegram(
          chatId,
          "❌ La cantidad debe contener solamente números."
        );
        return;
      }

      // Consultamos el catálogo para no inventar el Pack
      let productos;

      try {
        const result = await obtenerProductos("freefire_latam");

        if (!result.ok) {
          await enviarTelegram(
            chatId,
            "❌ No pude verificar el producto en GoXTop."
          );
          return;
        }

        productos =
          Array.isArray(result.data)
            ? result.data
            : Array.isArray(result.data?.data)
              ? result.data.data
              : [];

      } catch (error) {
        await enviarTelegram(
          chatId,
          "❌ No pude verificar el catálogo."
        );
        return;
      }

      const producto = productos.find(
        (p) => String(p.name) === String(cantidad)
      );

      if (!producto) {
        await enviarTelegram(
          chatId,
          `❌ No encontré ${cantidad} diamantes en el catálogo de Free Fire LATAM.\n\n` +
          "Usá /productos para ver las opciones."
        );
        return;
      }

      if (producto.stockStatus !== "in_stock") {
        await enviarTelegram(
          chatId,
          `❌ El producto de ${cantidad} diamantes no está disponible ahora.`
        );
        return;
      }

      const denom = producto.Pack || producto.name;

      pendingOrders.set(String(chatId), {
        game: "freefire_latam",
        denom,
        userid,
        cantidad,
        price: producto.price,
        createdAt: Date.now()
      });

      await enviarTelegram(
        chatId,
        "⚠️ CONFIRMAR RECARGA\n\n" +
        `🎮 Free Fire LATAM\n` +
        `🆔 ID: ${userid}\n` +
        `💎 Diamantes: ${cantidad}\n` +
        `💵 Costo GoXTop: $${producto.price}\n\n` +
        "Todavía NO se realizó ninguna compra.\n\n" +
        "Escribí /confirmar para realizarla.\n" +
        "Escribí /cancelar para cancelar."
      );

      return;
    }

    // CANCELAR
    if (text === "/cancelar") {
      if (!pendingOrders.has(String(chatId))) {
        await enviarTelegram(
          chatId,
          "No hay ninguna recarga pendiente."
        );
        return;
      }

      pendingOrders.delete(String(chatId));

      await enviarTelegram(
        chatId,
        "🚫 Recarga cancelada. No se realizó ningún cargo."
      );

      return;
    }

    // CONFIRMAR
    if (text === "/confirmar") {
      const order = pendingOrders.get(String(chatId));

      if (!order) {
        await enviarTelegram(
          chatId,
          "No hay ninguna recarga pendiente para confirmar."
        );
        return;
      }

      // La confirmación vence después de 5 minutos
      if (Date.now() - order.createdAt > 5 * 60 * 1000) {
        pendingOrders.delete(String(chatId));

        await enviarTelegram(
          chatId,
          "⌛ La confirmación venció.\n\n" +
          "Creá nuevamente la recarga con /recargar."
        );

        return;
      }

      // La quitamos ANTES de llamar a GoXTop.
      // Así un doble /confirmar no crea dos compras.
      pendingOrders.delete(String(chatId));

      await enviarTelegram(
        chatId,
        "⏳ Enviando recarga a GoXTop...\n\n" +
        "No vuelvas a enviar /confirmar."
      );

      try {
        const result = await crearRecarga(order);

        const data = result.data;

        if (data?.success === true) {
          await enviarTelegram(
            chatId,
            "✅ PEDIDO ENVIADO\n\n" +
            `🆔 ID: ${order.userid}\n` +
            `💎 Diamantes: ${order.cantidad}\n` +
            `💵 Costo: $${order.price}\n` +
            `📦 Pedido: ${result.partner_orderid}\n\n` +
            "GoXTop aceptó el pedido."
          );
          return;
        }

        await enviarTelegram(
          chatId,
          "❌ GoXTop no completó la solicitud.\n\n" +
          `Mensaje: ${data?.message || "Order failed"}\n` +
          `Pedido: ${result.partner_orderid}\n\n` +
          "No vuelvas a confirmar este pedido."
        );

      } catch (error) {
        console.error("Error creando recarga:", error);

        await enviarTelegram(
          chatId,
          "⚠️ Hubo un error de comunicación al enviar la recarga.\n\n" +
          "NO la repitas todavía. Revisá primero GoXTop para evitar una recarga duplicada."
        );
      }

      return;
    }

    await enviarTelegram(
      chatId,
      "Comando no reconocido.\n\nUsá /start para ver los comandos."
    );

  } catch (error) {
    console.error("Error webhook Telegram:", error);
  }
});

// ========================================
// INICIAR
// ========================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`JS Recargas ejecutándose en puerto ${PORT}`);
});
