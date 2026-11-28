export const SUPPORTED_ALGORITHMS = ["first-fit", "best-fit", "worst-fit"];

const ALGORITHM_LABELS = {
    "first-fit": "First Fit",
    "best-fit": "Best Fit",
    "worst-fit": "Worst Fit"
};

const ALGORITHM_EXPLANATIONS = {
    dynamic: {
        "first-fit": "First Fit percorre as lacunas pela ordem dos endereços e para na primeira que comporta o processo, sem olhar as demais.",
        "best-fit": "Best Fit verifica todas as lacunas e escolhe a menor que comporta o processo, para reduzir a sobra.",
        "worst-fit": "Worst Fit verifica todas as lacunas e escolhe a maior, para deixar a maior sobra possível aos próximos processos."
    },
    fixed: {
        "first-fit": "First Fit percorre as partições livres pela ordem dos endereços e usa a primeira que comporta o processo.",
        "best-fit": "Best Fit verifica todas as partições livres e usa a menor que comporta o processo.",
        "worst-fit": "Worst Fit verifica todas as partições livres e usa a maior disponível."
    }
};

export class SimulationError extends Error {
    constructor(message) {
        super(message);
        this.status = 400;
    }
}

/* ------------------------------------------------------------------ */
/* Config normalization                                                */
/* ------------------------------------------------------------------ */

function toPositiveInt(value) {
    const num = Number(value);
    return Number.isFinite(num) ? Math.round(num) : NaN;
}

const EVENT_TYPES = ["allocate", "free", "compact"];

function normalizeConfig(config) {
    const totalMemory = toPositiveInt(config.totalMemory);

    if (!(totalMemory > 0)) {
        throw new SimulationError("'totalMemory' must be a positive number.");
    }

    // The whole memory is available for processes (no OS reservation)
    const area = totalMemory;
    const partitionType = config.partitionType === "fixed" ? "fixed" : "dynamic";

    // Legacy payload support: { processes: [{ id, size }] } becomes a list of allocations
    let events = Array.isArray(config.events) ? config.events : [];
    if (events.length === 0 && Array.isArray(config.processes)) {
        events = config.processes.map((proc) => ({ type: "allocate", process: proc.id, size: proc.size }));
    }

    events = events.map((event, index) => {
        const type = EVENT_TYPES.includes(event?.type) ? event.type : "allocate";
        if (type === "compact") {
            return { type };
        }

        const process = String(event?.process ?? "").trim();
        if (!process) {
            throw new SimulationError(`Event ${index + 1} has no process id.`);
        }
        if (type === "free") {
            return { type, process };
        }
        const size = toPositiveInt(event.size);
        if (!(size > 0)) {
            throw new SimulationError(`Event ${index + 1} (${process}) must have a positive size.`);
        }
        return { type, process, size };
    });

    if (events.length === 0) {
        throw new SimulationError("'events' must contain at least one event.");
    }

    let partitions = [];
    if (partitionType === "fixed") {
        partitions = Array.isArray(config.partitions)
            ? config.partitions.map(toPositiveInt).filter((size) => size > 0)
            : [];

        if (partitions.length === 0) {
            // Default: four equal partitions, the last one absorbs the remainder
            const base = Math.floor(area / 4);
            partitions = [base, base, base, area - base * 3];
        }

        const sum = partitions.reduce((acc, size) => acc + size, 0);
        if (sum > area) {
            throw new SimulationError("The sum of 'partitions' exceeds 'totalMemory'.");
        }
    }

    return { totalMemory, area, partitionType, partitions, events };
}

/* ------------------------------------------------------------------ */
/* Memory primitives                                                   */
/* ------------------------------------------------------------------ */

function createInitialBlocks(cfg) {
    const blocks = [];

    if (cfg.partitionType === "fixed") {
        let cursor = 0;
        cfg.partitions.forEach((size, index) => {
            blocks.push({ start: cursor, size, kind: "free", partition: index + 1 });
            cursor += size;
        });
        // Unpartitioned leftover area (if partitions don't cover the whole area) is unusable
        if (cursor < cfg.totalMemory) {
            blocks.push({ start: cursor, size: cfg.totalMemory - cursor, kind: "unused" });
        }
    } else {
        blocks.push({ start: 0, size: cfg.area, kind: "free" });
    }

    return blocks;
}

function getHoles(blocks) {
    return blocks.filter((block) => block.kind === "free");
}

function findProcessBlock(blocks, processId) {
    return blocks.find((block) => block.kind === "proc" && block.process === processId);
}

function blockName(block) {
    if (!block) {
        return null;
    }
    if (block.kind === "proc") {
        return block.process;
    }
    return "Livre";
}

function computeMetrics(blocks, cfg) {
    const holes = getHoles(blocks);
    const procs = blocks.filter((block) => block.kind === "proc");

    const usedMemory = procs.reduce((acc, block) => acc + (block.used ?? block.size), 0);
    const freeMemory = holes.reduce((acc, block) => acc + block.size, 0);
    const largestHole = holes.reduce((acc, block) => Math.max(acc, block.size), 0);
    const holeCount = holes.length;
    const internalFragmentation = procs.reduce(
        (acc, block) => acc + (block.used !== undefined ? block.size - block.used : 0),
        0
    );

    return {
        totalMemory: cfg.totalMemory,
        availableMemory: cfg.area,
        usedMemory,
        freeMemory,
        largestHole,
        holeCount,
        utilization: round1((usedMemory / cfg.area) * 100),
        externalFragmentation: freeMemory > 0 ? round1(((freeMemory - largestHole) / freeMemory) * 100) : 0,
        internalFragmentation
    };
}

function snapshotBlocks(blocks) {
    return blocks.map((block) => ({
        start: block.start,
        size: block.size,
        end: block.start + block.size,
        process: block.kind === "proc" ? block.process : null,
        isFree: block.kind === "free",
        isUnused: block.kind === "unused",
        partition: block.partition ?? null,
        used: block.used ?? null
    }));
}

function round1(value) {
    return Math.round(value * 10) / 10;
}

function formatPercent(value) {
    return `${round1(value).toFixed(1).replace(".", ",")}%`;
}

function joinList(items) {
    if (items.length <= 1) {
        return items.join("");
    }
    return `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
}

function range(block) {
    return `${block.start}-${block.start + block.size}`;
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

/**
 * Picks a hole for the request according to the algorithm and returns the per-hole verdicts.
 */
function evaluateHoles(holes, size, algorithm) {
    const fits = holes.map((hole) => hole.size >= size);
    let chosenIndex = -1;

    if (algorithm === "first-fit") {
        chosenIndex = fits.indexOf(true);
    } else {
        holes.forEach((hole, index) => {
            if (!fits[index]) {
                return;
            }
            if (chosenIndex === -1) {
                chosenIndex = index;
                return;
            }
            const current = holes[chosenIndex].size;
            if (algorithm === "best-fit" ? hole.size < current : hole.size > current) {
                chosenIndex = index;
            }
        });
    }

    const holesChecked = holes.map((hole, index) => {
        let status;
        if (index === chosenIndex) {
            status = "chosen";
        } else if (algorithm === "first-fit" && chosenIndex !== -1 && index > chosenIndex) {
            status = "not-checked";
        } else {
            status = fits[index] ? "fits" : "no-fit";
        }

        return {
            index: index + 1,
            start: hole.start,
            end: hole.start + hole.size,
            size: hole.size,
            partition: hole.partition ?? null,
            status
        };
    });

    return { chosenIndex, holesChecked };
}

function allocate(blocks, cfg, algorithm, processId, size) {
    const holes = getHoles(blocks);
    const { chosenIndex, holesChecked } = evaluateHoles(holes, size, algorithm);

    if (chosenIndex === -1) {
        return { ok: false, holesChecked };
    }

    const hole = holes[chosenIndex];
    const holeBefore = { ...hole };
    const position = blocks.indexOf(hole);

    if (cfg.partitionType === "fixed") {
        hole.kind = "proc";
        hole.process = processId;
        hole.used = size;
        return { ok: true, holesChecked, holeBefore, block: hole, leftoverBlock: null };
    }

    const procBlock = { start: hole.start, size, kind: "proc", process: processId };
    const leftover = hole.size - size;
    const replacement = [procBlock];
    let leftoverBlock = null;

    if (leftover > 0) {
        leftoverBlock = { start: hole.start + size, size: leftover, kind: "free" };
        replacement.push(leftoverBlock);
    }

    blocks.splice(position, 1, ...replacement);

    return { ok: true, holesChecked, holeBefore, block: procBlock, leftoverBlock };
}

function release(blocks, cfg, processId) {
    const block = findProcessBlock(blocks, processId);
    if (!block) {
        return null;
    }

    const freedSize = block.used ?? block.size;
    let position = blocks.indexOf(block);
    const prev = blocks[position - 1];
    const next = blocks[position + 1];
    const neighbors = [blockName(prev), blockName(next)].filter(Boolean);

    block.kind = "free";
    delete block.process;
    delete block.used;

    const merged = [];
    if (cfg.partitionType === "dynamic") {
        if (next && next.kind === "free") {
            block.size += next.size;
            blocks.splice(position + 1, 1);
            merged.push(next);
        }
        if (prev && prev.kind === "free") {
            prev.size += block.size;
            blocks.splice(position, 1);
            merged.push(prev);
            position -= 1;
        }
    }

    return { hole: blocks[position], freedSize, neighbors, merged };
}

function compact(blocks, cfg) {
    const holeCountBefore = getHoles(blocks).length;
    const moved = [];
    const result = [];
    let cursor = 0;

    blocks
        .filter((block) => block.kind === "proc")
        .sort((a, b) => a.start - b.start)
        .forEach((block) => {
            if (block.start !== cursor) {
                moved.push({ process: block.process, from: block.start, to: cursor });
            }
            result.push({ ...block, start: cursor });
            cursor += block.size;
        });

    if (cursor < cfg.totalMemory) {
        result.push({ start: cursor, size: cfg.totalMemory - cursor, kind: "free" });
    }

    blocks.splice(0, blocks.length, ...result);
    return { moved, holeCountBefore };
}

/* ------------------------------------------------------------------ */
/* Decision texts                                                      */
/* ------------------------------------------------------------------ */

function describeAllocation(cfg, algorithm, event, result, blocks) {
    const { block, holeBefore, leftoverBlock } = result;
    const pid = event.process;

    if (cfg.partitionType === "fixed") {
        const internal = block.size - event.size;
        const internalText = internal > 0
            ? ` Sobram ${internal} KB dentro da partição (fragmentação interna), que nenhum outro processo pode usar.`
            : " O processo ocupa a partição por inteiro.";
        const lead = event.source === "queue"
            ? `${pid} estava na fila de espera e agora cabe na partição ${block.partition}.`
            : ALGORITHM_EXPLANATIONS.fixed[algorithm];

        return {
            title: `${pid} alocado na partição ${block.partition} (${range(block)})`,
            explanation: `${lead}${internalText}`
        };
    }

    let leftoverText = " A lacuna foi ocupada por inteiro.";
    if (leftoverBlock) {
        const after = blocks[blocks.indexOf(leftoverBlock) + 1];
        const where = after ? `entre ${pid} e ${blockName(after)}` : "no fim da memória";
        leftoverText = ` Sobra uma lacuna de ${leftoverBlock.size} KB ${where}.`;
    }

    const holeCount = getHoles(blocks).length;
    const lead = event.source === "queue"
        ? `${pid} estava na fila de espera e agora cabe na lacuna ${range(holeBefore)} (${holeBefore.size} KB).`
        : ALGORITHM_EXPLANATIONS.dynamic[algorithm];
    const fragText = event.source === "queue" && holeCount <= 1
        ? " A fragmentação externa é 0%, porque só existe uma lacuna."
        : "";

    return {
        title: `${pid} alocado em ${range(block)}`,
        explanation: `${lead}${leftoverText}${fragText}`
    };
}

/**
 * True when the request can never be satisfied, not even with an empty memory:
 * bigger than every fixed partition, or bigger than the whole area for processes.
 */
function neverFits(cfg, size) {
    if (cfg.partitionType === "fixed") {
        return size > Math.max(...cfg.partitions);
    }
    return size > cfg.area;
}

function describeRejection(cfg, event) {
    const pid = event.process;
    const history = "Em sistemas reais, a saída era dividir o programa em overlays (partes carregadas sob demanda), " +
        "reconfigurar a memória ou, mais tarde, usar memória virtual.";

    if (cfg.partitionType === "fixed") {
        const largest = Math.max(...cfg.partitions);
        return {
            refusalReason: "exceeds-all-partitions",
            decision: {
                title: `${pid} rejeitado: maior que qualquer partição`,
                explanation:
                    `Com partições fixas, um processo de ${event.size} KB nunca caberia (a maior partição tem ${largest} KB), ` +
                    `então o SO o recusa já no carregamento, em vez de deixá-lo esperando na fila. ${history}`
            }
        };
    }

    return {
        refusalReason: "exceeds-memory",
        decision: {
            title: `${pid} rejeitado: maior que a memória total`,
            explanation:
                `${pid} precisa de ${event.size} KB, mas a memória tem só ${cfg.area} KB. Mesmo com a memória vazia ele ` +
                `nunca caberia, então o SO o recusa já no carregamento, em vez de deixá-lo esperando na fila. ${history}`
        }
    };
}

function snapshotPartitions(blocks) {
    return blocks
        .filter((block) => block.partition)
        .map((block) => ({ ...block }));
}

/**
 * In fixed mode, the decision list shows every partition in address order: the free ones with
 * the algorithm's verdict and the occupied ones as "occupied" (spec S5).
 */
function withPartitionView(cfg, partitionsBefore, holesChecked) {
    if (cfg.partitionType !== "fixed") {
        return holesChecked;
    }

    const verdictByStart = new Map(holesChecked.map((hole) => [hole.start, hole]));
    return partitionsBefore
        .sort((a, b) => a.start - b.start)
        .map((block) => {
            if (block.kind === "free" && verdictByStart.has(block.start)) {
                return verdictByStart.get(block.start);
            }
            return {
                index: null,
                start: block.start,
                end: block.start + block.size,
                size: block.size,
                partition: block.partition,
                status: "occupied",
                process: block.process ?? null,
                used: block.used ?? null
            };
        });
}

function describeRefusal(cfg, event, blocks) {
    const pid = event.process;
    const holes = getHoles(blocks);
    const free = holes.reduce((acc, hole) => acc + hole.size, 0);

    if (cfg.partitionType === "fixed") {
        const detail = holes.length === 0
            ? "Todas as partições estão ocupadas"
            : `As partições livres (${joinList(holes.map((hole) => `${hole.size} KB`))}) são menores que ${event.size} KB`;

        return {
            refusalReason: "no-partition",
            decision: {
                title: `${pid} recusado: nenhuma partição livre comporta`,
                explanation: `${detail}, então ${pid} vai para a fila de espera.`
            }
        };
    }

    if (free >= event.size) {
        return {
            refusalReason: "external-fragmentation",
            decision: {
                title: `${pid} recusado por fragmentação externa`,
                explanation:
                    `Existem ${free} KB livres no total, mas divididos em lacunas de ${joinList(holes.map((hole) => `${hole.size} KB`))}. ` +
                    `Nenhuma tem ${event.size} KB contíguos, então ${pid} vai para a fila de espera. ` +
                    `Um evento de compactação juntaria tudo em uma lacuna de ${free} KB.`
            }
        };
    }

    return {
        refusalReason: "insufficient-memory",
        decision: {
            title: `${pid} recusado: memória insuficiente`,
            explanation: free === 0
                ? `A memória está cheia e ${pid} precisa de ${event.size} KB, então vai para a fila de espera.`
                : `Restam só ${free} KB livres e ${pid} precisa de ${event.size} KB, então vai para a fila de espera.`
        }
    };
}

function describeRelease(cfg, pid, info, blocks) {
    const prefix = `${pid} liberado`;

    if (cfg.partitionType === "fixed") {
        return {
            title: `${prefix}: partição ${info.hole.partition} (${range(info.hole)}) livre`,
            explanation: `A partição ${info.hole.partition} (${info.hole.size} KB) volta a ficar disponível para o próximo processo que couber nela.`
        };
    }

    const holes = getHoles(blocks);
    const free = holes.reduce((acc, hole) => acc + hole.size, 0);

    const mergeText = info.merged.length === 0
        ? `Os vizinhos de ${pid} (${joinList(info.neighbors)}) estão ocupados, então não há lacunas adjacentes para fundir.`
        : `A área de ${pid} (${info.freedSize} KB) se fundiu com ${info.merged.length > 1 ? "as lacunas vizinhas" : "a lacuna vizinha"}, formando uma única lacuna de ${info.hole.size} KB.`;

    const distribution = holes.length > 1
        ? ` A memória livre (${free} KB) agora está dividida em ${holes.length} lacunas: ${joinList(holes.map((hole) => `${hole.size} KB`))}.`
        : ` Agora existe uma única lacuna livre de ${free} KB.`;

    return {
        title: `${prefix}: nova lacuna em ${range(info.hole)} (${info.hole.size} KB)`,
        explanation: `${mergeText}${distribution}`
    };
}

function describeCompaction(info, blocks, queue) {
    const hole = getHoles(blocks)[0];
    const free = hole ? hole.size : 0;

    const movedText = info.moved.length === 0
        ? "Nenhum processo precisou ser movido."
        : `${joinList(info.moved.map((move, index) =>
            index === 0
                ? `${move.process} foi movido de ${move.from} para ${move.to}`
                : `${move.process} de ${move.from} para ${move.to}`
        ))}; os endereços base foram atualizados.`;

    const holesText = info.holeCountBefore > 1 ? ` As ${info.holeCountBefore} lacunas viraram uma só.` : "";
    const head = queue[0];
    const queueText = head && head.size <= free
        ? ` Agora ${head.process} (${head.size} KB), que estava na fila, cabe na memória.`
        : "";

    return {
        title: hole
            ? `Memória compactada: lacuna única de ${free} KB em ${range(hole)}`
            : "Memória compactada: não sobrou espaço livre",
        explanation: `${movedText}${holesText}${queueText}`
    };
}

/* ------------------------------------------------------------------ */
/* Simulation                                                          */
/* ------------------------------------------------------------------ */

function eventLabel(event) {
    if (event.type === "compact") {
        return "Compactar memória";
    }
    if (event.type === "free") {
        return `Liberar ${event.process}`;
    }
    return `Alocar ${event.process} (${event.size} KB)`;
}

function describeHoles(blocks) {
    const holes = getHoles(blocks);
    if (holes.length === 0) {
        return "Nenhuma";
    }
    return holes.map((hole) => `${hole.size} KB (${range(hole)})`).join(", ");
}

/**
 * Runs the full event sequence step by step. Events: allocate, free and compact
 * (compaction only applies to variable partitions).
 */
export function simulate(config, algorithm) {
    if (!SUPPORTED_ALGORITHMS.includes(algorithm)) {
        throw new SimulationError(`Unknown algorithm: ${algorithm}`);
    }

    const cfg = normalizeConfig(config);
    const blocks = createInitialBlocks(cfg);
    const steps = [];
    const queue = [];
    const everAllocated = new Set();
    const rejectedAtLoad = [];
    const divergences = [];

    const initial = { blocks: snapshotBlocks(blocks), metrics: computeMetrics(blocks, cfg) };

    function pushStep(step) {
        const full = {
            index: steps.length + 1,
            holesChecked: [],
            refusalReason: null,
            moved: [],
            affected: null,
            ...step,
            blocks: snapshotBlocks(blocks),
            queue: queue.map((item) => ({ ...item })),
            metrics: computeMetrics(blocks, cfg)
        };
        steps.push(full);
        return full;
    }

    function runAllocation(event, label, sequenceIndex) {
        const holesAtMoment = describeHoles(blocks);
        const partitionsBefore = snapshotPartitions(blocks);

        // A process that could never fit (bigger than every partition / the whole area) is
        // rejected at load time instead of waiting forever in the queue (spec D6).
        if (neverFits(cfg, event.size)) {
            const { holesChecked } = evaluateHoles(getHoles(blocks), event.size, algorithm);
            const rejection = describeRejection(cfg, event);
            rejectedAtLoad.push(event.process);

            if (sequenceIndex !== null) {
                divergences.push({ step: sequenceIndex, eventLabel: eventLabel(event), holesAtMoment, decision: "Rejeitado" });
            }

            pushStep({
                label,
                event,
                outcome: "rejected",
                holesChecked: withPartitionView(cfg, partitionsBefore, holesChecked),
                refusalReason: rejection.refusalReason,
                decision: rejection.decision
            });
            return false;
        }

        const result = allocate(blocks, cfg, algorithm, event.process, event.size);
        const holesChecked = withPartitionView(cfg, partitionsBefore, result.holesChecked);

        if (sequenceIndex !== null) {
            divergences.push({
                step: sequenceIndex,
                eventLabel: eventLabel(event),
                holesAtMoment,
                decision: result.ok ? `Lacuna ${range(result.holeBefore)}` : "Recusado (fila)"
            });
        }

        if (result.ok) {
            everAllocated.add(event.process);
            pushStep({
                label,
                event,
                outcome: "allocated",
                holesChecked,
                decision: describeAllocation(cfg, algorithm, event, result, blocks),
                affected: { process: event.process, start: result.block.start }
            });
            return true;
        }

        const refusal = describeRefusal(cfg, event, blocks);
        if (event.source !== "queue") {
            queue.push({ process: event.process, size: event.size });
        }
        pushStep({
            label,
            event,
            outcome: "refused",
            holesChecked,
            refusalReason: refusal.refusalReason,
            decision: refusal.decision
        });
        return false;
    }

    function retryQueue() {
        while (queue.length > 0) {
            const head = queue[0];
            const fits = getHoles(blocks).some((hole) => hole.size >= head.size);
            if (!fits) {
                return;
            }
            queue.shift();
            runAllocation({ type: "allocate", process: head.process, size: head.size, source: "queue" }, "F", null);
        }
    }

    function runCompaction(event, label) {
        if (cfg.partitionType !== "dynamic") {
            pushStep({
                label,
                event,
                outcome: "skipped",
                decision: {
                    title: "Compactação ignorada: partições fixas",
                    explanation: "Em partições fixas cada processo fica preso à sua partição, então não há lacunas para juntar."
                }
            });
            return;
        }

        const info = compact(blocks, cfg);
        pushStep({
            label,
            event,
            outcome: "compacted",
            moved: info.moved,
            decision: describeCompaction(info, blocks, queue)
        });
        retryQueue();
    }

    cfg.events.forEach((rawEvent, eventIndex) => {
        const label = String(eventIndex + 1);
        const event = { ...rawEvent, source: "sequence" };

        if (event.type === "allocate") {
            runAllocation(event, label, eventIndex + 1);
        } else if (event.type === "compact") {
            runCompaction(event, label);
        } else {
            const info = release(blocks, cfg, event.process);

            if (info) {
                pushStep({
                    label,
                    event,
                    outcome: "freed",
                    decision: describeRelease(cfg, event.process, info, blocks),
                    affected: { process: event.process, start: info.hole.start }
                });
                retryQueue();
            } else {
                const queuedIndex = queue.findIndex((item) => item.process === event.process);
                let decision;
                if (queuedIndex !== -1) {
                    queue.splice(queuedIndex, 1);
                    decision = {
                        title: `${event.process} removido da fila de espera`,
                        explanation: `${event.process} ainda não estava na memória, então a liberação apenas o retira da fila de espera.`
                    };
                } else {
                    decision = {
                        title: `Liberar ${event.process} ignorado`,
                        explanation: `${event.process} não está na memória, então não há nada a liberar.`
                    };
                }
                pushStep({ label, event, outcome: "skipped", decision });
            }
        }
    });

    const allocationEvents = cfg.events.filter((event) => event.type === "allocate");
    const totalProcesses = new Set(allocationEvents.map((event) => event.process)).size;
    const finalMetrics = computeMetrics(blocks, cfg);

    return {
        algorithm,
        partitionType: cfg.partitionType,
        initial,
        steps,
        blocks: snapshotBlocks(blocks),
        divergences,
        metrics: {
            allocatedProcesses: everAllocated.size,
            totalProcesses,
            allocationRate: totalProcesses > 0 ? round1((everAllocated.size / totalProcesses) * 100) : 0,
            rejectedProcesses: [...queue.map((item) => item.process), ...rejectedAtLoad],
            rejectedAtLoad: [...rejectedAtLoad],
            finalMemoryUtilization: finalMetrics.utilization,
            freeMemory: finalMetrics.freeMemory,
            largestHole: finalMetrics.largestHole,
            holeCount: finalMetrics.holeCount,
            externalFragmentation: finalMetrics.externalFragmentation,
            internalFragmentation: finalMetrics.internalFragmentation
        }
    };
}

export function runAlgorithm(config, algorithmName) {
    return simulate(config, algorithmName);
}

export { ALGORITHM_LABELS, formatPercent };
