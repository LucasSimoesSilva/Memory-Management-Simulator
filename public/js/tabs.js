const ACTIVE_TAB_STORAGE_KEY = "memsim_active_tab";
const VALID_TABS = ["configure", "simulate", "results", "compare", "tests"];

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/**
 * Smoothly scrolls the page back to the top (instant when the user prefers reduced motion).
 */
function scrollToTop() {
    window.scrollTo({ top: 0, left: 0, behavior: reducedMotion.matches ? "auto" : "smooth" });
}

/**
 * Switches the visible SPA panel and updates navigation button states.
 * Every tab change scrolls back to the top of the page, except the initial restore on load.
 */
export function switchTab(tabName, { scroll = true } = {}) {
    if (!VALID_TABS.includes(tabName)) {
        return;
    }

    const navButtons = document.querySelectorAll(".nav-tab[data-tab]");
    const tabPanels = document.querySelectorAll(".tab-panel");

    navButtons.forEach((button) => {
        const isTarget = button.dataset.tab === tabName;
        button.classList.toggle("active", isTarget);
        button.setAttribute("aria-selected", String(isTarget));
    });

    tabPanels.forEach((panel) => {
        const isTarget = panel.id === `tab-${tabName}`;
        panel.classList.toggle("active", isTarget);
        panel.hidden = !isTarget;
    });

    try {
        sessionStorage.setItem(ACTIVE_TAB_STORAGE_KEY, tabName);
    } catch {
        // Ignore storage errors in restricted environments
    }

    if (scroll) {
        scrollToTop();
    }

    window.dispatchEvent(new CustomEvent("memsim:tab-changed", { detail: { tabName } }));
}

/**
 * Returns the currently active tab identifier.
 */
export function getActiveTab() {
    const activeButton = document.querySelector(".nav-tab.active[data-tab]");
    return activeButton ? activeButton.dataset.tab : "configure";
}

function initTabs() {
    const navTabsContainer = document.querySelector(".nav-tabs");
    if (navTabsContainer) {
        navTabsContainer.addEventListener("click", (event) => {
            const tabButton = event.target.closest(".nav-tab[data-tab]");
            if (tabButton) {
                switchTab(tabButton.dataset.tab);
            }
        });
    }

    // Delegated listener for shortcut buttons such as [data-go-tab="configure"]
    document.addEventListener("click", (event) => {
        const shortcutButton = event.target.closest("[data-go-tab]");
        if (shortcutButton) {
            switchTab(shortcutButton.dataset.goTab);
        }
    });

    let initialTab = getActiveTab();
    try {
        const savedTab = sessionStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
        if (savedTab && VALID_TABS.includes(savedTab)) {
            initialTab = savedTab;
        }
    } catch {
        // Use default active tab from HTML
    }

    switchTab(initialTab, { scroll: false });

    // Tells the boot check in index.html that the module scripts loaded
    window.__memsimReady = true;
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initTabs);
} else {
    initTabs();
}