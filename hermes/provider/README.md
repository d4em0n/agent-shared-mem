# Shared memory for Hermes Agent

This provider maps Hermes Agent's `MemoryProvider` lifecycle to
shared-memory-runtime v2. The JavaScript runtime remains the source of truth for
store discovery, nested indexes, recall ranking, and index-health warnings.

Install from the runtime repository:

```bash
shared-memory-install --hermes --dry-run
shared-memory-install --hermes
```

Then select the provider and disable Hermes's two built-in file stores in the
active profile's `config.yaml`:

```yaml
memory:
  provider: shared-memory
  memory_enabled: false
  user_profile_enabled: false
```

Do not put `memory` in `agent.disabled_toolsets`; that broader switch can also
hide external-provider context. Restart Hermes or begin a new session after
changing the configuration.
