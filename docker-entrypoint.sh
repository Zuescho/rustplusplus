#!/bin/sh
set -e

# Only start the bundled LibreTranslate when the bot's translator URL still
# points at this container's loopback. If RPP_LIBRETRANSLATE_URL has been
# overridden (external instance) or unset entirely, leave the bundled
# engine asleep so we don't waste ~300 MB of RAM.
if [ "${RPP_LIBRETRANSLATE_URL:-}" = "http://127.0.0.1:5000" ]; then
    echo "[entrypoint] starting bundled LibreTranslate on 127.0.0.1:5000 (es,en)"
    /opt/libretranslate/bin/libretranslate \
        --host 127.0.0.1 --port 5000 \
        --load-only en,es \
        --disable-web-ui \
        --disable-files-translation \
        --threads 2 &
fi

exec npm start
