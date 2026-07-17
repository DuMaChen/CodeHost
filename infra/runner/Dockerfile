ARG GITLEAKS_IMAGE
FROM ${GITLEAKS_IMAGE} AS gitleaks

FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install --no-install-recommends --yes ca-certificates git python3 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /platform \
    && chown -R 1000:1000 /platform

COPY --from=gitleaks /usr/bin/gitleaks /usr/local/bin/gitleaks
COPY entrypoint.sh /platform/run
RUN chmod 0555 /platform/run

USER 1000:1000
ENTRYPOINT ["/platform/run"]
