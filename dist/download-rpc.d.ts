import type { Aria2Observation } from './downloader.js';
import type { ProgressReporter } from './progress.js';
import type { RequestHeaders } from './types.js';
export type Aria2RpcObservation = Aria2Observation;
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
}): Promise<Aria2Observation | undefined>;
