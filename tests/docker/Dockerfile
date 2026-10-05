FROM node:24-bookworm-slim
COPY sandbox/codebridge-launch /usr/libexec/codebridge-launch
RUN chmod 0555 /usr/libexec/codebridge-launch
ENTRYPOINT ["/usr/libexec/codebridge-launch"]
