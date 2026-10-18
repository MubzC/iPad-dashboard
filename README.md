# iPad Living Room Dashboard

A personal living room dashboard designed to run on an iPad using Safari. It provides a central interface for dashboard content, settings, and scheduled Quran recitation.

## Features

- **iPad-friendly interface** — Designed for use on an iPad through Safari.
- **Scheduled Quran recitation** — Plays selected recitations according to a configured schedule.
- **Surah Al-Baqarah** — Daily scheduled playback.
- **Surah Ya-Sin** — Daily scheduled playback following Al-Baqarah.
- **Surah Al-Kahf** — Scheduled playback on Fridays.
- **Audio settings** — Manage audio-related preferences through the dashboard.
- **Local audio files** — Quran recitations are stored within the project.
- **Automatic scheduling** — Includes audio initialisation logic to support scheduled playback in iPad Safari.
- **Local network access** — Accessible from an iPad connected to the same network as the host computer.

## Audio Schedule

The intended schedule uses UAE local time (GST, UTC+4).

| Day | Time | Recitation |
|---|---|---|
| Daily | 02:00 | Surah Al-Baqarah, followed by Surah Ya-Sin |
| Friday | 12:15 | Surah Al-Kahf |

Actual playback depends on the host server, network availability, and iPadOS/Safari background behaviour.

## Project Structure

```text
ipad/
├── index.html
├── css/
├── js/
├── audio/
│   └── quran/
│       ├── baqarah-mishary.mp3
│       ├── yaseen-mishary.mp3
│       └── kahf-mishary.mp3
├── config/
│   └── audio-sources.json
├── dashboard_server.py
├── startup_dashboard.sh
└── README.md