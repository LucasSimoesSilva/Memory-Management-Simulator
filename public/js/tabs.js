const ACTIVE_TAB_STORAGE_KEY = "memsim_active_tab";
const VALID_TABS = ["configure", "simulate", "results", "compare", "tests"];

/**
 * Switches the visible SPA panel and updates navigation button states.
 */
export function switchTab(tabName) {
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

    window.dispatchEvent(new CustomEvent("memsim:tab-changed", { detail: { tabName } }));
}

/**
 * Returns the currently active tab identifier.
 */
export function getActiveTab() {
    const activeButton = document.querySelector(".nav-tab.active[data-tab]");
    // TODO: Move the 'active' class in index.html to 'configure' once the Configure tab is implemented
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

    switchTab(initialTab);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initTabs);
} else {
    initTabs();
}