# No OCI SDK at runtime; implement request signing and HTTP ourselves

boci's reason to exist is being smaller and faster to start than the Python CLI, so it does not depend on the official OCI TypeScript SDK (large, slow to load, and organised differently from the CLI's command surface). boci implements OCI HTTP Signature request signing with `node:crypto` and builds requests from the extracted command surface. The only planned runtime dependency is a JMESPath implementation for `--query`.
