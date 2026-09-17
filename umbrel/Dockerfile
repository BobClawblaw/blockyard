# The image behind the Umbrel package. Built and pushed by
# .github/workflows/publish-umbrel-image.yml for linux/amd64 and linux/arm64; the store's
# compose file then names it by digest.
#
# Build context is the REPOSITORY ROOT, not this directory:
#   docker build -f umbrel/Dockerfile -t blockyard:dev .
#
# There is no build stage and no npm install because there is nothing to install:
# package.json's dependencies are empty and the server is plain Node. What ships is the
# same set package.json's `files` list publishes, plus this directory's entrypoint.
FROM node:22-slim

# uid/gid 1000 already exist in this image as `node`, and the compose file runs the
# container as 1000:1000 so that everything written into the Umbrel data volume belongs to
# the same user Umbrel uses on the host.
WORKDIR /app

COPY package.json ./
COPY bin ./bin
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY config/pool-map.json ./config/pool-map.json
COPY docs ./docs
COPY CHANGELOG.md SECURITY.md NOTICE LICENSE README.md ./
COPY umbrel/entrypoint.js umbrel/local.json.template ./umbrel/
# The DOS Diversions' game files: shareware DOOM, Quake and Wolfenstein 3D, 26 MB, exactly
# as this repository already carries them. They are here rather than left out because each
# is shareware whose terms permit free electronic redistribution of the whole package, and
# because the whole package is what travels: Quake's SLICNSE.TXT is in games/quake_dos/ and
# is COPYed with the rest, which is the condition its section 6 sets ("so long as this
# Agreement accompanies the Software at all times"). An Umbrel install is the same app as
# any other install, and it can run DOOM.
COPY games ./games

# The mount points. Both are volumes at runtime -- creating them here means the container
# starts correctly even when run by hand with neither mounted.
RUN mkdir -p /app/data /var/lib/bitcoind && chown -R 1000:1000 /app/data


ENV NODE_ENV=production \
    BLOCKYARD_BIND=0.0.0.0 \
    BLOCKYARD_PORT=21000 \
    BLOCKYARD_TLS=0 \
    BLOCKYARD_AUTH=1 \
    BLOCKYARD_LOG_SOURCE=0 \
    BLOCKYARD_DATA=/app/data/state \
    BLOCKYARD_CONFIG=/app/data/local.json

USER 1000:1000
EXPOSE 21000

# /api/health needs no sign-in (server/http/api.js) and answers as soon as the HTTP server
# is listening, whether or not the node is reachable -- which is what a container health
# check should measure. Node's own fetch, so nothing extra is installed for it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BLOCKYARD_PORT||21000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "/app/umbrel/entrypoint.js"]
