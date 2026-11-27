const STORAGE_KEY = "memsim_app_state_v1";

export const SUPPORTED_ALGORITHMS = ["first-fit", "best-fit", "worst-fit"];

export const ALGORITHM_LABELS = {
    "first-fit": "First Fit",
    "best-fit": "Best Fit",
    "worst-fit": "Worst Fit"
};

// Tonal memory palette (P1..P8), mirrors the --mem-* tokens in global.css
export const FALLBACK_PROCESS_COLORS = [
    "#6D7BFF",
    "#38BDF8",
    "#10B981",
    "#D946EF",
    "#F59E0B",
    "#FB7185",
    "#A3E635",
    "#FB923C"
];

export const OS_COLOR = "#64748B";

/**
 * Reference scenario ("Caso 1") used by the Figma designs.
 */
export const SAMPLE_CONFIG = {
    totalMemory: 1024,
    osSize: 128,
    partitionType: "dynamic",
    algorithm: "first-fit",
    events: [
        { type: "allocate", process: "P1", size: 200 },
        { type: "allocate", process: "P2", size: 250 },
        { type: "allocate", process: "P3", size: 150 },
        { type: "allocate", process: "P4", size: 100 },
        { type: "free", process: "P2" },
        { type: "allocate", process: "P5", size: 180 },
        { type: "allocate", process: "P6", size: 230 },
        { type: "allocate", process: "P7", size: 60 }
    ]
};

function createEmptyState() {
    return {
        config: null,
        resultsCache: {},
        simulationSession: null,
        configDraft: null
    };
}

function loadStateFromStorage() {
    try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return createEmptyState();
        }

        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") {
            return createEmptyState();
        }

        return {
            config: parsed.config && typeof parsed.config === "object" ? parsed.config : null,
            resultsCache:
                parsed.resultsCache && typeof parsed.resultsCache === "object" && !Array.isArray(parsed.resultsCache)
                    ? parsed.resultsCache
                    : {},
            simulationSession:
                parsed.simulationSession && typeof parsed.simulationSession === "object"
                    ? parsed.simulationSession
                    : null,
            configDraft:
                parsed.configDraft && typeof parsed.configDraft === "object" ? parsed.configDraft : null
        };
    } catch {
        return createEmptyState();
    }
}

function persistState() {
    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
    } catch (error) {
        console.warn("Unable to persist state to sessionStorage:", error);
    }
}

export const appState = loadStateFromStorage();

/**
 * Checks whether a valid simulation configuration with at least one event exists.
 */
export function hasValidConfig(config = appState.config) {
    return Boolean(
        config &&
            typeof config === "object" &&
            Number(config.totalMemory) > 0 &&
            Array.isArray(config.events) &&
            config.events.length > 0
    );
}

/**
 * Updates the active configuration, clears stale cached results, and notifies listeners.
 */
export function setConfig(newConfig) {
    appState.config = newConfig ? structuredClone(newConfig) : null;
    appState.resultsCache = {};
    appState.simulationSession = null;
    persistState();

    window.dispatchEvent(new CustomEvent("memsim:config-updated", { detail: appState.config }));
}

/**
 * Resets both configuration and cached results.
 */
export function clearConfig() {
    appState.config = null;
    appState.resultsCache = {};
    appState.simulationSession = null;
    persistState();

    window.dispatchEvent(new CustomEvent("memsim:config-updated", { detail: null }));
}

/**
 * Merges new algorithm results into the cache and persists to sessionStorage.
 */
export function saveSimulationResults(resultsByAlgorithm) {
    if (!resultsByAlgorithm || typeof resultsByAlgorithm !== "object") {
        return;
    }

    Object.assign(appState.resultsCache, resultsByAlgorithm);
    persistState();

    window.dispatchEvent(new CustomEvent("memsim:results-updated", { detail: appState.resultsCache }));
}

/**
 * Clears only the cached simulation results while preserving the current config.
 */
export function clearResultsCache() {
    appState.resultsCache = {};
    persistState();

    window.dispatchEvent(new CustomEvent("memsim:results-updated", { detail: appState.resultsCache }));
}

/**
 * Stores the step-by-step simulation session (Simulate tab) and notifies listeners.
 * The "playing" flag is never persisted.
 */
export function setSimulationSession(session) {
    appState.simulationSession = session ? { ...session, playing: false } : null;
    persistState();

    window.dispatchEvent(new CustomEvent("memsim:simulation-updated", { detail: appState.simulationSession }));
}

/**
 * Stores the Configure tab draft (edited values, not yet applied) and notifies listeners.
 * The applied config only changes through setConfig().
 */
export function setConfigDraft(draft) {
    appState.configDraft = draft ? structuredClone(draft) : null;
    persistState();

    window.dispatchEvent(new CustomEvent("memsim:draft-updated", { detail: appState.configDraft }));
}

/**
 * Returns a stable string identifying the current config, used to invalidate cached sessions.
 */
export function getConfigHash(config = appState.config) {
    return config ? JSON.stringify(getApiConfig(config)) : "";
}

/**
 * Returns a sanitized config payload for POST /api/simulate (without frontend-only processColors).
 */
export function getApiConfig(config = appState.config) {
    if (!config) {
        return null;
    }

    const { processColors: _ignoredColors, ...apiConfig } = config;
    return structuredClone(apiConfig);
}

/**
 * Resolves the hex color for a given process ID from config.processColors or a deterministic fallback.
 */
export function getProcessColor(processId, config = appState.config) {
    if (!processId) {
        return "var(--color-free)";
    }

    if (processId === "SO") {
        return OS_COLOR;
    }

    const configuredColor = config?.processColors?.[processId];
    if (configuredColor) {
        return configuredColor;
    }

    const numericSuffix = Number.parseInt(String(processId).replace(/\D+/g, ""), 10);
    const colorIndex = Number.isFinite(numericSuffix) && numericSuffix > 0
        ? (numericSuffix - 1) % FALLBACK_PROCESS_COLORS.length
        : 0;

    return FALLBACK_PROCESS_COLORS[colorIndex];
}