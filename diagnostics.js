import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import NM from 'gi://NM';
import Soup from 'gi://Soup?version=3.0';

const GATEWAY_HIGH_LATENCY_MS = 100;
const WAN_HIGH_LATENCY_MS = 150;
const DNS_HIGH_LATENCY_MS = 300;
const HTTP_HIGH_LATENCY_MS = 1000;
const DEFAULT_CMD_TIMEOUT_MS = 4000;
const DEFAULT_HTTP_TIMEOUT_MS = 5000;
const DEFAULT_SPEEDTEST_TIMEOUT_MS = 45000;
const OUTAGE_TRACE_TIMEOUT_MS = 35000;
export const OUTAGE_TRACE_TARGETS = ['1.1.1.1', '8.8.8.8'];
const SPEEDTEST_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const SPEEDTEST_UPLOAD_BYTES = 4 * 1024 * 1024;
const SPEEDTEST_CHUNK_BYTES = 64 * 1024;
const SPEEDTEST_DOWN_URL = 'https://speed.cloudflare.com/__down';
const SPEEDTEST_UP_URL = 'https://speed.cloudflare.com/__up';

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
 * Format a throughput value in Mbps for display.
 *
 * @param {number|null} mbps
 * @returns {string}
 */
export function formatSpeedMbps(mbps) {
    if (mbps === null || mbps === undefined || Number.isNaN(mbps))
        return '--';
    if (mbps >= 100)
        return `${Math.round(mbps)} Mbps`;
    return `${mbps.toFixed(1)} Mbps`;
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
 * Extract link and gateway metadata from an NM.ActiveConnection if it is
 * a usable non-loopback connection.
 *
 * @param {NM.ActiveConnection|null|undefined} activeConn
 * @returns {{device: string|null, type: string|null, connection: string|null, gateway: string|null}|null}
 */
function inspectActiveConnection(activeConn) {
    if (!activeConn)
        return null;

    const connType = activeConn.get_connection_type?.() ?? null;
    const devices = activeConn.get_devices?.() ?? [];
    const primaryDev = devices[0] ?? null;
    const device = primaryDev?.get_ip_iface?.() || primaryDev?.get_iface?.() || null;

    if (connType === 'loopback' || device === 'lo')
        return null;

    const ip4 = activeConn.get_ip4_config?.() ?? null;
    const ip6 = activeConn.get_ip6_config?.() ?? null;
    const state = activeConn.get_state?.();

    const isActivated = state === NM.ActiveConnectionState.ACTIVATED;
    const isActivatingWithIp = state === NM.ActiveConnectionState.ACTIVATING && Boolean(ip4 || ip6);
    if (!isActivated && !isActivatingWithIp)
        return null;

    const gateway = ip4?.get_gateway?.() || ip6?.get_gateway?.() || null;
    const connection = activeConn.get_id?.() || device || null;

    return {
        device,
        type: connType,
        connection,
        gateway,
    };
}

/**
 * Inspect NetworkManager state via a shared NM.Client without spawning subprocesses.
 *
 * @param {NM.Client|null|undefined} nmClient
 * @returns {{available: boolean, hasLink: boolean, device: string|null, type: string|null, connection: string|null, gateway: string|null}}
 */
export function hasActiveNetworkLink(nmClient) {
    if (!nmClient) {
        return {
            available: false,
            hasLink: true,
            device: null,
            type: null,
            connection: null,
            gateway: null,
        };
    }

    if (typeof nmClient.networking_get_enabled === 'function' && !nmClient.networking_get_enabled()) {
        return {
            available: true,
            hasLink: false,
            device: null,
            type: null,
            connection: null,
            gateway: null,
        };
    }

    const primary = inspectActiveConnection(nmClient.get_primary_connection?.());
    if (primary) {
        return {
            available: true,
            hasLink: true,
            device: primary.device,
            type: primary.type,
            connection: primary.connection,
            gateway: primary.gateway,
        };
    }

    const activeConnections = nmClient.get_active_connections?.() ?? [];
    let fallbackMatch = null;
    for (const ac of activeConnections) {
        const info = inspectActiveConnection(ac);
        if (!info)
            continue;
        if (info.gateway) {
            return {
                available: true,
                hasLink: true,
                device: info.device,
                type: info.type,
                connection: info.connection,
                gateway: info.gateway,
            };
        }
        if (!fallbackMatch)
            fallbackMatch = info;
    }

    if (fallbackMatch) {
        return {
            available: true,
            hasLink: true,
            device: fallbackMatch.device,
            type: fallbackMatch.type,
            connection: fallbackMatch.connection,
            gateway: fallbackMatch.gateway,
        };
    }

    return {
        available: true,
        hasLink: false,
        device: null,
        type: null,
        connection: null,
        gateway: null,
    };
}

/**
 * Build a complete diagnostic snapshot representing no active network link
 * without spawning any subprocesses or HTTP requests.
 *
 * @param {{available?: boolean, hasLink?: boolean, device?: string|null, type?: string|null, connection?: string|null, gateway?: string|null}|null} [nmStatus]
 * @param {Date} [timestamp]
 * @returns {{timestamp: Date, layers: {local: object, wan: object, dns: object, http: object}, diagnosis: {severity: 'pass'|'degraded'|'fail', message: string, shortBadge: string}}}
 */
export function buildNoLinkResult(nmStatus = null, timestamp = new Date()) {
    const local = {
        status: 'fail',
        latencyMs: null,
        summary: 'No active network',
        detail: nmStatus?.device
            ? `${nmStatus.device} has no active network link`
            : 'No active network connection (NetworkManager reports offline)',
        hasInterface: false,
        gateway: null,
    };

    const wan = {
        status: 'fail',
        latencyMs: null,
        summary: 'Skipped (no link)',
        detail: 'Skipped: no active network link',
    };

    const dns = {
        status: 'fail',
        latencyMs: null,
        summary: 'Skipped (no link)',
        detail: 'Skipped: no active network link',
    };

    const http = {
        status: 'fail',
        latencyMs: null,
        summary: 'Skipped (no link)',
        detail: 'Skipped: no active network link',
        captivePortal: false,
        statusCode: null,
    };

    const layers = {local, wan, dns, http};
    const diagnosis = diagnoseLayers(layers);

    return {
        timestamp,
        layers,
        diagnosis,
    };
}

/**
 * Layer 1: Local Interface & Gateway check.
 * Uses native NetworkManager (gi://NM) when nmClient is provided, falling back
 * to `nmcli` + `ip route` subprocesses only when nmClient is unavailable.
 *
 * @param {Gio.Cancellable|null} cancellable
 * @param {NM.Client|null} nmClient
 * @returns {Promise<{status: 'pass'|'degraded'|'fail', latencyMs: number|null, detail: string, summary: string, hasInterface: boolean, gateway: string|null}>}
 */
export async function checkLocalAndGateway(cancellable = null, nmClient = null) {
    let ifaceLabel = null;
    let gateway = null;
    let routeDev = null;

    const nmStatus = hasActiveNetworkLink(nmClient);
    if (nmStatus.available) {
        if (!nmStatus.hasLink) {
            return {
                status: 'fail',
                latencyMs: null,
                summary: 'No active network',
                detail: 'No connected network interface or default route',
                hasInterface: false,
                gateway: null,
            };
        }

        gateway = nmStatus.gateway;
        ifaceLabel = nmStatus.device && nmStatus.connection && nmStatus.connection !== nmStatus.device
            ? `${nmStatus.device} (${nmStatus.connection})`
            : (nmStatus.device || nmStatus.connection || 'network');
    } else {
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

        ifaceLabel = activeConn
            ? `${activeConn.device} (${activeConn.connection})`
            : routeDev;
    }

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
    const status = roundedMs > WAN_HIGH_LATENCY_MS ? 'degraded' : 'pass';

    return {
        status,
        latencyMs: roundedMs,
        summary: `${target} (${formatLatency(roundedMs)})`,
        detail: `ICMP reply from ${target} in ${formatLatency(roundedMs)}`,
    };
}

/**
 * Promise wrapper around Gio.Resolver.lookup_by_name_async.
 *
 * @param {Gio.Resolver} resolver
 * @param {string} domain
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<Gio.InetAddress[]>}
 */
function lookupByNameAsync(resolver, domain, cancellable) {
    return new Promise((resolve, reject) => {
        resolver.lookup_by_name_async(domain, cancellable, (r, res) => {
            try {
                const addresses = r.lookup_by_name_finish(res);
                resolve(addresses ?? []);
            } catch (err) {
                reject(err);
            }
        });
    });
}

/**
 * Layer 3: DNS Resolution check using native async Gio.Resolver (zero subprocesses).
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

    if (cancellable?.is_cancelled()) {
        throw new GLib.Error(
            Gio.io_error_quark(),
            Gio.IOErrorEnum.CANCELLED,
            'Operation was cancelled'
        );
    }

    const scoped = createScopedCancellable(cancellable, DEFAULT_CMD_TIMEOUT_MS);
    const startUs = GLib.get_monotonic_time();

    try {
        const resolver = Gio.Resolver.get_default();
        const addresses = await lookupByNameAsync(resolver, domain, scoped.cancellable);
        const elapsedMs = Math.round(((GLib.get_monotonic_time() - startUs) / 1000) * 10) / 10;
        const resolved = addresses.map(a => a.to_string()).slice(0, 3).join(', ');

        if (!resolved) {
            return {
                status: 'fail',
                latencyMs: null,
                summary: 'DNS failed',
                detail: `No addresses returned for ${domain}`,
            };
        }

        const status = elapsedMs > DNS_HIGH_LATENCY_MS ? 'degraded' : 'pass';
        return {
            status,
            latencyMs: elapsedMs,
            summary: `Resolved (${formatLatency(elapsedMs)})`,
            detail: `${domain} → ${resolved} (${formatLatency(elapsedMs)})`,
        };
    } catch (err) {
        if (cancellable?.is_cancelled() || (!scoped.isTimedOut() && isCancelledError(err)))
            throw err;

        const timedOut = scoped.isTimedOut();
        return {
            status: 'fail',
            latencyMs: null,
            summary: timedOut ? 'DNS timeout' : 'DNS failed',
            detail: timedOut
                ? `DNS lookup for ${domain} timed out`
                : `Failed to resolve ${domain}: ${err.message ?? String(err)}`,
        };
    } finally {
        scoped.cleanup();
    }
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

            const status = elapsedMs > HTTP_HIGH_LATENCY_MS ? 'degraded' : 'pass';
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
        (wan.latencyMs !== null && wan.latencyMs > WAN_HIGH_LATENCY_MS) ||
        (http.latencyMs !== null && http.latencyMs > HTTP_HIGH_LATENCY_MS);

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
 * @param {{publicIpTarget: string, dnsTestDomain: string, httpEndpoint: string, nmClient?: NM.Client|null}} config
 * @param {Soup.Session} soupSession
 * @param {Gio.Cancellable|null} [cancellable]
 * @param {NM.Client|null} [nmClient]
 * @returns {Promise<{timestamp: Date, layers: {local: object, wan: object, dns: object, http: object}, diagnosis: {severity: string, message: string, shortBadge: string}}>}
 */
export async function runDiagnostics(config, soupSession, cancellable = null, nmClient = null) {
    const effectiveNmClient = nmClient ?? config?.nmClient ?? null;
    const [local, wan, dns, http] = await Promise.all([
        checkLocalAndGateway(cancellable, effectiveNmClient),
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
 * Promise wrapper around Soup.Session.send_async (Soup 3.0).
 *
 * @param {Soup.Session} session
 * @param {Soup.Message} message
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<Gio.InputStream>}
 */
function sendStreamAsync(session, message, cancellable) {
    return new Promise((resolve, reject) => {
        session.send_async(
            message,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (s, res) => {
                try {
                    const stream = s.send_finish(res);
                    resolve(stream);
                } catch (err) {
                    reject(err);
                }
            }
        );
    });
}

/**
 * Promise wrapper around Gio.InputStream.read_bytes_async.
 *
 * @param {Gio.InputStream} stream
 * @param {number} count
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<GLib.Bytes>}
 */
function readBytesAsync(stream, count, cancellable) {
    return new Promise((resolve, reject) => {
        stream.read_bytes_async(
            count,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (s, res) => {
                try {
                    resolve(s.read_bytes_finish(res));
                } catch (err) {
                    reject(err);
                }
            }
        );
    });
}

/**
 * Run an on-demand download/upload/latency speed test using Soup 3.0.
 *
 * @param {Soup.Session} soupSession
 * @param {Gio.Cancellable|null} [cancellable]
 * @param {((phase: string) => void)|null} [onProgress]
 * @returns {Promise<{ok: boolean, downloadMbps: number|null, uploadMbps: number|null, latencyMs: number|null, detail: string, timestamp: Date}>}
 */
export async function runSpeedTest(soupSession, cancellable = null, onProgress = null) {
    const scoped = createScopedCancellable(cancellable, DEFAULT_SPEEDTEST_TIMEOUT_MS);

    try {
        // 1. Latency probe (3 lightweight requests; take minimum RTT after connection setup)
        onProgress?.('Testing latency...');
        const rttSamples = [];
        for (let i = 0; i < 3; i++) {
            const pingMsg = Soup.Message.new('GET', `${SPEEDTEST_DOWN_URL}?bytes=0`);
            const pingStartUs = GLib.get_monotonic_time();
            await sendAndReadAsync(soupSession, pingMsg, scoped.cancellable);
            const pingElapsedMs = (GLib.get_monotonic_time() - pingStartUs) / 1000;
            const pingStatus = pingMsg.get_status();
            if (pingStatus >= 200 && pingStatus < 300)
                rttSamples.push(pingElapsedMs);
        }
        const latencyMs = rttSamples.length > 0
            ? Math.min(...rttSamples)
            : null;

        // 2. Download throughput (streamed in 64 KB chunks so the payload is not buffered in RAM)
        onProgress?.('Testing download...');
        const downMsg = Soup.Message.new('GET', `${SPEEDTEST_DOWN_URL}?bytes=${SPEEDTEST_DOWNLOAD_BYTES}`);
        const downStream = await sendStreamAsync(soupSession, downMsg, scoped.cancellable);
        const downStatus = downMsg.get_status();
        let totalDownBytes = 0;
        const downStartUs = GLib.get_monotonic_time();
        try {
            if (downStatus < 200 || downStatus >= 300)
                throw new Error(`Download failed (HTTP ${downStatus})`);

            while (true) {
                const chunk = await readBytesAsync(downStream, SPEEDTEST_CHUNK_BYTES, scoped.cancellable);
                const size = chunk ? chunk.get_size() : 0;
                if (size === 0)
                    break;
                totalDownBytes += size;
            }
        } finally {
            try {
                downStream.close(null);
            } catch (_ignored) {
                // Stream may already be closed.
            }
        }
        const downElapsedSec = Math.max((GLib.get_monotonic_time() - downStartUs) / 1_000_000, 0.001);
        const downloadMbps = (totalDownBytes * 8) / (downElapsedSec * 1_000_000);

        // 3. Upload throughput
        onProgress?.('Testing upload...');
        const upMsg = Soup.Message.new('POST', SPEEDTEST_UP_URL);
        const payload = new Uint8Array(SPEEDTEST_UPLOAD_BYTES);
        upMsg.set_request_body_from_bytes('application/octet-stream', GLib.Bytes.new(payload));

        const upStartUs = GLib.get_monotonic_time();
        await sendAndReadAsync(soupSession, upMsg, scoped.cancellable);
        const upElapsedSec = Math.max((GLib.get_monotonic_time() - upStartUs) / 1_000_000, 0.001);
        const upStatus = upMsg.get_status();
        if (upStatus < 200 || upStatus >= 300)
            throw new Error(`Upload failed (HTTP ${upStatus})`);

        const uploadMbps = (SPEEDTEST_UPLOAD_BYTES * 8) / (upElapsedSec * 1_000_000);

        const parts = [
            `↓ ${formatSpeedMbps(downloadMbps)}`,
            `↑ ${formatSpeedMbps(uploadMbps)}`,
        ];
        if (latencyMs !== null)
            parts.push(formatLatency(latencyMs));

        return {
            ok: true,
            downloadMbps,
            uploadMbps,
            latencyMs,
            detail: parts.join(' · '),
            timestamp: new Date(),
        };
    } catch (err) {
        if (cancellable?.is_cancelled() || (!scoped.isTimedOut() && isCancelledError(err)))
            throw err;

        const timedOut = scoped.isTimedOut();
        return {
            ok: false,
            downloadMbps: null,
            uploadMbps: null,
            latencyMs: null,
            detail: timedOut
                ? 'Speed test timed out'
                : `Speed test failed: ${err.message ?? String(err)}`,
            timestamp: new Date(),
        };
    } finally {
        scoped.cleanup();
    }
}

/**
 * Resolve the preferred route-tracing tool available on the host.
 *
 * @returns {{tool: 'mtr'|'traceroute'|'tracepath'|'none', buildArgv: ((target: string) => string[])|null}}
 */
function resolveTraceTool() {
    const mtrPath = GLib.find_program_in_path('mtr');
    if (mtrPath) {
        return {
            tool: 'mtr',
            buildArgv: target => [mtrPath, '-rw', '-c', '10', target],
        };
    }

    const traceroutePath = GLib.find_program_in_path('traceroute');
    if (traceroutePath) {
        return {
            tool: 'traceroute',
            buildArgv: target => [traceroutePath, '-n', '-w', '2', '-q', '2', target],
        };
    }

    const tracepathPath = GLib.find_program_in_path('tracepath');
    if (tracepathPath) {
        return {
            tool: 'tracepath',
            buildArgv: target => [tracepathPath, '-n', target],
        };
    }

    return {tool: 'none', buildArgv: null};
}

/**
 * Run parallel mtr/traceroute captures to the configured DNS targets when an outage is detected.
 *
 * @param {string[]} [targets]
 * @param {string} [reason]
 * @param {Gio.Cancellable|null} [cancellable]
 * @returns {Promise<{timestamp: Date, tool: string, reason: string, traces: Array<{target: string, ok: boolean, output: string, elapsedMs: number}>}>}
 */
export async function runOutageTraces(
    targets = OUTAGE_TRACE_TARGETS,
    reason = '',
    cancellable = null
) {
    const resolved = resolveTraceTool();
    const targetList = Array.isArray(targets) && targets.length > 0
        ? targets
        : OUTAGE_TRACE_TARGETS;

    if (!resolved.buildArgv) {
        return {
            timestamp: new Date(),
            tool: 'none',
            reason,
            traces: targetList.map(target => ({
                target,
                ok: false,
                output: 'Neither mtr, traceroute, nor tracepath is installed',
                elapsedMs: 0,
            })),
        };
    }

    const traces = await Promise.all(targetList.map(async target => {
        const res = await runCommandAsync(resolved.buildArgv(target), {
            timeoutMs: OUTAGE_TRACE_TIMEOUT_MS,
            cancellable,
        });
        const stdout = res.stdout.trimEnd();
        const stderr = res.stderr.trim();
        const output = stdout.length > 0
            ? stdout
            : (stderr || (res.timedOut ? 'Trace timed out' : 'Trace produced no output'));

        return {
            target,
            ok: res.ok && stdout.length > 0,
            output,
            elapsedMs: Math.round(res.elapsedMs),
        };
    }));

    return {
        timestamp: new Date(),
        tool: resolved.tool,
        reason,
        traces,
    };
}

/**
 * Generate a formatted plain-text diagnostic report including live `nmcli device status`.
 *
 * @param {{timestamp: Date, layers: {local: object, wan: object, dns: object, http: object}, diagnosis: {severity: string, message: string, shortBadge: string}}|null} result
 * @param {Gio.Cancellable|null} cancellable
 * @param {{ok: boolean, downloadMbps: number|null, uploadMbps: number|null, latencyMs: number|null, detail: string, timestamp: Date}|null} [speedTestResult]
 * @param {{timestamp: Date, tool: string, reason: string, traces: Array<{target: string, ok: boolean, output: string, elapsedMs: number}>}|null} [outageTrace]
 * @returns {Promise<string>}
 */
export async function generateDiagnosticReport(
    result,
    cancellable = null,
    speedTestResult = null,
    outageTrace = null
) {
    const [nmcliRes, ipRouteRes, ip6RouteRes] = await Promise.all([
        runCommandAsync(['nmcli', 'device', 'status'], {
            timeoutMs: 4000,
            cancellable,
        }),
        runCommandAsync(['ip', 'route'], {
            timeoutMs: 4000,
            cancellable,
        }),
        runCommandAsync(['ip', '-6', 'route', 'show', 'default'], {
            timeoutMs: 4000,
            cancellable,
        }),
    ]);

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

    if (speedTestResult) {
        lines.push(
            '',
            '--- Speed Test (Cloudflare HTTP) ---',
            `Timestamp: ${speedTestResult.timestamp.toISOString()}`,
            `Result   : ${speedTestResult.detail}`
        );
    }

    lines.push('', '--- NetworkManager Device Status ---');
    if (nmcliRes.ok && nmcliRes.stdout.trim().length > 0)
        lines.push(nmcliRes.stdout.trimEnd());
    else
        lines.push(`(nmcli unavailable: ${nmcliRes.stderr.trim() || 'command failed'})`);

    lines.push('', '--- Routing Table (ip route) ---');
    if (ipRouteRes.ok && ipRouteRes.stdout.trim().length > 0)
        lines.push(ipRouteRes.stdout.trimEnd());
    else
        lines.push(`(ip route unavailable: ${ipRouteRes.stderr.trim() || 'command failed'})`);

    if (ip6RouteRes.ok && ip6RouteRes.stdout.trim().length > 0) {
        lines.push('', '--- IPv6 Default Route ---');
        lines.push(ip6RouteRes.stdout.trimEnd());
    }

    if (outageTrace && Array.isArray(outageTrace.traces) && outageTrace.traces.length > 0) {
        lines.push(
            '',
            `--- Outage Route Trace (${outageTrace.tool}) ---`,
            `Captured : ${outageTrace.timestamp.toISOString()}`
        );
        if (outageTrace.reason)
            lines.push(`Trigger  : ${outageTrace.reason}`);
        for (const trace of outageTrace.traces) {
            lines.push('', `[Target: ${trace.target}]`);
            lines.push(trace.output);
        }
    }

    return lines.join('\n');
}
