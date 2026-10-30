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

var CHECK_INTERVAL = 30000;
var playbackWatchdog = null;
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
    "UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";

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
        // Ignore unavailable or invalid saved settings.
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
        return settings.kahfNarrator || "mishary";
    }

    return settings[track + "Narrator"] || "mishary";
}

function getAudioSource(track) {
    var narrator = getNarrator(track);

    if (!narrator) {
        return null;
    }

    return "audio/quran/" + track + "-" + narrator + ".mp3";
}

function clearPlaybackWatchdog() {
    if (playbackWatchdog !== null) {
        window.clearInterval(playbackWatchdog);
        playbackWatchdog = null;
    }
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
        // Playback can continue if schedule history cannot be saved.
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

    clearPlaybackWatchdog();
    clearTrackStartTimer();
    stopBeep();

    if (audioPlayer) {
        try {
            audioPlayer.pause();
            audioPlayer.currentTime = 0;
        } catch (error) {
            // Ignore media reset errors.
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
                resumeResult.then(startBeep, function () {
                    setStatus(
                        "Unable to start the beep. Tap Test Beep again."
                    );
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
    }
}

// ---------------------------------------------------------
// INITIALISE PERSISTENT AUDIO PLAYER
// ---------------------------------------------------------

function initialiseScheduledAudio() {
    if (!audioPlayer) {
        audioPlayer = document.createElement("audio");
        audioPlayer.id = "dashboard-audio-player";
        audioPlayer.preload = "auto";

        audioPlayer.setAttribute("playsinline", "true");
        audioPlayer.setAttribute("webkit-playsinline", "true");

        audioPlayer.style.display = "none";

        audioPlayer.addEventListener("playing", function () {
            clearTrackStartTimer();
        }, false);

        document.body.appendChild(audioPlayer);
    }

    return audioPlayer;
}

// ---------------------------------------------------------
// PRIME AUDIO DURING THE OVERLAY USER INTERACTION
// ---------------------------------------------------------

function primeAudioPlayer() {
    var player = initialiseScheduledAudio();

    if (!player) {
        return;
    }

    try {
        player.pause();
        player.src = SILENT_WAV;
        player.load();

        var result = player.play();

        if (result && typeof result.then === "function") {
            result.then(function () {
                /*
                 * Wait until the play request has been accepted
                 * before cleaning up the silent source.
                 */
                window.setTimeout(function () {
                    try {
                        if (activeSequence !== null || player.getAttribute("src") !== SILENT_WAV) { return; }
                        player.pause();
                        player.removeAttribute("src");
                        player.load();
                    } catch (error) {
                        // Ignore silent-source cleanup errors.
                    }
                }, 100);
            }, function () {
                // Priming may be rejected by some browser versions.
            });
        }
    } catch (error) {
        // Priming must not interrupt dashboard initialisation.
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
                audioContext.resume();
            }
        } catch (error) {
            // Web Audio is optional.
        }
    }
}

// ---------------------------------------------------------
// PLAY AUDIO SEQUENCE
// ---------------------------------------------------------

function playSequence(tracks, description, onStarted) {
    // Never restart a sequence that is already playing.
    if (activeSequence !== null) {
        return;
    }

    stopBeep();
    clearTrackStartTimer();

    sequenceToken++;

    var thisSequenceToken = sequenceToken;
    var index = 0;

    if (!audioPlayer) {
        initialiseScheduledAudio();
    }

    var player = audioPlayer;

    if (!player) {
        setStatus("Audio player could not be initialised.");
        return;
    }

    activeSequence = { description: description };

    function playNextTrack() {
        if (thisSequenceToken !== sequenceToken) {
            return;
        }

        clearTrackStartTimer();
        clearPlaybackWatchdog();

        if (index >= tracks.length) {
            activeSequence = null;
            setStatus(description + " completed.");
            return;
        }

        var track = tracks[index++];
        var source = getAudioSource(track);

        if (!source) {
            playNextTrack();
            return;
        }

        var hasStarted = false;
        var trackIndex = index;
        var lastPosition = 0;
        var lastProgressAt = Date.now();
        var recoveryAttempts = 0;
        var resumePosition = null;

        function isCurrentTrack() {
            return thisSequenceToken === sequenceToken &&
                activeSequence !== null && trackIndex === index;
        }

        function failTrack(message) {
            if (!isCurrentTrack()) { return; }
            clearPlaybackWatchdog();
            clearTrackStartTimer();
            activeSequence = null;
            player.pause();
            setStatus(message);
        }

        function recoverTrack() {
            if (!isCurrentTrack()) { return; }
            if (recoveryAttempts >= 3) {
                failTrack("Playback interrupted for " + (trackLabels[track] || track) +
                    ". Check Wi-Fi/server, then tap Play MP3 to retry.");
                return;
            }
            recoveryAttempts++;
            resumePosition = Math.max(lastPosition, player.currentTime || 0);
            lastProgressAt = Date.now();
            setStatus("Reconnecting " + (trackLabels[track] || track) +
                " at " + Math.floor(resumePosition) + " seconds...");
            player.load();
            requestPlay();
        }

        function requestPlay() {
            try {
                var request = player.play();
                if (request && typeof request.then === "function") {
                    request.then(function () { }, function (error) {
                        if (!isCurrentTrack()) { return; }
                        if (error.name === "NotAllowedError") {
                            failTrack("Safari blocked playback. Tap Play MP3 to enable audio again.");
                        }
                        // Network failures are retried by the bounded watchdog.
                    });
                }
            } catch (error) {
                failTrack("Playback failed: " + (error.name || error.message || error));
            }
        }

        player.onloadedmetadata = function () {
            if (!isCurrentTrack() || resumePosition === null) { return; }
            try {
                player.currentTime = resumePosition;
                resumePosition = null;
            } catch (error) {
                failTrack("Unable to resume recording. Tap Play MP3 to restart.");
            }
        };
        player.ontimeupdate = function () {
            if (!isCurrentTrack()) { return; }
            if (player.currentTime > lastPosition + 0.1) {
                lastPosition = player.currentTime;
                lastProgressAt = Date.now();
            }
        };
        playbackWatchdog = window.setInterval(function () {
            if (isCurrentTrack() && !player.ended && Date.now() - lastProgressAt > 45000) {
                recoverTrack();
            }
        }, 15000);

        player.onplaying = function () {
            if (thisSequenceToken !== sequenceToken) {
                return;
            }

            hasStarted = true;
            if (onStarted) {
                onStarted();
                onStarted = null;
            }
            clearTrackStartTimer();

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
            playNextTrack();
        };

        player.onerror = function () {
            if (!isCurrentTrack()) { return; }
            if (player.error && (player.error.code === 3 || player.error.code === 4)) {
                failTrack("Audio file cannot be decoded. Check the MP3 file for " +
                    (trackLabels[track] || track) + ".");
            }
            // Transient network errors use the watchdog, avoiding retry loops.
        };

        player.onabort = function () { };
        player.onstalled = function () { };
        player.onwaiting = function () { };

        try {
            player.pause();
        } catch (resetError) {
            // Continue with assigning the next source.
        }

        player.src = source;
        player.load();

        setStatus("Loading " + (trackLabels[track] || track) + "...");

        trackStartTimer = window.setTimeout(function () {
            if (
                thisSequenceToken !== sequenceToken ||
                hasStarted
            ) {
                return;
            }

            /*
             * Retry once only if enough media data is available.
             * This does not guarantee that Safari will allow playback.
             */
            if (player.readyState >= 2) {
                try {
                    var retryResult = player.play();

                    if (
                        retryResult &&
                        typeof retryResult.then === "function"
                    ) {
                        retryResult.then(function () { }, function () { });
                    }
                } catch (retryError) {
                    // Retry failed; retain the waiting status below.
                }
            }

            if (!hasStarted) {
                setStatus(
                    "Waiting for " +
                    (trackLabels[track] || track) +
                    " to start."
                );
            }
        }, PLAYBACK_START_TIMEOUT_MS);

        requestPlay();
    }

    playNextTrack();
}

// ---------------------------------------------------------
// MANUAL TEST PLAY
// ---------------------------------------------------------

function playManualTrack() {
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
    var tracks = [];

    if (scheduleType === "daily" || scheduleType === "baqarah") {
        if (isTrackEnabled("baqarah")) {
            tracks.push("baqarah");
        }
    }

    if (scheduleType === "daily" || scheduleType === "yaseen") {
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

        if (activeSequence !== null) {
            return;
        }

        var dateKey = getLocalDateKey(now);
        var day = now.getDay();
        var minutesNow = now.getHours() * 60 + now.getMinutes();
        var schedules;

        if (TEST_SCHEDULE_ENABLED) {
            schedules = [{
                type: "baqarah",
                hour: TEST_SCHEDULE_TIME.getHours(),
                minute: TEST_SCHEDULE_TIME.getMinutes(),
                appliesToday: true,
                test: true
            }];
        } else {
            schedules = [
                {
                    type: "baqarah",
                    hour: 2,
                    minute: 0,
                    appliesToday: true,
                    test: false
                },
                {
                    type: "yaseen",
                    hour: 6,
                    minute: 0,
                    appliesToday: true,
                    test: false
                },
                {
                    type: "friday",
                    hour: 12,
                    minute: 10,
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

                var testResult = getScheduledTracks(schedule.type);

                if (testResult.error) {
                    setStatus(testResult.error);
                    return;
                }

                if (!testResult.tracks.length) {
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

            var result = getScheduledTracks(schedule.type);

            if (result.error) {
                setStatus(result.error);
                return;
            }

            if (!result.tracks.length) {
                setStatus("Scheduled " + schedule.type + " audio skipped.");
                return;
            }

            var description;

            if (schedule.type === "baqarah") {
                description = "Daily 2:00 AM Surah Al-Baqarah";
            } else if (schedule.type === "yaseen") {
                description = "Daily 5:00 AM Surah Yaseen";
            } else {
                description = "Friday 12:15 PM Surah Al-Kahf";
            }

            playSequence(result.tracks, description, function () {
                // A blocked or failed start must not consume today's schedule.
                markScheduleRun(scheduleId);
            });
        });
    } catch (error) {
        // Prevent an unexpected scheduler error from stopping future checks.
    }
}

// ---------------------------------------------------------
// INITIALISATION — EXISTING OVERLAY IDS PRESERVED
// ---------------------------------------------------------

function init() {
    var startOverlay = byId("audio-start-overlay");
    var startButton = byId("audio-start-button");

    if (startOverlay && startButton) {
        var dismissAudioOverlay = function (event) {
            if (event) {
                event.preventDefault();
            }
            if (startOverlay.style.display === "none") { return; }

            if (TEST_SCHEDULE_ENABLED) {
                TEST_SCHEDULE_TIME = new Date(Date.now() + 60000);
                window.dashboardAudioTestTriggered = false;
            }

            startOverlay.classList.add("hidden");
            startOverlay.style.display = "none";

            try {
                primeAudioPlayer();
            } catch (error) {
                // Audio initialisation must not break the dashboard.
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

    checkSchedule();

    scheduleTimer = window.setInterval(
        checkSchedule,
        CHECK_INTERVAL
    );
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}