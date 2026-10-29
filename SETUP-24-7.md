# iPad mini dashboard: deployment and 24/7 test

Updated 29 October 2026 for MD531ZP/A running iOS 9.3.5.

## Install on your Plex computer

1. Back up the dashboard folder on the Plex computer.
2. Pull the latest code with `git pull --ff-only`, then run `git lfs pull` to
   ensure the three MP3s in audio/quran are present. Preserve any local changes
   before pulling. The recordings themselves have not changed in this fix.
3. Stop the old dashboard server, then start dashboard_server.py again.
   Windows: run `py -3 dashboard_server.py` from the dashboard folder.
   macOS/Linux: run `python3 dashboard_server.py`.
   Use this server, not Python's generic http.server: Safari needs the added
   byte-range support. The dashboard folder is now resolved from the script's
   location, so starting it from another directory also works.
4. Reload Safari on the iPad. To bypass stale scripts, open the usual dashboard
   address with `/?v=20261029` appended. Tap Enable Audio & Continue.
5. Open Settings > Audio Test, select a recording, and tap Play MP3.

The existing startup_dashboard.sh contains Windows batch commands. This fix
leaves that launcher untouched. Restart the Python process actually serving
your iPad, whether launched manually or by your existing startup task.

## Power and screen

Move the Lightning cable from the Plex computer's USB port to an iPad-compatible
wall power adapter. A known-good Apple 10W/12W USB adapter with a good Lightning
cable is a useful test; a computer's USB 3.0 label does not establish its charging
power. The dashboard still connects to Plex over Wi-Fi.

Start with screen brightness around 20–30%, adjusting for readability.
On this LCD iPad, the physical brightness slider matters more than a dark theme.
Set Settings > General > Auto-Lock > Never if available, and keep Safari visible.
Keep the Plex computer awake and the server running, with stable Wi-Fi.
A web page cannot force an old iPad to stay awake or keep Safari running after
it is locked, closed, or suspended. Audio permission may need another tap after
Safari restarts. These code changes cannot establish the battery's condition.

## Verify on the actual iPad

- Play beyond the previous two-minute failure point, then let one full recording
  finish. Al-Baqarah is approximately 2 hours 6 minutes in this copy.
- If audio stalls, allow about one minute for a recovery attempt. The player
  reloads and seeks to its last known position, with at most three reconnects
  per track. Settings > Audio Test displays failures. Stop cancels retries.
- Check scheduled playback with the screen on: Al-Baqarah at 02:00, Yaseen at
  05:00, and Al-Kahf Friday at 12:15. The scheduler uses the iPad's local clock;
  set its time zone to Dubai for the intended UAE schedule. It can catch a
  missed start within ten minutes, but cannot run while Safari is suspended.
- Record battery percentage at the start, after two hours, and the next morning
  on wall power at your chosen brightness. If it still falls, try another known-
  good cable/adapter. Continued drain needs charging/battery investigation.

## Changes and verification

- Added 206/Content-Range/Accept-Ranges MP3 responses, suffix/open-ended ranges,
  HEAD support and 416 responses. Transfers stop at the requested byte boundary.
- Added bounded playback recovery at the saved position and clearer failures.
- Replaced the empty audio-unlock WAV with a short valid silent recording and
  guarded its delayed cleanup from interrupting a newly started track.
- Schedule history is recorded once playback starts, rather than before it starts.
- Reduced clock updates from every second to every minute; skip hidden clock
  updates/page rotation and refresh the clock when Safari becomes visible.
- Avoid creating an unused Web Audio context during normal MP3 playback.
- Preserved your existing separate 02:00 and 05:00 schedules.
- Restored this Mac's three MP3s from cached Git LFS objects; SHA-256 hashes match.

Five local HTTP integration tests passed (ranges, invalid ranges, HEAD, full file,
If-Range fallback). Simulated player tests passed for legacy play() without a
Promise, resume at 120 seconds, sequence completion, Stop, retry cap and decode
failure. JavaScript syntax and Python compilation checks passed. No real iOS 9
browser or 24-hour charging test was available here; the two-minute cause remains
a strong hypothesis until the updated server is tested on your iPad.

References:
- Apple Safari media server requirements:
  https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/CreatingVideoforSafarioniPhone/CreatingVideoforSafarioniPhone.html
- Apple charging troubleshooting: https://support.apple.com/en-ie/102612
- Apple battery performance guidance: https://www.apple.com/lae/batteries/maximizing-performance/
