import {
    SAMPLE_CONFIG,
    appState,
    getConfigHash,
    getProcessColor,
    setConfig,
    setConfigDraft,
    clearConfig,
    saveSimulationResults,
    setSimulationSession
} from "./state.js";
import { getActiveTab, switchTab } from "./tabs.js";
import {
    LIMITS,
    buildContext,
    configToDraft,
    createEmptyDraft,
    draftToConfig,
    normalizeId,
    splitEqually,
    suggestNextId,
    validateNewEvent,
    validateSequence
} from "./validation.js";

const MODE_HELP = {
    dynamic: "Cada processo recebe exatamente o espaço que pede. As lacunas entre processos podem gerar fragmentação externa.",
    fixed: "A memória é dividida em partições de tamanho fixo. Cada partição recebe no máximo um processo, e a sobra dentro dela é fragmentação interna."
};

const FORM_HELP = {
    allocate: "Preencha o processo e o tamanho para adicionar o evento à sequência.",
    free: "Escolha um processo alocado para liberá-lo.",
    compact: "A compactação junta todas as lacunas livres em uma só. Não precisa de processo nem de tamanho."
};

const EVENT_PILLS = {
    allocate: { label: "Alocar", className: "allocate" },
    free: { label: "Liberar", className: "free" },
    compact: { label: "Compactar", className: "compact" }
};

const TOAST_MS = 6000;
const SAVE_DEBOUNCE_MS = 200;
const LEAVE_MS = 280;

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/** Editable draft (spec §8.2). */
let draft = null;

const view = {
    touched: new Set(), // parameter fields that already showed validation
    newRows: new Set(), // event indexes (0-based) that should animate in
    staggerRows: false,
    toast: null, // { events, timer }
    saveTimer: null,
    wasReady: false
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

function plural(count, singular, pluralForm) {
    return `${count} ${count === 1 ? singular : pluralForm}`;
}

function restartAnimation(node, className) {
    node.classList.remove(className);
    void node.offsetWidth;
    node.classList.add(className);
}

function saveDraft({ immediate = false } = {}) {
    clearTimeout(view.saveTimer);
    if (immediate) {
        setConfigDraft(draft);
        return;
    }
    view.saveTimer = setTimeout(() => setConfigDraft(draft), SAVE_DEBOUNCE_MS);
}

function setFieldError(input, errorNode, message, { warning = false, shake = false } = {}) {
    if (message) {
        errorNode.textContent = message;
        errorNode.hidden = false;
        errorNode.classList.toggle("is-warning", warning);
        input.classList.toggle("has-warning", warning);
        if (warning) {
            input.removeAttribute("aria-invalid");
        } else if (shake || input.getAttribute("aria-invalid") !== "true") {
            // Re-adding the attribute replays the shake animation
            input.removeAttribute("aria-invalid");
            void input.offsetWidth;
            input.setAttribute("aria-invalid", "true");
        }
    } else {
        errorNode.hidden = true;
        errorNode.textContent = "";
        input.removeAttribute("aria-invalid");
        input.classList.remove("has-warning");
    }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/** Copies draft values into the inputs (only on load/reset, never while typing). */
function syncInputs() {
    el.total.value = draft.totalMemory;
    el.partitionsInput.value = draft.partitionsText;
    el.modeInputs.forEach((input) => {
        input.checked = input.value === draft.partitionType;
    });
    el.algorithmInputs.forEach((input) => {
        input.checked = input.value === draft.algorithm;
    });
}

function render() {
    const context = buildContext(draft);
    const sequence = validateSequence(draft.events, context);

    renderParams(context);
    renderMode(context);
    renderPartitions(context);
    renderForm(context, sequence);
    renderTable(sequence);
    renderActionBar(context, sequence);
}

function renderParams(context) {
    const { params } = context;

    setFieldError(el.total, el.totalError, view.touched.has("totalMemory") ? params.errors.totalMemory : "");

    el.sizeHint.textContent = params.ok ? `Inteiro de 1 a ${params.area} KB` : "Preencha a memória primeiro";
}

function renderMode(context) {
    const help = MODE_HELP[draft.partitionType];
    if (el.modeHelp.textContent !== help) {
        el.modeHelp.textContent = help;
        restartAnimation(el.modeHelp, "cfg-mode-help-swap");
    }

    const fixed = context.fixed;
    el.partitions.classList.toggle("is-open", fixed);
    el.partitions.setAttribute("aria-hidden", String(!fixed));
    el.partitionsInput.tabIndex = fixed ? 0 : -1;
    el.splitEqual.tabIndex = fixed ? 0 : -1;

    el.algorithmDescriptions.forEach((node) => {
        node.textContent = fixed ? node.dataset.descFixed : node.dataset.descDynamic;
    });

    // "Compactar memória" only exists for variable partitions
    el.compactOption.hidden = fixed;
    el.compactOption.disabled = fixed;
    if (fixed && el.eventType.value === "compact") {
        el.eventType.value = "allocate";
        clearFormErrors();
    }
}

function renderPartitions(context) {
    const partitions = context.partitions;
    if (!partitions) {
        el.partitionsPreview.innerHTML = "";
        el.partitionsSum.textContent = "";
        return;
    }

    const chips = partitions.sizes.map(
        (size, index) => `<span class="cfg-chip" style="--size: ${size}; --i: ${index};" title="Partição ${index + 1}: ${size} KB">${size}</span>`
    );
    if (partitions.status === "under") {
        chips.push(`<span class="cfg-chip cfg-chip--unused" style="--size: ${partitions.leftover};" title="Não particionado: ${partitions.leftover} KB">${partitions.leftover}</span>`);
    }
    const chipsHtml = chips.join("");
    if (el.partitionsPreview.dataset.html !== chipsHtml) {
        el.partitionsPreview.innerHTML = chipsHtml;
        el.partitionsPreview.dataset.html = chipsHtml;
    }

    const messages = {
        empty: "Informe os tamanhos das partições.",
        invalid: "Use apenas inteiros positivos separados por vírgula.",
        unknown: `Soma: ${partitions.sum} KB - preencha a memória total para comparar`,
        equal: `Soma: ${partitions.sum} KB - igual à memória total`,
        under: `Soma: ${partitions.sum} KB - ${partitions.leftover} KB ficam sem partição`,
        over: `Soma: ${partitions.sum} KB - excede a memória total em ${partitions.excess} KB`
    };

    el.partitionsSum.textContent = messages[partitions.status];
    el.partitionsSum.className = `cfg-partitions-sum is-${partitions.status === "empty" ? "unknown" : partitions.status}`;
    el.partitionsInput.setAttribute(
        "aria-invalid",
        String(partitions.status === "invalid" || partitions.status === "over")
    );
    el.splitEqual.disabled = !context.params.ok;
}

function renderForm(context, sequence) {
    const type = el.eventType.value;
    const isFree = type === "free";
    const isCompact = type === "compact";

    // Process field: free text for allocations, select of active processes for frees,
    // and no process/size at all for a compaction
    el.processField.classList.toggle("is-hidden", isCompact);
    el.processInput.hidden = isFree;
    el.processSelectWrap.hidden = !isFree;
    el.sizeField.classList.toggle("is-hidden", isFree || isCompact);
    el.formHelp.textContent = FORM_HELP[type];
    el.processInput.placeholder = `ex.: ${suggestNextId(draft.events)}`;

    if (isFree) {
        const current = el.processSelect.value;
        const options = sequence.activeAtEnd;
        el.processSelect.innerHTML = options.length > 0
            ? options.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join("")
            : '<option value="" disabled selected>Nenhum processo alocado</option>';
        if (options.includes(current)) {
            el.processSelect.value = current;
        }
    }

    el.btnAdd.disabled = draft.events.length >= LIMITS.maxEvents;
}

function renderTable(sequence) {
    const hasEvents = draft.events.length > 0;
    el.empty.hidden = hasEvents;
    el.eventsFrame.hidden = !hasEvents;

    if (!hasEvents) {
        el.eventsBody.innerHTML = "";
        return;
    }

    el.eventsBody.innerHTML = draft.events
        .map((event, index) => {
            const row = sequence.rows[index];
            const isCompact = event.type === "compact";
            const pill = EVENT_PILLS[event.type] ?? EVENT_PILLS.allocate;
            const label = isCompact ? "Compactar memória" : `${pill.label} ${event.process}`;
            const classes = [];
            if (!row.ok) {
                classes.push("is-invalid");
            }
            const animate = view.staggerRows || view.newRows.has(index);
            if (animate && !reducedMotion.matches) {
                classes.push("is-new");
            }
            const messages = [...row.errors, ...row.warnings];
            const alert = messages.length > 0
                ? `<span class="cfg-row-alert${row.ok ? " is-warning" : ""}" title="${escapeHtml(messages.join(" "))}" aria-label="${escapeHtml(messages.join(" "))}">!</span>`
                : "";
            const sizeText = event.type === "allocate" ? `${event.size} KB` : "--";
            const rejectTag = row.rejectedAtLoad ? '<span class="cfg-reject-tag">Rejeitado no carregamento</span>' : "";
            const processCell = isCompact
                ? '<span class="cfg-proc cfg-proc--none">--</span>'
                : `<span class="cfg-proc"><span class="cfg-swatch" style="--segment-color: ${getProcessColor(event.process, appState.config)};"></span>${escapeHtml(event.process)}</span>`;

            return `
                <tr class="${classes.join(" ")}" data-index="${index}" style="--i: ${view.staggerRows ? index : 0};">
                    <td><span class="cfg-row-index">${index + 1}${alert}</span></td>
                    <td><span class="cfg-pill cfg-pill--${pill.className}">${pill.label}</span></td>
                    <td data-size="${escapeHtml(isCompact ? "" : sizeText)}">${processCell}</td>
                    <td>${escapeHtml(sizeText)}${rejectTag}</td>
                    <td>
                        <button type="button" class="cfg-delete" data-delete="${index}" aria-label="Remover evento ${index + 1}: ${escapeHtml(label)}">
                            <span class="icon icon--trash" aria-hidden="true"></span>
                        </button>
                    </td>
                </tr>
            `;
        })
        .join("");

    view.newRows.clear();
    view.staggerRows = false;
}

function renderActionBar(context, sequence) {
    const { summary } = sequence;
    const config = draftToConfig(draft);
    const ready = Boolean(config);
    let text;
    let blocked = false;

    if (summary.total === 0) {
        text = "Nenhum evento cadastrado - cadastre ao menos uma alocação para iniciar";
    } else {
        const compactText = summary.compactions > 0
            ? ` - ${plural(summary.compactions, "compactação", "compactações")}`
            : "";
        text = `${plural(summary.total, "evento", "eventos")} - ${plural(summary.allocations, "alocação", "alocações")} - ` +
            `${plural(summary.frees, "liberação", "liberações")}${compactText} - demanda total de ${summary.demand} KB`;

        if (!context.params.ok) {
            text = "Corrija os parâmetros da memória para iniciar.";
            blocked = true;
        } else if (context.fixed && context.partitions?.status === "over") {
            text = "A soma das partições excede a memória total.";
            blocked = true;
        } else if (context.fixed && !context.partitions?.ok) {
            text = "Defina os tamanhos das partições para iniciar.";
            blocked = true;
        } else if (sequence.invalidCount > 0) {
            text = `${plural(sequence.invalidCount, "evento precisa", "eventos precisam")} de correção (marcados em vermelho).`;
            blocked = true;
        } else if (summary.allocations === 0) {
            text = "Cadastre ao menos uma alocação para iniciar.";
            blocked = true;
        }
    }

    el.summary.textContent = text;
    el.summary.classList.toggle("is-blocked", blocked);
    el.btnStart.disabled = !ready;
    el.btnCompare.disabled = !ready;

    if (ready && !view.wasReady && !reducedMotion.matches) {
        restartAnimation(el.btnStart, "is-attention");
    }
    view.wasReady = ready;

    const applied = appState.config ? getConfigHash(appState.config) : "";
    el.pending.hidden = !applied || applied === (config ? getConfigHash(config) : "");

    // Stays enabled while another tab still holds an applied config, even if the draft is empty
    el.btnReset.disabled = isDraftEmpty(draft) && !appState.config;
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function clearFormErrors() {
    setFieldError(el.processInput, el.processError, "");
    setFieldError(el.processSelect, el.processError, "");
    setFieldError(el.size, el.sizeError, "");
    el.formBanner.hidden = true;
}

function handleAddEvent(event) {
    event.preventDefault();
    const type = el.eventType.value;
    const context = buildContext(draft);
    const result = validateNewEvent(
        {
            type,
            process: type === "free" ? el.processSelect.value : el.processInput.value,
            size: el.size.value
        },
        draft.events,
        context
    );

    clearFormErrors();

    if (!result.ok) {
        const processInput = type === "free" ? el.processSelect : el.processInput;
        if (result.errors.form) {
            el.formBanner.textContent = result.errors.form;
        } else {
            el.formBanner.textContent = "Corrija o campo para continuar.";
            setFieldError(processInput, el.processError, result.errors.process, { shake: true });
            setFieldError(el.size, el.sizeError, result.errors.size, { shake: true });
        }
        el.formBanner.hidden = false;
        restartAnimation(el.formBanner, "is-shown");
        (result.errors.process ? processInput : el.size).focus();
        return;
    }

    hideToast();
    draft.events.push(result.event);
    view.newRows.add(draft.events.length - 1);
    saveDraft({ immediate: true });

    el.processInput.value = "";
    el.size.value = "";
    render();

    if (result.warnings.size) {
        setFieldError(el.size, el.sizeError, result.warnings.size, { warning: true });
    }

    const lastRow = el.eventsBody.lastElementChild;
    lastRow?.scrollIntoView({ block: "nearest", behavior: reducedMotion.matches ? "auto" : "smooth" });
    const focusTarget = { free: el.processSelect, compact: el.btnAdd }[type] ?? el.processInput;
    focusTarget.focus();
}

/**
 * Removes an event. Removing an allocation also removes the next liberation of the same process
 * (spec D3), with an undo toast.
 */
function handleDelete(index) {
    const target = draft.events[index];
    if (!target) {
        return;
    }

    const toRemove = [index];
    if (target.type === "allocate") {
        for (let i = index + 1; i < draft.events.length; i++) {
            const candidate = draft.events[i];
            if (candidate.process !== target.process) {
                continue;
            }
            if (candidate.type === "free") {
                toRemove.push(i);
            }
            break; // stop at the next event of the same process
        }
    }

    const snapshot = draft.events.map((item) => ({ ...item }));
    const finish = () => {
        draft.events = draft.events.filter((_, position) => !toRemove.includes(position));
        saveDraft({ immediate: true });
        render();

        const extra = toRemove.length > 1
            ? ` (e a liberação de ${target.process} no evento ${toRemove[1] + 1})`
            : "";
        showToast(`Evento ${index + 1} removido${extra}.`, snapshot);

        const nextButton = el.eventsBody.querySelector(`[data-delete="${Math.min(index, draft.events.length - 1)}"]`);
        (nextButton ?? el.processInput).focus();
    };

    if (reducedMotion.matches) {
        finish();
        return;
    }

    toRemove.forEach((position) => {
        el.eventsBody.querySelector(`tr[data-index="${position}"]`)?.classList.add("is-leaving");
    });
    setTimeout(finish, LEAVE_MS);
}

/**
 * Shows the undo toast. `snapshot` is either the previous events list or, for a full reset,
 * the whole previous draft ({ fullDraft }).
 */
function showToast(message, snapshot) {
    hideToast();
    el.toastText.textContent = message;
    el.toast.hidden = false;
    restartAnimation(el.toast, "is-shown");
    const progress = el.toast.querySelector(".cfg-toast-progress");
    restartAnimation(progress, "is-running");
    view.toast = {
        snapshot,
        timer: setTimeout(hideToast, TOAST_MS)
    };
}

function hideToast() {
    if (view.toast) {
        clearTimeout(view.toast.timer);
        view.toast = null;
    }
    el.toast.hidden = true;
}

function undoDelete() {
    if (!view.toast) {
        return;
    }
    const { snapshot } = view.toast;
    hideToast();

    if (snapshot.fullDraft) {
        loadDraft(snapshot.fullDraft, { stagger: true });
        restoreAppliedState(snapshot.applied);
        return;
    }

    draft.events = snapshot;
    saveDraft({ immediate: true });
    render();
}

function loadDraft(nextDraft, { stagger = false, touched = true } = {}) {
    hideToast();
    clearFormErrors();
    draft = nextDraft;
    view.touched = touched ? new Set(["totalMemory"]) : new Set();
    view.staggerRows = stagger;
    el.eventType.value = "allocate";
    el.processInput.value = "";
    el.size.value = "";
    syncInputs();
    saveDraft({ immediate: true });
    render();
}

function isDraftEmpty(candidate) {
    const empty = createEmptyDraft();
    return (
        String(candidate.totalMemory).trim() === "" &&
        String(candidate.partitionsText).trim() === "" &&
        candidate.partitionType === empty.partitionType &&
        candidate.algorithm === empty.algorithm &&
        candidate.events.length === 0
    );
}

/**
 * Resets the whole draft (memory, partitioning, algorithm and events) so the user can start over.
 * The applied config is untouched until the user starts or compares again (spec D1).
 */
function handleReset() {
    if (isDraftEmpty(draft) && !appState.config) {
        return;
    }

    // Snapshot of everything the reset discards, so "Desfazer" can bring it all back
    const snapshot = {
        fullDraft: structuredClone(draft),
        applied: appState.config
            ? {
                config: structuredClone(appState.config),
                resultsCache: structuredClone(appState.resultsCache ?? {}),
                simulationSession: appState.simulationSession ? structuredClone(appState.simulationSession) : null
            }
            : null
    };

    loadDraft(createEmptyDraft(), { touched: false });
    // Also clears the applied config, the Simulate session and the Compare results:
    // the other tabs go back to their empty state (spec D10)
    clearConfig();

    el.infoBanner.classList.add("hidden");
    playEntryAnimation();
    showToast("Configuração limpa em todas as abas. Comece de novo pelos parâmetros da memória.", snapshot);
    el.total.focus();
}

/**
 * Restores the applied config, the cached comparison results and the simulation session
 * captured before a reset.
 */
function restoreAppliedState(applied) {
    if (!applied?.config) {
        return;
    }
    setConfig(applied.config); // clears cache and session, then notifies the other tabs
    if (applied.resultsCache && Object.keys(applied.resultsCache).length > 0) {
        saveSimulationResults(applied.resultsCache);
    }
    if (applied.simulationSession) {
        setSimulationSession(applied.simulationSession);
    }
    render();
}

function applyAndGo(tabName) {
    const config = draftToConfig(draft);
    if (!config) {
        return;
    }
    saveDraft({ immediate: true });
    // Only re-apply when something changed: re-applying wipes the Compare results and the
    // simulation in progress
    const unchanged = appState.config && getConfigHash(appState.config) === getConfigHash(config);
    if (!unchanged) {
        setConfig(config);
    }
    switchTab(tabName);

    if (tabName === "compare") {
        window.dispatchEvent(new CustomEvent("memsim:request-comparison"));
    }
}

function showInfo(message) {
    el.infoText.textContent = message;
    el.infoBanner.classList.remove("hidden");
}

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

function cacheElements() {
    const byId = (id) => document.getElementById(id);
    el.section = byId("tab-configure");
    el.infoBanner = byId("cfg-info-banner");
    el.infoText = byId("cfg-info-text");
    el.infoClose = byId("cfg-info-close");
    el.total = byId("cfg-total");
    el.totalError = byId("cfg-total-error");
    el.modeInputs = [...document.querySelectorAll('input[name="cfg-mode"]')];
    el.modeHelp = byId("cfg-mode-help");
    el.partitions = byId("cfg-partitions");
    el.partitionsInput = byId("cfg-partitions-input");
    el.partitionsPreview = byId("cfg-partitions-preview");
    el.partitionsSum = byId("cfg-partitions-sum");
    el.splitEqual = byId("cfg-split-equal");
    el.algorithmInputs = [...document.querySelectorAll('input[name="cfg-algorithm"]')];
    el.algorithmDescriptions = [...document.querySelectorAll(".cfg-algorithm-text [data-desc-dynamic]")];
    el.form = byId("cfg-event-form");
    el.eventType = byId("cfg-event-type");
    el.processInput = byId("cfg-event-process");
    el.processSelectWrap = byId("cfg-event-process-select-wrap");
    el.processSelect = byId("cfg-event-process-select");
    el.processError = byId("cfg-event-process-error");
    el.sizeField = byId("cfg-size-field");
    el.processField = byId("cfg-process-field");
    el.compactOption = byId("cfg-event-type-compact");
    el.size = byId("cfg-event-size");
    el.sizeHint = byId("cfg-size-hint");
    el.sizeError = byId("cfg-event-size-error");
    el.formHelp = byId("cfg-form-help");
    el.formBanner = byId("cfg-form-banner");
    el.btnAdd = byId("cfg-btn-add");
    el.empty = byId("cfg-empty");
    el.btnSample = byId("cfg-btn-sample");
    el.eventsFrame = byId("cfg-events-frame");
    el.eventsBody = byId("cfg-events-body");
    el.toast = byId("cfg-toast");
    el.toastText = byId("cfg-toast-text");
    el.toastUndo = byId("cfg-toast-undo");
    el.summary = byId("cfg-summary");
    el.pending = byId("cfg-pending");
    el.btnCompare = byId("cfg-btn-compare");
    el.btnStart = byId("cfg-btn-start");
    el.btnReset = byId("cfg-btn-reset");
}

function bindEvents() {
    const bindParam = (input, key) => {
        input.addEventListener("input", () => {
            draft[key] = input.value;
            saveDraft();
            render();
        });
        input.addEventListener("blur", () => {
            if (input.value.trim() !== "" || view.touched.has(key)) {
                view.touched.add(key);
                render();
            }
        });
    };
    bindParam(el.total, "totalMemory");

    el.modeInputs.forEach((input) =>
        input.addEventListener("change", () => {
            draft.partitionType = input.value;
            if (input.value === "fixed" && draft.partitionsText.trim() === "") {
                const context = buildContext(draft);
                if (context.params.ok) {
                    draft.partitionsText = splitEqually(context.area).join(", ");
                    el.partitionsInput.value = draft.partitionsText;
                }
            }
            saveDraft();
            render();
        })
    );

    el.partitionsInput.addEventListener("input", () => {
        draft.partitionsText = el.partitionsInput.value;
        saveDraft();
        render();
    });

    el.splitEqual.addEventListener("click", () => {
        const context = buildContext(draft);
        if (!context.params.ok) {
            return;
        }
        draft.partitionsText = splitEqually(context.area).join(", ");
        el.partitionsInput.value = draft.partitionsText;
        saveDraft();
        render();
    });

    el.algorithmInputs.forEach((input) =>
        input.addEventListener("change", () => {
            draft.algorithm = input.value;
            saveDraft();
            render();
        })
    );

    el.eventType.addEventListener("change", () => {
        clearFormErrors();
        render();
    });

    el.processInput.addEventListener("input", () => {
        const normalized = normalizeId(el.processInput.value);
        if (normalized !== el.processInput.value) {
            el.processInput.value = normalized;
        }
        setFieldError(el.processInput, el.processError, "");
        if (el.size.getAttribute("aria-invalid") !== "true") {
            el.formBanner.hidden = true;
        }
    });

    el.size.addEventListener("input", () => {
        setFieldError(el.size, el.sizeError, "");
        if (el.processInput.getAttribute("aria-invalid") !== "true") {
            el.formBanner.hidden = true;
        }
    });

    el.form.addEventListener("submit", handleAddEvent);

    el.eventsBody.addEventListener("click", (event) => {
        const button = event.target.closest("[data-delete]");
        if (button) {
            handleDelete(Number(button.dataset.delete));
        }
    });

    el.toastUndo.addEventListener("click", undoDelete);
    el.btnReset.addEventListener("click", handleReset);
    el.btnSample.addEventListener("click", () => loadDraft(configToDraft(SAMPLE_CONFIG), { stagger: true }));
    el.btnStart.addEventListener("click", () => applyAndGo("simulate"));
    el.btnCompare.addEventListener("click", () => applyAndGo("compare"));
    el.infoClose.addEventListener("click", () => el.infoBanner.classList.add("hidden"));

    // Applied config changed elsewhere: refresh the "not applied" indicator
    window.addEventListener("memsim:config-updated", () => render());

    // Integration with the Tests tab (spec F15)
    window.addEventListener("memsim:load-config-draft", (event) => {
        const { config, label } = event.detail ?? {};
        if (!config) {
            return;
        }
        loadDraft(configToDraft(config), { stagger: true });
        showInfo(`Caso de teste ${label ? `'${label}' ` : ""}carregado. Revise e inicie a simulação.`);
        switchTab("configure");
    });

    window.addEventListener("memsim:tab-changed", (event) => {
        if (event.detail?.tabName === "configure") {
            playEntryAnimation();
        }
    });
}

function playEntryAnimation() {
    restartAnimation(el.section, "is-entering");
    setTimeout(() => el.section.classList.remove("is-entering"), 800);
}

function initConfigureTab() {
    cacheElements();
    if (!el.section) {
        return;
    }

    if (appState.configDraft) {
        draft = { ...createEmptyDraft(), ...appState.configDraft };
    } else if (appState.config) {
        draft = configToDraft(appState.config);
    } else {
        draft = createEmptyDraft();
    }

    if (draft.totalMemory !== "") {
        view.touched.add("totalMemory");
    }

    syncInputs();
    bindEvents();
    render();
    view.wasReady = Boolean(draftToConfig(draft));

    if (getActiveTab() === "configure") {
        playEntryAnimation();
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initConfigureTab);
} else {
    initConfigureTab();
}
