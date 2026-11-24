const STORAGE_KEY = "memsim_app_state_v1";

export const SUPPORTED_ALGORITHMS = ["first-fit", "best-fit", "worst-fit"];

export const ALGORITHM_LABELS = {
    "first-fit": "First Fit",
    "best-fit": "Best Fit",
    "worst-fit": "Worst Fit"
};

export const FALLBACK_PROCESS_COLORS = [
    "#1226FF",
    "#8300F5",
    "#1F6327",
    "#6925F2",
    "#FD8700",
    "#FF0000",
    "#FF008C",
    "#DAA365"
];

function createEmptyState() {
    return {
        config: null,
        resultsCache: {}
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
                    : {}
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
    persistState();

    window.dispatchEvent(new CustomEvent("memsim:config-updated", { detail: appState.config }));
}

/**
 * Resets both configuration and cached results.
 */
export function clearConfig() {
    appState.config = null;
    appState.resultsCache = {};
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