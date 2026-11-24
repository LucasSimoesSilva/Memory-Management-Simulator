import {
    ALGORITHM_LABELS,
    SUPPORTED_ALGORITHMS,
    appState,
    getApiConfig,
    getProcessColor,
    hasValidConfig,
    saveSimulationResults
} from "./state.js";

const METRIC_DEFINITIONS = [
    {
        key: "allocatedProcesses",
        label: "Processos alocados",
        rule: "max",
        getValue: (metrics) => Number(metrics.allocatedProcesses ?? 0),
        format: (metrics) => `${metrics.allocatedProcesses ?? 0} de ${metrics.totalProcesses ?? 0}`
    },
    {
        key: "allocationRate",
        label: "Taxa de alocação",
        rule: "max",
        getValue: (metrics) => Number(metrics.allocationRate ?? 0),
        format: (metrics) => `${formatNumber(metrics.allocationRate)}%`
    },
    {
        key: "rejectedProcesses",
        label: "Processos recusados",
        rule: "min",
        getValue: (metrics) => (Array.isArray(metrics.rejectedProcesses) ? metrics.rejectedProcesses.length : 0),
        format: (metrics) => {
            const rejected = Array.isArray(metrics.rejectedProcesses) ? metrics.rejectedProcesses : [];
            return rejected.length > 0 ? rejected.join(", ") : "Nenhum";
        }
    },
    {
        key: "finalMemoryUtilization",
        label: "Utilização final",
        rule: "max",
        getValue: (metrics) => Number(metrics.finalMemoryUtilization ?? 0),
        format: (metrics) => `${formatNumber(metrics.finalMemoryUtilization)}%`
    },
    {
        key: "freeMemory",
        label: "Memória livre",
        rule: "neutral",
        getValue: (metrics) => Number(metrics.freeMemory ?? 0),
        format: (metrics) => `${metrics.freeMemory ?? 0} KB`
    },
    {
        key: "largestHole",
        label: "Maior lacuna",
        rule: "max",
        getValue: (metrics) => Number(metrics.largestHole ?? 0),
        format: (metrics) => `${metrics.largestHole ?? 0} KB`
    },
    {
        key: "holeCount",
        label: "Nº de lacunas",
        rule: "min",
        getValue: (metrics) => Number(metrics.holeCount ?? 0),
        format: (metrics) => String(metrics.holeCount ?? 0)
    },
    {
        key: "externalFragmentation",
        label: "Fragmentação externa",
        rule: "min",
        getValue: (metrics) => Number(metrics.externalFragmentation ?? 0),
        format: (metrics) => `${formatNumber(metrics.externalFragmentation)}%`
    }
];

function formatNumber(value) {
    const num = Number(value ?? 0);
    return num.toLocaleString("pt-BR", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
    });
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = String(text ?? "");
    return div.innerHTML;
}

function getSelectedAlgorithms() {
    const checkedValues = Array.from(
        document.querySelectorAll('#tab-compare input[name="algorithm"]:checked')
    ).map((input) => input.value);

    return SUPPORTED_ALGORITHMS.filter((alg) => checkedValues.includes(alg));
}

function buildConfigSummary(config) {
    const partitionLabel = config.partitionType === "fixed" ? "Partições fixas" : "Partições dinâmicas";
    const totalEvents = config.events.length;
    const allocations = config.events.filter((ev) => ev.type === "allocate").length;

    return `${config.totalMemory} KB · ${partitionLabel} · ${totalEvents} eventos (${allocations} alocações)`;
}

/**
 * Determines which algorithm indices hold the best value for a given metric rule.
 */
function getBestResultIndices(entries, rule) {
    if (rule === "neutral") {
        return new Set();
    }

    const validEntries = entries.filter((entry) => entry.hasResult && Number.isFinite(entry.numericValue));
    if (validEntries.length < 2) {
        return new Set();
    }

    const numericValues = validEntries.map((entry) => entry.numericValue);
    const minVal = Math.min(...numericValues);
    const maxVal = Math.max(...numericValues);

    // No highlight when all executed algorithms tie
    if (minVal === maxVal) {
        return new Set();
    }

    const targetVal = rule === "max" ? maxVal : minVal;
    const winners = new Set();

    entries.forEach((entry, index) => {
        if (entry.hasResult && entry.numericValue === targetVal) {
            winners.add(index);
        }
    });

    return winners;
}

function renderMemoryRuler(totalMemory) {
    const ruler = document.getElementById("memory-ruler");
    if (!ruler) {
        return;
    }

    const safeTotal = Number(totalMemory) > 0 ? Number(totalMemory) : 1024;
    const ticks = [
        "0",
        String(Math.round(safeTotal * 0.25)),
        String(Math.round(safeTotal * 0.5)),
        String(Math.round(safeTotal * 0.75)),
        `${safeTotal} KB`
    ];

    ruler.innerHTML = ticks.map((tick) => `<span>${tick}</span>`).join("");
}

function renderMemoryBars(algorithms) {
    const container = document.getElementById("memory-list");
    if (!container) {
        return;
    }

    const displayAlgorithms = algorithms.length > 0 ? algorithms : SUPPORTED_ALGORITHMS;
    const totalMemory = Number(appState.config?.totalMemory) || 1024;

    container.innerHTML = displayAlgorithms
        .map((alg) => {
            const label = ALGORITHM_LABELS[alg] || alg;
            const result = appState.resultsCache[alg];

            if (!result || !Array.isArray(result.blocks) || result.blocks.length === 0) {
                return `
                    <div class="memory-row" data-algo="${escapeHtml(alg)}">
                        <span class="algo-name">${escapeHtml(label)}</span>
                        <div class="memory-bar">
                            <div class="memory-empty">Aguardando execução</div>
                        </div>
                    </div>
                `;
            }

            const segmentsHtml = result.blocks
                .map((block) => {
                    const widthPercent = Math.max(0, (Number(block.size) / totalMemory) * 100);
                    const isFree = Boolean(block.isFree);
                    const segmentColor = isFree
                        ? "var(--color-free)"
                        : getProcessColor(block.process, appState.config);
                    const titleText = isFree ? "Livre" : escapeHtml(block.process);
                    const rangeEnd = Number(block.start ?? 0) + Number(block.size ?? 0);
                    const tooltip = `${isFree ? "Livre" : block.process} — ${block.size} KB (${block.start ?? 0}–${rangeEnd})`;

                    return `
                        <div
                            class="memory-segment${isFree ? " is-free" : ""}"
                            style="width: ${widthPercent.toFixed(4)}%; --segment-color: ${segmentColor};"
                            title="${escapeHtml(tooltip)}"
                        >
                            <strong>${titleText}</strong>
                            <span>${block.size} KB</span>
                        </div>
                    `;
                })
                .join("");

            return `
                <div class="memory-row" data-algo="${escapeHtml(alg)}">
                    <span class="algo-name">${escapeHtml(label)}</span>
                    <div class="memory-bar">${segmentsHtml}</div>
                </div>
            `;
        })
        .join("");
}

function renderMetricsTable(algorithms) {
    const thead = document.getElementById("metrics-table-head");
    const tbody = document.getElementById("metrics-table-body");
    if (!thead || !tbody) {
        return;
    }

    const displayAlgorithms = algorithms.length > 0 ? algorithms : SUPPORTED_ALGORITHMS;

    thead.innerHTML = `
        <tr>
            <th>Métrica</th>
            ${displayAlgorithms.map((alg) => `<th>${escapeHtml(ALGORITHM_LABELS[alg] || alg)}</th>`).join("")}
        </tr>
    `;

    const hasAnyResult = displayAlgorithms.some((alg) => Boolean(appState.resultsCache[alg]?.metrics));
    if (!hasAnyResult) {
        tbody.innerHTML = `
            <tr>
                <td colspan="${displayAlgorithms.length + 1}" class="empty-table-cell">
                    As métricas aparecem após executar a comparação.
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = METRIC_DEFINITIONS.map((metricDef) => {
        const rowEntries = displayAlgorithms.map((alg) => {
            const metrics = appState.resultsCache[alg]?.metrics;
            if (!metrics) {
                return { hasResult: false, numericValue: NaN, displayText: "—" };
            }

            return {
                hasResult: true,
                numericValue: metricDef.getValue(metrics),
                displayText: metricDef.format(metrics)
            };
        });

        const winnerIndices = getBestResultIndices(rowEntries, metricDef.rule);

        const cellsHtml = rowEntries
            .map((entry, idx) => {
                const escapedValue = escapeHtml(entry.displayText);
                if (winnerIndices.has(idx)) {
                    return `<td><span class="highlight-best">${escapedValue}</span></td>`;
                }
                return `<td>${escapedValue}</td>`;
            })
            .join("");

        return `
            <tr>
                <td>${escapeHtml(metricDef.label)}</td>
                ${cellsHtml}
            </tr>
        `;
    }).join("");
}

function renderCharts(algorithms) {
    const container = document.getElementById("charts-container");
    if (!container) {
        return;
    }

    const displayAlgorithms = algorithms.length > 0 ? algorithms : SUPPORTED_ALGORITHMS;
    const totalMemory = Number(appState.config?.totalMemory) || 0;

    const chartSpecs = [
        {
            title: "Utilização da memória (maior é melhor)",
            barColor: "#6925F2",
            getPercent: (metrics) => Math.min(100, Math.max(0, Number(metrics.finalMemoryUtilization ?? 0))),
            getValueLabel: (metrics) => `${formatNumber(metrics.finalMemoryUtilization)}%`
        },
        {
            title: "Fragmentação externa (menor é melhor)",
            barColor: "#1226FF",
            getPercent: (metrics) => Math.min(100, Math.max(0, Number(metrics.externalFragmentation ?? 0))),
            getValueLabel: (metrics) => `${formatNumber(metrics.externalFragmentation)}%`
        },
        {
            title: totalMemory > 0 ? `Maior lacuna livre (KB, de ${totalMemory})` : "Maior lacuna livre (KB)",
            barColor: "#FF008C",
            getPercent: (metrics) => {
                if (totalMemory <= 0) {
                    return 0;
                }
                return Math.min(100, Math.max(0, (Number(metrics.largestHole ?? 0) / totalMemory) * 100));
            },
            getValueLabel: (metrics) => `${metrics.largestHole ?? 0} KB`
        }
    ];

    container.innerHTML = chartSpecs
        .map((spec) => {
            const rowsHtml = displayAlgorithms
                .map((alg) => {
                    const label = ALGORITHM_LABELS[alg] || alg;
                    const metrics = appState.resultsCache[alg]?.metrics;
                    const widthPercent = metrics ? spec.getPercent(metrics) : 0;
                    const valueText = metrics ? spec.getValueLabel(metrics) : "—";

                    return `
                        <div class="chart-row">
                            <span class="chart-label">${escapeHtml(label)}</span>
                            <div class="chart-track">
                                <div class="chart-fill" style="width: ${widthPercent.toFixed(2)}%; --bar-color: ${spec.barColor};"></div>
                            </div>
                            <span class="chart-value">${escapeHtml(valueText)}</span>
                        </div>
                    `;
                })
                .join("");

            return `
                <div class="chart-group">
                    <h4>${escapeHtml(spec.title)}</h4>
                    ${rowsHtml}
                </div>
            `;
        })
        .join("");
}

function renderDivergencesTable(algorithms) {
    const thead = document.getElementById("divergence-table-head");
    const tbody = document.getElementById("divergence-table-body");
    const subtitle = document.getElementById("divergence-subtitle");
    if (!thead || !tbody) {
        return;
    }

    const displayAlgorithms = algorithms.length > 0 ? algorithms : SUPPORTED_ALGORITHMS;
    const colSpan = displayAlgorithms.length + 2;

    thead.innerHTML = `
        <tr>
            <th>Evento</th>
            <th>Lacunas no momento</th>
            ${displayAlgorithms.map((alg) => `<th>${escapeHtml(ALGORITHM_LABELS[alg] || alg)}</th>`).join("")}
        </tr>
    `;

    const executedAlgorithms = displayAlgorithms.filter((alg) => Boolean(appState.resultsCache[alg]));
    if (executedAlgorithms.length === 0) {
        if (subtitle) {
            subtitle.textContent = "Compare dois ou mais algoritmos para identificar os passos em que as escolhas de alocação diferem.";
        }
        tbody.innerHTML = `
            <tr>
                <td colspan="${colSpan}" class="empty-table-cell">
                    As divergências aparecem após executar a comparação.
                </td>
            </tr>
        `;
        return;
    }

    if (executedAlgorithms.length < 2) {
        if (subtitle) {
            subtitle.textContent = "Selecione ao menos dois algoritmos para comparar decisões passo a passo.";
        }
        tbody.innerHTML = `
            <tr>
                <td colspan="${colSpan}" class="empty-table-cell">
                    Selecione pelo menos dois algoritmos para visualizar divergências.
                </td>
            </tr>
        `;
        return;
    }

    // Collect all divergence entries indexed by step across executed algorithms
    const stepsMap = new Map();

    executedAlgorithms.forEach((alg) => {
        const divergences = Array.isArray(appState.resultsCache[alg]?.divergences)
            ? appState.resultsCache[alg].divergences
            : [];

        divergences.forEach((item) => {
            if (!stepsMap.has(item.step)) {
                stepsMap.set(item.step, {
                    step: item.step,
                    eventLabel: item.eventLabel || `Evento ${item.step}`,
                    holesByAlg: {},
                    decisionsByAlg: {}
                });
            }

            const stepEntry = stepsMap.get(item.step);
            stepEntry.holesByAlg[alg] = item.holesAtMoment || "—";
            stepEntry.decisionsByAlg[alg] = item.decision || "—";
        });
    });

    const divergentRows = Array.from(stepsMap.values())
        .sort((a, b) => Number(a.step) - Number(b.step))
        .filter((entry) => {
            const uniqueDecisions = new Set(
                executedAlgorithms.map((alg) => entry.decisionsByAlg[alg] ?? "—")
            );
            return uniqueDecisions.size > 1;
        });

    if (divergentRows.length === 0) {
        if (subtitle) {
            subtitle.textContent = "Os algoritmos selecionados tomaram as mesmas decisões em todos os eventos.";
        }
        tbody.innerHTML = `
            <tr>
                <td colspan="${colSpan}" class="empty-table-cell">
                    Nenhuma divergência de decisão entre os algoritmos selecionados.
                </td>
            </tr>
        `;
        return;
    }

    if (subtitle) {
        const firstStep = divergentRows[0].step;
        subtitle.textContent = `As escolhas entre os algoritmos selecionados divergem a partir do evento ${firstStep}.`;
    }

    tbody.innerHTML = divergentRows
        .map((entry) => {
            const holeValues = executedAlgorithms
                .map((alg) => entry.holesByAlg[alg])
                .filter((val) => val && val !== "—");
            const uniqueHoles = new Set(holeValues);
            const holesLabel = uniqueHoles.size === 1
                ? holeValues[0]
                : "varia conforme os passos anteriores";

            const decisionCells = displayAlgorithms
                .map((alg) => `<td>${escapeHtml(entry.decisionsByAlg[alg] ?? "—")}</td>`)
                .join("");

            return `
                <tr>
                    <td>${escapeHtml(entry.eventLabel)}</td>
                    <td>${escapeHtml(holesLabel)}</td>
                    ${decisionCells}
                </tr>
            `;
        })
        .join("");
}

function renderComparisonView() {
    const selectedAlgorithms = getSelectedAlgorithms();
    renderMemoryRuler(appState.config?.totalMemory);
    renderMemoryBars(selectedAlgorithms);
    renderMetricsTable(selectedAlgorithms);
    renderCharts(selectedAlgorithms);
    renderDivergencesTable(selectedAlgorithms);
}

function updateRunButtonState() {
    const runButton = document.getElementById("btn-run-comparison");
    if (!runButton) {
        return;
    }

    const configured = hasValidConfig(appState.config);
    const selectedCount = getSelectedAlgorithms().length;
    runButton.disabled = !configured || selectedCount === 0;
}

function syncComparePageState() {
    const banner = document.getElementById("empty-config-banner");
    const bannerMessage = document.getElementById("empty-config-message");
    const subtitle = document.getElementById("comparison-subtitle");
    const configured = hasValidConfig(appState.config);

    if (banner) {
        banner.classList.toggle("hidden", configured);
    }

    if (bannerMessage && !configured) {
        bannerMessage.textContent =
            "Para comparar, cadastre a sequência de eventos na aba Configurar. Os três algoritmos rodam sobre a mesma entrada.";
    }

    if (subtitle) {
        subtitle.textContent = configured
            ? buildConfigSummary(appState.config)
            : "Nenhuma sequência de eventos cadastrada";
    }

    updateRunButtonState();
    renderComparisonView();
}

async function handleRunComparison() {
    if (!hasValidConfig(appState.config)) {
        return;
    }

    const selectedAlgorithms = getSelectedAlgorithms();
    if (selectedAlgorithms.length === 0) {
        return;
    }

    const missingAlgorithms = selectedAlgorithms.filter((alg) => !appState.resultsCache[alg]);

    // Render directly from cache when all selected algorithms were already computed
    if (missingAlgorithms.length === 0) {
        renderComparisonView();
        return;
    }

    const compareSection = document.getElementById("tab-compare");
    const runButton = document.getElementById("btn-run-comparison");
    const originalButtonText = runButton ? runButton.textContent : "Executar comparação";

    try {
        if (compareSection) {
            compareSection.setAttribute("aria-busy", "true");
        }
        if (runButton) {
            runButton.disabled = true;
            runButton.textContent = "Executando...";
        }

        const response = await fetch("/api/simulate", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                config: getApiConfig(appState.config),
                algorithms: missingAlgorithms
            })
        });

        const payload = await response.json();

        if (!response.ok) {
            throw new Error(payload?.error || "Erro ao executar simulação no servidor.");
        }

        saveSimulationResults(payload);
        renderComparisonView();
    } catch (error) {
        console.error("Comparison request failed:", error);
        const banner = document.getElementById("empty-config-banner");
        const bannerMessage = document.getElementById("empty-config-message");
        if (banner && bannerMessage) {
            bannerMessage.textContent = `Falha na simulação: ${error.message}`;
            banner.classList.remove("hidden");
        }
    } finally {
        if (compareSection) {
            compareSection.removeAttribute("aria-busy");
        }
        if (runButton) {
            runButton.textContent = originalButtonText;
            updateRunButtonState();
        }
    }
}

function initCompareTab() {
    const runButton = document.getElementById("btn-run-comparison");
    if (runButton) {
        runButton.addEventListener("click", handleRunComparison);
    }

    const checkboxes = document.querySelectorAll('#tab-compare input[name="algorithm"]');
    checkboxes.forEach((checkbox) => {
        checkbox.addEventListener("change", updateRunButtonState);
    });

    // Sync view whenever config/results change in other tabs or user navigates back to Compare
    window.addEventListener("memsim:config-updated", syncComparePageState);
    window.addEventListener("memsim:results-updated", renderComparisonView);
    window.addEventListener("memsim:tab-changed", (event) => {
        if (event.detail?.tabName === "compare") {
            syncComparePageState();
        }
    });

    syncComparePageState();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initCompareTab);
} else {
    initCompareTab();
}