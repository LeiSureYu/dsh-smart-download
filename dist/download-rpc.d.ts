import type { ProgressReporter } from './progress.js';
import type { RequestHeaders } from './types.js';
export interface Aria2RpcObservation {
    throughput: number;
    concurrency: number;
    cn: number;
}
export declare function downloadWithAria2Rpc(opts: {
    url: string;
    outputPath: string;
    concurrency: number;
    signal: AbortSignal;
    reporter?: ProgressReporter;
    resume: boolean;
    headers?: RequestHeaders;
    maxDownloadLimitBytes?: number;
    proxy?: string;
}): Promise<Aria2RpcObservation | undefined>;
