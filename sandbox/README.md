# Approved check image launcher

CodeBridge runs only an externally prepared immutable image. The image must
contain `/usr/libexec/codebridge-launch`, installed from this directory, the
selected adapter executable, and every dependency needed by the approved check.
The launcher copies the read-only snapshot into the bounded `/workspace` tmpfs,
then starts the externally approved executable with a small clean environment.

Build the image outside CodeBridge, add the project's runtime and dependencies,
and approve the final image ID/digest and profile with `codebridge approve-check`.
Never configure an image tag as the profile's image digest. CodeBridge never
builds, pulls, or modifies images from an MCP request.

The generic base `Dockerfile` installs the launcher only. Extend it with your
project's pinned dependency setup. Readiness probes verify the adapter executable
and required adapter dependency before checks are offered. Keep the image itself
inside your trusted execution base; CodeBridge does not attest to its build.

The workspace, `/tmp`, and `/home/cb` are separate bounded tmpfs mounts. A fresh
container starts with an empty workspace. Symlinks, hardlinks, non-regular files,
and snapshot identity changes cause the launcher to fail closed. The invoked
project process receives no parent environment values.
