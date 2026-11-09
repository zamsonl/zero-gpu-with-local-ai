# Reporting security issues

Do not post live tokens, signed URLs, private notebooks or chat exports in public issues. Report a minimal redacted reproduction through the repository's private vulnerability reporting feature when available. Rotate a disclosed credential at its issuer.

Public deployments should use the default workspace-key authentication, their own resources, HTTPS, private notebooks and the reviewed local approval policy. Do not disable browser sandboxing to make a test pass. Per-user local sessions do not make the website's shared workspace history multi-tenant.

Before publishing changes, rebuild and inspect archives as well as source. Keep `.dev.vars`, `.env`, `deployment.local.json`, credential stores, `.wrangler` state, local chats, logs and test outputs out of Git and release packages. Model weights retain their upstream licenses and are not bundled here.
