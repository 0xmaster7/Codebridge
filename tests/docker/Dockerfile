FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*
COPY sandbox/codebridge-launch /usr/libexec/codebridge-launch
RUN chmod 0555 /usr/libexec/codebridge-launch
ENTRYPOINT ["/usr/libexec/codebridge-launch"]
