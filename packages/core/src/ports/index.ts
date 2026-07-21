// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Barrel for the injected I/O ports. The core depends only on these
// interfaces; adapters (CLI, plugin) and test fakes implement them.

export type { Clock } from "./clock.ts";
export type { Env } from "./env.ts";
export type { FileStat, FileSystem } from "./fs.ts";
export type { HttpClient, HttpRequest, HttpResponse } from "./http.ts";
export { responseText } from "./http.ts";
export {
    NoopReporter,
    PlainReporter,
    PROGRESS_BAR_WIDTH,
    PROGRESS_INTERVAL_MS,
    PROGRESS_THRESHOLD_MS,
    percent,
    type Reporter,
    renderBar,
    Tracker,
} from "./progress.ts";
export type { Reader, Streams, Writer } from "./streams.ts";
export type { Yaml } from "./yaml.ts";
