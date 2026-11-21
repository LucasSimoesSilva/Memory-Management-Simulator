import express from "express";

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static("public"));

app.get("/api/help", (res) => {
    try {
        return res.status(200).json("API WORKING!");
    } catch (erro) {
        console.error("API ERROR:", erro);
        return res.status(500).json({ erro: "API ERROR" });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});