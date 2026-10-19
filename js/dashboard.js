(function () {
    "use strict";

    var CONFIG = {
        rotationInterval: 30000,
        clockInterval: 1000,
        highlightAndThemeInterval: 60000,
        weatherInterval: 900000,
        prayerRefreshInterval: 3600000
    };
    var currentPage = 0;
    var pages = [
        document.getElementById("time-page"),
        document.getElementById("weather-page"),
        document.getElementById("prayer-page")
    ];
    var lastTouchTime = 0;
    var touchStartX = 0;
    var touchStartY = 0;
    var lastPrayerDate = "";
    var lastWeatherFetch = 0;
    var lastPrayerFetch = 0;
    var locationData = {
        latitude: 25.2048,
        longitude: 55.2708,
        city: "Dubai",
        country: "United Arab Emirates",
        countryCode: "AE",
        timezone: "Asia/Dubai",
        method: "16"
    };
    var prayerData = null;
    var weatherData = null;
    var tomorrowFajrCache = null;
    var tomorrowFajrCacheKey = "";
    var tomorrowFajrLoadingKey = "";
    var tomorrowFajrLastAttemptKey = "";
    var tomorrowFajrLastAttempt = 0;
    var sunriseMinutes = 360;
    var sunsetMinutes = 1080;
    var isDaytime = true;
    var prayerNames = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];
    var prayerKeys = ["fajr", "dhuhr", "asr", "maghrib", "isha"];
    function byId(id) {
        return document.getElementById(id);
    }
    function pad(number) {
        return number < 10 ? "0" + number : String(number);
    }
    function getDateKey(date) {
        return date.getFullYear() + "-" +
            pad(date.getMonth() + 1) + "-" +
            pad(date.getDate());
    }
    function getDateForAPI(date) {
        return pad(date.getDate()) + "-" +
            pad(date.getMonth() + 1) + "-" +
            date.getFullYear();
    }
    function requestJSON(url, callback) {
        var xhr = new XMLHttpRequest();
        var completed = false;
        xhr.open("GET", url, true);
        xhr.timeout = 20000;
        function finish(error, data) {
            if (completed) {
                return;
            }
            completed = true;
            callback(error, data);
        }
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) {
                return;
            }
            if (xhr.status >= 200 && xhr.status < 300) {
                try {
                    finish(null, JSON.parse(xhr.responseText));
                } catch (error) {
                    finish(error, null);
                }
            } else {
                finish(
                    new Error("Request failed: HTTP " + xhr.status),
                    null
                );
            }
        };
        xhr.ontimeout = function () {
            finish(new Error("Request timed out"), null);
        };
        xhr.onerror = function () {
            finish(new Error("Network error"), null);
        };
        xhr.send(null);
    }
    /* PAGE NAVIGATION */
    function showPage(index) {
        currentPage = (index + pages.length) % pages.length;
        for (var i = 0; i < pages.length; i++) {
            pages[i].className =
                i === currentPage ? "page active" : "page";
        }
    }
    function advancePage() {
        showPage(currentPage + 1);
    }
    function previousPage() {
        showPage(currentPage - 1);
    }
    function handleTouchStart(event) {
        if (!event.touches || event.touches.length !== 1) {
            return;
        }
        touchStartX = event.touches[0].clientX;
        touchStartY = event.touches[0].clientY;
    }
    function handleTouchEnd(event) {
        var now = new Date().getTime();
        if (now - lastTouchTime < 500) {
            return;
        }
        if (!event.changedTouches || event.changedTouches.length !== 1) {
            return;
        }
        var touch = event.changedTouches[0];
        var deltaX = Math.abs(touch.clientX - touchStartX);
        var deltaY = Math.abs(touch.clientY - touchStartY);
        if (deltaX > 30 || deltaY > 30) {
            return;
        }
        lastTouchTime = now;
        if (event.preventDefault) {
            event.preventDefault();
        }
        if (touch.clientX < window.innerWidth / 2) {
            previousPage();
        } else {
            advancePage();
        }
    }
    function handleClick(event) {
        var now = new Date().getTime();
        if (now - lastTouchTime < 500) {
            return;
        }
        lastTouchTime = now;
        if (event.clientX < window.innerWidth / 2) {
            previousPage();
        } else {
            advancePage();
        }
    }
    var app = byId("app");
    app.addEventListener("touchstart", handleTouchStart, false);
    app.addEventListener("touchend", handleTouchEnd, false);
    app.addEventListener("click", handleClick, false);
    /* CLOCK */
    function updateClock() {
        var now = new Date();
        var hours = now.getHours();
        var minutes = now.getMinutes();
        var displayHours = hours % 12;
        if (displayHours === 0) {
            displayHours = 12;
        }
        byId("clock-time").innerHTML =
            displayHours + ":" + pad(minutes);
        byId("ampm").innerHTML = hours >= 12 ? "PM" : "AM";
        var days = [
            "Sunday", "Monday", "Tuesday", "Wednesday",
            "Thursday", "Friday", "Saturday"
        ];
        var months = [
            "January", "February", "March", "April",
            "May", "June", "July", "August",
            "September", "October", "November", "December"
        ];
        byId("gregorian-date").innerHTML =
            days[now.getDay()] + ", " +
            now.getDate() + " " +
            months[now.getMonth()] + " " +
            now.getFullYear();
        if (now.getSeconds() === 0) {
            checkPrayerDate();
        }
    }
    /* DAY/NIGHT THEME */
    function timeStringToMinutes(value) {
        if (!value) {
            return null;
        }
        var match = String(value).match(/(\d{1,2}):(\d{2})/);
        if (!match) {
            return null;
        }
        return parseInt(match[1], 10) * 60 +
            parseInt(match[2], 10);
    }
    function updateTheme() {
        var now = new Date();
        var currentMinutes = now.getHours() * 60 + now.getMinutes();
        isDaytime = currentMinutes >= sunriseMinutes &&
            currentMinutes < sunsetMinutes;
        var mode = "auto";
        if (window.DashboardSettings &&
            window.DashboardSettings.themeMode) {
            mode = window.DashboardSettings.themeMode;
        }
        if (mode === "day") {
            document.body.className = "day";
        } else if (mode === "night") {
            document.body.className = "";
        } else {
            document.body.className = isDaytime ? "day" : "";
        }
        updateWeatherSymbol();
        if (typeof window.applyDashboardPalette === "function") {
            window.applyDashboardPalette();
        }
    }
    window.updateDashboardTheme = updateTheme;
    /* SALAH TIMES */
    function checkPrayerDate() {
        var todayKey = getDateKey(new Date());
        if (todayKey !== lastPrayerDate &&
            isFinite(locationData.latitude) &&
            isFinite(locationData.longitude)) {
            loadPrayerTimes();
        }
    }
    function loadPrayerTimes() {
        var now = new Date();
        var dateKey = getDateKey(now);
        var apiDate = getDateForAPI(now);
        var url = "/api/prayer?date=" +
            encodeURIComponent(apiDate) +
            "&latitude=" +
            encodeURIComponent(locationData.latitude) +
            "&longitude=" +
            encodeURIComponent(locationData.longitude) +
            "&timezone=" +
            encodeURIComponent(locationData.timezone) +
            "&method=" +
            encodeURIComponent(locationData.method);
        requestJSON(url, function (error, data) {
            if (error || !data || !data.data || !data.data.timings) {
                byId("prayer-date").innerHTML = "Prayer times unavailable";
                byId("time-next-prayer").innerHTML = "Unable to load";
                byId("prayer-date").className = "subtitle error-message";
                return;
            }
            var result = data.data;
            var timings = result.timings || {};
            prayerData = {
                dateKey: dateKey,
                timings: timings,
                hijri: result.date ? result.date.hijri : null
            };
            lastPrayerDate = dateKey;
            lastPrayerFetch = new Date().getTime();
            byId("prayer-date").className = "subtitle";
            setPrayerTime("fajr", timings.Fajr);
            setPrayerTime("sunrise", timings.Sunrise);
            setPrayerTime("dhuhr", timings.Dhuhr);
            setPrayerTime("asr", timings.Asr);
            setPrayerTime("maghrib", timings.Maghrib);
            setPrayerTime("isha", timings.Isha);
            if (prayerData.hijri) {
                updateHijriDate(prayerData.hijri);
            }
            updatePrayerHighlights();
            updateTheme();
        });
    }
    function setPrayerTime(key, value) {
        var minutes = timeStringToMinutes(value);
        if (minutes === null) {
            byId("time-" + key).innerHTML = "--:--";
            return;
        }
        var hours = Math.floor(minutes / 60);
        var mins = minutes % 60;
        var displayHours = hours % 12;
        if (displayHours === 0) {
            displayHours = 12;
        }
        byId("time-" + key).innerHTML =
            displayHours + ":" + pad(mins) +
            (hours >= 12 ? " PM" : " AM");
    }
    function updateHijriDate(hijri) {
        if (!hijri) {
            return;
        }
        var englishMonth = hijri.month && hijri.month.en
            ? hijri.month.en : "";
        var arabicMonth = hijri.month && hijri.month.ar
            ? hijri.month.ar : "";
        byId("hijri-english").innerHTML =
            hijri.day + " " + englishMonth + " " + hijri.year + " AH";
        byId("hijri-arabic").innerHTML =
            hijri.day + " " + arabicMonth + " " + hijri.year;
    }
    function parsePrayerMinutes(value) {
        if (typeof value !== "string") {
            return null;
        }
        var match = value.match(/^\s*(\d{1,2}):(\d{2})(?:\s|$)/);
        if (!match) {
            return null;
        }
        var hours = parseInt(match[1], 10);
        var minutes = parseInt(match[2], 10);
        if (
            hours < 0 ||
            hours > 23 ||
            minutes < 0 ||
            minutes > 59
        ) {
            return null;
        }
        return hours * 60 + minutes;
    }
    function formatPrayerTime(value) {
        var minutes = parsePrayerMinutes(value);
        if (minutes === null) {
            return null;
        }
        var hours = Math.floor(minutes / 60);
        var mins = minutes % 60;
        var displayHours = hours % 12;
        if (displayHours === 0) {
            displayHours = 12;
        }
        return displayHours + ":" + pad(mins) +
            (hours >= 12 ? " PM" : " AM");
    }
    function getTomorrowFajrKey(date) {
        var tomorrow = new Date(date);
        tomorrow.setDate(tomorrow.getDate() + 1);
        return getDateKey(tomorrow) + "|" +
            locationData.latitude + "|" +
            locationData.longitude + "|" +
            locationData.method;
    }
    function loadTomorrowFajr(date) {
        var tomorrow = new Date(date);
        tomorrow.setDate(tomorrow.getDate() + 1);
        var cacheKey = getTomorrowFajrKey(date);
        var nextPrayerDisplay = byId("time-next-prayer");
        if (
            tomorrowFajrCache &&
            tomorrowFajrCacheKey === cacheKey
        ) {
            nextPrayerDisplay.innerHTML =
                "Fajr · " + tomorrowFajrCache;
            return;
        }
        if (tomorrowFajrLoadingKey === cacheKey) {
            return;
        }
        if (
            tomorrowFajrLastAttemptKey === cacheKey &&
            Date.now() - tomorrowFajrLastAttempt < 300000
        ) {
            nextPrayerDisplay.innerHTML = "Fajr · Unavailable";
            return;
        }
        tomorrowFajrLoadingKey = cacheKey;
        tomorrowFajrLastAttemptKey = cacheKey;
        tomorrowFajrLastAttempt = Date.now();
        nextPrayerDisplay.innerHTML = "Fajr · Loading…";
        var url = "/api/prayer?date=" +
            encodeURIComponent(getDateForAPI(tomorrow)) +
            "&latitude=" +
            encodeURIComponent(locationData.latitude) +
            "&longitude=" +
            encodeURIComponent(locationData.longitude) +
            "&timezone=" +
            encodeURIComponent(locationData.timezone) +
            "&method=" +
            encodeURIComponent(locationData.method);
        requestJSON(url, function (error, data) {
            tomorrowFajrLoadingKey = "";
            if (
                error ||
                !data ||
                !data.data ||
                !data.data.timings ||
                !data.data.timings.Fajr
            ) {
                nextPrayerDisplay.innerHTML = "Fajr · Unavailable";
                return;
            }
            var formatted = formatPrayerTime(
                data.data.timings.Fajr
            );
            if (!formatted) {
                nextPrayerDisplay.innerHTML = "Fajr · Unavailable";
                return;
            }
            tomorrowFajrCache = formatted;
            tomorrowFajrCacheKey = cacheKey;
            updatePrayerHighlights();
        });
    }
    function updatePrayerHighlights() {
        if (!prayerData || !prayerData.timings) {
            return;
        }
        var timings = prayerData.timings;
        var now = new Date();
        var currentMinutes = now.getHours() * 60 + now.getMinutes();
        var prayers = [
            {
                key: "fajr",
                name: "Fajr",
                minutes: parsePrayerMinutes(timings.Fajr)
            },
            {
                key: "dhuhr",
                name: "Dhuhr",
                minutes: parsePrayerMinutes(timings.Dhuhr)
            },
            {
                key: "asr",
                name: "Asr",
                minutes: parsePrayerMinutes(timings.Asr)
            },
            {
                key: "maghrib",
                name: "Maghrib",
                minutes: parsePrayerMinutes(timings.Maghrib)
            },
            {
                key: "isha",
                name: "Isha",
                minutes: parsePrayerMinutes(timings.Isha)
            }
        ];
        var sunrise = parsePrayerMinutes(timings.Sunrise);
        for (var i = 0; i < prayers.length; i++) {
            if (prayers[i].minutes === null) {
                return;
            }
            if (
                i > 0 &&
                prayers[i].minutes <= prayers[i - 1].minutes
            ) {
                return;
            }
        }
        if (
            sunrise !== null &&
            (sunrise <= prayers[0].minutes ||
                sunrise >= prayers[1].minutes)
        ) {
            sunrise = null;
        }
        var currentIndex = prayers.length - 1;
        for (var j = 0; j < prayers.length; j++) {
            if (currentMinutes >= prayers[j].minutes) {
                currentIndex = j;
            } else {
                break;
            }
        }
        var currentRow = prayers[currentIndex].key;
        if (sunrise !== null) {
            if (currentMinutes === sunrise) {
                currentRow = "sunrise";
            } else if (
                currentMinutes > sunrise &&
                currentMinutes < prayers[1].minutes
            ) {
                currentRow = null;
            }
        }
        var rows = [
            "fajr",
            "sunrise",
            "dhuhr",
            "asr",
            "maghrib",
            "isha"
        ];
        for (var k = 0; k < rows.length; k++) {
            var row = byId("prayer-" + rows[k]);
            if (row) {
                row.className = rows[k] === currentRow
                    ? "prayer-row current"
                    : "prayer-row";
            }
        }
        var nextPrayer = null;
        for (var m = 0; m < prayers.length; m++) {
            if (prayers[m].minutes > currentMinutes) {
                nextPrayer = prayers[m];
                break;
            }
        }
        var nextPrayerDisplay = byId("time-next-prayer");
        if (nextPrayer === null) {
            loadTomorrowFajr(now);
        } else {
            var nextPrayerTime = byId("time-" + nextPrayer.key);
            if (nextPrayerTime && nextPrayerDisplay) {
                nextPrayerDisplay.innerHTML =
                    nextPrayer.name + " · " +
                    nextPrayerTime.innerHTML;
            }
        }
        byId("prayer-date").innerHTML =
            now.toLocaleDateString("en-GB", {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric"
            });
    }
    /* WEATHER SYMBOLS */
    function weatherDescription(code) {
        var map = {
            0: ["Clear sky", "clear"],
            1: ["Mainly clear", "clear"],
            2: ["Partly cloudy", "partly"],
            3: ["Overcast", "cloud"],
            45: ["Fog", "fog"],
            48: ["Depositing rime fog", "fog"],
            51: ["Light drizzle", "drizzle"],
            53: ["Moderate drizzle", "drizzle"],
            55: ["Dense drizzle", "drizzle"],
            56: ["Freezing drizzle", "drizzle"],
            57: ["Heavy freezing drizzle", "drizzle"],
            61: ["Slight rain", "rain"],
            63: ["Moderate rain", "rain"],
            65: ["Heavy rain", "rain"],
            66: ["Freezing rain", "rain"],
            67: ["Heavy freezing rain", "rain"],
            71: ["Light snow", "snow"],
            73: ["Moderate snow", "snow"],
            75: ["Heavy snow", "snow"],
            77: ["Snow grains", "snow"],
            80: ["Rain showers", "shower"],
            81: ["Moderate rain showers", "shower"],
            82: ["Heavy rain showers", "shower"],
            85: ["Snow showers", "snow"],
            86: ["Heavy snow showers", "snow"],
            95: ["Thunderstorm", "storm"],
            96: ["Thunderstorm with hail", "storm"],
            99: ["Thunderstorm with heavy hail", "storm"]
        };
        return map[code] || ["Current conditions", "clear"];
    }
    function updateWeatherSymbol() {
        var iconEl = byId("weather-icon");
        if (!iconEl) {
            return;
        }
        var iconClass;
        if (!weatherData) {
            iconClass = isDaytime ? "bi-sun" : "bi-moon-stars";
        } else {
            var current = weatherData.current ||
                weatherData.current_weather || {};
            var code = current.weather_code !== undefined
                ? current.weather_code
                : current.weathercode;
            var description = weatherDescription(code);
            var category = description ? description[1] : "";
            switch (category) {
                case "clear":
                    iconClass = isDaytime ? "bi-sun" : "bi-moon-stars";
                    break;
                case "partly":
                    iconClass = isDaytime ? "bi-cloud-sun" : "bi-cloud-moon";
                    break;
                case "cloud":
                case "overcast":
                    iconClass = "bi-cloud";
                    break;
                case "fog":
                case "haze":
                    iconClass = "bi-cloud-fog2";
                    break;
                case "drizzle":
                    iconClass = "bi-cloud-drizzle";
                    break;
                case "rain":
                    iconClass = "bi-cloud-rain";
                    break;
                case "shower":
                    iconClass = "bi-cloud-rain-heavy";
                    break;
                case "snow":
                    iconClass = "bi-cloud-snow";
                    break;
                case "storm":
                case "thunderstorm":
                    iconClass = "bi-cloud-lightning-rain";
                    break;
                default:
                    iconClass = isDaytime ? "bi-sun" : "bi-moon-stars";
            }
        }
        iconEl.innerHTML =
            '<i class="bi ' + iconClass + '" aria-hidden="true"></i>';
    }
    /* WEATHER */
    function loadWeather() {
        var latitude = locationData.latitude;
        var longitude = locationData.longitude;
        var url = "/api/weather?latitude=" +
            encodeURIComponent(latitude) +
            "&longitude=" +
            encodeURIComponent(longitude);
        requestJSON(url, function (error, data) {
            if (error || !data || !data.current) {
                byId("weather-condition").innerHTML =
                    "Weather unavailable";
                return;
            }
            weatherData = data;
            lastWeatherFetch = new Date().getTime();
            var current = data.current;
            var temp = current.temperature_2m;
            var feels = current.apparent_temperature;
            var humidity = current.relative_humidity_2m;
            var wind = current.wind_speed_10m;
            var code = current.weather_code;
            if (temp !== undefined) {
                byId("temperature").innerHTML =
                    Math.round(temp) + "°";
            }
            if (feels !== undefined) {
                byId("weather-feels").innerHTML =
                    "Feels like " + Math.round(feels) + "°";
            }
            if (humidity !== undefined) {
                byId("weather-humidity").innerHTML =
                    humidity + "%";
            }
            if (wind !== undefined) {
                byId("weather-wind").innerHTML =
                    Math.round(wind) + " km/h";
            }
            var descPair = weatherDescription(code);
            byId("weather-condition").innerHTML =
                descPair[0] || "Current conditions";
            if (data.daily &&
                data.daily.sunrise &&
                data.daily.sunset &&
                data.daily.sunrise.length &&
                data.daily.sunset.length) {
                var sunriseStr = data.daily.sunrise[0].split("T")[1];
                var sunsetStr = data.daily.sunset[0].split("T")[1];
                byId("weather-sunrise").innerHTML =
                    sunriseStr.substring(0, 5);
                byId("weather-sunset").innerHTML =
                    sunsetStr.substring(0, 5);
                var srMins = timeStringToMinutes(sunriseStr);
                var ssMins = timeStringToMinutes(sunsetStr);
                if (srMins !== null) {
                    sunriseMinutes = srMins;
                }
                if (ssMins !== null) {
                    sunsetMinutes = ssMins;
                }
            }
            updateTheme();
        });
    }
    /* LOCATION */
    function loadLocation(callback) {
        function applyLocation(latitude, longitude, timezone) {
            locationData.latitude = latitude;
            locationData.longitude = longitude;
            locationData.timezone = timezone;
            locationData.method = String(locationData.method || "4");
            if (callback) {
                callback(null);
            }
        }
        function useDefaultLocation() {
            applyLocation(
                25.2048,
                55.2708,
                "Asia/Dubai"
            );
        }
        if (!navigator.geolocation) {
            useDefaultLocation();
            return;
        }
        navigator.geolocation.getCurrentPosition(
            function (position) {
                applyLocation(
                    position.coords.latitude,
                    position.coords.longitude,
                    "Asia/Dubai"
                );
            },
            function () {
                useDefaultLocation();
            },
            {
                enableHighAccuracy: false,
                timeout: 10000,
                maximumAge: 900000
            }
        );
    }
    /* START */
    function start() {
        updateClock();
        updateTheme();
        window.setInterval(updateClock, CONFIG.clockInterval);
        window.setInterval(function () {
            updatePrayerHighlights();
            updateTheme();
            checkPrayerDate();
        }, CONFIG.highlightAndThemeInterval);
        window.setInterval(function () {
            if (!window.isSettingsModalOpen ||
                !window.isSettingsModalOpen()) {
                advancePage();
            }
        }, CONFIG.rotationInterval);
        loadLocation(function (error) {
            if (error) {
                byId("weather-condition").innerHTML =
                    "Location unavailable";
                return;
            }
            loadWeather();
            loadPrayerTimes();
            window.setInterval(function () {
                var now = new Date().getTime();
                if (now - lastWeatherFetch >= CONFIG.weatherInterval) {
                    loadWeather();
                }
            }, CONFIG.weatherInterval);
            window.setInterval(function () {
                var now = new Date().getTime();
                if (now - lastPrayerFetch >= CONFIG.prayerRefreshInterval) {
                    loadPrayerTimes();
                }
            }, CONFIG.prayerRefreshInterval);
        });
    }
    start();

})();