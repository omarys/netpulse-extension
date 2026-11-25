import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    formatLatency,
    generateDiagnosticReport,
    isCancelledError,
    runDiagnostics,
} from './diagnostics.js';
import {NetPulseLogger} from './logger.js';

const LAYER_DEFINITIONS = [
    {key: 'local', title: 'Local Interface & Gateway'},
    {key: 'wan', title: 'WAN / ISP Routing (ICMP)'},
    {key: 'dns', title: 'DNS Resolution'},
    {key: 'http', title: 'HTTP / Captive Portal'},
];

const STATUS_CLASS_MAP = {
    pass: 'netpulse-status-pass',
    degraded: 'netpulse-status-degraded',
    fail: 'netpulse-status-fail',
    unknown: 'netpulse-status-unknown',
};

const BANNER_CLASS_MAP = {
    pass: 'netpulse-banner-pass',
    degraded: 'netpulse-banner-degraded',
    fail: 'netpulse-banner-fail',
    unknown: 'netpulse-status-unknown',
};

const ICON_NAME_MAP = {
    pass: 'network-transmit-receive-symbolic',
    degraded: 'dialog-warning-symbolic',
    fail: 'network-wired-disconnected-symbolic',
    unknown: 'network-transmit-receive-symbolic',
};

const STATUS_LABEL_MAP = {
    pass: 'PASS',
    degraded: 'DEGRADED',
    fail: 'FAIL',
    unknown: 'PENDING',
};

const NetPulseIndicator = GObject.registerClass(
class NetPulseIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, extension.metadata.name);

        this._extension = extension;
        this._layerWidgets = new Map();

        const panelBox = new St.BoxLayout({
            style_class: 'netpulse-panel-box',
        });

        this._icon = new St.Icon({
            icon_name: ICON_NAME_MAP.unknown,
            style_class: `system-status-icon ${STATUS_CLASS_MAP.unknown}`,
        });
        panelBox.add_child(this._icon);

        this._panelLabel = new St.Label({
            text: '...',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: `netpulse-panel-label ${STATUS_CLASS_MAP.unknown}`,
        });
        panelBox.add_child(this._panelLabel);

        this.add_child(panelBox);

        this._buildMenu();
    }

    _buildMenu() {
        // Root-Cause Diagnosis Banner
        const bannerItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._bannerBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: `netpulse-banner ${BANNER_CLASS_MAP.unknown}`,
        });
        this._bannerLabel = new St.Label({
            text: 'Running initial network diagnostics...',
            x_expand: true,
        });
        this._bannerLabel.clutter_text.line_wrap = true;
        this._bannerBox.add_child(this._bannerLabel);
        bannerItem.add_child(this._bannerBox);
        this.menu.addMenuItem(bannerItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // 4 Diagnostic Layer Rows
        for (const def of LAYER_DEFINITIONS) {
            const rowItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
            });

            const rowBox = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: 'netpulse-layer-row',
            });

            const headerBox = new St.BoxLayout({
                x_expand: true,
            });

            const titleLabel = new St.Label({
                text: def.title,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'netpulse-layer-title',
            });

            const badgeLabel = new St.Label({
                text: STATUS_LABEL_MAP.unknown,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: `netpulse-layer-badge ${STATUS_CLASS_MAP.unknown}`,
            });

            headerBox.add_child(titleLabel);
            headerBox.add_child(badgeLabel);

            const detailLabel = new St.Label({
                text: 'Waiting for first check...',
                x_expand: true,
                style_class: 'netpulse-layer-detail',
            });
            detailLabel.clutter_text.line_wrap = true;

            rowBox.add_child(headerBox);
            rowBox.add_child(detailLabel);
            rowItem.add_child(rowBox);
            this.menu.addMenuItem(rowItem);

            this._layerWidgets.set(def.key, {
                badgeLabel,
                detailLabel,
            });
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Last-checked timestamp
        const timestampItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._timestampLabel = new St.Label({
            text: 'Last checked: Never',
            x_expand: true,
            style_class: 'netpulse-layer-detail',
        });
        timestampItem.add_child(this._timestampLabel);
        this.menu.addMenuItem(timestampItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Action buttons
        this._runNowItem = new PopupMenu.PopupMenuItem('Run Diagnostics Now');
        this._runNowItem.connect('activate', () => {
            this._extension.triggerDiagnosticsNow();
        });
        this.menu.addMenuItem(this._runNowItem);

        this._copyReportItem = new PopupMenu.PopupMenuItem('Copy Diagnostic Report');
        this._copyReportItem.connect('activate', () => {
            this._extension.copyDiagnosticReport();
        });
        this.menu.addMenuItem(this._copyReportItem);

        this._prefsItem = new PopupMenu.PopupMenuItem('Preferences');
        this._prefsItem.connect('activate', () => {
            this._extension.openPreferences();
        });
        this.menu.addMenuItem(this._prefsItem);
    }

    setBadgeVisible(visible) {
        this._panelLabel.visible = visible;
    }

    setRunning(isRunning) {
        this._runNowItem.setSensitive(!isRunning);
        this._runNowItem.label.text = isRunning
            ? 'Running Diagnostics...'
            : 'Run Diagnostics Now';
    }

    setCopyFeedback(text) {
        this._copyReportItem.label.text = text;
    }

    updateFromResult(result) {
        const {diagnosis, layers, timestamp} = result;
        const severity = diagnosis.severity in STATUS_CLASS_MAP
            ? diagnosis.severity
            : 'unknown';

        const statusClass = STATUS_CLASS_MAP[severity];
        const bannerClass = BANNER_CLASS_MAP[severity];

        this._icon.icon_name = ICON_NAME_MAP[severity];
        this._icon.style_class = `system-status-icon ${statusClass}`;

        this._panelLabel.text = diagnosis.shortBadge;
        this._panelLabel.style_class = `netpulse-panel-label ${statusClass}`;

        this._bannerBox.style_class = `netpulse-banner ${bannerClass}`;
        this._bannerLabel.text = diagnosis.message;

        for (const def of LAYER_DEFINITIONS) {
            const widget = this._layerWidgets.get(def.key);
            const layer = layers[def.key];
            if (!widget || !layer)
                continue;

            const layerStatus = layer.status in STATUS_CLASS_MAP
                ? layer.status
                : 'unknown';
            const badgeText = layer.latencyMs !== null
                ? `${STATUS_LABEL_MAP[layerStatus]} · ${formatLatency(layer.latencyMs)}`
                : STATUS_LABEL_MAP[layerStatus];

            widget.badgeLabel.text = badgeText;
            widget.badgeLabel.style_class = `netpulse-layer-badge ${STATUS_CLASS_MAP[layerStatus]}`;
            widget.detailLabel.text = layer.detail;
        }

        const timeText = timestamp.toLocaleTimeString();
        this._timestampLabel.text = `Last checked: ${timeText}`;
    }
});

export default class NetPulseExtension extends Extension {
    enable() {
        this._isEnabled = true;
        this._isRunning = false;
        this._lastResult = null;
        this._lastNotifiedSeverity = null;
        this._lastNotifiedReason = null;
        this._timerId = 0;
        this._copyFeedbackTimerId = 0;
        this._settingsHandlerIds = [];

        this._settings = this.getSettings();
        this._cancellable = new Gio.Cancellable();
        this._soupSession = new Soup.Session({timeout: 5});
        this._logger = new NetPulseLogger({
            rotationDays: this._settings.get_int('log-rotation-days'),
        });

        this._indicator = new NetPulseIndicator(this);
        this._indicator.setBadgeVisible(this._settings.get_boolean('show-latency-badge'));
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._connectSettings();
        this._scheduleTimer();
        this.triggerDiagnosticsNow();
    }

    disable() {
        this._isEnabled = false;

        if (this._timerId !== 0) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }

        if (this._copyFeedbackTimerId !== 0) {
            GLib.Source.remove(this._copyFeedbackTimerId);
            this._copyFeedbackTimerId = 0;
        }

        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        if (this._soupSession) {
            this._soupSession.abort();
            this._soupSession = null;
        }

        this._logger?.destroy();
        this._logger = null;

        if (this._settings) {
            for (const id of this._settingsHandlerIds)
                this._settings.disconnect(id);
            this._settingsHandlerIds = [];
            this._settings = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._lastResult = null;
        this._lastNotifiedSeverity = null;
        this._lastNotifiedReason = null;
        this._isRunning = false;
    }

    _connectSettings() {
        const onIntervalChanged = this._settings.connect('changed::check-interval', () => {
            this._scheduleTimer();
        });

        const onShowBadgeChanged = this._settings.connect('changed::show-latency-badge', () => {
            if (this._indicator)
                this._indicator.setBadgeVisible(this._settings.get_boolean('show-latency-badge'));
        });

        const onLogRotationDaysChanged = this._settings.connect('changed::log-rotation-days', () => {
            if (this._logger && this._settings)
                this._logger.setRotationDays(this._settings.get_int('log-rotation-days'));
        });

        const onTargetChanged = () => {
            this.triggerDiagnosticsNow();
        };

        const onPublicIpChanged = this._settings.connect('changed::public-ip-target', onTargetChanged);
        const onDnsChanged = this._settings.connect('changed::dns-test-domain', onTargetChanged);
        const onHttpChanged = this._settings.connect('changed::http-endpoint', onTargetChanged);

        this._settingsHandlerIds.push(
            onIntervalChanged,
            onShowBadgeChanged,
            onLogRotationDaysChanged,
            onPublicIpChanged,
            onDnsChanged,
            onHttpChanged
        );
    }

    _scheduleTimer() {
        if (this._timerId !== 0) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }

        if (!this._isEnabled || !this._settings)
            return;

        const interval = Math.max(5, this._settings.get_int('check-interval'));
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            if (!this._isEnabled) {
                this._timerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this.triggerDiagnosticsNow();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _readConfig() {
        return {
            publicIpTarget: this._settings.get_string('public-ip-target'),
            dnsTestDomain: this._settings.get_string('dns-test-domain'),
            httpEndpoint: this._settings.get_string('http-endpoint'),
        };
    }

    _handleOutageNotification(result) {
        const diagnosis = result?.diagnosis;
        if (!diagnosis)
            return;

        const notifyEnabled = this._settings ? this._settings.get_boolean('notify-on-outage') : false;

        if (diagnosis.severity === 'fail') {
            if (this._lastNotifiedSeverity !== 'fail' || this._lastNotifiedReason !== diagnosis.message) {
                if (notifyEnabled)
                    Main.notify('NetPulse: Network Outage Detected', diagnosis.message);
                this._lastNotifiedSeverity = 'fail';
                this._lastNotifiedReason = diagnosis.message;
            }
        } else if (diagnosis.severity === 'pass' && this._lastNotifiedSeverity === 'fail') {
            if (notifyEnabled)
                Main.notify('NetPulse: Connection Restored', diagnosis.message);
            this._lastNotifiedSeverity = 'pass';
            this._lastNotifiedReason = null;
        } else if (diagnosis.severity === 'degraded' && this._lastNotifiedSeverity !== 'fail') {
            this._lastNotifiedSeverity = 'degraded';
            this._lastNotifiedReason = null;
        }
    }

    triggerDiagnosticsNow() {
        if (!this._isEnabled || this._isRunning || !this._settings || !this._soupSession)
            return;

        this._isRunning = true;
        this._indicator?.setRunning(true);

        const config = this._readConfig();
        const cancellable = this._cancellable;
        const soupSession = this._soupSession;

        runDiagnostics(config, soupSession, cancellable)
            .then(result => {
                if (!this._isEnabled || !this._indicator)
                    return;
                this._lastResult = result;
                this._indicator.updateFromResult(result);
                this._handleOutageNotification(result);
                if (this._logger) {
                    this._logger.logDiagnostic(result).catch(err => {
                        if (!isCancelledError(err))
                            console.error('[NetPulse] Failed to write diagnostic log:', err);
                    });
                }
            })
            .catch(err => {
                if (!isCancelledError(err))
                    console.error('[NetPulse] Diagnostics failed:', err);
            })
            .finally(() => {
                this._isRunning = false;
                if (this._isEnabled && this._indicator)
                    this._indicator.setRunning(false);
            });
    }

    copyDiagnosticReport() {
        if (!this._isEnabled || !this._cancellable)
            return;

        generateDiagnosticReport(this._lastResult, this._cancellable)
            .then(report => {
                if (!this._isEnabled || !this._indicator)
                    return;

                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, report);
                this._indicator.setCopyFeedback('Copied Diagnostic Report');

                if (this._copyFeedbackTimerId !== 0) {
                    GLib.Source.remove(this._copyFeedbackTimerId);
                    this._copyFeedbackTimerId = 0;
                }

                this._copyFeedbackTimerId = GLib.timeout_add_seconds(
                    GLib.PRIORITY_DEFAULT,
                    2,
                    () => {
                        this._copyFeedbackTimerId = 0;
                        if (this._isEnabled && this._indicator)
                            this._indicator.setCopyFeedback('Copy Diagnostic Report');
                        return GLib.SOURCE_REMOVE;
                    }
                );
            })
            .catch(err => {
                if (!isCancelledError(err))
                    console.error('[NetPulse] Failed to generate diagnostic report:', err);
            });
    }
}
