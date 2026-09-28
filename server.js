const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`JS Recargas ejecutándose en puerto ${PORT}`);
});
