(function () {
    "use strict";

    var CHECK_INTERVAL = 5000;
    var RECOVERY_WINDOW_MINUTES = 10;
    var TEST_SCHEDULE_ENABLED = true;

    var STORAGE_KEY = "livingRoomDashboardSettings";
    var HISTORY_KEY = "dashboardAudioScheduleHistory";

    var player = null;
    var audioContext = null;
    var checkTimer = null;
    var testTimer = null;
    var sequence = [];
    var sequenceIndex = 0;
    var currentTrack = null;
    var playbackTimer = null;
    var playbackStarted = false;
    var playbackRetryCount = 0;
    var audioUnlocked = false;

    var testScheduleTime = new Date(
        new Date().getTime() + 60000
    );

    var labels = {
        baqarah: "Surah Al-Baqarah",
        yaseen: "Surah Yaseen",
        kahf: "Surah Al-Kahf",
    };

    /*
     * Diagnostics are sent to the existing Python server.
     * A failed diagnostic request must never stop audio playback.
     */
    function audioDebug(message) {
        try {
            var xhr = new XMLHttpRequest();

            xhr.open("POST", "/api/audio-debug", true);
            xhr.setRequestHeader(
                "Content-Type",
                "application/json"
            );

            xhr.send(JSON.stringify({
                message: String(message),
                time: new Date().toISOString()
            }));
        } catch (error) {
            // Diagnostics must not interrupt the dashboard.
        }
    }

    function padTwoDigits(number) {
        return number < 10 ? "0" + number : String(number);
    }

    function getTimeString(date) {
        return padTwoDigits(date.getHours()) + ":" +
            padTwoDigits(date.getMinutes());
    }

    function getDateKey(date) {
        return date.getFullYear() + "-" +
            padTwoDigits(date.getMonth() + 1) + "-" +
            padTwoDigits(date.getDate());
    }

    function getSettings() {
        /*
         * settings.js exposes the current settings here.
         * Read localStorage as a fallback if this script starts first.
         */
        if (window.DashboardSettings) {
            return window.DashboardSettings;
        }

        try {
            var saved = window.localStorage.getItem(STORAGE_KEY);

            if (saved) {
                return JSON.parse(saved);
            }
        } catch (error) {
            audioDebug("Could not read saved settings: " + error);
        }

        return {};
    }

    function settingIsEnabled(value) {
        return value !== false &&
            value !== "off" &&
            value !== 0;
    }

    function isTrackEnabled(settings, track) {
        if (track === "kahf") {
            /*
             * Support both versions of the settings property names.
             */
            if (settings.kahfEnabled !== undefined) {
                return settingIsEnabled(settings.kahfEnabled);
            }

            return true;
        }

        var key = track + "Enabled";

        if (settings[key] === undefined) {
            return true;
        }

        return settingIsEnabled(settings[key]);
    }

    function getNarrator(settings, track) {
        var key;

        if (track === "kahf") {
            if (settings.kahfNarrator !== undefined) {
                return settings.kahfNarrator;
            }

            return "mishary";
        }

        key = track + "Narrator";

        return settings[key] || "mishary";
    }

    /*
     * Quran paths are constructed from the saved narrator selection.
     * Example:
     * audio/quran/baqarah-mishary.mp3
     *
     * This preserves the existing directory and filename convention
     * without hardcoding a separate source for every track.
     */
    function getAudioSource(track) {
        var settings = getSettings();
        var narrator;
        var filename;

        narrator = getNarrator(settings, track);

        if (!narrator) {
            audioDebug(
                "No narrator is configured for " + track
            );

            return null;
        }

        filename = track + "-" + narrator + ".mp3";

        return "audio/quran/" + filename;
    }

    function getScheduleHistory() {
        try {
            var value = window.localStorage.getItem(HISTORY_KEY);

            return value ? JSON.parse(value) : {};
        } catch (error) {
            return {};
        }
    }

    function markScheduleRun(scheduleName, date) {
        var history = getScheduleHistory();

        history[scheduleName] = getDateKey(date);

        try {
            window.localStorage.setItem(
                HISTORY_KEY,
                JSON.stringify(history)
            );
        } catch (error) {
            audioDebug("Could not save schedule history: " + error);
        }
    }

    function hasScheduleRun(scheduleName, date) {
        var history = getScheduleHistory();

        return history[scheduleName] === getDateKey(date);
    }

    function stopPlaybackTimer() {
        if (playbackTimer !== null) {
            window.clearTimeout(playbackTimer);
            playbackTimer = null;
        }
    }

    function stopAudio() {
        stopPlaybackTimer();

        if (player) {
            try {
                player.pause();
                player.removeAttribute("src");
                player.load();
            } catch (error) {
                audioDebug("Error stopping audio: " + error);
            }
        }

        sequence = [];
        sequenceIndex = 0;
        currentTrack = null;
        playbackStarted = false;
        playbackRetryCount = 0;

        audioDebug("Audio stopped.");
    }

    /*
     * Initialise one persistent audio element.
     * Reuse it for every track rather than creating new players.
     */
    function initialiseScheduledAudio() {
        if (player) {
            return;
        }

        player = document.createElement("audio");
        player.id = "dashboard-audio-player";
        player.preload = "auto";

        player.setAttribute("playsinline", "playsinline");
        player.setAttribute("webkit-playsinline", "webkit-playsinline");

        player.style.display = "none";

        document.body.appendChild(player);

        player.addEventListener("loadstart", function () {
            audioDebug(
                "MEDIA EVENT: loadstart; networkState=" +
                player.networkState +
                "; readyState=" + player.readyState +
                "; paused=" + player.paused +
                "; currentTime=" + player.currentTime +
                "; duration=" + player.duration +
                "; currentSrc=" + player.currentSrc
            );
        }, false);

        player.addEventListener("loadedmetadata", function () {
            audioDebug(
                "MEDIA EVENT: loadedmetadata; readyState=" +
                player.readyState +
                "; duration=" + player.duration +
                "; currentSrc=" + player.currentSrc
            );
        }, false);

        player.addEventListener("canplay", function () {
            audioDebug(
                "MEDIA EVENT: canplay; readyState=" +
                player.readyState +
                "; paused=" + player.paused
            );

            /*
             * Older Safari may not return a Promise from play().
             * If playback has not started, make one controlled retry.
             */
            if (
                currentTrack &&
                !playbackStarted &&
                player.paused &&
                playbackRetryCount < 1
            ) {
                retryPlayback("canplay event");
            }
        }, false);

        player.addEventListener("playing", function () {
            playbackStarted = true;
            playbackRetryCount = 0;

            stopPlaybackTimer();

            audioDebug(
                "MEDIA EVENT: playing; track=" + currentTrack +
                "; currentTime=" + player.currentTime +
                "; duration=" + player.duration
            );
        }, false);

        player.addEventListener("pause", function () {
            audioDebug(
                "MEDIA EVENT: pause; track=" + currentTrack +
                "; currentTime=" + player.currentTime
            );
        }, false);

        player.addEventListener("waiting", function () {
            audioDebug(
                "MEDIA EVENT: waiting; track=" + currentTrack
            );
        }, false);

        player.addEventListener("stalled", function () {
            audioDebug(
                "MEDIA EVENT: stalled; track=" + currentTrack
            );
        }, false);

        player.addEventListener("suspend", function () {
            audioDebug(
                "MEDIA EVENT: suspend; networkState=" +
                player.networkState +
                "; readyState=" + player.readyState
            );
        }, false);

        player.addEventListener("ended", function () {
            audioDebug(
                "MEDIA EVENT: ended; track=" + currentTrack
            );

            stopPlaybackTimer();

            sequenceIndex++;

            if (sequenceIndex < sequence.length) {
                playCurrentTrack();
            } else {
                audioDebug("Audio sequence completed.");

                sequence = [];
                sequenceIndex = 0;
                currentTrack = null;
                playbackStarted = false;
            }
        }, false);

        player.addEventListener("error", function () {
            var mediaError = player.error;
            var errorCode = mediaError ? mediaError.code : "unknown";

            stopPlaybackTimer();

            audioDebug(
                "MEDIA ERROR: code=" + errorCode +
                "; track=" + currentTrack +
                "; networkState=" + player.networkState +
                "; readyState=" + player.readyState +
                "; currentSrc=" + player.currentSrc
            );

            /*
             * Do not silently advance to the next track on an error.
             * The diagnostic log must show which file failed.
             */
        }, false);

        /*
         * Web Audio is optional. Older Safari may not support it.
         */
        try {
            var AudioContextConstructor =
                window.AudioContext ||
                window.webkitAudioContext;

            if (AudioContextConstructor) {
                audioContext = new AudioContextConstructor();
            }
        } catch (error) {
            audioContext = null;

            audioDebug(
                "AudioContext unavailable: " + error
            );
        }

        audioDebug("Persistent audio player initialised.");
    }

    function playBeep() {
        if (!audioContext) {
            audioDebug("Beep unavailable: AudioContext unsupported.");
            return;
        }

        try {
            if (audioContext.state === "suspended") {
                audioContext.resume();
            }

            var oscillator = audioContext.createOscillator();
            var gain = audioContext.createGain();

            oscillator.frequency.value = 880;
            gain.gain.value = 0.08;

            oscillator.connect(gain);
            gain.connect(audioContext.destination);

            oscillator.start(0);
            oscillator.stop(audioContext.currentTime + 0.15);

            audioDebug("Beep played.");
        } catch (error) {
            audioDebug("Beep failed: " + error);
        }
    }

    function retryPlayback(reason) {
        if (!player || !currentTrack || playbackStarted) {
            return;
        }

        playbackRetryCount++;

        audioDebug(
            "Retrying playback; reason=" + reason +
            "; attempt=" + playbackRetryCount +
            "; paused=" + player.paused +
            "; readyState=" + player.readyState
        );

        try {
            var result = player.play();

            if (result && typeof result.then === "function") {
                result.then(function () {
                    audioDebug(
                        "Playback retry accepted for " + currentTrack
                    );
                }).catch(function (error) {
                    audioDebug(
                        "Playback retry rejected for " +
                        currentTrack + ": " + error
                    );
                });
            }
        } catch (error) {
            audioDebug(
                "Playback retry threw an error for " +
                currentTrack + ": " + error
            );
        }
    }

    function playCurrentTrack() {
        initialiseScheduledAudio();

        if (sequenceIndex >= sequence.length) {
            audioDebug("No remaining tracks in sequence.");
            return;
        }

        currentTrack = sequence[sequenceIndex];

        var source = getAudioSource(currentTrack);

        if (!source) {
            audioDebug(
                "Cannot play " + currentTrack +
                ": no usable source is configured."
            );

            sequenceIndex++;

            if (sequenceIndex < sequence.length) {
                playCurrentTrack();
            }

            return;
        }

        playbackStarted = false;
        playbackRetryCount = 0;

        stopPlaybackTimer();

        audioDebug(
            "Loading " + (labels[currentTrack] || currentTrack) +
            "; source=" + source
        );

        /*
         * Set the source and call play immediately.
         * Do not wait for loadedmetadata before attempting playback.
         */
        try {
            player.pause();
            player.src = source;
            player.load();

            var result = player.play();

            if (result && typeof result.then === "function") {
                result.then(function () {
                    audioDebug(
                        "play() accepted for " + currentTrack
                    );
                }).catch(function (error) {
                    audioDebug(
                        "play() rejected for " + currentTrack +
                        ": " + error
                    );
                });
            } else {
                audioDebug(
                    "play() returned no Promise; waiting for media events."
                );
            }
        } catch (error) {
            audioDebug(
                "play() threw an error for " + currentTrack +
                ": " + error
            );
        }

        /*
         * If Safari never fires "playing", record the state and retry
         * once. This distinguishes a stalled player from successful play.
         */
        playbackTimer = window.setTimeout(function () {
            if (playbackStarted || !currentTrack) {
                return;
            }

            audioDebug(
                "PLAYBACK WATCHDOG: no playing event within 8 seconds; " +
                "track=" + currentTrack +
                "; paused=" + player.paused +
                "; networkState=" + player.networkState +
                "; readyState=" + player.readyState +
                "; currentTime=" + player.currentTime +
                "; duration=" + player.duration
            );

            if (player.paused && playbackRetryCount < 1) {
                retryPlayback("8-second watchdog");
            }
        }, 8000);
    }

    function playSequence(tracks, reason) {
        if (!tracks || !tracks.length) {
            audioDebug(
                "No tracks to play. Reason: " + reason
            );
            return;
        }

        stopPlaybackTimer();

        sequence = tracks.slice(0);
        sequenceIndex = 0;
        currentTrack = null;
        playbackStarted = false;
        playbackRetryCount = 0;

        audioDebug(
            "Starting sequence; reason=" + reason +
            "; tracks=" + sequence.join(",")
        );

        playCurrentTrack();
    }

    function playManualTrack(track) {
        var settings = getSettings();

        if (
            !isTrackEnabled(settings, track)
        ) {
            audioDebug(
                "Manual test requested for disabled track: " + track
            );
        }

        /*
         * A manual test is allowed even when a track is disabled
         * for scheduled playback.
         */
        playSequence([track], "Manual test");
    }

    function getScheduledTracks(isFriday) {
        var settings = getSettings();
        var tracks = [];

        if (isTrackEnabled(settings, "baqarah")) {
            tracks.push("baqarah");
        }

        if (isTrackEnabled(settings, "yaseen")) {
            tracks.push("yaseen");
        }

        if (isFriday) {
            if (isTrackEnabled(settings, "kahf")) {
                tracks.push("kahf");
            }
        }

        return tracks;
    }

    function minutesSinceMidnight(date) {
        return date.getHours() * 60 + date.getMinutes();
    }

    function checkSchedule() {
        var now = new Date();
        var time = minutesSinceMidnight(now);
        var isFriday = now.getDay() === 5;

        /*
         * TEST SCHEDULE
         * Runs once, approximately one minute after page load.
         */
        if (
            TEST_SCHEDULE_ENABLED &&
            !window.dashboardAudioTestTriggered &&
            now.getTime() >= testScheduleTime.getTime()
        ) {
            window.dashboardAudioTestTriggered = true;

            var testTracks = getScheduledTracks(isFriday);

            audioDebug(
                "TEST SCHEDULE triggered; time=" +
                getTimeString(now) +
                "; tracks=" + testTracks.join(",")
            );

            playSequence(testTracks, "Daily scheduler TEST");
            return;
        }

        /*
         * Daily schedule: 02:00.
         * Friday schedule: 12:15.
         *
         * The recovery window allows a missed check to be recovered
         * for up to ten minutes after the scheduled time.
         */
        var scheduleName;
        var scheduledMinute;

        if (isFriday) {
            scheduleName = "friday";
            scheduledMinute = 12 * 60 + 15;
        } else {
            scheduleName = "daily";
            scheduledMinute = 2 * 60;
        }

        var difference = time - scheduledMinute;

        if (
            difference < 0 ||
            difference > RECOVERY_WINDOW_MINUTES
        ) {
            return;
        }

        if (hasScheduleRun(scheduleName, now)) {
            return;
        }

        var tracks = getScheduledTracks(isFriday);

        if (!tracks.length) {
            audioDebug(
                "Scheduled run skipped: no tracks are enabled."
            );

            markScheduleRun(scheduleName, now);
            return;
        }

        /*
         * Mark before playback to prevent the five-second timer
         * from starting the same sequence more than once.
         */
        markScheduleRun(scheduleName, now);

        audioDebug(
            "Scheduled playback triggered; schedule=" +
            scheduleName +
            "; time=" + getTimeString(now) +
            "; tracks=" + tracks.join(",")
        );

        playSequence(tracks, "Scheduled " + scheduleName);
    }

    function bindIfPresent(id, eventName, handler) {
        var element = document.getElementById(id);

        if (element) {
            element.addEventListener(eventName, handler, false);
        }
    }

    function init() {
        initialiseScheduledAudio();

        /*
         * Keep the existing test dropdown and controls.
         */
        bindIfPresent("audio-test-play", "click", function (event) {
            event.preventDefault();

            var select = document.getElementById("audio-test-track");

            if (select && select.value) {
                audioUnlocked = true;
                playManualTrack(select.value);
            }
        });

        bindIfPresent("audio-stop", "click", function (event) {
            event.preventDefault();
            stopAudio();
        });

        bindIfPresent("audio-test-track", "change", function () {
            audioDebug(
                "Manual test track selected: " + this.value
            );
        });

        /*
         * Preserve compatibility with pages that have an audio-enable
         * control. AudioContext resume must be attempted in its handler.
         */
        var enableIds = [
            "audio-enable",
            "audio-enable-button",
            "enable-audio-button"
        ];

        for (var i = 0; i < enableIds.length; i++) {
            bindIfPresent(enableIds[i], "click", function () {
                audioUnlocked = true;

                if (
                    audioContext &&
                    audioContext.state === "suspended"
                ) {
                    try {
                        audioContext.resume();
                    } catch (error) {
                        audioDebug(
                            "AudioContext resume failed: " + error
                        );
                    }
                }

                audioDebug(
                    "Audio enable control activated by user."
                );
            });
        }

        /*
         * A touch can count as the direct interaction on older iOS.
         */
        var playerTouchHandler = function () {
            audioUnlocked = true;

            if (
                audioContext &&
                audioContext.state === "suspended"
            ) {
                try {
                    audioContext.resume();
                } catch (error) {
                    audioDebug(
                        "AudioContext resume failed: " + error
                    );
                }
            }
        };

        document.addEventListener(
            "touchend",
            playerTouchHandler,
            false
        );

        checkSchedule();

        if (checkTimer !== null) {
            window.clearInterval(checkTimer);
        }

        checkTimer = window.setInterval(
            checkSchedule,
            CHECK_INTERVAL
        );

        audioDebug(
            "Audio scheduler initialised; interval=" +
            CHECK_INTERVAL + "ms; testTime=" +
            getTimeString(testScheduleTime)
        );
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init, false);
    } else {
        init();
    }

    /*
     * Keep the existing test hooks available to other dashboard code.
     */
    window.dashboardAudio = {
        play: playManualTrack,
        stop: stopAudio,
        beep: playBeep,
        checkSchedule: checkSchedule,
        getSettings: getSettings
    };
})();