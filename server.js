import express from "express";
import { runAlgorithm, SUPPORTED_ALGORITHMS } from "./src/algorithms.js";

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static("public"));

app.get("/api/help", (_req, res) => {
    return res.status(200).json({
        status: "API WORKING!",
        endpoints: {
            simulate: {
                method: "POST",
                url: "/api/simulate",
                supportedAlgorithms: SUPPORTED_ALGORITHMS,
                examplePayload: {
                    config: {
                        totalMemory: 1024,
                        partitionType: "dynamic",
                        events: [
                            { type: "allocate", process: "P1", size: 200 },
                            { type: "allocate", process: "P2", size: 250 },
                            { type: "free", process: "P1" },
                            { type: "compact" }
                        ]
                    },
                    algorithms: ["first-fit", "best-fit"]
                }
            }
        }
    });
});


app.post("/api/simulate", (req, res) => {
    try {
        const { config, algorithms } = req.body;

        if (
            !config ||
            typeof config !== "object" ||
            Array.isArray(config) ||
            Object.keys(config).length === 0 ||
            !Array.isArray(algorithms) ||
            algorithms.length === 0
        ) {
            return res.status(400).json({
                error: "Invalid request: non-empty 'config' object and 'algorithms' array are required."
            });
        }

        const uniqueAlgorithms = [...new Set(algorithms)]

        const invalidAlgorithms = uniqueAlgorithms.filter(
            (alg) => !SUPPORTED_ALGORITHMS.includes(alg)
        );

        if (invalidAlgorithms.length > 0) {
            return res.status(400).json({
                error: `Unsupported algorithm(s): ${invalidAlgorithms.join(", ")}.`,
                allowedAlgorithms: SUPPORTED_ALGORITHMS
            });
        }

        const results = {};

        for (const algorithmName of uniqueAlgorithms) {
            results[algorithmName] = runAlgorithm(config, algorithmName);
        }

        return res.status(200).json(results);
    } catch (error) {
        const status = error.status || 500;
        if (status >= 500) {
            console.error("Simulation error:", error);
        }
        return res.status(status).json({ error: error.message || "Internal server error." });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});