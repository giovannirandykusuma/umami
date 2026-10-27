# 0001 — Use standard Pi CLI RPC

Status: accepted (2026-10-27)

## Context

The runtime foundation initially implemented a restricted custom JSONL bridge around the Pi SDK. Review verified it invoked the actual agent loop, but it was not the standard Pi RPC interface requested for this feature. No custom bridge implementation was merged.

## Decision

Use the pinned standard Pi CLI with `--mode rpc`, not a bespoke SDK transport. A trusted explicitly loaded tool bridge may connect allowlisted analytics reads to the authenticated host. Preserve fresh process/session isolation, explicit provider configuration, resource-discovery restrictions, bounded lifecycle handling, host authorization and explicit human Save.

Verify actual native CLI startup and protocol behavior with synthetic, credential-free smoke tests in addition to fixtures. Never call a live model or production analytics in acceptance tests. If native CLI isolation cannot satisfy the contract, report the precise blocker rather than silently changing architecture.

## Consequences

Rework the unmerged runtime through a fresh worker and judge. Tool allowlisting remains distinct from OS isolation; dedicated deployment filesystem/network/credential controls are still required. First-release analytics tools are a documented capability subset, not an aggregate-only authorization policy.
