FROM node:22-slim

# System dependencies:
#  - graphicsmagick: map rendering
#  - python3 + venv: host for the bundled LibreTranslate (Spanish → English)
#  - tini: PID 1 to reap the libretranslate background process cleanly
#  - ca-certificates: argospm/pip TLS
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       graphicsmagick \
       python3 python3-pip python3-venv \
       tini ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# LibreTranslate lives in its own venv so its dependencies don't fight with
# anything Node-side. Only the Spanish → English language pack is installed,
# which is ~200 MB instead of the ~3 GB the full LibreTranslate image ships.
RUN python3 -m venv /opt/libretranslate \
    && /opt/libretranslate/bin/pip install --no-cache-dir libretranslate \
    && /opt/libretranslate/bin/argospm update \
    && /opt/libretranslate/bin/argospm install translate-es_en

# Bot talks to the in-container LibreTranslate by default. Override at run
# time to point at an external instance, or set to empty string to disable
# the libre path and fall back to the (rate-limited) google web endpoint.
ENV RPP_LIBRETRANSLATE_URL=http://127.0.0.1:5000

WORKDIR /app

COPY package.json /app/package.json
COPY package-lock.json /app/package-lock.json
RUN npm install
COPY . /app

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

VOLUME [ "/app/credentials" ]
VOLUME [ "/app/instances" ]
VOLUME [ "/app/logs" ]
VOLUME [ "/app/maps" ]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/docker-entrypoint.sh"]
