FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends graphicsmagick \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json /app/package.json
COPY package-lock.json /app/package-lock.json
RUN npm install
COPY . /app

VOLUME [ "/app/credentials" ]
VOLUME [ "/app/instances" ]
VOLUME [ "/app/logs" ]
VOLUME [ "/app/maps" ]

CMD ["npm", "start"]
