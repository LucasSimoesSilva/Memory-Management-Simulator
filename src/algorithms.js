export const SUPPORTED_ALGORITHMS = ["first-fit", "best-fit", "worst-fit"];

export function runAlgorithm(config, algorithmName) {
    switch (algorithmName) {
        case "first-fit":
            return firstFit(config);
        case "best-fit":
            return bestFit(config);
        case "worst-fit":
            return worstFit(config);
        default:
            throw new Error(`Unknown or unimplemented algorithm: ${algorithmName}`);
    }
}

function firstFit(config) {
    // Add logic to firstFit algorithm:
    return {
        blocks: [
            { start: 0, size: 212, process: "P1", isFree: false },
            { start: 212, size: 812, process: null, isFree: true }
        ],
        metrics: {
            allocatedProcesses: 1,
            totalProcesses: config.processes.length,
            allocationRate: 50.0,
            rejectedProcesses: 1,
            finalMemoryUtilization: 20.7,
            freeMemory: 812,
            largestHole: 812,
            holeCount: 1,
            externalFragmentation: 0
        }
    };
}

function bestFit(config) {
    // Add logic to bestFit algorithm:
    return {
        blocks: [
            { start: 0, size: 212, process: "P1", isFree: false },
            { start: 212, size: 812, process: null, isFree: true }
        ],
        metrics: {
            allocatedProcesses: 1,
            totalProcesses: config.processes.length,
            allocationRate: 50.0,
            rejectedProcesses: 1,
            finalMemoryUtilization: 20.7,
            freeMemory: 812,
            largestHole: 812,
            holeCount: 1,
            externalFragmentation: 0
        }
    };
}

function worstFit(config) {
    // Add logic to worstFit algorithm:
    return {
        blocks: [
            { start: 0, size: 212, process: "P1", isFree: false },
            { start: 212, size: 812, process: null, isFree: true }
        ],
        metrics: {
            allocatedProcesses: 1,
            totalProcesses: config.processes.length,
            allocationRate: 50.0,
            rejectedProcesses: 1,
            finalMemoryUtilization: 20.7,
            freeMemory: 812,
            largestHole: 812,
            holeCount: 1,
            externalFragmentation: 0
        }
    };
}