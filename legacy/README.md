# legacy/ — original Python sketch (reference only)

These three files are the **early, dormant Python orchestration sketch** that
predated the real engine. They are kept for historical reference and are **not**
part of the build, the CLI, or CI.

- `radar_orchestrator.py` — async pipeline skeleton (stubs only)
- `engines/github_engine.py` → `github_engine.py` — placeholder GitHub metrics
- `engines/community_engine.py` → `community_engine.py` — placeholder community signals

The active, shipped implementation is the TypeScript engine under [`../src`](../src),
which ports the proven in-`ardur.ai` OSS RADAR logic. See [`../docs/spec.md`](../docs/spec.md).
