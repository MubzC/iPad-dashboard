(function () {
    "use strict";

    var STORAGE_KEY = "livingRoomDashboardSettings";

    var DEFAULTS = {
        themeMode: "auto",
        themeColour: "warm",
        baqarahEnabled: "on",
        yaseenEnabled: "on",
        kahfEnabled: "on",
        baqarahNarrator: "mishary",
        yaseenNarrator: "mishary",
        kahfNarrator: "mishary"
    };

    var PALETTES = {
        warm: {
            night: {
                bg: "#191714", panel: "#26221D", text: "#F3EBDD",
                muted: "#B4A895", accent: "#D2B477",
                border: "#40372B", highlight: "#352C20"
            },
            day: {
                bg: "#F5F0E6", panel: "#EAE1D2", text: "#39342D",
                muted: "#898071", accent: "#A98545",
                border: "#DCD0BC", highlight: "#E9DFC9"
            }
        },
        ocean: {
            night: {
                bg: "#111B25", panel: "#1B2B39", text: "#E7F0F7",
                muted: "#A7BECE", accent: "#83B8E0",
                border: "#304657", highlight: "#22394A"
            },
            day: {
                bg: "#EAF2F7", panel: "#DCE8F0", text: "#263B4B",
                muted: "#718899", accent: "#477FA8",
                border: "#C4D6E3", highlight: "#D4E5F0"
            }
        },
        forest: {
            night: {
                bg: "#151F18", panel: "#1F3024", text: "#E8EFE5",
                muted: "#B1C0AD", accent: "#9AB88A",
                border: "#354839", highlight: "#293D2D"
            },
            day: {
                bg: "#EDF2E9", panel: "#DDE7D7", text: "#344437",
                muted: "#788875", accent: "#547B4E",
                border: "#C7D5C0", highlight: "#D6E4D0"
            }
        },
        plum: {
            night: {
                bg: "#1C1722", panel: "#292033", text: "#F0EAF6",
                muted: "#C2B2D0", accent: "#C2A4E5",
                border: "#44364F", highlight: "#352941"
            },
            day: {
                bg: "#F1ECF6", panel: "#E5DCEC", text: "#403348",
                muted: "#887994", accent: "#8663A9",
                border: "#D6C9E0", highlight: "#E3D7EE"
            }
        },
        teal: {
            night: {
                bg: "#121F1F", panel: "#192A2A", text: "#E5F2EF",
                muted: "#AAC9C3", accent: "#80C7BE",
                border: "#304746", highlight: "#223A38"
            },
            day: {
                bg: "#EAF4F1", panel: "#D9EAE5", text: "#304A46",
                muted: "#738F88", accent: "#398B80",
                border: "#C4DCD5", highlight: "#D1E8E1"
            }
        },
        rose: {
            night: {
                bg: "#211719", panel: "#302124", text: "#F5E9E9",
                muted: "#D0B3B3", accent: "#D9A0A4",
                border: "#4C3438", highlight: "#3C282D"
            },
            day: {
                bg: "#F7EEEE", panel: "#EEDDDD", text: "#4B3437",
                muted: "#947579", accent: "#AD6872",
                border: "#E0C7C9", highlight: "#F0DCDC"
            }
        }
    };

    var SETTINGS_FIELDS = {
        "theme-mode": "themeMode",
        "theme-colour": "themeColour",
        "audio-baqarah-enabled": "baqarahEnabled",
        "audio-yaseen-enabled": "yaseenEnabled",
        "audio-kahf-enabled": "kahfEnabled",
        "narrator-baqarah": "baqarahNarrator",
        "narrator-yaseen": "yaseenNarrator",
        "narrator-kahf": "kahfNarrator"
    };

    var settings = {};
    var modal;
    var status;
    var app;
    var rotationWasPaused = false;

    function byId(id) {
        return document.getElementById(id);
    }

    function loadSettings() {
        var saved = null;

        try {
            saved = window.localStorage.getItem(STORAGE_KEY);
        } catch (error) {
            saved = null;
        }

        settings = {};

        for (var key in DEFAULTS) {
            if (DEFAULTS.hasOwnProperty(key)) {
                settings[key] = DEFAULTS[key];
            }
        }

        if (saved) {
            try {
                var parsed = JSON.parse(saved);

                for (var savedKey in DEFAULTS) {
                    if (DEFAULTS.hasOwnProperty(savedKey) &&
                        parsed[savedKey] !== undefined) {
                        settings[savedKey] = parsed[savedKey];
                    }
                }
            } catch (error) {
                console.log("Could not read saved settings:", error);
            }
        }
    }

    function saveSettings() {
        try {
            window.localStorage.setItem(
                STORAGE_KEY,
                JSON.stringify(settings)
            );

            if (status) {
                status.innerHTML = "Settings saved.";
            }
        } catch (error) {
            if (status) {
                status.innerHTML =
                    "Unable to save settings in this browser.";
            }
        }

        applySettings();
    }

    function populateControls() {
        for (var id in SETTINGS_FIELDS) {
            if (SETTINGS_FIELDS.hasOwnProperty(id)) {
                var field = byId(id);
                var key = SETTINGS_FIELDS[id];

                if (field) {
                    field.value = settings[key];
                }
            }
        }
    }

    function applyPalette() {
        var themeName = settings.themeColour || "warm";
        var palette = PALETTES[themeName] || PALETTES.warm;
        var mode = document.body.className.indexOf("day") !== -1
            ? "day"
            : "night";
        var colours = palette[mode];

        for (var key in colours) {
            if (colours.hasOwnProperty(key)) {
                document.body.style.setProperty(
                    "--" + key,
                    colours[key]
                );
            }
        }
    }



    function applySettings() {
        window.DashboardSettings = settings;

        if (settings.themeMode === "day") {
            document.body.className = "day";
        } else if (settings.themeMode === "night") {
            document.body.className = "";
        } else if (typeof window.updateDashboardTheme === "function") {
            window.updateDashboardTheme();
        }

        applyPalette();
    }

    window.applyDashboardPalette = applyPalette;

    function openModal(event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }

        modal.className = "settings-overlay open";
        modal.setAttribute("aria-hidden", "false");

        /*
         * Prevent clicks in the modal from changing dashboard pages.
         */
        rotationWasPaused = true;
    }

    function closeModal(event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }

        modal.className = "settings-overlay";
        modal.setAttribute("aria-hidden", "true");
        rotationWasPaused = false;
    }

    function handleFieldChange(event) {
        var id = event.target.id;
        var key = SETTINGS_FIELDS[id];

        if (!key) {
            return;
        }

        settings[key] = event.target.value;
        saveSettings();
    }

    function init() {
        modal = byId("settings-modal");
        status = byId("settings-status");
        app = byId("app");

        if (!modal || !app) {
            return;
        }

        loadSettings();
        populateControls();
        applySettings();

        var buttons = document.querySelectorAll(".settings-button");

        for (var i = 0; i < buttons.length; i++) {
            buttons[i].addEventListener("click", openModal, false);
            buttons[i].addEventListener("touchend", function (event) {
                event.preventDefault();
                event.stopPropagation();
                openModal(event);
            }, false);
        }

        byId("settings-close").addEventListener(
            "click",
            closeModal,
            false
        );

        byId("settings-close").addEventListener(
            "touchend",
            function (event) {
                event.preventDefault();
                event.stopPropagation();
                closeModal(event);
            },
            false
        );

        modal.addEventListener("click", function (event) {
            event.stopPropagation();

            if (event.target === modal) {
                closeModal(event);
            }
        }, false);

        modal.addEventListener("touchend", function (event) {
            event.stopPropagation();
        }, false);

        for (var fieldId in SETTINGS_FIELDS) {
            if (SETTINGS_FIELDS.hasOwnProperty(fieldId)) {
                byId(fieldId).addEventListener(
                    "change",
                    handleFieldChange,
                    false
                );
            }
        }

        /*
         * Let dashboard.js check whether page rotation should pause
         * while the modal is open.
         */
        window.isSettingsModalOpen = function () {
            return rotationWasPaused;
        };
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init, false);
    } else {
        init();
    }
})();