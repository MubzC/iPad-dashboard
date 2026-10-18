import json
import logging
import os
import re

from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse, parse_qs, urlencode
from urllib.request import Request, urlopen


DASHBOARD_DIR = r"./"

HOST = "0.0.0.0"
PORT = 8000

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)


class DashboardHandler(SimpleHTTPRequestHandler):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DASHBOARD_DIR, **kwargs)

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
            logging.error(
                "External API returned HTTP %s: %s",
                exc.code,
                url
            )

            self.send_json(502, {
                "error": "External API returned an HTTP error",
                "upstream_status": exc.code
            })

        except (URLError, TimeoutError, OSError) as exc:
            logging.error(
                "External API connection failed: %s",
                exc
            )

            self.send_json(502, {
                "error": "Could not connect to external API"
            })

        except (ValueError, UnicodeDecodeError) as exc:
            logging.error(
                "Invalid API response: %s",
                exc
            )

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

        # Dubai's calculation method is used only when the detected
        # location is Dubai in the United Arab Emirates.
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
        parsed = urlparse(self.path)

        if parsed.path != "/api/audio-debug":
            self.send_json(404, {"error": "Not found"})
            return

        try:
            content_length = int(
                self.headers.get("Content-Length", "0")
            )

            if content_length <= 0 or content_length > 4096:
                self.send_json(400, {"error": "Invalid message size"})
                return

            body = self.rfile.read(content_length)
            data = json.loads(body.decode("utf-8"))

            message = str(data.get("message", ""))[:1000]

            # Identify the device by its IP address.
            device_ip = self.client_address[0]

            logging.info(
                "[AUDIO DEBUG] [%s] %s",
                device_ip,
                message
            )

            self.send_json(200, {"ok": True})

        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            self.send_json(400, {"error": "Invalid JSON"})
    
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

                logging.info(
                    "Detected location: %s, %s | method=%s",
                    location["city"],
                    location["country"],
                    location["method"]
                )

                self.send_json(200, location)

            except Exception as exc:
                logging.error(
                    "Location detection failed: %s",
                    exc
                )

                # Do not silently report Dubai when detection fails.
                # The dashboard can display a location error instead.
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

            self.proxy_json(url)
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

            # Validate date.
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

            # Only allow the two methods requested.
            if method not in ("4", "16"):
                self.send_json(400, {
                    "error": "Unsupported calculation method"
                })
                return

            # Validate timezone before passing it to the API.
            # The API can calculate it from coordinates if omitted.
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

            # Coordinate-based endpoint: works worldwide.
            url = (
                "https://api.aladhan.com/v1/timings/"
                + date
                + "?"
                + query
            )

            logging.info(
                "Prayer request: date=%s lat=%s lon=%s method=%s",
                date,
                lat,
                lon,
                method
            )

            self.proxy_json(url)
            return

        # -----------------------------------------------------
        # STATIC DASHBOARD FILES
        # -----------------------------------------------------
        super().do_GET()

    def log_message(self, format_string, *args):
        logging.info(
            "%s - %s",
            self.client_address[0],
            format_string % args
        )


if __name__ == "__main__":
    os.chdir(DASHBOARD_DIR)

    server = ThreadingHTTPServer(
        (HOST, PORT),
        DashboardHandler
    )

    logging.info(
        "Dashboard directory: %s",
        DASHBOARD_DIR
    )

    logging.info(
        "Dashboard server: http://localhost:%s",
        PORT
    )

    logging.info(
        "Listening on %s:%s",
        HOST,
        PORT
    )

    try:
        server.serve_forever()

    except KeyboardInterrupt:
        logging.info("Shutting down dashboard server")

    finally:
        server.server_close()