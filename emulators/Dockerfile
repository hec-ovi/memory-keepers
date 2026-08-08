# Firestore emulator with the Emulator Suite UI: browse and edit the live
# document tree at http://localhost:4000 while developing at zero cost.
FROM node:24-trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends default-jre-headless \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g firebase-tools \
    && npm cache clean --force
WORKDIR /fb
COPY firebase.json .
EXPOSE 8480 4000
CMD ["firebase", "emulators:start", "--project", "memory-keepers-local"]
