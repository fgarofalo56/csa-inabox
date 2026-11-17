// Same shape as apps/loom-health-cp/src/registry/types.ts SLUG: the tenant segment
// is substituted into the archive hostname, so anything else is rejected first.
export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/;
