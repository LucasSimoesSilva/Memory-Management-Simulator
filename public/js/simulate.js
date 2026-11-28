import {
    ALGORITHM_LABELS,
    appState,
    getApiConfig,
    getConfigHash,
    getProcessColor,
    hasValidConfig,
    setSimulationSession
} from "./state.js";
import { getActiveTab } from "./tabs.js";

const BASE_INTERVAL_MS = 1600;
const COUNT_UP_MS = 400;

const OUTCOME_STATUS = {
    allocated: "Alocado",
    freed: "Liberado",
    refused: "Recusado",
    compacted: "Compactado",
    skipped: "Ignorado",
    rejected: "Rejeitado"
};

const HOLE_BADGES = {
    chosen: "Comporta - escolhida",
    fits: "Comporta",
    "no-fit": "Não Comporta",
    "not-checked": "Não Verificada",
    occupied: "Ocupada"
};

/**
 * Steps that are not part of the configured sequence. Compaction is now a regular (numbered)
 * event of the sequence, so only F remains.
 */
const SPECIAL_STEPS = {
    F: {
        name: "Alocação da fila",
        description: "um processo da fila de espera passou a caber e foi alocado automaticamente"
    }
};

const LEGEND_ITEMS = {
    process: { label: "Processo (cada um com sua cor)", swatch: 'style="--segment-color: var(--mem-indigo);"' },
    free: { label: "Lacuna livre", className: "sim-swatch--free" },
    freePartition: { label: "Partição livre", className: "sim-swatch--free" },
    internal: { label: "Fragmentação interna", className: "sim-swatch--internal" },
    unused: { label: "Não particionado", className: "sim-swatch--unused" }
};

const EMPTY_DECISION = {
    variant: "empty",
    title: "Aguardando o primeiro evento",
    text: "Aqui o simulador explica, passo a passo, quais lacunas o algoritmo verificou e por que escolheu (ou recusou) cada uma."
};

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const mqVertical = window.matchMedia("(max-width: 420px)");
const mqSmall = window.matchMedia("(max-width: 600px)");
const mqTablet = window.matchMedia("(max-width: 768px)");

/** Persisted simulation session (see spec §8.3). */
let session = null;

/** Transient view state. */
const view = {
    status: "empty", // empty | loading | ready | error
    busy: false,
    playing: false,
    timer: null,
    errorMessage: "",
    retry: null,
    requestToken: 0,
    lastMetrics: null
};

const el = {};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = String(text ?? "");
    return div.innerHTML;
}

function formatPercent(value) {
    return `${Number(value ?? 0).toFixed(1).replace(".", ",")}%`;
}

function currentAlgorithm() {
    return appState.config?.algorithm && ALGORITHM_LABELS[appState.config.algorithm]
        ? appState.config.algorithm
        : "first-fit";
}

function activeTrail() {
    return session ? session.original : null;
}

function trailLength() {
    return activeTrail()?.steps.length ?? 0;
}

function stepAt(position) {
    const trail = activeTrail();
    return trail && position > 0 ? trail.steps[position - 1] ?? null : null;
}

function snapshotAt(position) {
    const step = stepAt(position);
    if (step) {
        return step;
    }
    const trail = activeTrail();
    return trail ? { blocks: trail.initial.blocks, metrics: trail.initial.metrics, queue: [] } : null;
}

function isFixed() {
    return (activeTrail()?.partitionType ?? appState.config?.partitionType) === "fixed";
}

function eventText(step) {
    const event = step.event ?? {};
    if (event.type === "compact") {
        return "Compactar memória";
    }
    if (event.type === "free") {
        return `Liberar ${event.process}`;
    }
    return event.source === "queue"
        ? `Alocar ${event.process} da fila (${event.size} KB)`
        : `Alocar ${event.process} (${event.size} KB)`;
}

function segmentKey(block) {
    if (block.isFree || block.isUnused) {
        return `free-${block.start}`;
    }
    return `proc-${block.process}`;
}

function blockName(block) {
    if (block.isUnused) {
        return "Não particionado";
    }
    return block.isFree ? "Livre" : block.process;
}

function restartAnimation(node, className) {
    if (!node) {
        return;
    }
    node.classList.remove(className);
    void node.offsetWidth; // Force reflow so the animation runs again
    node.classList.add(className);
}

function persist() {
    if (session) {
        setSimulationSession(session);
    }
}

/* ------------------------------------------------------------------ */
/* Data loading                                                        */
/* ------------------------------------------------------------------ */

async function requestTrail() {
    const algorithm = currentAlgorithm();
    const response = await fetch("/api/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            config: getApiConfig(appState.config),
            algorithms: [algorithm]
        })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload?.error || "Erro ao executar a simulação no servidor.");
    }

    const result = payload[algorithm];
    if (!result || !Array.isArray(result.steps)) {
        throw new Error("Resposta do servidor sem a lista de passos da simulação.");
    }

    return { initial: result.initial, steps: result.steps, partitionType: result.partitionType };
}

async function loadSession() {
    stopPlayback();

    if (!hasValidConfig(appState.config)) {
        session = null;
        view.status = "empty";
        renderAll();
        return;
    }

    const configHash = getConfigHash(appState.config);
    const saved = appState.simulationSession;

    if (session && session.configHash === configHash) {
        view.status = "ready";
        renderAll();
        return;
    }

    if (saved && saved.configHash === configHash && saved.original) {
        session = { ...saved };
        view.status = "ready";
        renderAll();
        return;
    }

    const token = ++view.requestToken;
    view.status = "loading";
    setBusy(true);
    renderAll();

    try {
        const original = await requestTrail();
        if (token !== view.requestToken) {
            return;
        }
        session = {
            configHash,
            algorithm: currentAlgorithm(),
            original,
            cursor: 0,
            speed: 1
        };
        view.status = "ready";
        persist();
    } catch (error) {
        if (token !== view.requestToken) {
            return;
        }
        console.error("Simulation request failed:", error);
        view.status = "error";
        view.errorMessage = error.message;
        view.retry = loadSession;
    } finally {
        if (token === view.requestToken) {
            setBusy(false);
            renderAll();
        }
    }
}

/* ------------------------------------------------------------------ */
/* Navigation and playback                                             */
/* ------------------------------------------------------------------ */

function goTo(target, { keepPlaying = false } = {}) {
    if (!session || view.status !== "ready" || view.busy) {
        return;
    }
    if (!keepPlaying) {
        stopPlayback();
    }

    const length = trailLength();
    const next = Math.max(0, Math.min(length, target));

    // direction: 1 = single step forward (full step animations), other non-zero values = jumps
    const delta = next - session.cursor;
    const direction = delta === 1 ? 1 : delta === 0 ? 0 : Math.sign(delta) * 2;
    session.cursor = next;
    persist();
    renderAll({ direction });
}

function goNext({ keepPlaying = false } = {}) {
    if (session && session.cursor < trailLength()) {
        goTo(session.cursor + 1, { keepPlaying });
    }
}

function goPrev() {
    if (session && session.cursor > 0) {
        goTo(session.cursor - 1);
    }
}

function restart() {
    if (!session) {
        return;
    }
    stopPlayback();
    goTo(0);
}

function stopPlayback() {
    if (view.timer) {
        clearTimeout(view.timer);
        view.timer = null;
    }
    if (view.playing) {
        view.playing = false;
        renderToolbar();
        renderProcesses();
    }
}

function scheduleTick() {
    clearTimeout(view.timer);
    const speed = Number(session?.speed) || 1;
    view.timer = setTimeout(() => {
        if (!view.playing) {
            return;
        }
        goNext({ keepPlaying: true });
        if (!session || session.cursor >= trailLength()) {
            stopPlayback();
            return;
        }
        scheduleTick();
    }, BASE_INTERVAL_MS / speed);
}

function togglePlayback() {
    if (!session || view.status !== "ready") {
        return;
    }
    if (view.playing) {
        stopPlayback();
        return;
    }
    if (session.cursor >= trailLength()) {
        return;
    }
    view.playing = true;
    renderToolbar();
    renderProcesses();
    goNext({ keepPlaying: true });
    if (session.cursor >= trailLength()) {
        stopPlayback();
        return;
    }
    scheduleTick();
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function setBusy(isBusy) {
    view.busy = isBusy;
    if (isBusy) {
        el.section.setAttribute("aria-busy", "true");
    } else {
        el.section.removeAttribute("aria-busy");
    }
}

function hideError() {
    el.errorBanner.classList.add("hidden");
}

function renderAll({ direction = 0 } = {}) {
    renderHeader(direction);
    renderErrorBanner();
    renderToolbar();
    renderMap(direction);
    renderDecision(direction);
    renderIndicators(direction);
    renderTimeline();
    renderProcesses(direction);
    renderResultsButton(direction);
}

function renderHeader(direction) {
    const config = appState.config;
    if (hasValidConfig(config)) {
        const fixedMode = config.partitionType === "fixed";
        const partitionCount = Array.isArray(config.partitions) && config.partitions.length > 0 ? config.partitions.length : 4;
        const partition = fixedMode ? `Partições fixas · ${partitionCount} partições` : "Partições variáveis";
        el.subtitle.textContent = `${ALGORITHM_LABELS[currentAlgorithm()]} · ${partition} · ${config.totalMemory} KB`;
    } else {
        el.subtitle.textContent = "Nenhuma configuração carregada";
    }

    let pill = "- de -";
    if (view.status === "ready" && session) {
        const total = config.events.length;
        const step = stepAt(session.cursor);
        if (!step) {
            pill = `0 de ${total}`;
        } else if (/^\d+$/.test(step.label)) {
            pill = `${step.label} de ${total}`;
        } else {
            // Special steps get a readable name: "Passo F · Alocação da fila"
            const special = SPECIAL_STEPS[step.label];
            pill = special ? `${step.label} · ${special.name}` : step.label;
        }
    }

    if (el.pillValue.textContent !== pill) {
        el.pillValue.textContent = pill;
        if (direction !== 0) {
            restartAnimation(el.pill, "is-ticking");
        }
    }
}

function renderErrorBanner() {
    if (view.status === "error") {
        el.errorMessage.textContent = `Falha na simulação: ${view.errorMessage}`;
        el.errorBanner.classList.remove("hidden");
    } else if (!view.retry) {
        hideError();
    }
}

function renderToolbar() {
    const ready = view.status === "ready" && Boolean(session) && !view.busy;
    const cursor = session?.cursor ?? 0;
    const length = trailLength();

    el.btnRestart.disabled = !ready || cursor === 0;
    el.btnPrev.disabled = !ready || cursor === 0;
    el.btnNext.disabled = !ready || cursor >= length;
    el.btnPlay.disabled = !ready || (cursor >= length && !view.playing);
    el.speed.disabled = !ready;
    el.speed.value = String(session?.speed ?? 1);

    // Play / pause toggle
    el.btnPlay.setAttribute("aria-pressed", String(view.playing));
    el.btnPlay.setAttribute("aria-label", view.playing ? "Pausar" : "Reproduzir");
    el.btnPlayLabel.textContent = view.playing ? "Pausar" : "Reproduzir";
    el.btnPlayIcon.classList.toggle("sim-icon--play", !view.playing);
    el.btnPlayIcon.classList.toggle("sim-icon--pause", view.playing);
}

/* --- Memory map ---------------------------------------------------- */

function captureSegmentRects() {
    const rects = new Map();
    el.bar.querySelectorAll(".memory-segment[data-key]").forEach((segment) => {
        if (!segment.dataset.key.startsWith("free-")) {
            rects.set(segment.dataset.key, segment.getBoundingClientRect());
        }
    });
    return rects;
}

function playFlip(previousRects) {
    if (reducedMotion.matches || previousRects.size === 0) {
        return;
    }

    let order = 0;
    el.bar.querySelectorAll(".memory-segment[data-key]").forEach((segment) => {
        const before = previousRects.get(segment.dataset.key);
        if (!before) {
            return;
        }
        const after = segment.getBoundingClientRect();
        const dx = before.left - after.left;
        const dy = before.top - after.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
            return;
        }

        const delay = order++ * 60;
        segment.style.transition = "none";
        segment.style.transform = `translate(${dx}px, ${dy}px)`;
        segment.getBoundingClientRect();

        requestAnimationFrame(() => {
            segment.style.transition = `transform var(--dur-slow) var(--ease-in-out) ${delay}ms`;
            segment.style.transform = "";
            segment.addEventListener(
                "transitionend",
                () => {
                    segment.style.transition = "";
                },
                { once: true }
            );
        });
    });
}

function updateSegmentSizes() {
    const vertical = mqVertical.matches;
    const [tinyLimit, narrowLimit] = vertical ? [14, 0] : mqSmall.matches ? [24, 56] : [28, 72];
    const noRangeLimit = !vertical && mqTablet.matches ? 96 : 0;

    el.bar.querySelectorAll(".memory-segment").forEach((segment) => {
        const size = vertical ? segment.offsetHeight : segment.offsetWidth;
        segment.classList.toggle("is-tiny", size < tinyLimit);
        segment.classList.toggle("is-narrow", size >= tinyLimit && size < narrowLimit);
        segment.classList.toggle("is-no-range", size < noRangeLimit);
    });
}

/**
 * Legend adapts to the partitioning mode (spec S3): fixed mode shows free partitions,
 * internal fragmentation and (when present) the unpartitioned area.
 */
function renderLegend(blocks, fixed) {
    const keys = fixed ? ["process", "freePartition", "internal"] : ["process", "free"];
    if (fixed && blocks.some((block) => block.isUnused)) {
        keys.push("unused");
    }

    const html = keys
        .map((key) => {
            const item = LEGEND_ITEMS[key];
            const attrs = item.swatch ?? "";
            const className = item.className ? ` ${item.className}` : "";
            return `<li><span class="sim-swatch${className}" ${attrs}></span>${item.label}</li>`;
        })
        .join("");

    if (el.legend.dataset.html !== html) {
        el.legend.innerHTML = html;
        el.legend.dataset.html = html;
    }
}

function renderRuler(totalMemory) {
    const ticks = [0, 0.25, 0.5, 0.75].map((fraction) => String(Math.round(totalMemory * fraction)));
    ticks.push(`${totalMemory} KB`);
    el.ruler.innerHTML = ticks
        .map((tick, index) => `<span class="${index % 2 === 1 ? "sim-tick-minor" : ""}">${tick}</span>`)
        .join("");
}

function renderMap(direction) {
    const snapshot = view.status === "ready" ? snapshotAt(session.cursor) : null;

    if (!snapshot) {
        el.mapEmpty.hidden = false;
        el.map.hidden = true;
        el.segmentDetail.hidden = true;
        el.mapEmptyText.textContent = view.status === "loading"
            ? "Carregando a simulação…"
            : view.status === "error"
                ? "Não foi possível carregar a simulação."
                : "A memória aparece aqui depois que você configurar e iniciar uma simulação.";
        el.mapEmptyButton.hidden = view.status === "loading";
        return;
    }

    el.mapEmpty.hidden = true;
    el.map.hidden = false;

    const step = stepAt(session.cursor);
    const animate = direction === 1 && !reducedMotion.matches;
    const previousRects = animate ? captureSegmentRects() : new Map();
    const totalMemory = snapshot.metrics.totalMemory;
    const fixed = isFixed();

    el.bar.innerHTML = snapshot.blocks
        .map((block) => {
            const classes = ["memory-segment"];
            const style = [`--size: ${block.size}`];
            const name = blockName(block);

            if (block.isFree) {
                classes.push("is-free");
            } else if (block.isUnused) {
                classes.push("is-unused");
            } else {
                style.push(`--segment-color: ${getProcessColor(block.process, appState.config)}`);
            }

            if (fixed && block.partition) {
                classes.push("is-partition");
                if (!block.isFree && block.used) {
                    style.push(`--used: ${((block.used / block.size) * 100).toFixed(2)}%`);
                }
            }

            if (step?.affected && !block.isFree && block.process === step.affected.process && step.outcome === "allocated") {
                classes.push("is-active");
                if (animate) {
                    classes.push("is-new");
                }
            }

            if (animate && block.isFree && step?.affected && block.start <= step.affected.start
                && block.end > step.affected.start && step.outcome === "freed") {
                classes.push("is-freed");
                style.push(`--freed-color: ${getProcessColor(step.affected.process, appState.config)}`);
            }

            const sizeText = fixed && block.used ? `${block.used} / ${block.size} KB` : `${block.size} KB`;
            const partitionText = fixed && block.partition ? ` · partição ${block.partition}` : "";
            const internalText = fixed && block.used && block.size > block.used
                ? ` · ${block.size - block.used} KB de fragmentação interna`
                : "";
            const detail = `${name} — ${sizeText} (${block.start}–${block.end})${partitionText}${internalText}`;

            return `
                <div class="${classes.join(" ")}" style="${style.join("; ")}" data-key="${escapeHtml(segmentKey(block))}"
                    data-detail="${escapeHtml(detail)}" title="${escapeHtml(detail)}" tabindex="-1">
                    ${fixed && block.partition ? `<span class="sim-seg-part">Partição ${block.partition}</span>` : ""}
                    <strong>${escapeHtml(name)}</strong>
                    <span class="sim-seg-size">${escapeHtml(sizeText)}</span>
                    <span class="sim-seg-range">${block.start}-${block.end}</span>
                </div>
            `;
        })
        .join("");

    el.bar.setAttribute(
        "aria-label",
        `Memória: ${snapshot.blocks.map((block) => `${blockName(block)} ${block.start}-${block.end}`).join(", ")}`
    );

    renderRuler(totalMemory);
    renderLegend(snapshot.blocks, fixed);
    updateSegmentSizes();
    el.segmentDetail.hidden = true;

    if (animate) {
        playFlip(previousRects);
    }
}

/* --- Decision ------------------------------------------------------ */

function renderDecision(direction) {
    const ready = view.status === "ready" && session;
    const step = ready ? stepAt(session.cursor) : null;
    let html;

    if (!ready || !step) {
        let decision = EMPTY_DECISION;
        if (view.status === "loading") {
            decision = { variant: "empty", title: "Carregando a simulação…", text: "Executando a sequência de eventos no servidor." };
        } else if (ready) {
            decision = {
                variant: "empty",
                title: "Pronto para iniciar",
                text: "Clique em Próximo passo ou Reproduzir para executar o primeiro evento."
            };
        }
        el.currentEvent.textContent = "--";
        html = outcomeHtml(decision.variant, decision.title, decision.text);
    } else {
        el.currentEvent.textContent = eventText(step);
        const length = trailLength();
        const isLast = session.cursor === length;
        const parts = [];

        if (step.event?.type === "allocate" && step.holesChecked.length > 0) {
            parts.push(`<ul class="sim-hole-list">${step.holesChecked.map(holeHtml).join("")}</ul>`);
        }

        const variant = {
            allocated: "success",
            refused: "refused",
            compacted: "compacted",
            rejected: "rejected"
        }[step.outcome] ?? "neutral";

        const title = step.outcome === "refused" && isLast
            ? `${step.decision.title} - fim da sequência`
            : step.decision.title;
        parts.push(outcomeHtml(variant, title, step.decision.explanation));

        if (step.queue.length > 0) {
            const chips = step.queue
                .map((item) => `<span class="sim-chip${isLast ? " sim-chip--stuck" : ""}">${escapeHtml(item.process)} - ${item.size} KB</span>`)
                .join("");
            const nextStep = stepAt(session.cursor + 1);
            const allocNow = step.outcome === "compacted" && nextStep?.label === "F"
                ? `<button type="button" class="sim-alloc-now" data-action="alloc-now">Alocar ${escapeHtml(nextStep.event.process)} agora</button>`
                : "";
            parts.push(`<div class="sim-queue"><span>Fila de espera:</span>${chips}${allocNow}</div>`);
        }

        html = parts.join("");
    }

    el.decisionBody.innerHTML = html;
    if (direction !== 0) {
        restartAnimation(el.decisionBody, "is-swapping");
    }
}

function holeHtml(hole, index) {
    const name = hole.partition ? `Partição ${hole.partition}` : `Lacuna ${hole.index}`;
    const badge = hole.status === "occupied" && hole.process
        ? `${HOLE_BADGES.occupied} · ${hole.process}`
        : HOLE_BADGES[hole.status] ?? hole.status;
    const classes = ["sim-hole"];
    if (hole.status === "chosen") {
        classes.push("is-chosen");
    }
    if (hole.status === "occupied") {
        classes.push("is-occupied");
    }
    return `
        <li class="${classes.join(" ")}" style="--i: ${index};">
            <span>${escapeHtml(name)} - ${hole.start}-${hole.end} - ${hole.size} KB</span>
            <span class="sim-badge sim-badge--${hole.status}" style="--i: ${index};">${escapeHtml(badge)}</span>
        </li>
    `;
}

function outcomeHtml(variant, title, text) {
    return `
        <div class="sim-outcome sim-outcome--${variant}">
            <p class="sim-outcome-title">${escapeHtml(title)}</p>
            <p class="sim-outcome-text">${escapeHtml(text)}</p>
        </div>
    `;
}

/* --- Indicators ---------------------------------------------------- */

const INDICATORS = [
    { key: "usedMemory", format: (value) => `${Math.round(value)} KB` },
    { key: "utilization", format: formatPercent, decimals: true },
    { key: "freeMemory", format: (value) => `${Math.round(value)} KB` },
    { key: "largestHole", format: (value) => `${Math.round(value)} KB` },
    { key: "holeCount", format: (value) => String(Math.round(value)) },
    { key: "externalFragmentation", format: formatPercent, decimals: true }
];

function animateNumber(node, from, to, format, decimals) {
    if (reducedMotion.matches || from === to) {
        node.textContent = format(to);
        return;
    }
    const start = performance.now();
    const tick = (now) => {
        const progress = Math.min(1, (now - start) / COUNT_UP_MS);
        const eased = 1 - Math.pow(1 - progress, 3);
        const value = from + (to - from) * eased;
        node.textContent = format(decimals ? Math.round(value * 10) / 10 : value);
        if (progress < 1) {
            requestAnimationFrame(tick);
        }
    };
    requestAnimationFrame(tick);
}

function renderIndicators(direction) {
    const snapshot = view.status === "ready" && session ? snapshotAt(session.cursor) : null;
    const fixed = isFixed();

    INDICATORS.forEach((indicator) => {
        const card = el.indicators.querySelector(`[data-metric="${indicator.key}"]`);
        const label = card.querySelector("dt");
        const valueNode = card.querySelector("dd");

        let key = indicator.key;
        let format = indicator.format;
        let decimals = indicator.decimals;
        // Fixed partitions use partition-oriented labels (spec S4)
        const labels = {
            holeCount: fixed ? "Partições livres" : "Nº de lacunas",
            largestHole: fixed ? "Maior partição livre" : "Maior lacuna",
            externalFragmentation: fixed ? "Fragmentação interna" : "Fragmentação externa"
        };
        if (labels[key] && label.textContent !== labels[key]) {
            label.textContent = labels[key];
        }
        if (fixed && key === "externalFragmentation") {
            key = "internalFragmentation";
            format = (value) => `${Math.round(value)} KB`;
            decimals = false;
        }

        if (!snapshot) {
            card.classList.add("is-empty");
            valueNode.textContent = "--";
            return;
        }

        card.classList.remove("is-empty");
        const value = Number(snapshot.metrics[key] ?? 0);
        const previous = view.lastMetrics ? Number(view.lastMetrics[key] ?? 0) : value;

        if (direction !== 0 && view.lastMetrics) {
            animateNumber(valueNode, previous, value, format, decimals);
            card.classList.remove("is-up", "is-down");
            if (value !== previous) {
                restartAnimation(card, value > previous ? "is-up" : "is-down");
            }
        } else {
            valueNode.textContent = format(value);
        }
    });

    view.lastMetrics = snapshot ? snapshot.metrics : null;
}

/* --- Timeline ------------------------------------------------------ */

function renderTimeline() {
    const trail = view.status === "ready" ? activeTrail() : null;

    if (!trail) {
        el.timelineEmpty.hidden = false;
        el.timeline.hidden = true;
        el.timeline.style.setProperty("--indicator-o", "0");
        el.timelineLegend.hidden = true;
        return;
    }

    el.timelineEmpty.hidden = true;
    el.timeline.hidden = false;
    const cursor = session.cursor;

    el.timeline.innerHTML = trail.steps
        .map((step, index) => {
            const position = index + 1;
            const executed = position <= cursor;
            const status = executed ? step.outcome : "pending";
            const statusText = executed ? OUTCOME_STATUS[step.outcome] ?? step.outcome : "Pendente";
            const current = position === cursor;
            const special = SPECIAL_STEPS[step.label];

            return `
                <li>
                    <button type="button" class="sim-timeline-btn${executed ? "" : " is-pending"}" data-position="${position}"
                        ${current ? 'aria-current="step"' : ""} aria-label="Ir para o passo ${escapeHtml(step.label)}${special ? ` (${special.name})` : ""}: ${escapeHtml(eventText(step))} (${statusText})">
                        <span class="sim-tl-marker${special ? " is-special" : ""}" aria-hidden="true"
                            ${special ? `title="${escapeHtml(`${step.label} = ${special.name}: ${special.description}`)}"` : ""}>${escapeHtml(step.label)}</span>
                        <span class="sim-tl-label">${escapeHtml(eventText(step))}</span>
                        <span class="sim-tl-status sim-tl-status--${status}">${escapeHtml(statusText)}</span>
                    </button>
                </li>
            `;
        })
        .join("");

    renderTimelineLegend(trail);
    positionTimelineIndicator();
}

/**
 * Explains the letters C, L and F under the timeline, only for the ones present in the trail.
 */
function renderTimelineLegend(trail) {
    const present = Object.keys(SPECIAL_STEPS).filter((label) => trail.steps.some((step) => step.label === label));

    if (present.length === 0) {
        el.timelineLegend.hidden = true;
        el.timelineLegend.innerHTML = "";
        return;
    }

    const html = present
        .map((label) => {
            const special = SPECIAL_STEPS[label];
            return `
                <li>
                    <span class="sim-tl-marker is-special" aria-hidden="true">${label}</span>
                    <span><strong>${special.name}</strong>: ${special.description}</span>
                </li>
            `;
        })
        .join("");

    if (el.timelineLegend.dataset.html !== html) {
        el.timelineLegend.innerHTML = html;
        el.timelineLegend.dataset.html = html;
    }
    el.timelineLegend.hidden = false;
}

function positionTimelineIndicator() {
    const current = el.timeline.querySelector('[aria-current="step"]');
    if (!current) {
        el.timeline.style.setProperty("--indicator-o", "0");
        return;
    }
    el.timeline.style.setProperty("--indicator-y", `${current.parentElement.offsetTop}px`);
    el.timeline.style.setProperty("--indicator-h", `${current.offsetHeight}px`);
    el.timeline.style.setProperty("--indicator-o", "1");
}

/* --- Processes table ----------------------------------------------- */

function renderProcesses(direction = 0) {
    const snapshot = view.status === "ready" && session ? snapshotAt(session.cursor) : null;
    const processes = snapshot
        ? snapshot.blocks
            .filter((block) => !block.isFree && !block.isUnused)
            .sort((a, b) => a.start - b.start)
        : [];

    if (processes.length === 0) {
        el.processBody.innerHTML = `
            <tr class="is-empty-row"><td colspan="4" class="empty-table-cell">Nenhum processo na memória.</td></tr>
        `;
        return;
    }

    const existing = new Map();
    el.processBody.querySelectorAll("tr[data-id]").forEach((row) => existing.set(row.dataset.id, row));
    el.processBody.querySelectorAll("tr.is-empty-row").forEach((row) => row.remove());

    const fragment = document.createDocumentFragment();
    processes.forEach((block) => {
        let row = existing.get(block.process);
        if (row && !row.classList.contains("is-leaving")) {
            existing.delete(block.process);
        } else {
            row = document.createElement("tr");
            row.dataset.id = block.process;
            row.classList.add("is-new-row");
            setTimeout(() => row.classList.remove("is-new-row"), 320);
        }

        const color = getProcessColor(block.process, appState.config);
        row.innerHTML = `
            <td class="sim-td-process" data-label="Processo">
                <span class="sim-proc-id"><span class="sim-swatch" style="--segment-color: ${color};"></span>${escapeHtml(block.process)}</span>
            </td>
            <td data-label="Endereço base">${block.start}</td>
            <td data-label="Endereço final">${block.end}</td>
            <td data-label="Tamanho">${block.used ?? block.size} KB</td>
        `;
        fragment.appendChild(row);
    });

    // Rows whose process left memory play an exit animation before removal
    const leaving = [];
    existing.forEach((row) => {
        if (direction !== 0 && !reducedMotion.matches) {
            row.classList.add("is-leaving");
            leaving.push(row);
        }
    });

    el.processBody.replaceChildren(fragment);
    leaving.forEach((row) => {
        el.processBody.appendChild(row);
        setTimeout(() => row.remove(), 300);
    });
}

function renderResultsButton(direction) {
    const ready = view.status === "ready" && Boolean(session);
    el.btnResults.hidden = !ready;
    const atEnd = ready && session.cursor === trailLength() && trailLength() > 0;
    if (atEnd && direction > 0) {
        restartAnimation(el.btnResults, "is-attention");
    } else if (!atEnd) {
        el.btnResults.classList.remove("is-attention");
    }
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

function playEntryAnimation() {
    restartAnimation(el.section, "is-entering");
    setTimeout(() => el.section.classList.remove("is-entering"), 900);
}

function handleKeydown(event) {
    if (getActiveTab() !== "simulate" || event.altKey || event.ctrlKey || event.metaKey) {
        return;
    }
    const tag = event.target?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || event.target?.isContentEditable) {
        return;
    }

    if (event.key === "ArrowRight") {
        event.preventDefault();
        goNext();
    } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        goPrev();
    } else if (event.key === " " && tag !== "BUTTON") {
        event.preventDefault();
        togglePlayback();
    } else if (event.key === "r" || event.key === "R") {
        restart();
    }
}

function cacheElements() {
    const byId = (id) => document.getElementById(id);
    el.section = byId("tab-simulate");
    el.subtitle = byId("sim-subtitle");
    el.pill = byId("sim-step-pill");
    el.pillValue = byId("sim-step-pill-value");
    el.errorBanner = byId("sim-error-banner");
    el.errorMessage = byId("sim-error-message");
    el.btnRetry = byId("sim-btn-retry");
    el.btnRestart = byId("sim-btn-restart");
    el.btnPrev = byId("sim-btn-prev");
    el.btnPlay = byId("sim-btn-play");
    el.btnPlayLabel = el.btnPlay.querySelector(".sim-ctrl-label");
    el.btnPlayIcon = el.btnPlay.querySelector(".sim-icon");
    el.btnNext = byId("sim-btn-next");
    el.speed = byId("sim-speed");
    el.mapEmpty = byId("sim-map-empty");
    el.mapEmptyText = el.mapEmpty.querySelector("p");
    el.mapEmptyButton = el.mapEmpty.querySelector("button");
    el.map = byId("sim-map");
    el.bar = byId("sim-memory-bar");
    el.ruler = byId("sim-memory-ruler");
    el.legend = document.querySelector("#tab-simulate .sim-legend");
    el.segmentDetail = byId("sim-segment-detail");
    el.currentEvent = byId("sim-current-event");
    el.decisionBody = byId("sim-decision-body");
    el.indicators = byId("sim-indicators");
    el.timeline = byId("sim-timeline");
    el.timelineEmpty = byId("sim-timeline-empty");
    el.timelineLegend = byId("sim-timeline-legend");
    el.processBody = byId("sim-process-body");
    el.btnResults = byId("sim-btn-results");
}

function bindEvents() {
    el.btnRestart.addEventListener("click", restart);
    el.btnPrev.addEventListener("click", goPrev);
    el.btnNext.addEventListener("click", () => goNext());
    el.btnPlay.addEventListener("click", togglePlayback);

    el.speed.addEventListener("change", () => {
        if (!session) {
            return;
        }
        session.speed = Number(el.speed.value) || 1;
        persist();
        if (view.playing) {
            scheduleTick();
        }
    });

    el.btnRetry.addEventListener("click", () => {
        hideError();
        const retry = view.retry;
        view.retry = null;
        view.errorMessage = "";
        if (retry) {
            retry();
        }
    });

    el.decisionBody.addEventListener("click", (event) => {
        if (event.target.closest('[data-action="alloc-now"]')) {
            goNext();
        }
    });

    el.timeline.addEventListener("click", (event) => {
        const button = event.target.closest("[data-position]");
        if (button) {
            goTo(Number(button.dataset.position));
        }
    });

    el.bar.addEventListener("click", (event) => {
        const segment = event.target.closest(".memory-segment[data-detail]");
        if (!segment) {
            return;
        }
        const detail = segment.dataset.detail;
        const isSame = !el.segmentDetail.hidden && el.segmentDetail.textContent === detail;
        el.segmentDetail.textContent = detail;
        el.segmentDetail.hidden = isSame;
    });

    if (typeof ResizeObserver !== "undefined") {
        const observer = new ResizeObserver(() => {
            updateSegmentSizes();
            positionTimelineIndicator();
        });
        observer.observe(el.bar);
        observer.observe(el.timeline);
    }

    document.addEventListener("keydown", handleKeydown);

    window.addEventListener("memsim:config-updated", () => {
        stopPlayback();
        session = null;
        view.lastMetrics = null;
        view.requestToken++;
        if (getActiveTab() === "simulate") {
            loadSession();
        } else {
            // Reloaded when the user comes back to the tab
            setBusy(false);
            view.status = "empty";
            renderAll();
        }
    });

    window.addEventListener("memsim:tab-changed", (event) => {
        if (event.detail?.tabName === "simulate") {
            playEntryAnimation();
            loadSession();
        } else {
            stopPlayback();
        }
    });
}

function initSimulateTab() {
    cacheElements();
    if (!el.section) {
        return;
    }
    bindEvents();
    renderAll();

    if (getActiveTab() === "simulate") {
        playEntryAnimation();
        loadSession();
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSimulateTab);
} else {
    initSimulateTab();
}
