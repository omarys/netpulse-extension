import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export const DEFAULT_ROTATION_DAYS = 3;
export const DEFAULT_MAX_ARCHIVES = 10;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ACTIVE_LOG_FILENAME = 'netpulse.log';
const ROTATION_META_FILENAME = '.rotation-meta.json';
const ARCHIVE_FILENAME_RE = /^netpulse-.+\.log$/;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

/**
 * Normalize a positive numeric setting, falling back to a default.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizePositiveNumber(value, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0)
        return fallback;
    return num;
}

/**
 * Normalize a non-negative integer setting, falling back to a default.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeNonNegativeInt(value, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0)
        return fallback;
    return Math.floor(num);
}

/**
 * Check whether an error represents a GLib/Gio cancellation.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isCancelledError(err) {
    if (!err)
        return false;
    if (err instanceof GLib.Error)
        return err.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED);
    return err.code === Gio.IOErrorEnum.CANCELLED || err.name === 'CancelledError';
}

/**
 * Check whether a GLib.Error matches a specific Gio.IOErrorEnum code.
 *
 * @param {unknown} err
 * @param {number} code
 * @returns {boolean}
 */
function isIoError(err, code) {
    if (!err)
        return false;
    if (err instanceof GLib.Error)
        return err.matches(Gio.io_error_quark(), code);
    return err.code === code;
}

/**
 * Determine whether the active log file should be rotated.
 *
 * @param {number} startedAtMs - Epoch milliseconds when the active log started.
 * @param {number} nowMs - Current epoch milliseconds.
 * @param {number} [rotationDays=DEFAULT_ROTATION_DAYS]
 * @returns {boolean}
 */
export function shouldRotate(startedAtMs, nowMs, rotationDays = DEFAULT_ROTATION_DAYS) {
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs))
        return false;
    if (!Number.isFinite(rotationDays) || rotationDays <= 0)
        return false;
    return (nowMs - startedAtMs) >= (rotationDays * MS_PER_DAY);
}

/**
 * Normalize a single diagnostic layer object for log serialization.
 *
 * @param {object|null|undefined} layer
 * @returns {object}
 */
function normalizeLayer(layer) {
    if (!layer || typeof layer !== 'object') {
        return {
            status: 'unknown',
            latencyMs: null,
            summary: '',
            detail: '',
        };
    }

    const out = {
        status: typeof layer.status === 'string' ? layer.status : 'unknown',
        latencyMs: typeof layer.latencyMs === 'number' && Number.isFinite(layer.latencyMs)
            ? layer.latencyMs
            : null,
        summary: typeof layer.summary === 'string' ? layer.summary : '',
        detail: typeof layer.detail === 'string' ? layer.detail : '',
    };

    if (typeof layer.gateway === 'string' || layer.gateway === null)
        out.gateway = layer.gateway;
    if (typeof layer.captivePortal === 'boolean')
        out.captivePortal = layer.captivePortal;
    if (typeof layer.statusCode === 'number' || layer.statusCode === null)
        out.statusCode = layer.statusCode;

    return out;
}

/**
 * Format a diagnostic result snapshot into a single newline-terminated JSONL log line.
 *
 * @param {object|null|undefined} result
 * @returns {string}
 */
export function formatLogEntry(result) {
    let timestamp;
    const rawTs = result?.timestamp;
    if (rawTs instanceof Date && !Number.isNaN(rawTs.getTime()))
        timestamp = rawTs.toISOString();
    else if (typeof rawTs === 'string' && rawTs.trim().length > 0)
        timestamp = rawTs.trim();
    else if (typeof rawTs === 'number' && Number.isFinite(rawTs))
        timestamp = new Date(rawTs).toISOString();
    else
        timestamp = new Date().toISOString();

    const diag = result?.diagnosis;
    const layers = result?.layers;

    const entry = {
        timestamp,
        diagnosis: {
            severity: typeof diag?.severity === 'string' ? diag.severity : 'unknown',
            shortBadge: typeof diag?.shortBadge === 'string' ? diag.shortBadge : '',
            message: typeof diag?.message === 'string' ? diag.message : '',
        },
        layers: {
            local: normalizeLayer(layers?.local),
            wan: normalizeLayer(layers?.wan),
            dns: normalizeLayer(layers?.dns),
            http: normalizeLayer(layers?.http),
        },
    };

    return `${JSON.stringify(entry)}\n`;
}

/**
 * Format an outage mtr/traceroute capture into a single newline-terminated JSONL log line.
 *
 * @param {{timestamp?: Date|string|number, tool?: string, reason?: string, traces?: Array<{target: string, ok: boolean, output: string, elapsedMs: number}>}|null|undefined} traceCapture
 * @returns {string}
 */
export function formatOutageTraceEntry(traceCapture) {
    let timestamp;
    const rawTs = traceCapture?.timestamp;
    if (rawTs instanceof Date && !Number.isNaN(rawTs.getTime()))
        timestamp = rawTs.toISOString();
    else if (typeof rawTs === 'string' && rawTs.trim().length > 0)
        timestamp = rawTs.trim();
    else if (typeof rawTs === 'number' && Number.isFinite(rawTs))
        timestamp = new Date(rawTs).toISOString();
    else
        timestamp = new Date().toISOString();

    const entry = {
        type: 'outage_trace',
        timestamp,
        tool: typeof traceCapture?.tool === 'string' ? traceCapture.tool : 'unknown',
        reason: typeof traceCapture?.reason === 'string' ? traceCapture.reason : '',
        traces: Array.isArray(traceCapture?.traces)
            ? traceCapture.traces.map(t => ({
                target: typeof t?.target === 'string' ? t.target : '',
                ok: Boolean(t?.ok),
                elapsedMs: typeof t?.elapsedMs === 'number' && Number.isFinite(t.elapsedMs)
                    ? t.elapsedMs
                    : 0,
                output: typeof t?.output === 'string' ? t.output : '',
            }))
            : [],
    };

    return `${JSON.stringify(entry)}\n`;
}

/**
 * Format an archive filename for a given epoch timestamp in milliseconds:
 * `netpulse-YYYY-MM-DD_HHMMSS.log`.
 *
 * @param {number} nowMs
 * @returns {string}
 */
function formatArchiveFilename(nowMs) {
    const d = new Date(nowMs);
    const pad2 = n => String(n).padStart(2, '0');
    const yyyy = d.getFullYear();
    const mm = pad2(d.getMonth() + 1);
    const dd = pad2(d.getDate());
    const hh = pad2(d.getHours());
    const min = pad2(d.getMinutes());
    const ss = pad2(d.getSeconds());
    return `netpulse-${yyyy}-${mm}-${dd}_${hh}${min}${ss}.log`;
}

/**
 * Async wrapper for Gio.File.make_directory_async.
 *
 * @param {Gio.File} dirFile
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<void>}
 */
function makeDirectoryAsync(dirFile, cancellable) {
    return new Promise((resolve, reject) => {
        dirFile.make_directory_async(GLib.PRIORITY_DEFAULT, cancellable, (f, res) => {
            try {
                f.make_directory_finish(res);
                resolve();
            } catch (err) {
                reject(err);
            }
        });
    });
}

/**
 * Asynchronously ensure a directory and all its parent directories exist.
 *
 * @param {Gio.File} dirFile
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<void>}
 */
async function ensureDirAsync(dirFile, cancellable) {
    try {
        await makeDirectoryAsync(dirFile, cancellable);
    } catch (err) {
        if (isIoError(err, Gio.IOErrorEnum.EXISTS))
            return;

        if (isIoError(err, Gio.IOErrorEnum.NOT_FOUND)) {
            const parent = dirFile.get_parent();
            if (!parent)
                throw err;
            await ensureDirAsync(parent, cancellable);
            try {
                await makeDirectoryAsync(dirFile, cancellable);
            } catch (err2) {
                if (!isIoError(err2, Gio.IOErrorEnum.EXISTS))
                    throw err2;
            }
            return;
        }

        throw err;
    }
}

/**
 * Async wrapper for Gio.File.query_info_async; returns null if the file does not exist.
 *
 * @param {Gio.File} file
 * @param {string} attributes
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<Gio.FileInfo|null>}
 */
function queryFileInfoAsync(file, attributes, cancellable) {
    return new Promise((resolve, reject) => {
        file.query_info_async(
            attributes,
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (f, res) => {
                try {
                    resolve(f.query_info_finish(res));
                } catch (err) {
                    if (isIoError(err, Gio.IOErrorEnum.NOT_FOUND))
                        resolve(null);
                    else
                        reject(err);
                }
            }
        );
    });
}

/**
 * Extract epoch milliseconds from a Gio.FileInfo (preferring creation time, falling back to mtime).
 *
 * @param {Gio.FileInfo|null} info
 * @returns {number|null}
 */
function getFileTimestampMs(info) {
    if (!info)
        return null;

    try {
        if (info.has_attribute('time::created')) {
            const createdSec = info.get_attribute_uint64('time::created');
            if (Number.isFinite(createdSec) && createdSec > 0)
                return createdSec * 1000;
        }
    } catch (_ignored) {
        // Fallback to modification time.
    }

    try {
        const dt = info.get_modification_date_time();
        if (dt)
            return dt.to_unix() * 1000;
    } catch (_ignored) {
        // Fallback to raw uint64 attribute.
    }

    try {
        if (info.has_attribute('time::modified')) {
            const modSec = info.get_attribute_uint64('time::modified');
            if (Number.isFinite(modSec) && modSec > 0)
                return modSec * 1000;
        }
    } catch (_ignored) {
        // No timestamp available.
    }

    return null;
}

/**
 * Async wrapper for Gio.File.load_contents_async; returns null if the file does not exist.
 *
 * @param {Gio.File} file
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<string|null>}
 */
function readTextFileAsync(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(cancellable, (f, res) => {
            try {
                const [ok, contents] = f.load_contents_finish(res);
                if (!ok || !contents) {
                    resolve(null);
                    return;
                }
                resolve(textDecoder.decode(contents));
            } catch (err) {
                if (isIoError(err, Gio.IOErrorEnum.NOT_FOUND))
                    resolve(null);
                else
                    reject(err);
            }
        });
    });
}

/**
 * Async wrapper for Gio.File.replace_contents_bytes_async.
 *
 * @param {Gio.File} file
 * @param {string} text
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<void>}
 */
function writeTextFileAsync(file, text, cancellable) {
    const bytes = new GLib.Bytes(textEncoder.encode(text));
    return new Promise((resolve, reject) => {
        file.replace_contents_bytes_async(
            bytes,
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            cancellable,
            (f, res) => {
                try {
                    f.replace_contents_finish(res);
                    resolve();
                } catch (err) {
                    reject(err);
                }
            }
        );
    });
}

/**
 * Async wrapper for Gio.File.move_async.
 *
 * @param {Gio.File} srcFile
 * @param {Gio.File} destFile
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<void>}
 */
function moveFileAsync(srcFile, destFile, cancellable) {
    return new Promise((resolve, reject) => {
        srcFile.move_async(
            destFile,
            Gio.FileCopyFlags.OVERWRITE,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            null,
            (f, res) => {
                try {
                    f.move_finish(res);
                    resolve();
                } catch (err) {
                    reject(err);
                }
            }
        );
    });
}

/**
 * Async wrapper for Gio.File.delete_async.
 *
 * @param {Gio.File} file
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<void>}
 */
function deleteFileAsync(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.delete_async(GLib.PRIORITY_DEFAULT, cancellable, (f, res) => {
            try {
                f.delete_finish(res);
                resolve();
            } catch (err) {
                if (isIoError(err, Gio.IOErrorEnum.NOT_FOUND))
                    resolve();
                else
                    reject(err);
            }
        });
    });
}

/**
 * Async wrapper for Gio.File.append_to_async.
 *
 * @param {Gio.File} file
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<Gio.FileOutputStream>}
 */
function appendToAsync(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.append_to_async(
            Gio.FileCreateFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (f, res) => {
                try {
                    resolve(f.append_to_finish(res));
                } catch (err) {
                    reject(err);
                }
            }
        );
    });
}

/**
 * Async wrapper for Gio.OutputStream.write_bytes_async.
 *
 * @param {Gio.OutputStream} stream
 * @param {GLib.Bytes} bytes
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<number>}
 */
function writeBytesAsync(stream, bytes, cancellable) {
    return new Promise((resolve, reject) => {
        stream.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
            try {
                resolve(s.write_bytes_finish(res));
            } catch (err) {
                reject(err);
            }
        });
    });
}

/**
 * Async wrapper for Gio.OutputStream.close_async.
 *
 * @param {Gio.OutputStream} stream
 * @returns {Promise<void>}
 */
function closeOutputStreamAsync(stream) {
    return new Promise(resolve => {
        stream.close_async(GLib.PRIORITY_DEFAULT, null, (s, res) => {
            try {
                s.close_finish(res);
            } catch (_ignored) {
                // Best-effort close.
            }
            resolve();
        });
    });
}

/**
 * Asynchronously append UTF-8 text to a file.
 *
 * @param {Gio.File} file
 * @param {string} text
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<void>}
 */
async function appendTextFileAsync(file, text, cancellable) {
    const encoded = textEncoder.encode(text);
    const stream = await appendToAsync(file, cancellable);
    try {
        let offset = 0;
        while (offset < encoded.length) {
            const slice = offset === 0 ? encoded : encoded.subarray(offset);
            const written = await writeBytesAsync(stream, new GLib.Bytes(slice), cancellable);
            if (written <= 0)
                break;
            offset += written;
        }
    } finally {
        await closeOutputStreamAsync(stream);
    }
}

/**
 * Async wrapper for Gio.File.enumerate_children_async.
 *
 * @param {Gio.File} dirFile
 * @param {string} attributes
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<Gio.FileEnumerator>}
 */
function enumerateChildrenAsync(dirFile, attributes, cancellable) {
    return new Promise((resolve, reject) => {
        dirFile.enumerate_children_async(
            attributes,
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (f, res) => {
                try {
                    resolve(f.enumerate_children_finish(res));
                } catch (err) {
                    reject(err);
                }
            }
        );
    });
}

/**
 * Async wrapper for Gio.FileEnumerator.next_files_async.
 *
 * @param {Gio.FileEnumerator} enumerator
 * @param {number} numFiles
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<Gio.FileInfo[]>}
 */
function nextFilesAsync(enumerator, numFiles, cancellable) {
    return new Promise((resolve, reject) => {
        enumerator.next_files_async(numFiles, GLib.PRIORITY_DEFAULT, cancellable, (e, res) => {
            try {
                resolve(e.next_files_finish(res));
            } catch (err) {
                reject(err);
            }
        });
    });
}

/**
 * Async wrapper for Gio.FileEnumerator.close_async.
 *
 * @param {Gio.FileEnumerator} enumerator
 * @returns {Promise<void>}
 */
function closeEnumeratorAsync(enumerator) {
    return new Promise(resolve => {
        enumerator.close_async(GLib.PRIORITY_DEFAULT, null, (e, res) => {
            try {
                e.close_finish(res);
            } catch (_ignored) {
                // Best-effort close.
            }
            resolve();
        });
    });
}

/**
 * Async, non-blocking diagnostic logger with 3-day rotation and archive pruning.
 */
export class NetPulseLogger {
    /**
     * @param {{logDir?: string|null, rotationDays?: number, maxArchives?: number}} [options]
     */
    constructor({
        logDir = null,
        rotationDays = DEFAULT_ROTATION_DAYS,
        maxArchives = DEFAULT_MAX_ARCHIVES,
    } = {}) {
        this._logDir = logDir && typeof logDir === 'string'
            ? logDir
            : GLib.build_filenamev([GLib.get_user_state_dir(), 'netpulse', 'logs']);
        this._rotationDays = normalizePositiveNumber(rotationDays, DEFAULT_ROTATION_DAYS);
        this._maxArchives = normalizeNonNegativeInt(maxArchives, DEFAULT_MAX_ARCHIVES);

        this._cancellable = new Gio.Cancellable();
        this._destroyed = false;
        this._writeQueue = Promise.resolve();
        this._startedAtMs = null;

        this._logDirFile = Gio.File.new_for_path(this._logDir);
        this._activeLogFile = this._logDirFile.get_child(ACTIVE_LOG_FILENAME);
        this._metaFile = this._logDirFile.get_child(ROTATION_META_FILENAME);
    }

    /**
     * Return the configured log directory path.
     *
     * @returns {string}
     */
    getLogDir() {
        return this._logDir;
    }

    /**
     * Update the rotation window in days.
     *
     * @param {number} days
     */
    setRotationDays(days) {
        this._rotationDays = normalizePositiveNumber(days, DEFAULT_ROTATION_DAYS);
    }

    /**
     * Serialize and asynchronously append a diagnostic snapshot to the active log file,
     * rotating and pruning archives if the rotation window has elapsed.
     *
     * @param {object} result
     * @returns {Promise<void>}
     */
    async logDiagnostic(result) {
        if (this._destroyed || this._cancellable.is_cancelled())
            return;

        const task = this._writeQueue.then(() => this._writeFormattedLine(formatLogEntry(result)));
        this._writeQueue = task.catch(() => {});
        return task;
    }

    /**
     * Serialize and asynchronously append an outage mtr/traceroute capture to the active log file.
     *
     * @param {object} traceCapture
     * @returns {Promise<void>}
     */
    async logOutageTrace(traceCapture) {
        if (this._destroyed || this._cancellable.is_cancelled())
            return;

        const task = this._writeQueue.then(() => this._writeFormattedLine(formatOutageTraceEntry(traceCapture)));
        this._writeQueue = task.catch(() => {});
        return task;
    }

    /**
     * Cancel any in-flight I/O and mark the logger destroyed so subsequent calls no-op.
     */
    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._cancellable.cancel();
    }

    /**
     * Read rotation start timestamp from `.rotation-meta.json`.
     *
     * @returns {Promise<number|null>}
     */
    async _readRotationMeta() {
        const content = await readTextFileAsync(this._metaFile, this._cancellable);
        if (!content)
            return null;

        try {
            const parsed = JSON.parse(content);
            if (typeof parsed?.startedAtMs === 'number' && Number.isFinite(parsed.startedAtMs) && parsed.startedAtMs > 0)
                return parsed.startedAtMs;
        } catch (_ignored) {
            // Corrupted metadata; caller will fall back to file timestamps.
        }
        return null;
    }

    /**
     * Persist rotation start timestamp to `.rotation-meta.json`.
     *
     * @param {number} startedAtMs
     * @returns {Promise<void>}
     */
    async _writeRotationMeta(startedAtMs) {
        this._startedAtMs = startedAtMs;
        const payload = `${JSON.stringify({startedAtMs})}\n`;
        await writeTextFileAsync(this._metaFile, payload, this._cancellable);
    }

    /**
     * Delete oldest `netpulse-*.log` archives beyond `this._maxArchives`.
     *
     * @returns {Promise<void>}
     */
    async _pruneArchives() {
        const enumerator = await enumerateChildrenAsync(
            this._logDirFile,
            'standard::name,standard::type,time::modified',
            this._cancellable
        );

        const archives = [];
        try {
            while (true) {
                if (this._destroyed || this._cancellable.is_cancelled())
                    return;

                const infos = await nextFilesAsync(enumerator, 50, this._cancellable);
                if (!infos || infos.length === 0)
                    break;

                for (const info of infos) {
                    const name = info.get_name();
                    if (!name || name === ACTIVE_LOG_FILENAME || !ARCHIVE_FILENAME_RE.test(name))
                        continue;
                    const mtimeMs = getFileTimestampMs(info) ?? 0;
                    archives.push({name, mtimeMs});
                }
            }
        } finally {
            await closeEnumeratorAsync(enumerator);
        }

        if (archives.length <= this._maxArchives)
            return;

        archives.sort((a, b) => {
            if (a.mtimeMs !== b.mtimeMs)
                return a.mtimeMs - b.mtimeMs;
            return a.name.localeCompare(b.name);
        });

        const toDeleteCount = archives.length - this._maxArchives;
        for (let i = 0; i < toDeleteCount; i++) {
            if (this._destroyed || this._cancellable.is_cancelled())
                return;
            const archiveFile = this._logDirFile.get_child(archives[i].name);
            await deleteFileAsync(archiveFile, this._cancellable);
        }
    }

    /**
     * Internal serialized write path: ensure directory, check/perform rotation, append line.
     *
     * @param {string} line
     * @returns {Promise<void>}
     */
    async _writeFormattedLine(line) {
        if (this._destroyed || this._cancellable.is_cancelled())
            return;

        try {
            await ensureDirAsync(this._logDirFile, this._cancellable);

            const nowMs = Date.now();
            const activeInfo = await queryFileInfoAsync(
                this._activeLogFile,
                'standard::type,time::created,time::modified',
                this._cancellable
            );

            let startedAtMs = await this._readRotationMeta();
            let needsMetaWrite = false;

            if (startedAtMs === null) {
                if (activeInfo) {
                    startedAtMs = getFileTimestampMs(activeInfo) ?? this._startedAtMs ?? nowMs;
                } else {
                    startedAtMs = nowMs;
                }
                needsMetaWrite = true;
            }
            this._startedAtMs = startedAtMs;

            if (activeInfo && shouldRotate(startedAtMs, nowMs, this._rotationDays)) {
                const archiveName = formatArchiveFilename(nowMs);
                const archiveFile = this._logDirFile.get_child(archiveName);
                await moveFileAsync(this._activeLogFile, archiveFile, this._cancellable);
                await this._writeRotationMeta(nowMs);
                await this._pruneArchives();
                needsMetaWrite = false;
            } else if (needsMetaWrite) {
                await this._writeRotationMeta(startedAtMs);
            }

            if (this._destroyed || this._cancellable.is_cancelled())
                return;

            await appendTextFileAsync(this._activeLogFile, line, this._cancellable);
        } catch (err) {
            if (this._destroyed || this._cancellable.is_cancelled() || isCancelledError(err))
                return;
            throw err;
        }
    }
}
