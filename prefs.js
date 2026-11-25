import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SETTING_KEYS = [
    'check-interval',
    'show-latency-badge',
    'public-ip-target',
    'dns-test-domain',
    'http-endpoint',
    'notify-on-outage',
    'log-rotation-days',
];

export default class NetPulsePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // Keep a strong reference to Gio.Settings for the lifetime of the window
        // so GSettings property bindings are not garbage-collected.
        window._settings = settings;
        window.set_default_size(600, 580);

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        // Group 1: General / Monitoring
        const monitoringGroup = new Adw.PreferencesGroup({
            title: _('General / Monitoring'),
            description: _('Configure diagnostic polling frequency and top bar appearance.'),
        });
        page.add(monitoringGroup);

        const intervalRow = new Adw.SpinRow({
            title: _('Check Interval (seconds)'),
            subtitle: _('Time between automatic diagnostic checks (5–3600 seconds)'),
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 3600,
                step_increment: 5,
                page_increment: 30,
                value: settings.get_int('check-interval'),
            }),
            numeric: true,
        });
        settings.bind(
            'check-interval',
            intervalRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        monitoringGroup.add(intervalRow);

        const latencyBadgeRow = new Adw.SwitchRow({
            title: _('Show Latency Badge in Top Bar'),
            subtitle: _('Display live WAN round-trip latency next to the status icon'),
        });
        settings.bind(
            'show-latency-badge',
            latencyBadgeRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        monitoringGroup.add(latencyBadgeRow);

        // Group 2: Diagnostic Targets
        const targetsGroup = new Adw.PreferencesGroup({
            title: _('Diagnostic Targets'),
            description: _('Endpoints used for WAN ICMP, DNS resolution, and HTTP reachability checks.'),
        });
        page.add(targetsGroup);

        const publicIpRow = new Adw.EntryRow({
            title: _('Public IP Target (WAN ICMP)'),
        });
        settings.bind(
            'public-ip-target',
            publicIpRow,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );
        targetsGroup.add(publicIpRow);

        const dnsDomainRow = new Adw.EntryRow({
            title: _('DNS Test Domain'),
        });
        settings.bind(
            'dns-test-domain',
            dnsDomainRow,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );
        targetsGroup.add(dnsDomainRow);

        const httpEndpointRow = new Adw.EntryRow({
            title: _('HTTP Check Endpoint'),
        });
        settings.bind(
            'http-endpoint',
            httpEndpointRow,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );
        targetsGroup.add(httpEndpointRow);

        // Group 3: Notifications & Logging
        const notificationsLoggingGroup = new Adw.PreferencesGroup({
            title: _('Notifications & Logging'),
            description: _('Configure outage desktop notifications and diagnostic log retention.'),
        });
        page.add(notificationsLoggingGroup);

        const notifyOutageRow = new Adw.SwitchRow({
            title: _('Notify on Network Outage'),
            subtitle: _('Show a desktop notification when a network outage occurs or connectivity recovers'),
        });
        settings.bind(
            'notify-on-outage',
            notifyOutageRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        notificationsLoggingGroup.add(notifyOutageRow);

        const logRotationRow = new Adw.SpinRow({
            title: _('Log Rotation Interval (days)'),
            subtitle: _('Number of days before rotating diagnostic log files (1–90 days)'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 90,
                step_increment: 1,
                page_increment: 7,
                value: settings.get_int('log-rotation-days'),
            }),
            numeric: true,
        });
        settings.bind(
            'log-rotation-days',
            logRotationRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        notificationsLoggingGroup.add(logRotationRow);

        // Group 4: Reset
        const resetGroup = new Adw.PreferencesGroup({
            title: _('Reset'),
        });
        page.add(resetGroup);

        const resetRow = new Adw.ActionRow({
            title: _('Reset to Defaults'),
            subtitle: _('Restore all monitoring options, diagnostic targets, and notification settings to default values'),
        });

        const resetButton = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });

        resetButton.connect('clicked', () => {
            const previous = {
                'check-interval': settings.get_int('check-interval'),
                'show-latency-badge': settings.get_boolean('show-latency-badge'),
                'public-ip-target': settings.get_string('public-ip-target'),
                'dns-test-domain': settings.get_string('dns-test-domain'),
                'http-endpoint': settings.get_string('http-endpoint'),
                'notify-on-outage': settings.get_boolean('notify-on-outage'),
                'log-rotation-days': settings.get_int('log-rotation-days'),
            };

            for (const key of SETTING_KEYS)
                settings.reset(key);

            const toast = new Adw.Toast({
                title: _('Settings reset to defaults'),
                button_label: _('Undo'),
                timeout: 5,
            });
            toast.connect('button-clicked', () => {
                settings.set_int('check-interval', previous['check-interval']);
                settings.set_boolean('show-latency-badge', previous['show-latency-badge']);
                settings.set_string('public-ip-target', previous['public-ip-target']);
                settings.set_string('dns-test-domain', previous['dns-test-domain']);
                settings.set_string('http-endpoint', previous['http-endpoint']);
                settings.set_boolean('notify-on-outage', previous['notify-on-outage']);
                settings.set_int('log-rotation-days', previous['log-rotation-days']);
            });
            window.add_toast(toast);
        });

        resetRow.add_suffix(resetButton);
        resetRow.set_activatable_widget(resetButton);
        resetGroup.add(resetRow);
    }
}
