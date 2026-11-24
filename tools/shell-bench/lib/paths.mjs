/** Where the repository is, and where the shells think the workspace is. */
export const ROOT = new URL("../../../", import.meta.url);

/** `WORKSPACE_ROOT` from `@cloudfarm/computer`, hardcoded so `lib` needs no build. */
export const WORKDIR = "/data";
