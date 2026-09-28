const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const app = express();

app.use(cors());
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString("utf8");
  }
}));

const GOXTOP_BASE_URL = "https://goxtop.com/api/v.1";

// Comprobar que nuestro servidor funciona
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "JS Recargas API funcionando"
  });
});

// Consultar juegos disponibles en GoXtop
app.get("/api/games", async (req, res) => {
  try {
    const response = await fetch(`${GOXTOP_BASE_URL}/games`, {
      headers: {
        "x-api-key": process.env.GOXTOP_API_KEY
      }
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "No se pudo conectar con el proveedor"
    });
  }
});

// Consultar productos de un juego
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
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "No se pudieron obtener los productos"
    });
  }
});
// Crear una recarga en GoXTop
app.post("/api/create-order", async (req, res) => {
  try {
    const {
      game,
      denom,
      userid,
      serverid = "",
      charname = ""
    } = req.body;

    if (!game || !denom || !userid) {
      return res.status(400).json({
        success: false,
        error: "Faltan game, denom o userid"
      });
    }

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
        serverid,
        charname,
        partner_webhook_url:
          "https://js-recargas-2.onrender.com/webhook/order-status",
        partner_orderid
      })
    });

    const data = await response.json();
    return res.status(response.status).json(data);

  } catch (error) {
    console.error("Error creando pedido:", error);

    return res.status(500).json({
      success: false,
      error: "No se pudo crear el pedido"
    });
  }
});

// Recibir actualizaciones de pedidos desde GoXTop
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

  if (signature !== expectedSignature) {
    return res.status(401).json({ success: false });
  }

  console.log("Webhook GoXTop:", req.body);

  return res.status(200).json({ success: true });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`JS Recargas ejecutándose en puerto ${PORT}`);
});
