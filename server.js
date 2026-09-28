const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

const GOXTOP_BASE_URL = "https://goxtop.com/api/v.1";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

app.use(cors());

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
// GOXTOP
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

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "No se pudieron obtener los productos"
    });
  }
});

// ========================================
// WEBHOOK GOXTOP
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
    const valid = crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );

    if (!valid) {
      return res.status(401).json({ success: false });
    }
  } catch {
    return res.status(401).json({ success: false });
  }

  console.log("Webhook GoXTop:", req.body);

  return res.status(200).json({ success: true });
});

// ========================================
// TELEGRAM
// ========================================

async function enviarTelegram(chatId, texto) {
  if (!TELEGRAM_BOT_TOKEN) return;

  await fetch(
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
}

app.post("/telegram/webhook", async (req, res) => {
  // Contestamos inmediatamente a Telegram.
  res.sendStatus(200);

  try {
    const message = req.body.message;

    if (!message || !message.chat) {
      return;
    }

    const chatId = message.chat.id;
    const text = (message.text || "").trim();

    if (text === "/start") {
      await enviarTelegram(
        chatId,
        "✅ JS Recargas conectado.\n\nUsá /id para obtener tu ID de administrador."
      );
      return;
    }

    if (text === "/id") {
      await enviarTelegram(
        chatId,
        `🆔 Tu Telegram ID es:\n${chatId}`
      );
      return;
    }

    if (text.startsWith("/recargar")) {
      await enviarTelegram(
        chatId,
        "🔒 Las recargas todavía están bloqueadas hasta registrar al administrador."
      );
      return;
    }

    await enviarTelegram(
      chatId,
      "Comandos disponibles:\n/start\n/id"
    );

  } catch (error) {
    console.error("Error Telegram:", error);
  }
});

// ========================================
// INICIAR SERVIDOR
// ========================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`JS Recargas ejecutándose en puerto ${PORT}`);
});
