/**
 * Pure validation rules for the simulation configuration (Configure tab spec §6–§7).
 * No DOM access: reusable by the Configure and Tests tabs.
 */

export const LIMITS = {
    minTotalMemory: 64,
    maxTotalMemory: 65536,
    maxEvents: 50,
    maxIdLength: 8
};

const ID_PATTERN = /^[A-Z0-9_-]{1,8}$/;
const INT_PATTERN = /^\d+$/;

export function parseIntStrict(value) {
    const text = String(value ?? "").trim();
    return INT_PATTERN.test(text) ? Number.parseInt(text, 10) : NaN;
}

export function normalizeId(value) {
    return String(value ?? "").trim().toUpperCase();
}

/**
 * Validates the total memory. The whole memory is available for processes (no OS reservation).
 */
export function validateParams(draft) {
    const errors = {};
    const totalText = String(draft?.totalMemory ?? "").trim();
    const totalMemory = parseIntStrict(totalText);

    if (totalText === "") {
        errors.totalMemory = "Informe a memória total.";
    } else if (!(totalMemory >= LIMITS.minTotalMemory && totalMemory <= LIMITS.maxTotalMemory)) {
        errors.totalMemory = `Informe um inteiro entre ${LIMITS.minTotalMemory} e ${LIMITS.maxTotalMemory} KB.`;
    }

    const ok = Object.keys(errors).length === 0;
    return {
        ok,
        errors,
        totalMemory: ok ? totalMemory : null,
        area: ok ? totalMemory : null
    };
}

/**
 * Parses "100, 200, 256, 340" into sizes and classifies the sum against the area.
 * status: empty | invalid | equal | under | over | unknown (area not defined yet)
 */
export function parsePartitions(text, area) {
    const raw = String(text ?? "").trim();
    if (raw === "") {
        return { sizes: [], sum: 0, status: "empty", ok: false };
    }

    const parts = raw.split(",").map((part) => part.trim()).filter((part) => part !== "");
    const sizes = parts.map(parseIntStrict);

    if (sizes.length === 0 || sizes.some((size) => !(size > 0))) {
        return { sizes: [], sum: 0, status: "invalid", ok: false };
    }

    const sum = sizes.reduce((acc, size) => acc + size, 0);
    if (!Number.isFinite(area)) {
        return { sizes, sum, status: "unknown", ok: false };
    }
    if (sum === area) {
        return { sizes, sum, status: "equal", ok: true };
    }
    if (sum < area) {
        return { sizes, sum, status: "under", ok: true, leftover: area - sum };
    }
    return { sizes, sum, status: "over", ok: false, excess: sum - area };
}

/**
 * Splits the area into four equal partitions (the last one absorbs the remainder),
 * mirroring the server default.
 */
export function splitEqually(area, count = 4) {
    const base = Math.floor(area / count);
    const sizes = Array.from({ length: count }, () => base);
    sizes[count - 1] = area - base * (count - 1);
    return sizes;
}

/**
 * Builds the context used by event validation from a draft.
 */
export function buildContext(draft) {
    const params = validateParams(draft);
    const fixed = draft?.partitionType === "fixed";
    const partitions = fixed ? parsePartitions(draft?.partitionsText, params.area) : null;
    const largestPartition = partitions && partitions.sizes.length > 0 ? Math.max(...partitions.sizes) : null;

    return { params, fixed, partitions, area: params.area, largestPartition };
}

/**
 * Replays the event sequence and flags invalid rows (spec §7.3).
 */
export function validateSequence(events, context) {
    const active = new Map(); // id -> index (1-based) of the allocation
    const rows = [];
    let allocations = 0;
    let frees = 0;
    let compactions = 0;
    let demand = 0;

    (events ?? []).forEach((event, position) => {
        const index = position + 1;
        const row = { index, ok: true, errors: [], warnings: [], rejectedAtLoad: false };

        if (event.type === "compact") {
            compactions += 1;
            if (context.fixed) {
                row.errors.push("A compactação não se aplica a partições fixas.");
            }
        } else if (event.type === "allocate") {
            allocations += 1;
            demand += Number(event.size) || 0;

            if (active.has(event.process)) {
                row.errors.push(`${event.process} já está alocado (evento ${active.get(event.process)}) e ainda não foi liberado.`);
            }
            if (Number.isFinite(context.area) && event.size > context.area) {
                row.errors.push(`${event.process} (${event.size} KB) excede a memória total de ${context.area} KB.`);
            } else if (context.fixed && Number.isFinite(context.largestPartition) && event.size > context.largestPartition) {
                row.rejectedAtLoad = true;
                row.warnings.push(`${event.process} (${event.size} KB) é maior que todas as partições: o SO vai rejeitá-lo no carregamento.`);
            }
            active.set(event.process, index);
        } else {
            frees += 1;
            if (!active.has(event.process)) {
                row.errors.push(`${event.process} não está alocado, então não pode ser liberado.`);
            }
            active.delete(event.process);
        }

        row.ok = row.errors.length === 0;
        rows.push(row);
    });

    return {
        rows,
        activeAtEnd: [...active.keys()],
        invalidCount: rows.filter((row) => !row.ok).length,
        summary: { total: rows.length, allocations, frees, compactions, demand }
    };
}

/**
 * Validates a new event from the form against the end state of the current sequence.
 */
export function validateNewEvent(input, events, context) {
    const errors = {};
    const warnings = {};
    const type = ["free", "compact"].includes(input.type) ? input.type : "allocate";
    const process = normalizeId(input.process);

    if (!context.params.ok) {
        return { ok: false, errors: { form: "Defina os parâmetros da memória antes de adicionar eventos." }, warnings };
    }
    if ((events?.length ?? 0) >= LIMITS.maxEvents) {
        return { ok: false, errors: { form: `A sequência aceita no máximo ${LIMITS.maxEvents} eventos.` }, warnings };
    }

    // Compaction has no process or size; it only exists for variable partitions
    if (type === "compact") {
        if (context.fixed) {
            return { ok: false, errors: { form: "A compactação não se aplica a partições fixas." }, warnings };
        }
        return { ok: true, errors, warnings, event: { type: "compact" } };
    }

    const { activeAtEnd } = validateSequence(events, context);
    const allocationIndex = new Map();
    (events ?? []).forEach((event, position) => {
        if (event.type === "allocate") {
            allocationIndex.set(event.process, position + 1);
        }
    });

    if (process === "") {
        errors.process = type === "free" ? "Escolha um processo alocado." : "Informe o ID do processo.";
    } else if (!ID_PATTERN.test(process)) {
        errors.process = `Use até ${LIMITS.maxIdLength} letras, números, _ ou -.`;
    } else if (type === "allocate" && activeAtEnd.includes(process)) {
        errors.process = `${process} já está alocado (evento ${allocationIndex.get(process)}) e ainda não foi liberado.`;
    } else if (type === "free" && !activeAtEnd.includes(process)) {
        errors.process = `${process} não está alocado, então não pode ser liberado.`;
    }

    let size = null;
    if (type === "allocate") {
        const sizeText = String(input.size ?? "").trim();
        size = parseIntStrict(sizeText);
        const label = process || "O processo";

        if (sizeText === "" || !Number.isFinite(size)) {
            errors.size = "Informe um tamanho inteiro em KB.";
        } else if (size <= 0) {
            errors.size = "O tamanho precisa ser maior que 0.";
        } else if (size > context.area) {
            errors.size = `${label} (${size}KB) excede a memória total de ${context.area} KB.`;
        } else if (context.fixed && Number.isFinite(context.largestPartition) && size > context.largestPartition) {
            warnings.size = `${label} (${size} KB) é maior que todas as partições: o SO vai rejeitá-lo no carregamento.`;
        }
    }

    const ok = Object.keys(errors).length === 0;
    return {
        ok,
        errors,
        warnings,
        event: ok ? (type === "free" ? { type, process } : { type, process, size }) : null
    };
}

/**
 * Suggests the next free "P{n}" id.
 */
export function suggestNextId(events) {
    const numbers = (events ?? [])
        .map((event) => /^P(\d+)$/.exec(event.process))
        .filter(Boolean)
        .map((match) => Number(match[1]));
    return `P${numbers.length > 0 ? Math.max(...numbers) + 1 : 1}`;
}

/**
 * Converts a draft into an API-ready config, or null when it isn't ready to run.
 */
export function draftToConfig(draft) {
    const context = buildContext(draft);
    if (!context.params.ok) {
        return null;
    }
    if (context.fixed && !context.partitions?.ok) {
        return null;
    }

    const events = (draft.events ?? []).map((event) => {
        if (event.type === "compact") {
            return { type: "compact" };
        }
        return event.type === "free"
            ? { type: "free", process: event.process }
            : { type: "allocate", process: event.process, size: Number(event.size) };
    });
    const sequence = validateSequence(events, context);
    if (sequence.summary.allocations === 0 || sequence.invalidCount > 0 || events.length > LIMITS.maxEvents) {
        return null;
    }

    const config = {
        totalMemory: context.params.totalMemory,
        partitionType: context.fixed ? "fixed" : "dynamic",
        algorithm: draft.algorithm || "first-fit",
        events
    };
    if (context.fixed) {
        config.partitions = context.partitions.sizes;
    }
    return config;
}

/**
 * Converts a config (e.g. SAMPLE_CONFIG or a test case) into an editable draft.
 */
export function configToDraft(config) {
    return {
        totalMemory: config?.totalMemory != null ? String(config.totalMemory) : "",
        partitionType: config?.partitionType === "fixed" ? "fixed" : "dynamic",
        partitionsText: Array.isArray(config?.partitions) ? config.partitions.join(", ") : "",
        algorithm: config?.algorithm || "first-fit",
        events: Array.isArray(config?.events) ? config.events.map((event) => ({ ...event })) : []
    };
}

export function createEmptyDraft() {
    return configToDraft({ partitionType: "dynamic", algorithm: "first-fit", events: [] });
}
