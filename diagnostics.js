import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

const HIGH_LATENCY_MS = 150;
const GATEWAY_HIGH_LATENCY_MS = 100;
const DEFAULT_CMD_TIMEOUT_MS = 4000;
const DEFAULT_HTTP_TIMEOUT_MS = 5000;

/**
 * Format a latency value in milliseconds for display.
 *
 * @param {number|null} ms
 * @returns {string}
 */
export function formatLatency(ms) {
    if (ms === null || ms === undefined || Number.isNaN(ms))
        return '--';
    return `${Math.round(ms)}ms`;
}

/**
 * Check whether an error represents a GLib/Gio cancellation.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isCancelledError(err) {
    if (!err)
        return false;
    if (err instanceof GLib.Error)
        return err.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED);
    return err.code === Gio.IOErrorEnum.CANCELLED || err.name === 'CancelledError';
}

/**
 * Create a child Gio.Cancellable linked to an optional parent cancellable
 * and an automatic timeout.
 *
 * @param {Gio.Cancellable|null} parentCancellable
 * @param {number} timeoutMs
 * @returns {{cancellable: Gio.Cancellable, isTimedOut: () => boolean, cleanup: () => void}}
 */
function createScopedCancellable(parentCancellable, timeoutMs) {
    const child = new Gio.Cancellable();
    let timedOut = false;
    let parentHandlerId = 0;
    let timeoutId = 0;

    if (parentCancellable) {
        if (parentCancellable.is_cancelled()) {
            child.cancel();
        } else {
            parentHandlerId = parentCancellable.connect(() => {
                child.cancel();
            });
        }
    }

    if (timeoutMs > 0 && !child.is_cancelled()) {
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            timedOut = true;
            child.cancel();
            timeoutId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    return {
        cancellable: child,
        isTimedOut: () => timedOut,
        cleanup: () => {
            if (timeoutId !== 0) {
                GLib.Source.remove(timeoutId);
                timeoutId = 0;
            }
            if (parentCancellable && parentHandlerId !== 0) {
                parentCancellable.disconnect(parentHandlerId);
                parentHandlerId = 0;
            }
        },
    };
}

/**
 * Run a subprocess asynchronously without blocking the GNOME Shell main loop.
 *
 * @param {string[]} argv
 * @param {{timeoutMs?: number, cancellable?: Gio.Cancellable|null}} [options]
 * @returns {Promise<{ok: boolean, exitStatus: number, stdout: string, stderr: string, elapsedMs: number, timedOut: boolean, spawnError?: string}>}
 */
export function runCommandAsync(argv, options = {}) {
    const {
        timeoutMs = DEFAULT_CMD_TIMEOUT_MS,
        cancellable = null,
    } = options;

    return new Promise((resolve, reject) => {
        if (cancellable?.is_cancelled()) {
            reject(new GLib.Error(
                Gio.io_error_quark(),
                Gio.IOErrorEnum.CANCELLED,
                'Operation was cancelled'
            ));
            return;
        }

        const scoped = createScopedCancellable(cancellable, timeoutMs);
        const startUs = GLib.get_monotonic_time();

        let proc;
        try {
            proc = new Gio.Subprocess({
                argv,
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            proc.init(scoped.cancellable);
        } catch (err) {
            scoped.cleanup();
            if (cancellable?.is_cancelled() || (!scoped.isTimedOut() && isCancelledError(err))) {
                reject(err);
                return;
            }
            resolve({
                ok: false,
                exitStatus: -1,
                stdout: '',
                stderr: err.message ?? String(err),
                elapsedMs: (GLib.get_monotonic_time() - startUs) / 1000,
                timedOut: scoped.isTimedOut(),
                spawnError: err.message ?? String(err),
            });
            return;
        }

        proc.communicate_utf8_async(null, scoped.cancellable, (p, res) => {
            const elapsedMs = (GLib.get_monotonic_time() - startUs) / 1000;
            const timedOut = scoped.isTimedOut();
            scoped.cleanup();

            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                resolve({
                    ok: p.get_successful(),
                    exitStatus: p.get_if_exited() ? p.get_exit_status() : -1,
                    stdout: stdout ?? '',
                    stderr: stderr ?? '',
                    elapsedMs,
                    timedOut: false,
                });
            } catch (err) {
                try {
                    p.force_exit();
                } catch (_ignored) {
                    // Process may have already exited.
                }

                if (cancellable?.is_cancelled()) {
                    reject(err);
                    return;
                }

                if (timedOut) {
                    resolve({
                        ok: false,
                        exitStatus: -1,
                        stdout: '',
                        stderr: 'Command timed out',
                        elapsedMs,
                        timedOut: true,
                    });
                    return;
                }

                resolve({
                    ok: false,
                    exitStatus: -1,
                    stdout: '',
                    stderr: err.message ?? String(err),
                    elapsedMs,
                    timedOut: false,
                });
            }
        });
    });
}

/**
 * Parse RTT in milliseconds from Linux iputils `ping` stdout.
 *
 * @param {string} stdout
 * @returns {number|null}
 */
function parsePingRttMs(stdout) {
    const match = stdout.match(/time[=<]\s*([\d.]+)\s*ms/i);
    if (!match)
        return null;
    const value = Number.parseFloat(match[1]);
    return Number.isFinite(value) ? value : null;
}

/**
 * Split a `nmcli -t` colon-delimited line respecting `\\:` escapes.
 *
 * @param {string} line
 * @returns {string[]}
 */
function splitNmcliTerseLine(line) {
    const fields = [];
    let current = '';
    for (let i = 0; i < line.length; i++) {
        if (line[i] === '\\' && i + 1 < line.length && line[i + 1] === ':') {
            current += ':';
            i++;
        } else if (line[i] === ':') {
            fields.push(current);
            current = '';
        } else {
            current += line[i];
        }
    }
    fields.push(current);
    return fields;
}

/**
 * Layer 1: Local Interface & Gateway check.
 *
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<{status: 'pass'|'degraded'|'fail', latencyMs: number|null, detail: string, summary: string, hasInterface: boolean, gateway: string|null}>}
 */
export async function checkLocalAndGateway(cancellable = null) {
    const [nmRes, routeRes] = await Promise.all([
        runCommandAsync(
            ['nmcli', '-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status'],
            {timeoutMs: 3000, cancellable}
        ),
        runCommandAsync(
            ['ip', 'route', 'show', 'default'],
            {timeoutMs: 3000, cancellable}
        ),
    ]);

    let activeConn = null;
    if (nmRes.ok) {
        const lines = nmRes.stdout.split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
            const [device, type, state, connection] = splitNmcliTerseLine(line);
            if (!device || type === 'loopback' || device === 'lo')
                continue;
            if (state && state.toLowerCase().startsWith('connected')) {
                activeConn = {
                    device,
                    type: type || 'unknown',
                    state,
                    connection: connection || device,
                };
                break;
            }
        }
    }

    let gateway = null;
    let routeDev = null;
    if (routeRes.ok) {
        const viaMatch = routeRes.stdout.match(/^default\s+via\s+(\S+)(?:\s+dev\s+(\S+))?/m);
        if (viaMatch) {
            gateway = viaMatch[1];
            routeDev = viaMatch[2] || null;
        } else {
            const devMatch = routeRes.stdout.match(/^default\s+dev\s+(\S+)/m);
            if (devMatch)
                routeDev = devMatch[1];
        }
    }

    if (!activeConn && !routeDev && !gateway) {
        return {
            status: 'fail',
            latencyMs: null,
            summary: 'No active network',
            detail: nmRes.ok
                ? 'No connected network interface or default route'
                : 'No default route found (nmcli unavailable)',
            hasInterface: false,
            gateway: null,
        };
    }

    const ifaceLabel = activeConn
        ? `${activeConn.device} (${activeConn.connection})`
        : routeDev;

    if (!gateway) {
        if (routeDev) {
            return {
                status: 'pass',
                latencyMs: null,
                summary: `${routeDev} (point-to-point)`,
                detail: `${ifaceLabel} active with direct default route`,
                hasInterface: true,
                gateway: null,
            };
        }

        return {
            status: 'fail',
            latencyMs: null,
            summary: 'No default gateway',
            detail: `${ifaceLabel} connected, but no default gateway route`,
            hasInterface: true,
            gateway: null,
        };
    }

    const pingRes = await runCommandAsync(
        ['ping', '-c', '1', '-W', '2', gateway],
        {timeoutMs: 3500, cancellable}
    );

    if (!pingRes.ok) {
        return {
            status: 'fail',
            latencyMs: null,
            summary: 'Gateway unreachable',
            detail: `${ifaceLabel} → gateway ${gateway} unreachable`,
            hasInterface: true,
            gateway,
        };
    }

    const rttMs = parsePingRttMs(pingRes.stdout) ?? pingRes.elapsedMs;
    const roundedMs = Math.round(rttMs * 10) / 10;
    const status = roundedMs > GATEWAY_HIGH_LATENCY_MS ? 'degraded' : 'pass';

    return {
        status,
        latencyMs: roundedMs,
        summary: `GW ${gateway} (${formatLatency(roundedMs)})`,
        detail: `${ifaceLabel} → ${gateway} (${formatLatency(roundedMs)})`,
        hasInterface: true,
        gateway,
    };
}

/**
 * Layer 2: WAN / ISP Routing (ICMP) check.
 *
 * @param {string} publicIpTarget
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<{status: 'pass'|'degraded'|'fail', latencyMs: number|null, detail: string, summary: string}>}
 */
export async function checkWanIcmp(publicIpTarget, cancellable = null) {
    const target = (publicIpTarget || '1.1.1.1').trim();
    if (!target) {
        return {
            status: 'fail',
            latencyMs: null,
            summary: 'No target',
            detail: 'Public IP target is empty in preferences',
        };
    }

    const pingRes = await runCommandAsync(
        ['ping', '-c', '1', '-W', '2', target],
        {timeoutMs: 3500, cancellable}
    );

    if (!pingRes.ok) {
        return {
            status: 'fail',
            latencyMs: null,
            summary: 'WAN unreachable',
            detail: pingRes.timedOut
                ? `ICMP ping to ${target} timed out`
                : `ICMP ping to ${target} failed`,
        };
    }

    const rttMs = parsePingRttMs(pingRes.stdout) ?? pingRes.elapsedMs;
    const roundedMs = Math.round(rttMs * 10) / 10;
    const status = roundedMs > HIGH_LATENCY_MS ? 'degraded' : 'pass';

    return {
        status,
        latencyMs: roundedMs,
        summary: `${target} (${formatLatency(roundedMs)})`,
        detail: `ICMP reply from ${target} in ${formatLatency(roundedMs)}`,
    };
}

/**
 * Layer 3: DNS Resolution check (`resolvectl query` with `getent hosts` fallback).
 *
 * @param {string} dnsTestDomain
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<{status: 'pass'|'degraded'|'fail', latencyMs: number|null, detail: string, summary: string}>}
 */
export async function checkDns(dnsTestDomain, cancellable = null) {
    const domain = (dnsTestDomain || 'fedoraproject.org').trim();
    if (!domain) {
        return {
            status: 'fail',
            latencyMs: null,
            summary: 'No domain',
            detail: 'DNS test domain is empty in preferences',
        };
    }

    const resolvectlRes = await runCommandAsync(
        ['resolvectl', 'query', '--legend=no', domain],
        {timeoutMs: 4000, cancellable}
    );

    if (resolvectlRes.ok && resolvectlRes.stdout.trim().length > 0) {
        const firstLine = resolvectlRes.stdout.trim().split('\n')[0];
        const ipMatch = firstLine.match(/:\s*([0-9a-fA-F.:]+)/);
        const resolved = ipMatch ? ipMatch[1] : firstLine.trim();
        const elapsedMs = Math.round(resolvectlRes.elapsedMs * 10) / 10;
        const status = elapsedMs > HIGH_LATENCY_MS ? 'degraded' : 'pass';

        return {
            status,
            latencyMs: elapsedMs,
            summary: `Resolved (${formatLatency(elapsedMs)})`,
            detail: `${domain} → ${resolved} via resolvectl (${formatLatency(elapsedMs)})`,
        };
    }

    const getentRes = await runCommandAsync(
        ['getent', 'hosts', domain],
        {timeoutMs: 4000, cancellable}
    );

    if (getentRes.ok && getentRes.stdout.trim().length > 0) {
        const firstLine = getentRes.stdout.trim().split('\n')[0];
        const resolved = firstLine.split(/\s+/)[0] || firstLine;
        const elapsedMs = Math.round(getentRes.elapsedMs * 10) / 10;
        const status = elapsedMs > HIGH_LATENCY_MS ? 'degraded' : 'pass';

        return {
            status,
            latencyMs: elapsedMs,
            summary: `Resolved (${formatLatency(elapsedMs)})`,
            detail: `${domain} → ${resolved} via getent (${formatLatency(elapsedMs)})`,
        };
    }

    const reason = resolvectlRes.timedOut || getentRes.timedOut
        ? `DNS lookup for ${domain} timed out`
        : `Failed to resolve ${domain}`;

    return {
        status: 'fail',
        latencyMs: null,
        summary: 'DNS failed',
        detail: reason,
    };
}

/**
 * Promise wrapper around Soup.Session.send_and_read_async (Soup 3.0).
 *
 * @param {Soup.Session} session
 * @param {Soup.Message} message
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<GLib.Bytes|null>}
 */
function sendAndReadAsync(session, message, cancellable) {
    return new Promise((resolve, reject) => {
        session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (s, res) => {
                try {
                    const bytes = s.send_and_read_finish(res);
                    resolve(bytes);
                } catch (err) {
                    reject(err);
                }
            }
        );
    });
}

/**
 * Layer 4: HTTP Captive Portal / Layer 7 check using Soup 3.0 async API.
 *
 * @param {string} httpEndpoint
 * @param {Soup.Session} soupSession
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<{status: 'pass'|'degraded'|'fail', latencyMs: number|null, detail: string, summary: string, captivePortal: boolean, statusCode: number|null}>}
 */
export async function checkHttpCaptivePortal(httpEndpoint, soupSession, cancellable = null) {
    const endpoint = (httpEndpoint || 'https://fedoraproject.org/static/hotspot.txt').trim();
    if (!endpoint) {
        return {
            status: 'fail',
            latencyMs: null,
            summary: 'No endpoint',
            detail: 'HTTP endpoint is empty in preferences',
            captivePortal: false,
            statusCode: null,
        };
    }

    let message;
    try {
        message = Soup.Message.new('GET', endpoint);
    } catch (_err) {
        message = null;
    }

    if (!message) {
        return {
            status: 'fail',
            latencyMs: null,
            summary: 'Invalid URL',
            detail: `Invalid HTTP endpoint: ${endpoint}`,
            captivePortal: false,
            statusCode: null,
        };
    }

    // Do not auto-follow redirects so 3xx captive portal redirects are detected directly.
    message.add_flags(Soup.MessageFlags.NO_REDIRECT);

    const scoped = createScopedCancellable(cancellable, DEFAULT_HTTP_TIMEOUT_MS);
    const startUs = GLib.get_monotonic_time();

    try {
        const bytes = await sendAndReadAsync(soupSession, message, scoped.cancellable);
        const elapsedMs = Math.round(((GLib.get_monotonic_time() - startUs) / 1000) * 10) / 10;
        const statusCode = message.get_status();

        if (statusCode >= 300 && statusCode < 400) {
            const location = message.get_response_headers().get_one('Location');
            return {
                status: 'degraded',
                latencyMs: elapsedMs,
                summary: `Redirect (${statusCode})`,
                detail: location
                    ? `Captive portal redirect (${statusCode}) → ${location}`
                    : `Captive portal redirect (HTTP ${statusCode})`,
                captivePortal: true,
                statusCode,
            };
        }

        if (statusCode === 200 || statusCode === 204) {
            const data = bytes ? bytes.get_data() : null;
            const body = data ? new TextDecoder('utf-8').decode(data) : '';

            if (endpoint.endsWith('hotspot.txt') && body.trim() !== 'OK') {
                return {
                    status: 'degraded',
                    latencyMs: elapsedMs,
                    summary: 'Captive portal',
                    detail: 'Unexpected hotspot.txt body (possible captive portal)',
                    captivePortal: true,
                    statusCode,
                };
            }

            const status = elapsedMs > HIGH_LATENCY_MS ? 'degraded' : 'pass';
            return {
                status,
                latencyMs: elapsedMs,
                summary: `HTTP ${statusCode} (${formatLatency(elapsedMs)})`,
                detail: `HTTP ${statusCode} OK in ${formatLatency(elapsedMs)}`,
                captivePortal: false,
                statusCode,
            };
        }

        const reason = message.get_reason_phrase() || '';
        return {
            status: 'fail',
            latencyMs: elapsedMs,
            summary: `HTTP ${statusCode}`,
            detail: `HTTP ${statusCode} ${reason}`.trim(),
            captivePortal: false,
            statusCode,
        };
    } catch (err) {
        if (cancellable?.is_cancelled())
            throw err;

        const timedOut = scoped.isTimedOut();
        return {
            status: 'fail',
            latencyMs: null,
            summary: timedOut ? 'HTTP timeout' : 'HTTP failed',
            detail: timedOut
                ? `HTTP request timed out (${endpoint})`
                : `HTTP error: ${err.message ?? String(err)}`,
            captivePortal: false,
            statusCode: null,
        };
    } finally {
        scoped.cleanup();
    }
}

/**
 * Root-Cause Diagnosis Engine: evaluates the 4 layers top-to-bottom.
 *
 * @param {{local: object, wan: object, dns: object, http: object}} layers
 * @returns {{severity: 'pass'|'degraded'|'fail', message: string, shortBadge: string}}
 */
export function diagnoseLayers(layers) {
    const {local, wan, dns, http} = layers;

    if (local.status === 'fail') {
        if (local.hasInterface === false) {
            return {
                severity: 'fail',
                message: 'No active network connection or local gateway unreachable',
                shortBadge: 'No Net',
            };
        }
        return {
            severity: 'fail',
            message: 'No active network connection or local gateway unreachable',
            shortBadge: 'GW Fail',
        };
    }

    if (wan.status === 'fail') {
        return {
            severity: 'fail',
            message: 'Router reachable, but ISP WAN is down',
            shortBadge: 'WAN Down',
        };
    }

    if (dns.status === 'fail') {
        return {
            severity: 'fail',
            message: 'Internet reachable, but DNS is failing',
            shortBadge: 'DNS Fail',
        };
    }

    if (http.captivePortal) {
        return {
            severity: 'degraded',
            message: 'Captive portal login required',
            shortBadge: 'Portal',
        };
    }

    if (http.status === 'fail') {
        return {
            severity: 'fail',
            message: 'HTTP connectivity failing',
            shortBadge: 'HTTP Fail',
        };
    }

    const primaryLatency = wan.latencyMs ?? http.latencyMs ?? local.latencyMs;
    const badge = primaryLatency !== null ? `${Math.round(primaryLatency)}ms` : 'OK';

    const anyDegraded =
        local.status === 'degraded' ||
        wan.status === 'degraded' ||
        dns.status === 'degraded' ||
        http.status === 'degraded' ||
        (wan.latencyMs !== null && wan.latencyMs > HIGH_LATENCY_MS) ||
        (http.latencyMs !== null && http.latencyMs > HIGH_LATENCY_MS);

    if (anyDegraded) {
        return {
            severity: 'degraded',
            message: 'All layers reachable, but latency is elevated',
            shortBadge: badge,
        };
    }

    return {
        severity: 'pass',
        message: 'All network layers healthy',
        shortBadge: badge,
    };
}

/**
 * Execute all 4 diagnostic layers asynchronously and return the full snapshot.
 *
 * @param {{publicIpTarget: string, dnsTestDomain: string, httpEndpoint: string}} config
 * @param {Soup.Session} soupSession
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<{timestamp: Date, layers: {local: object, wan: object, dns: object, http: object}, diagnosis: {severity: string, message: string, shortBadge: string}}>}
 */
export async function runDiagnostics(config, soupSession, cancellable = null) {
    const [local, wan, dns, http] = await Promise.all([
        checkLocalAndGateway(cancellable),
        checkWanIcmp(config.publicIpTarget, cancellable),
        checkDns(config.dnsTestDomain, cancellable),
        checkHttpCaptivePortal(config.httpEndpoint, soupSession, cancellable),
    ]);

    const layers = {local, wan, dns, http};
    const diagnosis = diagnoseLayers(layers);

    return {
        timestamp: new Date(),
        layers,
        diagnosis,
    };
}

/**
 * Generate a formatted plain-text diagnostic report including live `nmcli device status`.
 *
 * @param {{timestamp: Date, layers: {local: object, wan: object, dns: object, http: object}, diagnosis: {severity: string, message: string, shortBadge: string}}|null} result
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<string>}
 */
export async function generateDiagnosticReport(result, cancellable = null) {
    const nmcliRes = await runCommandAsync(['nmcli', 'device', 'status'], {
        timeoutMs: 4000,
        cancellable,
    });

    const timestampStr = result?.timestamp
        ? result.timestamp.toISOString()
        : new Date().toISOString();

    const lines = [
        '=== NetPulse Network Diagnostic Report ===',
        `Timestamp: ${timestampStr}`,
    ];

    if (result) {
        lines.push(
            `Diagnosis: [${result.diagnosis.severity.toUpperCase()}] ${result.diagnosis.message}`,
            '',
            '--- Diagnostic Layers ---',
            `1. Local & Gateway : [${result.layers.local.status.toUpperCase()}] ${formatLatency(result.layers.local.latencyMs)} — ${result.layers.local.detail}`,
            `2. WAN / ISP (ICMP): [${result.layers.wan.status.toUpperCase()}] ${formatLatency(result.layers.wan.latencyMs)} — ${result.layers.wan.detail}`,
            `3. DNS Resolution  : [${result.layers.dns.status.toUpperCase()}] ${formatLatency(result.layers.dns.latencyMs)} — ${result.layers.dns.detail}`,
            `4. HTTP / Portal   : [${result.layers.http.status.toUpperCase()}] ${formatLatency(result.layers.http.latencyMs)} — ${result.layers.http.detail}`
        );
    } else {
        lines.push('Diagnosis: No diagnostic run completed yet.');
    }

    lines.push('', '--- NetworkManager Device Status ---');
    if (nmcliRes.ok && nmcliRes.stdout.trim().length > 0)
        lines.push(nmcliRes.stdout.trimEnd());
    else
        lines.push(`(nmcli unavailable: ${nmcliRes.stderr.trim() || 'command failed'})`);

    return lines.join('\n');
}
