import {
    ALGORITHM_LABELS,
    SUPPORTED_ALGORITHMS,
    appState,
    getApiConfig,
    getProcessColor,
    hasValidConfig,
    saveSimulationResults
} from "./state.js";

const LEGEND_ITEMS = {
    process: { label: "Processo (cada um com sua cor)", swatch: 'style="--segment-color: var(--mem-indigo);"' },
    freePartition: { label: "Partição livre", className: "cmp-swatch--free" },
    internal: { label: "Fragmentação interna", className: "cmp-swatch--internal" },
    unused: { label: "Não particionado", className: "cmp-swatch--unused" }
};

function isFixedPartitionMode() {
    return appState.config?.partitionType === "fixed";
}

function getMetricDefinitions(fixed) {
    return [
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
            label: fixed ? "Maior partição livre" : "Maior lacuna",
            rule: "max",
            getValue: (metrics) => Number(metrics.largestHole ?? 0),
            format: (metrics) => `${metrics.largestHole ?? 0} KB`
        },
        {
            key: "holeCount",
            label: fixed ? "Partições livres" : "Nº de lacunas",
            rule: "min",
            getValue: (metrics) => Number(metrics.holeCount ?? 0),
            format: (metrics) => String(metrics.holeCount ?? 0)
        },
        fixed
            ? {
                key: "internalFragmentation",
                label: "Fragmentação interna",
                rule: "min",
                getValue: (metrics) => Number(metrics.internalFragmentation ?? 0),
                format: (metrics) => `${Math.round(Number(metrics.internalFragmentation ?? 0))} KB`
            }
            : {
                key: "externalFragmentation",
                label: "Fragmentação externa",
                rule: "min",
                getValue: (metrics) => Number(metrics.externalFragmentation ?? 0),
                format: (metrics) => `${formatNumber(metrics.externalFragmentation)}%`
            }
    ];
}

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

function renderMemoryLegend(algorithms, fixed) {
    const legend = document.getElementById("memory-legend");
    if (!legend) {
        return;
    }

    if (!fixed) {
        legend.hidden = true;
        legend.innerHTML = "";
        return;
    }

    const hasUnusedArea = algorithms.some((alg) =>
        appState.resultsCache[alg]?.blocks?.some((block) => Boolean(block.isUnused))
    );

    const keys = ["process", "freePartition", "internal"];
    if (hasUnusedArea) {
        keys.push("unused");
    }

    legend.hidden = false;
    legend.innerHTML = keys
        .map((key) => {
            const item = LEGEND_ITEMS[key];
            const attrs = item.swatch ?? "";
            const extraClass = item.className ? ` ${item.className}` : "";
            return `<li><span class="cmp-swatch${extraClass}" ${attrs}></span>${escapeHtml(item.label)}</li>`;
        })
        .join("");
}

function buildFixedSegmentHtml(block, index) {
    const isFree = Boolean(block.isFree);
    const isUnused = Boolean(block.isUnused);
    const classes = ["memory-segment"];
    const styles = [`--size: ${Number(block.size) || 0}`, `--i: ${index}`];

    if (isFree) {
        classes.push("is-free");
    } else if (isUnused) {
        classes.push("is-unused");
    } else {
        styles.push(`--segment-color: ${getProcessColor(block.process, appState.config)}`);
        if (block.used != null && Number(block.size) > 0) {
            const usedPercent = Math.min(100, Math.max(0, (Number(block.used) / Number(block.size)) * 100));
            styles.push(`--used: ${usedPercent.toFixed(2)}%`);
        }
    }

    const titleText = isUnused ? "Não particionado" : isFree ? "Livre" : block.process;
    const sizeText = !isFree && !isUnused && block.used != null ? `${block.used} / ${block.size} KB` : `${block.size} KB`;
    const rangeStart = Number(block.start ?? 0);
    const rangeEnd = Number(block.end ?? rangeStart + Number(block.size ?? 0));

    const partitionSuffix = block.partition ? ` · partição ${block.partition}` : "";
    const internalAmount = !isFree && !isUnused && block.used != null ? Number(block.size) - Number(block.used) : 0;
    const internalSuffix = internalAmount > 0 ? ` · ${internalAmount} KB de fragmentação interna` : "";
    const tooltip = `${titleText} — ${sizeText} (${rangeStart}–${rangeEnd})${partitionSuffix}${internalSuffix}`;

    return `
        <div class="${classes.join(" ")}" style="${styles.join("; ")}" title="${escapeHtml(tooltip)}">
            ${block.partition ? `<span class="cmp-seg-part">Partição ${block.partition}</span>` : ""}
            <strong>${escapeHtml(titleText)}</strong>
            <span class="cmp-seg-size">${escapeHtml(sizeText)}</span>
            <span class="cmp-seg-range">${rangeStart}-${rangeEnd}</span>
        </div>
    `;
}

function buildDynamicSegmentHtml(block, index, totalMemory) {
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
      style="width: ${widthPercent.toFixed(4)}%; --segment-color: ${segmentColor}; --i: ${index};"
      title="${escapeHtml(tooltip)}"
    >
      <strong>${titleText}</strong>
      <span>${block.size} KB</span>
    </div>
  `.trim();
}

function renderMemoryBars(algorithms) {
    const container = document.getElementById("memory-list");
    if (!container) {
        return;
    }

    const displayAlgorithms = algorithms.length > 0 ? algorithms : SUPPORTED_ALGORITHMS;
    const totalMemory = Number(appState.config?.totalMemory) || 1024;
    const fixed = isFixedPartitionMode();

    renderMemoryLegend(displayAlgorithms, fixed);

    container.innerHTML = displayAlgorithms
        .map((alg) => {
            const label = ALGORITHM_LABELS[alg] || alg;
            const result = appState.resultsCache[alg];
            const barClass = "memory-bar is-fixed";

            if (!result || !Array.isArray(result.blocks) || result.blocks.length === 0) {
                return `
                    <div class="memory-row" data-algo="${escapeHtml(alg)}">
                        <span class="algo-name">${escapeHtml(label)}</span>
                        <div class="${barClass}">
                            <div class="memory-empty">Aguardando execução</div>
                        </div>
                    </div>
                `;
            }

            const segmentsHtml = result.blocks
                .map((block, index) =>
                    fixed ? buildFixedSegmentHtml(block, index) : buildDynamicSegmentHtml(block, index, totalMemory)
                )
                .join("");

            return `
                <div class="memory-row" data-algo="${escapeHtml(alg)}">
                    <span class="algo-name">${escapeHtml(label)}</span>
                    <div class="${barClass}">${segmentsHtml}</div>
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

    const metricDefinitions = getMetricDefinitions(isFixedPartitionMode());

    tbody.innerHTML = metricDefinitions.map((metricDef, rowIndex) => {
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
            <tr style="--i: ${rowIndex};">
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

    const fixed = isFixedPartitionMode();

    const fragmentationChart = fixed
        ? {
            title: "Fragmentação interna (menor é melhor)",
            barColor: "#1226FF",
            getPercent: (metrics) => {
                if (totalMemory <= 0) {
                    return 0;
                }
                return Math.min(100, Math.max(0, (Number(metrics.internalFragmentation ?? 0) / totalMemory) * 100));
            },
            getValueLabel: (metrics) => `${Math.round(Number(metrics.internalFragmentation ?? 0))} KB`
        }
        : {
            title: "Fragmentação externa (menor é melhor)",
            barColor: "#1226FF",
            getPercent: (metrics) => Math.min(100, Math.max(0, Number(metrics.externalFragmentation ?? 0))),
            getValueLabel: (metrics) => `${formatNumber(metrics.externalFragmentation)}%`
        };

    const largestFreeLabel = fixed ? "Maior partição livre" : "Maior lacuna livre";

    const chartSpecs = [
        {
            title: "Utilização da memória (maior é melhor)",
            barColor: "#6925F2",
            getPercent: (metrics) => Math.min(100, Math.max(0, Number(metrics.finalMemoryUtilization ?? 0))),
            getValueLabel: (metrics) => `${formatNumber(metrics.finalMemoryUtilization)}%`
        },
        fragmentationChart,
        {
            title: totalMemory > 0 ? `${largestFreeLabel} (KB, de ${totalMemory})` : `${largestFreeLabel} (KB)`,
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
                .map((alg, rowIndex) => {
                    const label = ALGORITHM_LABELS[alg] || alg;
                    const metrics = appState.resultsCache[alg]?.metrics;
                    const widthPercent = metrics ? spec.getPercent(metrics) : 0;
                    const valueText = metrics ? spec.getValueLabel(metrics) : "—";

                    // Bars start at 0 and grow to data-width (see animateChartFills)
                    return `
                        <div class="chart-row">
                            <span class="chart-label">${escapeHtml(label)}</span>
                            <div class="chart-track">
                                <div class="chart-fill" data-width="${widthPercent.toFixed(2)}" style="width: 0%; --bar-color: ${spec.barColor}; --i: ${rowIndex};"></div>
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

    animateChartFills(container);
}

/**
 * Grows each bar from 0 to its value on the next frames, so the CSS width transition plays.
 */
function animateChartFills(container) {
    const fills = container.querySelectorAll(".chart-fill[data-width]");
    // Force a reflow so the browser commits width: 0 before the target width (works even in
    // background tabs, where requestAnimationFrame is paused)
    void container.offsetWidth;
    fills.forEach((fill) => {
        fill.style.width = `${fill.dataset.width}%`;
    });
}

/**
 * Replays a one-shot animation class on the Compare section.
 */
function playSectionAnimation(className, durationMs) {
    const section = document.getElementById("tab-compare");
    if (!section) {
        return;
    }
    section.classList.remove(className);
    void section.offsetWidth;
    section.classList.add(className);
    clearTimeout(section[`_${className}Timer`]);
    section[`_${className}Timer`] = setTimeout(() => section.classList.remove(className), durationMs);
}

const OUTCOME_LABELS = {
    allocated: "Alocado",
    freed: "Liberado",
    refused: "Recusado",
    compacted: "Compactado",
    skipped: "Ignorado",
    rejected: "Rejeitado",
};

function formatEventText(step) {
    const event = step.event ?? {};

    if (event.type === "compact") return "Compactar memória";
    if (event.type === "free") return `Liberar ${event.process}`;

    return event.source === "queue"
        ? `Alocar ${event.process} (fila)`
        : `Alocar ${event.process} (${event.size} KB)`;
}

function renderTimelinesComparison(algorithms) {
    const container = document.getElementById("compare-timelines-container");
    const subtitle = document.getElementById("timeline-subtitle");

    if (!container) return;

    const displayAlgorithms = algorithms.length > 0 ? algorithms : SUPPORTED_ALGORITHMS;
    const executedAlgorithms = displayAlgorithms.filter((alg) => Boolean(appState.resultsCache[alg]));

    if (executedAlgorithms.length === 0) {
        if (subtitle) {
            subtitle.textContent =
                "Acompanhe a sequência de eventos e as decisões de alocação passo a passo em cada algoritmo.";
        }

        container.innerHTML = `
      <div>Execute a comparação para visualizar a linha do tempo dos algoritmos.</div>
    `;
        return;
    }

    if (subtitle) {
        subtitle.textContent = "Exibindo a linha do tempo comparativa para os algoritmos selecionados.";
    }

    container.innerHTML = displayAlgorithms
        .map((alg) => {
            const label = ALGORITHM_LABELS[alg] || alg;
            const result = appState.resultsCache[alg];
            const steps = Array.isArray(result?.steps) ? result.steps : [];

            if (steps.length === 0) {
                return `
          <div class="compare-timeline-column">
            <div class="compare-timeline-header">${escapeHtml(label)}</div>
            <div>Aguardando execução</div>
          </div>
        `;
            }

            const stepsHtml = steps
                .map((step) => {
                    const statusText = OUTCOME_LABELS[step.outcome] || step.outcome;
                    const statusClass = `compare-tl-status--${step.outcome}`;
                    const eventDesc = formatEventText(step);

                    return `
            <li class="compare-timeline-item">
              <span class="compare-tl-badge">${escapeHtml(step.label)}</span>
              <div class="compare-tl-info">
                <span class="compare-tl-label">${escapeHtml(eventDesc)}</span>
                <span class="compare-tl-status ${statusClass}">${escapeHtml(statusText)}</span>
              </div>
            </li>
          `;
                })
                .join("");

            return `
        <div class="compare-timeline-column">
          <div class="compare-timeline-header">
            <span>${escapeHtml(label)}</span>
            <span>${steps.length} passos</span>
          </div>
          <ul class="compare-timeline-list">${stepsHtml}</ul>
        </div>
      `;
        })
        .join("");
}

function renderComparisonView() {
    const selectedAlgorithms = getSelectedAlgorithms();

    renderMemoryRuler(appState.config?.totalMemory);
    renderMemoryBars(selectedAlgorithms);
    updateCompareSegmentSizes();
    renderMetricsTable(selectedAlgorithms);
    renderCharts(selectedAlgorithms);
    renderTimelinesComparison(selectedAlgorithms);
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
        playSectionAnimation("is-revealing", 1800);
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
        playSectionAnimation("is-revealing", 1800);
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
            playSectionAnimation("is-entering", 900);
            syncComparePageState();
        }
    });

    // "Comparar os 3 algoritmos" in the Configure tab: select all algorithms and run immediately
    window.addEventListener("memsim:request-comparison", () => {
        checkboxes.forEach((checkbox) => {
            checkbox.checked = true;
        });
        syncComparePageState();
        handleRunComparison();
    });

    window.addEventListener("resize", updateCompareSegmentSizes);

    syncComparePageState();
}

function updateCompareSegmentSizes() {
    const segments = document.querySelectorAll("#tab-compare .memory-segment");
    segments.forEach((segment) => {
        const width = segment.offsetWidth;
        const isFixedBar = segment.closest(".memory-bar")?.classList.contains("is-fixed");

        if (isFixedBar) {
            segment.classList.toggle("is-tiny", width < 26);
            segment.classList.toggle("is-narrow", width >= 26 && width < 64);
            segment.classList.toggle("is-no-range", width >= 64 && width < 92);
        } else {
            segment.classList.toggle("is-tiny", width < 28);
            segment.classList.remove("is-narrow", "is-no-range");
        }
    });
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initCompareTab);
} else {
    initCompareTab();
}