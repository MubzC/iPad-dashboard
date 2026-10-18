// ---------------------------------------------------------
// SERVER-SIDE DIAGNOSTICS
// ---------------------------------------------------------

function audioDebug(message) {
    try {
        var xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/audio-debug", true);
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.send(JSON.stringify({
            message: String(message),
            time: new Date().toISOString()
        }));
    } catch (error) {
        // Diagnostics must never interrupt playback.
    }
}

function describeMediaError(player) {
    if (!player || !player.error) {
        return "No MediaError details available";
    }

    var error = player.error;
    var descriptions = {
        1: "MEDIA_ERR_ABORTED",
        2: "MEDIA_ERR_NETWORK",
        3: "MEDIA_ERR_DECODE",
        4: "MEDIA_ERR_SRC_NOT_SUPPORTED"
    };

    return "code=" + error.code + "; message=" +
        (error.message || descriptions[error.code] || "Unknown");
}

function getMediaState(player) {
    if (!player) {
        return "player=null";
    }

    var networkStates = [
        "NETWORK_EMPTY",
        "NETWORK_IDLE",
        "NETWORK_LOADING",
        "NETWORK_NO_SOURCE"
    ];

    var readyStates = [
        "HAVE_NOTHING",
        "HAVE_METADATA",
        "HAVE_CURRENT_DATA",
        "HAVE_FUTURE_DATA",
        "HAVE_ENOUGH_DATA"
    ];

    return "networkState=" +
        (networkStates[player.networkState] || player.networkState) +
        "; readyState=" +
        (readyStates[player.readyState] || player.readyState) +
        "; paused=" + player.paused +
        "; currentTime=" + player.currentTime +
        "; duration=" + player.duration +
        "; currentSrc=" + (player.currentSrc || player.src || "none");
}

// ---------------------------------------------------------
// AUDIO STATE
// ---------------------------------------------------------

var audioPlayer = null;
var audioContext = null;
var beepOscillator = null;
var beepGain = null;
var beepTimer = null;

var scheduleTimer = null;
var activeSequence = null;
var sequenceToken = 0;
var trackStartTimer = null;

var CHECK_INTERVAL = 5000;
var RECOVERY_WINDOW_MINUTES = 10;

var TEST_SCHEDULE_ENABLED = false;
var TEST_SCHEDULE_TIME = new Date(Date.now() + 60000);

var PLAYBACK_START_TIMEOUT_MS = 20000;

var SETTINGS_STORAGE_KEY = "livingRoomDashboardSettings";
var SCHEDULE_STORAGE_KEY = "livingRoomDashboardAudioSchedule";

var trackLabels = {
    baqarah: "Surah Al-Baqarah",
    yaseen: "Surah Yaseen",
    kahf: "Surah Al-Kahf"
};

// Short silent WAV used to prime the HTML audio element.
var SILENT_WAV =
    "data:audio/wav;base64," +
    "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

// ---------------------------------------------------------
// GENERAL HELPERS
// ---------------------------------------------------------

function byId(id) {
    return document.getElementById(id);
}

function setStatus(message) {
    var status = byId("audio-test-status");

    if (status) {
        status.textContent = message;
    }

    audioDebug("STATUS: " + message);

    if (window.console && window.console.log) {
        console.log("[Dashboard Audio] " + message);
    }
}

function getSettings() {
    if (window.DashboardSettings) {
        return window.DashboardSettings;
    }

    try {
        var saved = window.localStorage.getItem(SETTINGS_STORAGE_KEY);

        if (saved) {
            return JSON.parse(saved);
        }
    } catch (error) {
        audioDebug("Could not read settings: " + error.message);
    }

    return {};
}

function settingIsEnabled(value) {
    return value !== false && value !== "off" && value !== 0;
}

function isEnabled(settingName) {
    var settings = getSettings();

    if (settings[settingName] === undefined) {
        return true;
    }

    return settingIsEnabled(settings[settingName]);
}

function isTrackEnabled(track) {
    var settings = getSettings();

    if (track === "kahf") {
        if (settings.kahfEnabled !== undefined) {
            return settingIsEnabled(settings.kahfEnabled);
        }

        return true;
    }

    return isEnabled(track + "Enabled");
}

function getNarrator(track) {
    var settings = getSettings();

    if (track === "kahf") {
        return settings.kahfNarrator ||
            "mishary";
    }

    return settings[track + "Narrator"] || "mishary";
}

function getAudioSource(track) {
    var settings = getSettings();

    var sourceTrack = track;
    var narrator = getNarrator(sourceTrack);

    if (!narrator) {
        audioDebug("No narrator configured for " + sourceTrack);
        return null;
    }

    return "audio/quran/" + sourceTrack + "-" + narrator + ".mp3";
}

function clearTrackStartTimer() {
    if (trackStartTimer !== null) {
        window.clearTimeout(trackStartTimer);
        trackStartTimer = null;
    }
}

// ---------------------------------------------------------
// DATE HELPERS
// ---------------------------------------------------------

function padTwoDigits(value) {
    value = String(value);
    return value.length < 2 ? "0" + value : value;
}

function getLocalDateKey(date) {
    return date.getFullYear() + "-" +
        padTwoDigits(date.getMonth() + 1) + "-" +
        padTwoDigits(date.getDate());
}

// ---------------------------------------------------------
// SCHEDULE HISTORY
// ---------------------------------------------------------

function getScheduleHistory() {
    try {
        return JSON.parse(
            window.localStorage.getItem(SCHEDULE_STORAGE_KEY) || "{}"
        );
    } catch (error) {
        audioDebug("Could not read schedule history: " + error.message);
        return {};
    }
}

function markScheduleRun(scheduleId) {
    var history = getScheduleHistory();
    history[scheduleId] = new Date().toISOString();

    try {
        window.localStorage.setItem(
            SCHEDULE_STORAGE_KEY,
            JSON.stringify(history)
        );
    } catch (error) {
        audioDebug("Could not save schedule history: " + error.message);
    }
}

// ---------------------------------------------------------
// STOP AUDIO
// ---------------------------------------------------------

function stopBeep() {
    if (beepTimer !== null) {
        window.clearTimeout(beepTimer);
        beepTimer = null;
    }

    if (beepOscillator) {
        try {
            if (typeof beepOscillator.stop === "function") {
                beepOscillator.stop();
            } else if (typeof beepOscillator.noteOff === "function") {
                beepOscillator.noteOff(0);
            }
        } catch (error) {
            // Oscillator may already have stopped.
        }

        beepOscillator = null;
        beepGain = null;
    }
}

function stopAudio(updateMessage) {
    sequenceToken++;
    activeSequence = null;

    clearTrackStartTimer();
    stopBeep();

    if (audioPlayer) {
        try {
            audioPlayer.pause();
            audioPlayer.currentTime = 0;
        } catch (error) {
            audioDebug("Error stopping audio: " + error.message);
        }
    }

    if (updateMessage !== false) {
        setStatus("Audio stopped.");
    }
}

// ---------------------------------------------------------
// TEST BEEP
// ---------------------------------------------------------

function playBeep() {
    stopAudio(false);

    var AudioContextClass =
        window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) {
        setStatus("Beep testing is not supported by this browser.");
        return;
    }

    try {
        audioContext = audioContext || new AudioContextClass();

        function startBeep() {
            stopBeep();

            beepOscillator = audioContext.createOscillator();
            beepGain = audioContext.createGain();

            beepOscillator.type = "sine";
            beepOscillator.frequency.value = 880;
            beepGain.gain.value = 0.15;

            beepOscillator.connect(beepGain);
            beepGain.connect(audioContext.destination);

            if (typeof beepOscillator.start === "function") {
                beepOscillator.start(0);
            } else if (typeof beepOscillator.noteOn === "function") {
                beepOscillator.noteOn(0);
            }

            setStatus("Playing test beep...");

            beepTimer = window.setTimeout(function () {
                stopBeep();
                setStatus("Test beep finished.");
            }, 500);
        }

        if (
            audioContext.state === "suspended" &&
            typeof audioContext.resume === "function"
        ) {
            var resumeResult = audioContext.resume();

            if (resumeResult && typeof resumeResult.then === "function") {
                resumeResult.then(startBeep, function (error) {
                    audioDebug("Beep resume failed: " + error.message);
                    setStatus("Unable to start the beep. Tap Test Beep again.");
                });
            } else {
                startBeep();
            }
        } else {
            startBeep();
        }
    } catch (error) {
        stopBeep();
        setStatus("Unable to play the test beep.");
        audioDebug("Beep error: " + error.message);
    }
}

// ---------------------------------------------------------
// INITIALISE PERSISTENT AUDIO PLAYER
// ---------------------------------------------------------

function initialiseScheduledAudio() {
    if (!audioPlayer) {
        audioDebug("Creating persistent audio player.");

        audioPlayer = document.createElement("audio");
        audioPlayer.id = "dashboard-audio-player";
        audioPlayer.preload = "auto";

        audioPlayer.setAttribute("playsinline", "true");
        audioPlayer.setAttribute("webkit-playsinline", "true");

        audioPlayer.style.display = "none";

        audioPlayer.addEventListener("loadstart", function () {
            audioDebug("MEDIA EVENT: loadstart; " + getMediaState(audioPlayer));
        }, false);

        audioPlayer.addEventListener("loadedmetadata", function () {
            audioDebug("MEDIA EVENT: loadedmetadata; " + getMediaState(audioPlayer));
        }, false);

        audioPlayer.addEventListener("loadeddata", function () {
            audioDebug("MEDIA EVENT: loadeddata; " + getMediaState(audioPlayer));
        }, false);

        audioPlayer.addEventListener("canplay", function () {
            audioDebug("MEDIA EVENT: canplay; " + getMediaState(audioPlayer));
        }, false);

        audioPlayer.addEventListener("canplaythrough", function () {
            audioDebug("MEDIA EVENT: canplaythrough; " + getMediaState(audioPlayer));
        }, false);

        audioPlayer.addEventListener("playing", function () {
            clearTrackStartTimer();
            audioDebug("MEDIA EVENT: playing; " + getMediaState(audioPlayer));
        }, false);

        audioPlayer.addEventListener("pause", function () {
            audioDebug("MEDIA EVENT: pause; " + getMediaState(audioPlayer));
        }, false);

        audioPlayer.addEventListener("waiting", function () {
            audioDebug("MEDIA EVENT: waiting; " + getMediaState(audioPlayer));
        }, false);

        audioPlayer.addEventListener("stalled", function () {
            audioDebug("MEDIA EVENT: stalled; " + getMediaState(audioPlayer));
        }, false);

        audioPlayer.addEventListener("suspend", function () {
            audioDebug("MEDIA EVENT: suspend; " + getMediaState(audioPlayer));
        }, false);

        audioPlayer.addEventListener("abort", function () {
            audioDebug("MEDIA EVENT: abort; " + getMediaState(audioPlayer));
        }, false);

        audioPlayer.addEventListener("emptied", function () {
            audioDebug("MEDIA EVENT: emptied; " + getMediaState(audioPlayer));
        }, false);

        audioPlayer.addEventListener("ended", function () {
            audioDebug("MEDIA EVENT: ended; " + getMediaState(audioPlayer));
        }, false);

        audioPlayer.addEventListener("error", function () {
            audioDebug(
                "MEDIA EVENT: error; " +
                describeMediaError(audioPlayer) +
                "; " + getMediaState(audioPlayer)
            );
        }, false);

        document.body.appendChild(audioPlayer);
    }

    var AudioContextClass =
        window.AudioContext || window.webkitAudioContext;

    if (AudioContextClass && !audioContext) {
        try {
            audioContext = new AudioContextClass();
            audioDebug("AudioContext created.");
        } catch (error) {
            audioDebug("AudioContext unavailable: " + error.message);
        }
    }

    return audioPlayer;
}

// ---------------------------------------------------------
// PRIME AUDIO DURING THE OVERLAY USER INTERACTION
// ---------------------------------------------------------

function primeAudioPlayer() {
    var player = initialiseScheduledAudio();

    if (!player) {
        audioDebug("AUDIO PRIME FAILED: player unavailable.");
        return;
    }

    try {
        player.pause();
        player.src = SILENT_WAV;
        player.load();

        audioDebug(
            "AUDIO PRIME ATTEMPTED; " + getMediaState(player)
        );

        var result = player.play();

        if (result && typeof result.then === "function") {
            result.then(function () {
                audioDebug(
                    "AUDIO PRIME PLAY ACCEPTED; " +
                    getMediaState(player)
                );

                /*
                 * Wait until the play request has been accepted
                 * before cleaning up the silent source.
                 */
                window.setTimeout(function () {
                    try {
                        player.pause();
                        player.removeAttribute("src");
                        player.load();

                        audioDebug("AUDIO PRIME COMPLETE.");
                    } catch (error) {
                        audioDebug(
                            "AUDIO PRIME CLEANUP ERROR: " +
                            error.message
                        );
                    }
                }, 100);
            }, function (error) {
                audioDebug(
                    "AUDIO PRIME REJECTED: " +
                    error.name + " - " + error.message
                );
            });
        } else {
            /*
             * Older Safari may return no Promise.
             * The media events below provide the diagnostic evidence.
             */
            audioDebug("AUDIO PRIME: play() returned no Promise.");
        }
    } catch (error) {
        audioDebug(
            "AUDIO PRIME ERROR: " +
            error.name + " - " + error.message
        );
    }

    /*
     * Attempt to initialise Web Audio during the same user gesture.
     * This is primarily for the beep feature.
     */
    if (audioContext) {
        try {
            if (
                audioContext.state === "suspended" &&
                typeof audioContext.resume === "function"
            ) {
                var resumeResult = audioContext.resume();

                if (resumeResult && typeof resumeResult.then === "function") {
                    resumeResult.then(function () {
                        audioDebug("AUDIO CONTEXT RESUMED.");
                    }, function (error) {
                        audioDebug(
                            "AUDIO CONTEXT RESUME FAILED: " +
                            error.message
                        );
                    });
                }
            }
        } catch (error) {
            audioDebug("AudioContext prime failed: " + error.message);
        }
    }
}

// ---------------------------------------------------------
// PLAY AUDIO SEQUENCE
// ---------------------------------------------------------

function playSequence(tracks, description) {
    audioDebug(
        "playSequence called. Description=" + description +
        "; tracks=" + tracks.join(",")
    );

    stopAudio(false);

    var thisSequenceToken = sequenceToken;
    var index = 0;

    if (!audioPlayer) {
        initialiseScheduledAudio();
    }

    var player = audioPlayer;

    if (!player) {
        audioDebug("ERROR: Audio player unavailable.");
        setStatus("Audio player could not be initialised.");
        return;
    }

    activeSequence = { description: description };

    function playNextTrack() {
        if (thisSequenceToken !== sequenceToken) {
            audioDebug("Sequence cancelled before next track.");
            return;
        }

        clearTrackStartTimer();

        if (index >= tracks.length) {
            activeSequence = null;
            audioDebug("Sequence completed: " + description);
            setStatus(description + " completed.");
            return;
        }

        var track = tracks[index++];
        var source = getAudioSource(track);

        if (!source) {
            audioDebug("No usable audio source for " + track);
            playNextTrack();
            return;
        }

        var hasStarted = false;

        audioDebug(
            "Preparing track: " + track + "; source=" + source
        );

        player.onplaying = function () {
            if (thisSequenceToken !== sequenceToken) {
                return;
            }

            hasStarted = true;
            clearTrackStartTimer();

            audioDebug(
                "PLAYING event received for " + track +
                "; " + getMediaState(player)
            );

            setStatus(
                description + ": playing " +
                (trackLabels[track] || track) + "."
            );
        };

        player.onended = function () {
            if (thisSequenceToken !== sequenceToken) {
                return;
            }

            clearTrackStartTimer();
            audioDebug("Track ended: " + track);
            playNextTrack();
        };

        player.onerror = function () {
            if (thisSequenceToken !== sequenceToken) {
                return;
            }

            clearTrackStartTimer();
            activeSequence = null;

            audioDebug(
                "TRACK ERROR for " + track +
                "; " + describeMediaError(player) +
                "; " + getMediaState(player)
            );

            setStatus(
                "Unable to play " +
                (trackLabels[track] || track) +
                ". Check the server log."
            );
        };

        player.onabort = function () {
            if (thisSequenceToken === sequenceToken) {
                audioDebug("TRACK ABORT for " + track);
            }
        };

        player.onstalled = function () {
            if (thisSequenceToken === sequenceToken) {
                audioDebug("TRACK STALLED for " + track);
            }
        };

        player.onwaiting = function () {
            if (thisSequenceToken === sequenceToken) {
                audioDebug("TRACK WAITING for " + track);
            }
        };

        try {
            player.pause();
            player.removeAttribute("src");
            player.load();
        } catch (resetError) {
            audioDebug("Player reset warning: " + resetError.message);
        }

        player.src = source;

        setStatus("Loading " + (trackLabels[track] || track) + "...");

        audioDebug(
            "Source assigned for " + track +
            "; " + getMediaState(player)
        );

        trackStartTimer = window.setTimeout(function () {
            if (
                thisSequenceToken !== sequenceToken ||
                hasStarted
            ) {
                return;
            }

            audioDebug(
                "PLAYBACK START TIMEOUT after " +
                PLAYBACK_START_TIMEOUT_MS +
                "ms for " + track +
                "; " + describeMediaError(player) +
                "; " + getMediaState(player)
            );

            /*
             * Retry once only if enough media data is available.
             * This does not guarantee that Safari will allow playback.
             */
            if (player.readyState >= 2) {
                audioDebug("Attempting one playback retry for " + track);

                try {
                    var retryResult = player.play();

                    if (
                        retryResult &&
                        typeof retryResult.then === "function"
                    ) {
                        retryResult.then(function () {
                            audioDebug("Retry accepted for " + track);
                        }, function (error) {
                            audioDebug(
                                "Retry rejected for " + track +
                                ": " + error.name + " - " + error.message
                            );
                        });
                    }
                } catch (retryError) {
                    audioDebug(
                        "Retry threw for " + track +
                        ": " + retryError.message
                    );
                }
            }

            if (!hasStarted) {
                setStatus(
                    "Waiting for " +
                    (trackLabels[track] || track) +
                    " to start. Check server diagnostics."
                );
            }
        }, PLAYBACK_START_TIMEOUT_MS);

        try {
            audioDebug(
                "Calling player.play() for " + track +
                "; " + getMediaState(player)
            );

            var result = player.play();

            if (result && typeof result.then === "function") {
                result.then(function () {
                    if (thisSequenceToken !== sequenceToken) {
                        return;
                    }

                    audioDebug(
                        "PLAY PROMISE RESOLVED for " + track +
                        "; " + getMediaState(player)
                    );
                }, function (error) {
                    if (thisSequenceToken !== sequenceToken) {
                        return;
                    }

                    clearTrackStartTimer();
                    activeSequence = null;

                    audioDebug(
                        "PLAY PROMISE REJECTED for " + track +
                        ": " + error.name + " - " +
                        error.message + "; " + getMediaState(player)
                    );

                    setStatus(
                        "Playback failed for " +
                        (trackLabels[track] || track) +
                        ": " + (error.name || error.message || error)
                    );
                });
            } else {
                audioDebug(
                    "player.play() returned no Promise for " + track
                );
            }
        } catch (error) {
            clearTrackStartTimer();
            activeSequence = null;

            audioDebug(
                "PLAY THREW ERROR for " + track +
                ": " + error.name + " - " +
                error.message + "; " + getMediaState(player)
            );

            setStatus(
                "Playback failed: " +
                (error.name || error.message || error)
            );
        }
    }

    playNextTrack();
}

// ---------------------------------------------------------
// MANUAL TEST PLAY
// ---------------------------------------------------------

function playManualTrack() {
    audioDebug("Manual Test Play button activated.");

    var selector = byId("audio-test-track");
    var track = selector ? selector.value : "baqarah";

    if (!getAudioSource(track)) {
        setStatus(
            "No usable audio source is configured for this selection."
        );
        return;
    }

    playSequence([track], "Manual test");
}

// ---------------------------------------------------------
// GET TRACKS FOR SCHEDULE
// ---------------------------------------------------------

function getScheduledTracks(scheduleType) {
    var settings = getSettings();
    var tracks = [];

    if (scheduleType === "daily") {
        if (isTrackEnabled("baqarah")) {
            tracks.push("baqarah");
        }

        if (isTrackEnabled("yaseen")) {
            tracks.push("yaseen");
        }
    }

    if (scheduleType === "friday") {
        if (isTrackEnabled("kahf")) {
            tracks.push("kahf");
        }
    }

    return { tracks: tracks, error: null };
}

// ---------------------------------------------------------
// SCHEDULER
// ---------------------------------------------------------

function checkSchedule() {
    try {
        var now = new Date();

        audioDebug(
            "checkSchedule running; time=" +
            now.toLocaleTimeString() +
            "; testEnabled=" + TEST_SCHEDULE_ENABLED +
            "; testTime=" + TEST_SCHEDULE_TIME.toLocaleTimeString()
        );

        var dateKey = getLocalDateKey(now);
        var day = now.getDay();
        var minutesNow = now.getHours() * 60 + now.getMinutes();
        var schedules;

        if (TEST_SCHEDULE_ENABLED) {
            schedules = [{
                type: "daily",
                hour: TEST_SCHEDULE_TIME.getHours(),
                minute: TEST_SCHEDULE_TIME.getMinutes(),
                appliesToday: true,
                test: true
            }];
        } else {
            schedules = [
                {
                    type: "daily",
                    hour: 2,
                    minute: 0,
                    appliesToday: true,
                    test: false
                },
                {
                    type: "friday",
                    hour: 12,
                    minute: 15,
                    appliesToday: day === 5,
                    test: false
                }
            ];
        }

        schedules.forEach(function (schedule) {
            if (!schedule.appliesToday) {
                return;
            }

            var scheduledMinutes =
                schedule.hour * 60 + schedule.minute;

            var minutesLate = minutesNow - scheduledMinutes;

            if (schedule.test) {
                if (now.getTime() < TEST_SCHEDULE_TIME.getTime()) {
                    return;
                }

                if (window.dashboardAudioTestTriggered) {
                    return;
                }

                window.dashboardAudioTestTriggered = true;

                audioDebug(
                    "TEST SCHEDULE TRIGGERED at " +
                    now.toLocaleTimeString()
                );

                var testResult = getScheduledTracks(schedule.type);

                audioDebug("Test tracks: " + testResult.tracks.join(","));

                if (testResult.error) {
                    audioDebug("TEST SCHEDULE ERROR: " + testResult.error);
                    setStatus(testResult.error);
                    return;
                }

                if (!testResult.tracks.length) {
                    audioDebug("TEST SKIPPED: all daily tracks are disabled.");
                    setStatus(
                        "Test skipped: all daily audio tracks are disabled."
                    );
                    return;
                }

                playSequence(testResult.tracks, "Daily scheduler TEST");
                return;
            }

            if (
                minutesLate < 0 ||
                minutesLate >= RECOVERY_WINDOW_MINUTES
            ) {
                return;
            }

            var scheduleId = dateKey + "-" + schedule.type;
            var history = getScheduleHistory();

            if (history[scheduleId]) {
                return;
            }

            markScheduleRun(scheduleId);

            var result = getScheduledTracks(schedule.type);

            if (result.error) {
                audioDebug("Schedule error: " + result.error);
                setStatus(result.error);
                return;
            }

            if (!result.tracks.length) {
                audioDebug("Schedule skipped: no tracks enabled.");
                setStatus("Scheduled " + schedule.type + " audio skipped.");
                return;
            }

            var description = schedule.type === "daily"
                ? "Daily 2:00 AM audio"
                : "Friday 12:15 PM audio";

            audioDebug(
                "REAL SCHEDULE TRIGGERED: " +
                schedule.type + "; tracks=" + result.tracks.join(",")
            );

            playSequence(result.tracks, description);
        });
    } catch (error) {
        audioDebug(
            "SCHEDULER CRASH: " +
            error.name + " - " + error.message
        );

        if (window.console && window.console.log) {
            console.log("[Dashboard Audio] Scheduler error:", error);
        }
    }
}

// ---------------------------------------------------------
// INITIALISATION — EXISTING OVERLAY IDS PRESERVED
// ---------------------------------------------------------

function init() {
    audioDebug("Audio JS init() started.");

    var startOverlay = byId("audio-start-overlay");
    var startButton = byId("audio-start-button");

    if (startOverlay && startButton) {
        var dismissAudioOverlay = function (event) {
            if (event) {
                event.preventDefault();
            }

            if (TEST_SCHEDULE_ENABLED) {
                TEST_SCHEDULE_TIME = new Date(Date.now() + 60000);
                window.dashboardAudioTestTriggered = false;

                audioDebug(
                    "Test rescheduled for one minute from audio enable: " +
                    TEST_SCHEDULE_TIME.toLocaleTimeString()
                );
            }

            startOverlay.classList.add("hidden");
            startOverlay.style.display = "none";

            audioDebug("Audio overlay dismissed by user.");

            try {
                primeAudioPlayer();
            } catch (error) {
                audioDebug(
                    "Audio initialisation error: " +
                    error.name + " - " + error.message
                );
            }
        };

        if (window.PointerEvent) {
            startButton.addEventListener(
                "pointerup",
                dismissAudioOverlay
            );
        } else {
            startButton.addEventListener(
                "touchend",
                dismissAudioOverlay
            );

            startButton.addEventListener(
                "click",
                dismissAudioOverlay
            );
        }
    } else {
        audioDebug("Audio overlay or start button not found.");
    }

    var beepButton = byId("audio-test-beep");
    var playButton = byId("audio-test-play");
    var stopButton = byId("audio-test-stop");

    if (beepButton) {
        beepButton.addEventListener("click", function (event) {
            event.preventDefault();
            event.stopPropagation();
            playBeep();
        });
    }

    if (playButton) {
        playButton.addEventListener("click", function (event) {
            event.preventDefault();
            event.stopPropagation();
            playManualTrack();
        });
    }

    if (stopButton) {
        stopButton.addEventListener("click", function (event) {
            event.preventDefault();
            event.stopPropagation();
            stopAudio(true);
        });
    }

    audioDebug("Starting initial scheduler check.");

    checkSchedule();

    scheduleTimer = window.setInterval(
        checkSchedule,
        CHECK_INTERVAL
    );

    audioDebug(
        "Scheduler interval started: every " +
        CHECK_INTERVAL + " milliseconds."
    );

    if (window.console && window.console.log) {
        console.log(
            "[Dashboard Audio] Scheduler started. " +
            "Daily at 02:00; Fridays at 12:15 local time."
        );
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}