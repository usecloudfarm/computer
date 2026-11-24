/**
 * The batteries-included entry point.
 *
 * `@cloudfarm/computer` holds the Computer and every interface; the shell and
 * the code engine are separate packages because they implement those
 * interfaces and depend on it, so it cannot depend on them back. That split is
 * real, but it is the build graph's problem rather than yours: this package
 * sits above all three and declares them as ordinary dependencies, so
 * `pnpm add cloudfarm` leaves nothing to wire up.
 *
 * Install `@cloudfarm/computer` directly instead when you want to choose the
 * shell yourself, or to keep a Workers bundle down to what it actually uses.
 */
export * from "@cloudfarm/computer";
