# Extend this base with the project runtime and dependencies, build externally,
# then approve only the final immutable image digest in CodeBridge.
FROM python:3.12-slim
COPY codebridge-launch /usr/libexec/codebridge-launch
RUN chmod 0555 /usr/libexec/codebridge-launch
ENTRYPOINT ["/usr/libexec/codebridge-launch"]
