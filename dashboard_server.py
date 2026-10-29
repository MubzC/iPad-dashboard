import json
import os
import re
import threading
import time

from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse, parse_qs, urlencode
from urllib.request import Request, urlopen


DASHBOARD_DIR = os.path.dirname(os.path.abspath(__file__))

PORT = int(os.environ.get("PORT", 8000))
HOST = "0.0.0.0"

# Shared cache for upstream API responses.
API_CACHE = {}
API_CACHE_LOCK = threading.Lock()
API_RETRY_AFTER = {}


class DashboardHandler(SimpleHTTPRequestHandler):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DASHBOARD_DIR, **kwargs)

    def send_head(self):
        """Safari probes and resumes MP3s with single byte-range requests."""
        self.media_bytes_remaining = None
        path = self.translate_path(self.path)
        if not path.lower().endswith(".mp3") or not os.path.isfile(path):
            return super().send_head()

        source = open(path, "rb")
        size = os.fstat(source.fileno()).st_size
        start, end = 0, size - 1
        range_header = self.headers.get("Range")
        # Without a validator, honor If-Range by sending the complete file.
        partial = bool(range_header and not self.headers.get("If-Range"))
        if partial:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
            try:
                if not match or not any(match.groups()):
                    raise ValueError("Invalid range")
                first, last = match.groups()
                if first:
                    start = int(first)
                    end = min(int(last), size - 1) if last else size - 1
                else:
                    length = int(last)
                    if length <= 0:
                        raise ValueError("Invalid suffix")
                    start = max(0, size - length)
                if start > end or start >= size:
                    raise ValueError("Unsatisfiable range")
            except ValueError:
                source.close()
                self.send_response(416)
                self.send_header("Content-Range", "bytes */%d" % size)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return None

        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Last-Modified", self.date_time_string(os.fstat(source.fileno()).st_mtime))
        if partial:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.end_headers()
        source.seek(start)
        self.media_bytes_remaining = end - start + 1
        return source

    def copyfile(self, source, outputfile):
        remaining = getattr(self, "media_bytes_remaining", None)
        try:
            if remaining is None:
                return super().copyfile(source, outputfile)
            while remaining > 0:
                chunk = source.read(min(65536, remaining))
                if not chunk:
                    break
                outputfile.write(chunk)
                remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            # Safari can cancel its probe or switch to a new range.
            pass

    def send_json(self, status, data):
        body = json.dumps(data).encode("utf-8")

        self.send_response(status)
        self.send_header(
            "Content-Type",
            "application/json; charset=utf-8"
        )
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        self.wfile.write(body)

    def fetch_json(self, url):
        request = Request(
            url,
            headers={
                "User-Agent": "LivingRoomDashboard/1.0",
                "Accept": "application/json"
            }
        )

        with urlopen(request, timeout=20) as response:
            body = response.read()

        return json.loads(body.decode("utf-8"))

    def proxy_json(self, url):
        try:
            data = self.fetch_json(url)
            self.send_json(200, data)

        except HTTPError as exc:
            self.send_json(502, {
                "error": "External API returned an HTTP error",
                "upstream_status": exc.code
            })

        except (URLError, TimeoutError, OSError):
            self.send_json(502, {
                "error": "Could not connect to external API"
            })

        except (ValueError, UnicodeDecodeError):
            self.send_json(502, {
                "error": "External API returned invalid JSON"
            })

    def cached_proxy_json(
        self,
        url,
        cache_key,
        ttl=900,
        stale_ttl=172800
    ):
        """
        Cache successful API responses.

        ttl:
            How long a response remains fresh.

        stale_ttl:
            Maximum age at which an old response can still
            be served if the upstream API fails.
        """

        now = time.time()

        # Serialize cache checks and upstream requests.
        with API_CACHE_LOCK:
            entry = API_CACHE.get(cache_key)

            # Return fresh cached data without contacting the API.
            if entry and now - entry["fetched_at"] < ttl:
                self.send_json(200, entry["data"])
                return

            # Avoid repeatedly contacting a rate-limited API.
            retry_after = API_RETRY_AFTER.get(cache_key, 0)

            if now < retry_after:
                if entry and now - entry["fetched_at"] < stale_ttl:
                    self.send_json(200, entry["data"])
                else:
                    self.send_json(503, {
                        "error": "API temporarily unavailable",
                        "cached_data": False
                    })
                return

            try:
                data = self.fetch_json(url)

                API_CACHE[cache_key] = {
                    "data": data,
                    "fetched_at": time.time()
                }

                API_RETRY_AFTER.pop(cache_key, None)

                self.send_json(200, data)

            except HTTPError as exc:
                if exc.code == 429:
                    API_RETRY_AFTER[cache_key] = time.time() + 60

                # Prefer cached data when the upstream API fails.
                if (
                    entry
                    and time.time() - entry["fetched_at"] < stale_ttl
                ):
                    self.send_json(200, entry["data"])
                else:
                    self.send_json(502, {
                        "error": "External API returned an HTTP error",
                        "upstream_status": exc.code
                    })

            except (URLError, TimeoutError, OSError):
                if (
                    entry
                    and time.time() - entry["fetched_at"] < stale_ttl
                ):
                    self.send_json(200, entry["data"])
                else:
                    self.send_json(502, {
                        "error": "Could not connect to external API"
                    })

            except (ValueError, UnicodeDecodeError):
                if (
                    entry
                    and time.time() - entry["fetched_at"] < stale_ttl
                ):
                    self.send_json(200, entry["data"])
                else:
                    self.send_json(502, {
                        "error": "External API returned invalid JSON"
                    })

    def get_location(self):
        """
        Detect the public IP location of the computer running
        this server.
        """

        data = self.fetch_json("https://ipapi.co/json/")

        if data.get("error"):
            raise ValueError("IP geolocation service returned an error")

        city = str(data.get("city") or "").strip()
        country = str(data.get("country_name") or "").strip()
        country_code = str(data.get("country_code") or "").strip()
        timezone = str(data.get("timezone") or "").strip()

        latitude = float(data["latitude"])
        longitude = float(data["longitude"])

        if not (-90 <= latitude <= 90):
            raise ValueError("Invalid latitude")

        if not (-180 <= longitude <= 180):
            raise ValueError("Invalid longitude")

        # Use method 16 for Dubai, UAE; method 4 elsewhere.
        if (
            city.lower() == "dubai"
            and country_code.upper() == "AE"
        ):
            method = "16"
        else:
            method = "4"

        return {
            "latitude": latitude,
            "longitude": longitude,
            "city": city,
            "country": country,
            "countryCode": country_code,
            "timezone": timezone or "UTC",
            "method": method
        }

    def do_POST(self):
        # Diagnostic POST endpoints have been removed.
        self.send_json(404, {"error": "Not found"})

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        # -----------------------------------------------------
        # LOCATION
        # -----------------------------------------------------
        if path == "/api/location":
            try:
                location = self.get_location()
                self.send_json(200, location)

            except Exception:
                self.send_json(502, {
                    "error": "Could not detect location"
                })

            return

        # -----------------------------------------------------
        # WEATHER
        # -----------------------------------------------------
        if path == "/api/weather":
            latitude = params.get("latitude", [""])[0]
            longitude = params.get("longitude", [""])[0]

            try:
                lat = float(latitude)
                lon = float(longitude)

                if not (-90 <= lat <= 90):
                    raise ValueError("Latitude out of range")

                if not (-180 <= lon <= 180):
                    raise ValueError("Longitude out of range")

            except (TypeError, ValueError):
                self.send_json(400, {
                    "error": "Invalid coordinates"
                })
                return

            query = urlencode({
                "latitude": lat,
                "longitude": lon,
                "current": (
                    "temperature_2m,"
                    "relative_humidity_2m,"
                    "apparent_temperature,"
                    "weather_code,"
                    "wind_speed_10m,"
                    "is_day"
                ),
                "daily": "sunrise,sunset",
                "temperature_unit": "celsius",
                "wind_speed_unit": "kmh",
                "timezone": "auto"
            })

            url = (
                "https://api.open-meteo.com/v1/forecast?"
                + query
            )

            self.cached_proxy_json(
                url,
                cache_key=(
                    "weather",
                    round(lat, 3),
                    round(lon, 3)
                ),
                ttl=900,
                stale_ttl=172800
            )
            return

        # -----------------------------------------------------
        # PRAYER TIMES
        # -----------------------------------------------------
        if path == "/api/prayer":
            date = params.get("date", [""])[0]
            latitude = params.get("latitude", [""])[0]
            longitude = params.get("longitude", [""])[0]
            timezone = params.get("timezone", [""])[0]
            method = params.get("method", ["4"])[0]

            # Validate date format.
            if not re.fullmatch(r"\d{2}-\d{2}-\d{4}", date):
                self.send_json(400, {
                    "error": "Invalid date; expected DD-MM-YYYY"
                })
                return

            try:
                lat = float(latitude)
                lon = float(longitude)

                if not (-90 <= lat <= 90):
                    raise ValueError("Latitude out of range")

                if not (-180 <= lon <= 180):
                    raise ValueError("Longitude out of range")

            except (TypeError, ValueError):
                self.send_json(400, {
                    "error": "Invalid coordinates"
                })
                return

            # Only allow the supported calculation methods.
            if method not in ("4", "16"):
                self.send_json(400, {
                    "error": "Unsupported calculation method"
                })
                return

            # Validate timezone before passing it to the API.
            if timezone and not re.fullmatch(
                r"[A-Za-z0-9_+./-]+",
                timezone
            ):
                self.send_json(400, {
                    "error": "Invalid timezone"
                })
                return

            query_values = {
                "latitude": lat,
                "longitude": lon,
                "method": method,
                "iso8601": "false"
            }

            if timezone:
                query_values["timezonestring"] = timezone

            query = urlencode(query_values)

            url = (
                "https://api.aladhan.com/v1/timings/"
                + date
                + "?"
                + query
            )

            self.cached_proxy_json(
                url,
                cache_key=(
                    "prayer",
                    date,
                    round(lat, 5),
                    round(lon, 5),
                    timezone,
                    method
                ),
                ttl=86400,
                stale_ttl=604800
            )
            return

        # -----------------------------------------------------
        # STATIC DASHBOARD FILES
        # -----------------------------------------------------
        super().do_GET()

    def log_message(self, format_string, *args):
        # Suppress HTTP request logging.
        pass


if __name__ == "__main__":
    os.chdir(DASHBOARD_DIR)

    server = ThreadingHTTPServer(
        (HOST, PORT),
        DashboardHandler
    )

    try:
        server.serve_forever()

    except KeyboardInterrupt:
        pass

    finally:
        server.server_close()